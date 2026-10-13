import test from "node:test";
import assert from "node:assert/strict";
import { JsonUsageTracker, parseRateLimitObservation, summarizeResources } from "./usage-tracker";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeCapacityPayload } from "./claude-capacity";
import type { AgentStatus, OrchestrationSettings, TaskRecord } from "./types";

test("login retry releases only authentication backoff and retains stale usage/error until verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "login-retry-"));
  try {
    const tracker = new JsonUsageTracker(join(directory, "usage.json")); await tracker.init();
    await tracker.record("anthropic", { limited: false, usedPercent: 23 });
    await tracker.recordRefreshFailure("anthropic", "Claude usage authorization failed. Open Claude Code to renew your login, then refresh.");
    await tracker.clearAuthenticationRetry("anthropic");
    const auth = tracker.getRateLimits()[0];
    assert.equal(auth.refreshRetryAt, undefined); assert.ok(auth.refreshError); assert.equal(auth.usedPercent, 23);
    await tracker.recordRefreshFailure("anthropic", "Claudeの使用量取得APIが要求を制限しています（HTTP 429）。", 600000);
    const retry = tracker.getRateLimits()[0].refreshRetryAt;
    await tracker.clearAuthenticationRetry("anthropic");
    assert.equal(tracker.getRateLimits()[0].refreshRetryAt, retry);
    await tracker.record("anthropic", { limited: false, usedPercent: 24 });
    assert.equal(tracker.getRateLimits()[0].refreshError, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("parallel provider refreshes persist every provider without temporary-file collisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parallel-usage-")), path = join(directory, "usage.json");
  try {
    const tracker = new JsonUsageTracker(path); await tracker.init();
    await Promise.all(Array.from({ length: 12 }, (_, i) => tracker.record(`provider-${i}`, { limited: false, usedPercent: i })));
    const restored = new JsonUsageTracker(path); await restored.init();
    assert.deepEqual(restored.getRateLimits(), JSON.parse(JSON.stringify(tracker.getRateLimits())));
    assert.equal(restored.getRateLimits().length, 12);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("manual usage recovery can retry a timeout but preserves API throttling and cached errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manual-usage-retry-"));
  try {
    const tracker = new JsonUsageTracker(join(directory, "usage.json")); await tracker.init();
    await tracker.record("openai", { limited: false, usedPercent: 14 });
    await tracker.recordRefreshFailure("openai", "Codex capacity check timed out.");
    await tracker.clearManualRefreshRetry("openai");
    assert.equal(tracker.getRateLimits()[0].refreshRetryAt, undefined);
    assert.equal(tracker.getRateLimits()[0].usedPercent, 14);
    assert.match(tracker.getRateLimits()[0].refreshError!, /timed out/);
    await tracker.recordRefreshFailure("openai", "HTTP 429 Too many requests", 600000);
    const retry = tracker.getRateLimits()[0].refreshRetryAt;
    await tracker.clearManualRefreshRetry("openai");
    assert.equal(tracker.getRateLimits()[0].refreshRetryAt, retry);
    await tracker.recordRefreshFailure("openai", "HTTP 401 Unauthorized");
    await tracker.clearAuthenticationRetry("openai");
    assert.equal(tracker.getRateLimits()[0].refreshRetryAt, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("percentage-labelled quota fields below one percent remain percentages", () => {
  for (const key of ["usedPercent", "used_percentage", "usedPercentage", "used_percentage_percent", "utilizationPercent"]) {
    const result = parseRateLimitObservation(JSON.stringify({ windows: [{ id: "weekly", [key]: 0.5 }] }));
    assert.equal(result.windows?.[0].usedPercent, 0.5, key);
  }
});

test("cooldown expiry does not make old usage look freshly observed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-freshness-"));
  try {
    const tracker = new JsonUsageTracker(join(directory, "usage.json")); await tracker.init();
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    await tracker.record("provider", { limited: true, usedPercent: 95, resetAt: new Date(Date.now() - 1000).toISOString() }, "reported-run", at);
    await tracker.clearExpiredCooldown("provider");
    assert.equal(tracker.getRateLimits()[0].updatedAt, at);
    assert.equal(tracker.getRateLimits()[0].cooldownUntil, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("usage-fetch backoff persists, preserves timestamps, and is independent of model limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-quota-backoff-"));
  try {
    const path = join(directory, "usage.json"); const tracker = new JsonUsageTracker(path); await tracker.init();
    const at = new Date(Date.now() - 10000).toISOString();
    await tracker.record("claude", parseClaudeCapacityPayload({ seven_day_fable: { utilization: 17 } }), "reported-live", at);
    await tracker.recordRefreshFailure("claude", "HTTP 429", 1200000);
    const failure = tracker.getRateLimits()[0];
    assert.equal(failure.updatedAt, at); assert.equal(failure.cooldownUntil, undefined);
    assert.ok(Date.parse(failure.refreshRetryAt!) >= Date.now() + 1199000);
    await tracker.record("claude", parseClaudeCapacityPayload({ five_hour: { used_percentage: 9 } }), "reported-run");
    const partial = tracker.getRateLimits()[0];
    assert.equal(partial.windows?.length, 2); assert.equal(partial.windows?.find(w => w.id === "seven_day_fable")?.observedAt, at);
    assert.equal(partial.refreshRetryAt, failure.refreshRetryAt);
    const restored = new JsonUsageTracker(path); await restored.init();
    assert.equal(restored.getRateLimits()[0].refreshRetryAt, failure.refreshRetryAt);
    await tracker.record("claude", parseClaudeCapacityPayload({ five_hour: { utilization: 10 } }));
    assert.equal(tracker.getRateLimits()[0].refreshRetryAt, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rate limit parser reads structured utilization and retry delay", () => {
  const observation = parseRateLimitObservation([
    JSON.stringify({ usage: { used_percentage: 92 } }),
    "HTTP 429 rate limit reached; retry after 5 minutes"
  ].join("\n"));
  assert.equal(observation.limited, true);
  assert.equal(observation.usedPercent, 92);
  assert.ok(observation.resetAt);
  const delay = new Date(observation.resetAt!).getTime() - Date.now();
  assert.ok(delay > 4 * 60_000 && delay <= 5 * 60_000 + 1000);
});

test("live Claude snapshots replace stale buckets; stream updates preserve Fable and reset metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-usage-test-"));
  try {
    const tracker = new JsonUsageTracker(join(directory, "usage.json"));
    await tracker.init();
    const live = parseClaudeCapacityPayload({
      five_hour: { utilization: 22, resets_at: "2026-09-11T10:10:00Z" },
      seven_day: { utilization: 13, resets_at: "2026-09-15T22:00:00Z" },
      limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 12 }]
    });
    await tracker.record("anthropic", live, "reported-live", "2026-09-11T09:00:00Z");
    await tracker.record("anthropic", parseRateLimitObservation(JSON.stringify({
      type: "rate_limit_event", rate_limit_info: {
        status: "allowed", unifiedWindows: { five_hour: { utilization: 0.23 } },
        rateLimitType: "seven_day_overage_included", utilization: 0.14
      }
    })), "reported-run", "2026-09-11T09:01:00Z");
    const updated = tracker.getRateLimits()[0];
    assert.equal(updated.windows?.length, 3);
    assert.equal(updated.windows?.[0].label, "Current session");
    assert.equal(updated.windows?.[0].usedPercent, 23);
    assert.equal(updated.windows?.[0].resetAt, "2026-09-11T10:10:00.000Z");
    assert.equal(updated.windows?.[2].scope, "model");
    assert.equal(updated.windows?.[2].model, "Fable");
    await tracker.record("anthropic", live, "reported-run", "2026-09-10T09:00:00Z");
    assert.deepEqual(tracker.getRateLimits()[0], updated);
    await tracker.record("anthropic", { limited: false, windows: live.windows?.slice(0, 2) }, "reported-live", "2026-09-11T09:02:00Z");
    assert.equal(tracker.getRateLimits()[0].windows?.length, 2);
    await tracker.recordRefreshFailure("anthropic", "Network unavailable");
    assert.equal(tracker.getRateLimits()[0].windows?.length, 2);
    assert.equal(tracker.getRateLimits()[0].updatedAt, "2026-09-11T09:02:00.000Z");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an allowed Claude rate status reports utilization without creating a limit", () => {
  const observation = parseRateLimitObservation(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.02, resetsAt: 1_789_103_400 },
        seven_day: { utilization: 0.1, resetsAt: 1_789_509_600 }
      }
    }
  }));
  assert.equal(observation.limited, false);
  assert.equal(observation.usedPercent, 10);
  assert.ok(observation.resetAt);
  assert.deepEqual(observation.windows?.map((window) => [window.id, window.usedPercent]), [
    ["five_hour", 2],
    ["seven_day", 10]
  ]);
});

