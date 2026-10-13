import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isOllamaLoginNavigation, isOllamaUsagePage, parseOllamaUsagePage } from "./ollama-usage";
import { JsonUsageTracker } from "./usage-tracker";

test("Ollama website navigation stays HTTPS with explicit origins; usage never reads auth pages", () => {
  for (const url of ["https://ollama.com/settings", "https://ollama.com/settings/"]) assert.equal(isOllamaUsagePage(url), true);
  for (const url of ["https://signin.ollama.com", "https://api.workos.com/user_management/authorize", "https://accounts.google.com", "https://github.com/login"]) {
    assert.equal(isOllamaLoginNavigation(url), true); assert.equal(isOllamaUsagePage(url), false);
  }
  for (const url of ["http://ollama.com/settings", "https://ollama.com.evil.test/settings", "https://ollama.com@evil.test", "file:///tmp/private", "javascript:alert(1)", "https://ollama.com:444/settings"]) assert.equal(isOllamaLoginNavigation(url), false);
  assert.equal(isOllamaUsagePage("https://ollama.com/settings/keys"), false);
});

test("Ollama usage distinguishes used, remaining, zero, monetary credit and reset precision", () => {
  const data = parseOllamaUsagePage({ blocks: [
    { label: "Session usage", text: "Session usage\n0% used\nResets in 2 hours", reset: "2026-09-16T15:00:00+09:00" },
    { label: "Weekly usage", text: "Weekly usage\n30% remaining\nResets Friday" },
    { label: "Monthly usage", text: "Monthly usage\n$12.50 / $60.00\nResets October 1", reset: "2026-10-01" },
    { label: "Extra balance", text: "Extra balance\n$8.20" },
    { label: "Account", text: "PRIVATE" }
  ] });
  assert.deepEqual(data.windows?.map(w => w.usedPercent), [0, 70, 12.5 / 60 * 100]);
  assert.equal(data.windows?.[0].resetAt, "2026-09-16T06:00:00.000Z");
  assert.equal(data.windows?.[2].resetAt, undefined, "No timezone guessing");
  assert.equal(data.windows?.[2].resetText, "Resets October 1");
  assert.equal(data.creditBalance, "extra balance: $8.20");
  assert.equal(data.replaceQuota, true); assert.equal(data.limited, false);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE/);
});

test("Ollama usage never invents a quota from unknown markup or model share percentages", () => {
  for (const text of ["Sign in", "Model A 40% Model B 60%", "101% used", "NaN% used", "$50 / $0", "PRIVATE"]) {
    assert.throws(() => parseOllamaUsagePage({ blocks: [{ label: "Session usage", text }] }), /読み取れません/);
  }
  assert.throws(() => parseOllamaUsagePage({ blocks: [] }), /読み取れません/);
  assert.equal(parseOllamaUsagePage({ blocks: [{ label: "Included usage", text: "$45 / $60 remaining" }] }).usedPercent, 25);
  assert.equal(parseOllamaUsagePage({ blocks: [{ label: "Weekly usage", text: "Weekly usage", percent: 0 }] }).usedPercent, 0);
});

test("Ollama full snapshots remove old plan windows; failures preserve last successful observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-ollama-usage-"));
  try {
    const tracker = new JsonUsageTracker(join(dir, "usage.json")); await tracker.init();
    await tracker.record("ollama-cloud", parseOllamaUsagePage({ blocks: [{ label: "Weekly", text: "90% used", reset: "2026-09-20T00:00:00Z" }] }));
    await tracker.record("ollama-cloud", parseOllamaUsagePage({ blocks: [{ label: "Monthly usage", text: "$3 / $60" }] }));
    const before = tracker.getRateLimits()[0];
    assert.equal(before.windows?.length, 1); assert.equal(before.windows?.[0].id, "ollama-monthly");
    assert.equal(before.usedPercent, 5);
    await tracker.recordRefreshFailure("ollama-cloud", "Webログインが必要です。");
    assert.equal(tracker.getRateLimits()[0].updatedAt, before.updatedAt);
    assert.equal(tracker.getRateLimits()[0].usedPercent, 5);
    await tracker.record("ollama-cloud", parseOllamaUsagePage({ blocks: [{ label: "Credit balance", text: "$0" }] }));
    const balance = tracker.getRateLimits()[0];
    assert.equal(balance.usedPercent, undefined); assert.deepEqual(balance.windows, []);
    assert.equal(balance.refreshError, undefined); assert.equal(balance.creditBalance, "credit balance: $0.00");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
