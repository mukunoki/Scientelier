import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceUsageLimit } from "./usage-policy";
import { summarizeResources } from "./usage-tracker";
import { selectAgent, createStandardWorkflow } from "./orchestration";
import { JsonSettingsStore } from "./settings-store";
import type { AgentStatus, OrchestrationSettings, TaskRecord } from "./types";

const settings: OrchestrationSettings = { warningPercent: 70, drainPercent: 85, agentPolicies: [
  { agentId: "codex", enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "subscription", priority: 100, usageLimitPercent: 60 },
  { agentId: "claude", enabled: true, providerKey: "anthropic", providerLabel: "Anthropic", authMode: "subscription", priority: 70, usageLimitPercent: 95 }
] };
const agents: AgentStatus[] = settings.agentPolicies.map(p => ({ id: p.agentId, label: p.agentId, command: p.agentId, installed: true }));
const task: TaskRecord = { id: "thresholds", title: "thresholds", prompt: "work", cwd: "/tmp", strategy: "quality", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, workUnits: createStandardWorkflow(), runs: [], state: "queued", output: "", createdAt: "", updatedAt: "" };

test("service percentages drive status and actual routing, including pinned fallback", () => {
  const resources = summarizeResources(settings, agents, [], [
    { providerKey: "openai", usedPercent: 65, source: "reported-live", updatedAt: new Date().toISOString() },
    { providerKey: "anthropic", usedPercent: 90, source: "reported-live", updatedAt: new Date().toISOString() }
  ]);
  assert.equal(resources[0].state, "draining");
  assert.equal(resources[1].state, "warning");
  assert.equal(selectAgent({ task, unit: task.workUnits[1], agents, settings, resources }), "claude");
  const pinned = { ...task, assignments: { worker: { agentId: "codex" as const, allowFallback: true } } };
  assert.equal(selectAgent({ task: pinned, unit: task.workUnits[1], agents, settings, resources }), "claude");
  const changed = structuredClone(settings); changed.agentPolicies[0].usageLimitPercent = 80;
  assert.equal(selectAgent({ task, unit: task.workUnits[1], agents, settings: changed, resources }), "codex");
});

test("shared account uses stricter enabled limit and unknown usage never comes from old token guesses", () => {
  const shared = structuredClone(settings);
  shared.agentPolicies.push({ ...shared.agentPolicies[0], agentId: "opencode", usageLimitPercent: 40 });
  assert.equal(serviceUsageLimit(shared, shared.agentPolicies[0]), 40);
  shared.agentPolicies[2].enabled = false;
  assert.equal(serviceUsageLimit(shared, shared.agentPolicies[0]), 60);
  shared.agentPolicies[0].softTokenBudget = 1;
  const resources = summarizeResources(shared, agents, [], []);
  assert.equal(resources[0].usedPercent, undefined);
  assert.equal(resources[0].softTokenBudget, undefined);
});

test("per-service percentage persists, supersedes legacy tokens and rejects invalid values atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "service-percentage-"));
  const path = join(dir, "settings.json");
  const reports = { texCommand: "latexmk", texArgs: [], plotCommand: "python3", plotCheckArgs: [], outputDirectory: "/tmp" };
  try {
    const store = new JsonSettingsStore(path, reports, settings); await store.init();
    const input = structuredClone(settings); input.agentPolicies[0].softTokenBudget = 12345;
    await store.updateOrchestration(input);
    const restored = new JsonSettingsStore(path, reports, settings); await restored.init();
    assert.equal(restored.getOrchestration().agentPolicies[0].usageLimitPercent, 60);
    assert.equal(restored.getOrchestration().agentPolicies[1].usageLimitPercent, 95);
    assert.equal(restored.getOrchestration().agentPolicies[0].softTokenBudget, undefined);
    const before = restored.getOrchestration();
    for (const value of [0, 101, NaN, Infinity]) {
      const invalid = structuredClone(before); invalid.agentPolicies[0].usageLimitPercent = value;
      await assert.rejects(restored.updateOrchestration(invalid));
      assert.deepEqual(restored.getOrchestration(), before);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
