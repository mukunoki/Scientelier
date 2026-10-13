import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeCapacityPayload, retryAfterMilliseconds, readClaudeCapacity, CapacityRequestError } from "./claude-capacity";
import { statusQuota } from "./claude-status-hook";

test("expired Claude credentials never make a usage API request", async () => {
  let calls = 0;
  await assert.rejects(readClaudeCapacity({
    credentials: async () => ({ token: "private-token", expiresAt: 1000, source: "keychain" }), now: () => 1001,
    request: async () => { calls++; throw new Error("not expected"); }
  }), e => e instanceof CapacityRequestError && e.status === 401 && /期限切れ.*再ログイン不要/.test(e.message) && !e.message.includes("private-token"));
  assert.equal(calls, 0);
});

test("401 retries only once when Claude has rotated its stored token", async () => {
  let reads = 0, calls = 0;
  const result = await readClaudeCapacity({
    credentials: async () => ({ token: ++reads === 1 ? "old-secret" : "new-secret", source: "file" }),
    request: async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get("Authorization"), calls === 1 ? "Bearer old-secret" : "Bearer new-secret");
      return calls === 1 ? new Response(null, { status: 401 }) : Response.json({ five_hour: { utilization: 7 } });
    }
  });
  assert.equal(calls, 2); assert.equal(result.usedPercent, 7);
});

test("unchanged rejected tokens are not retried; override and 429 guidance stay distinct", async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    await assert.rejects(readClaudeCapacity({
      credentials: async () => ({ token: "private-token", source: "environment" }),
      request: async () => { calls++; return new Response(null, { status, headers: { "retry-after": "120" } }); }
    }), e => {
      assert.ok(e instanceof CapacityRequestError);
      assert.equal(e.status, status); assert.equal(e.retryAfterMs, 120000);
      assert.doesNotMatch(e.message, /private-token|Claudeログイン管理/);
      assert.match(e.message, status === 429 ? /要求を制限/ : /CLAUDE_CODE_OAUTH_TOKEN/);
      if (status !== 429) assert.match(e.message, /CLIが使えている場合は再ログイン不要/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("native status quota accepts documented fields without fabricating missing buckets", () => {
  const result = statusQuota({ rate_limits: { five_hour: { used_percentage: 8, resets_at: 1800000000 }, seven_day: { used_percentage: 15, resets_at: 1800001000 } }, secret: "must not persist" });
  assert.equal(result?.windows?.length, 2);
  assert.equal(result?.windows?.[0].usedPercent, 8);
  assert.doesNotMatch(JSON.stringify(result), /secret|must not persist/);
  assert.equal(statusQuota({}), undefined);
  assert.equal(retryAfterMilliseconds("120"), 120000);
  assert.equal(retryAfterMilliseconds("0"), undefined);
  assert.equal(retryAfterMilliseconds("bad"), undefined);
});

test("Claude usage preserves session, all-model week and server-named Fable week with resets", () => {
  const result = parseClaudeCapacityPayload({
    five_hour: { utilization: 1, resets_at: "2026-09-11T10:00:00Z" },
    seven_day: { utilization: 32, resets_at: "2026-09-15T10:00:00Z" },
    seven_day_sonnet: null,
    limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 0.5, resets_at: 1_789_123_760 }]
  });
  assert.deepEqual(result.windows?.map((w) => [w.label, w.usedPercent, w.scope]), [
    ["Current session", 1, "shared"], ["Current week (all)", 32, "shared"], ["Current week (Fable)", 0.5, "model"]
  ]);
  assert.equal(result.windows?.[0].resetAt, "2026-09-11T10:00:00.000Z");
  assert.equal(result.windows?.[2].resetAt, new Date(1_789_123_760_000).toISOString());
  assert.equal(result.windows?.[2].model, "Fable");
});

test("Claude usage omits unavailable windows, keeps zero and deduplicates model projections", () => {
  const result = parseClaudeCapacityPayload({
    five_hour: { utilization: null, resets_at: null },
    seven_day: { utilization: 0, resets_at: null },
    seven_day_opus: { utilization: NaN },
    limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 100 }],
    model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "bad date" }],
    extra_usage: { is_enabled: false, utilization: 30 }
  });
  assert.equal(result.windows?.length, 2);
  assert.equal(result.windows?.[0].resetAt, undefined);
  assert.equal(result.windows?.[1].resetAt, undefined);
  assert.equal(result.limited, false);
  assert.equal(result.usedPercent, 0);
});

test("Claude usage includes other available weekly and monthly buckets without inventing resets", () => {
  const result = parseClaudeCapacityPayload({
    seven_day_oauth_apps: { utilization: 4 },
    seven_day_sonnet: { utilization: 8 },
    extra_usage: { is_enabled: true, utilization: 10, resets_at: null }
  });
  assert.equal(result.windows?.length, 3);
  assert.equal(result.windows?.[2].label, "Monthly extra usage");
  assert.equal(result.windows?.[2].resetAt, undefined);
  for (const value of [null, [], {}, { five_hour: { utilization: null } }]) {
    assert.throws(() => parseClaudeCapacityPayload(value));
  }
});