test("rate parser keeps every provider-reported time window", () => {
  const observation = parseRateLimitObservation(JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      unifiedWindows: {
        five_day: { utilization: 0.12, resetsAt: 1_789_103_400 },
        weekly: { utilization: 0.34 },
        monthly: { utilization: 0.56 }
      }
    }
  }));
  assert.deepEqual(observation.windows?.map((window) => [window.label, Number(window.usedPercent.toFixed(1))]), [
    ["5 day", 12],
    ["weekly", 34],
    ["monthly", 56]
  ]);
});

test("Claude observation tracks the actual model separately from shared capacity", () => {
  const observation = parseRateLimitObservation([
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.2 } } }
    }),
    JSON.stringify({ type: "assistant", message: { model: "claude-current", content: [] } })
  ].join("\n"));
  assert.equal(observation.windows?.[0].scope, "shared");
  assert.equal(observation.models?.[0].id, "claude-current");
  assert.equal(observation.models?.[0].source, "observed");
});

test("resource summary groups historical runs by provider account", () => {
  const settings: OrchestrationSettings = {
    warningPercent: 70,
    drainPercent: 85,
    agentPolicies: [
      { agentId: "codex", enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "subscription", priority: 80, softTokenBudget: 1_000 },
      { agentId: "claude", enabled: true, providerKey: "anthropic", providerLabel: "Anthropic", authMode: "subscription", priority: 80 },
      { agentId: "gemini", enabled: false, providerKey: "google", providerLabel: "Google", authMode: "unknown", priority: 70 },
      { agentId: "opencode", enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "api-key", priority: 60 }
    ]
  };
  const agents: AgentStatus[] = settings.agentPolicies.map((policy) => ({
    id: policy.agentId,
    label: policy.agentId,
    command: policy.agentId,
    installed: policy.agentId !== "gemini"
  }));
  const task: TaskRecord = {
    id: "task-1",
    title: "Usage",
    prompt: "Track usage",
    cwd: "/tmp",
    strategy: "balanced",
    allowedAgentIds: ["codex", "opencode"],
    modelOverrides: {},
    workUnits: [],
    runs: [
      { id: "run-1", workUnitId: "work-1", role: "worker", agentId: "codex", providerKey: "openai", state: "completed", output: "", usage: { inputTokens: 400, outputTokens: 100, source: "reported" }, startedAt: "2026-09-11T00:00:00.000Z" },
      { id: "run-2", workUnitId: "work-2", role: "reviewer", agentId: "opencode", providerKey: "openai", state: "completed", output: "", usage: { inputTokens: 300, outputTokens: 100, source: "reported" }, startedAt: "2026-09-11T00:01:00.000Z" }
    ],
    state: "completed",
    output: "",
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:02:00.000Z"
  };
  const openai = summarizeResources(settings, agents, [task], []).find((item) => item.providerKey === "openai");
  assert.equal(openai?.runs, 2);
  assert.equal(openai?.totalTokens, 900);
  assert.equal(openai?.usedPercent, 90);
  assert.equal(openai?.state, "draining");
});

test("resource summary does not apply another model's dedicated quota to the default model", () => {
  const settings: OrchestrationSettings = {
    warningPercent: 70,
    drainPercent: 85,
    agentPolicies: [
      { agentId: "codex", enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "subscription", priority: 80 }
    ]
  };
  const resources = summarizeResources(settings, [{
    id: "codex", label: "Codex", command: "codex", installed: true
  }], [], [{
    providerKey: "openai",
    usedPercent: 90,
    windows: [
      { id: "shared", label: "Shared", usedPercent: 3, scope: "shared" },
      { id: "spark", label: "Spark", usedPercent: 90, scope: "model", model: "GPT Spark" }
    ],
    models: [
      { id: "gpt-latest", label: "GPT Latest", isDefault: true, source: "catalog" },
      { id: "gpt-spark", label: "GPT Spark", source: "catalog" }
    ],
    source: "reported-live",
    updatedAt: "2026-09-11T00:00:00.000Z"
  }]);
  assert.equal(resources[0].usedPercent, 3);
  assert.equal(resources[0].state, "available");
});
