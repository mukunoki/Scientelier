import test from "node:test";
import assert from "node:assert/strict";
import { terminalQuota, exitedQuota } from "./cli-quota";
import { JsonUsageTracker } from "./usage-tracker";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const quotaBanner = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in\r\n95h24m18s.\r\nError ID: a0fcf25a-373e-4d88-9970-4a2189919a6c-13";

test("native quota detection handles ANSI/wrapped reset times without matching instructions or ordinary 429 text", () => {
  const now=Date.now(), q=terminalQuota("antigravity",`\x1b[31m${quotaBanner}\x1b[m`,now)!;
  assert.equal(q.limited,true); assert.equal(Date.parse(q.resetAt!)-now,95*3600000+24*60000+18000);
  for (const text of ["If a provider limit prevents completion, use status=rate-limited", "HTTP 429 documented in source", "Individual quota reached", "⚠ Individual quota reached. Please upgrade your subscription to increase your limits."]) assert.equal(terminalQuota("antigravity",text),undefined);
  assert.equal(terminalQuota("codex",quotaBanner),undefined);
  assert.equal(exitedQuota("claude","Example source contains 429", ""),undefined);
  assert.equal(exitedQuota("claude","","API Error: 429 Too many requests")?.limited,true);
});

test("account cooldown survives a partial usage refresh and application reload; remote accounts remain isolated", async () => {
  const root=await mkdtemp(join(tmpdir(),"quota-cooldown-"));
  try {
    const tracker=new JsonUsageTracker(join(root,"usage.json"));await tracker.init();
    const quota=terminalQuota("antigravity",quotaBanner)!;
    await tracker.record("google-antigravity@remote-test",quota,"reported-run");
    await tracker.record("google-antigravity@remote-test",{limited:false,usedPercent:0});
    await tracker.record("google-antigravity",{limited:false,usedPercent:0});
    const restored=new JsonUsageTracker(join(root,"usage.json"));await restored.init();
    assert.equal(restored.getRateLimits().find(r=>r.providerKey.endsWith("remote-test"))?.cooldownUntil,quota.resetAt);
    assert.equal(restored.getRateLimits().find(r=>r.providerKey==="google-antigravity")?.cooldownUntil,undefined);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("confirmed account switch archives only its scope and rejects historical quota after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-account-switch-"));
  try {
    const file = join(root, "usage.json"), key = "google-antigravity@remote-test";
    const tracker = new JsonUsageTracker(file); await tracker.init();
    const old = "2026-09-20T12:00:00Z", boundary = "2026-09-21T12:00:00Z", fresh = "2026-09-21T12:01:00Z";
    const quota = { limited: true, resetAt: "2026-09-24T12:00:00Z", detail: "old limit" };
    await tracker.record(key, quota, "reported-run", old);
    await tracker.record("google-antigravity", quota, "reported-run", old);
    await tracker.recordRefreshFailure(key, "old failure");
    await tracker.confirmAccountChange(key, boundary);
    assert.equal(tracker.acceptsObservation(key, old), false, "late in-flight results must be discarded");
    assert.equal(tracker.acceptsObservation(key, boundary), false);
    const restored = new JsonUsageTracker(file); await restored.init();
    await restored.record(key, quota, "reported-run", old);
    await restored.record(key, { limited: false, usedPercent: 0 }, "reported-live", old);
    assert.deepEqual(restored.getRateLimits().find(r => r.providerKey === key), {
      providerKey: key, source: "unknown", updatedAt: boundary, accountChangedAt: boundary
    });
    assert.equal(restored.getRateLimits().find(r => r.providerKey === "google-antigravity")?.cooldownUntil, quota.resetAt);
    const archive = JSON.parse(await readFile(file, "utf8")).accountHistory;
    assert.equal(archive.length, 1); assert.equal(archive[0].previous.lastError, "old limit");
    await restored.record(key, { limited: false, usedPercent: 12 }, "reported-live", fresh);
    assert.equal(restored.getRateLimits().find(r => r.providerKey === key)?.cooldownUntil, undefined);
    await restored.record(key, quota, "reported-run", "2026-09-21T12:02:00Z");
    assert.equal(restored.getRateLimits().find(r => r.providerKey === key)?.cooldownUntil, quota.resetAt, "new account's actual limits still apply");
  } finally { await rm(root, { recursive: true, force: true }); }
});
