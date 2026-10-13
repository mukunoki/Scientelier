import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
async function view() {
  return runInNewContext(`${await readFile("dist/renderer/services.js", "utf8")}\n({accountResourceGroups,serviceReadiness,quotaIsFresh,quotaObservationNote,usageAuthenticationFailed,serviceCapacityError,cliAuthenticationFailed})`);
}
const now = Date.parse("2026-09-21T10:00:00Z");
function resource(patch: Record<string, unknown> = {}): any {
  return { providerKey: "openai", serviceKey: "openai", providerLabel: "OpenAI", serviceLabel: "OpenAI", environmentLabel: "このMac",
    state: "available", connected: true, cliInstalled: true, enabled: true, totalTokens: 10, inputTokens: 7, outputTokens: 3, runs: 1,
    windows: [{ id: "week", usedPercent: 20, resetAt: "2026-09-25T00:00:00Z" }], usedPercent: 20, limitSource: "reported-live",
    capacityUpdatedAt: new Date(now).toISOString(), login: { loggedIn: true, checkedAt: new Date(now).toISOString(), detail: "CLI報告" }, ...patch };
}
test("retired account labels never merge environment observations or add quotas", async () => {
  const v = await view(); const local = resource();
  const remote = resource({ providerKey: "openai@remote", environmentLabel: "server", usedPercent: 40, capacityUpdatedAt: "2026-09-21T10:01:00Z", windows: [{ id: "week", usedPercent: 40 }] });
  assert.equal(v.accountResourceGroups([local, remote]).length, 2);
  local.accountLabel = remote.accountLabel = "personal";
  const before = JSON.stringify([local, remote]);
  const grouped = v.accountResourceGroups([local, remote]);
  assert.equal(grouped.length, 2); assert.equal(grouped[0].quota.usedPercent, 20);
  assert.equal(grouped[1].quota.windows[0].usedPercent, 40);
  assert.equal(grouped[0].quota.totalTokens, 10); assert.equal(grouped[1].quota.environmentLabel, "server");
  assert.doesNotMatch(grouped[0].quota.providerLabel, /personal|未区分/);
  assert.equal(JSON.stringify([local, remote]), before);
  assert.equal(v.accountResourceGroups([local, { ...remote, serviceKey: "anthropic" }]).length, 2);
});
test("fresh errors and missing identity are not turned into a successful quota observation", async () => {
  const v = await view();
  const reset = resource({ limitSource: "unknown", windows: [], usedPercent: undefined });
  assert.equal(v.quotaIsFresh(reset, now), false, "an account reset timestamp is not a usage observation");
  assert.match(v.quotaObservationNote(reset), /未取得/);
  const groups = v.accountResourceGroups([resource({ limitSource: "configured", softTokenBudget: 1000, windows: [] })]);
  assert.equal(groups[0].quota.usedPercent, undefined); assert.equal(groups[0].quota.softTokenBudget, undefined);
  const latest = resource({ accountLabel: "a", capacityError: "API failed" });
  const older = resource({ providerKey: "openai@remote", accountLabel: "a", capacityUpdatedAt: "2026-09-21T09:00:00Z" });
  assert.equal(v.accountResourceGroups([latest, older])[0].quota.capacityError, "API failed");
});
test("execution readiness and quota freshness are separate; auth/connection and known exhaustion block readiness", async () => {
  const { serviceReadiness: status } = await view();
  assert.equal(status(resource(), undefined, now).tone, "ready");
  for (const patch of [
    { login: undefined }, { login: { loggedIn: false, checkedAt: new Date(now).toISOString(), detail: "未ログイン" } },
    { connected: false }, { cliInstalled: false }, { enabled: false }, { state: "draining" }, { ordinaryUsageAllowed: false },
    { cooldownUntil: "2026-09-22T00:00:00Z" }, { usedPercent: 100 },
    { login: { loggedIn: true, checkedAt: "invalid" } }
  ]) assert.notEqual(status(resource(patch), undefined, now).tone, "ready", JSON.stringify(patch));
  for (const patch of [{ capacityUpdatedAt: "invalid" }, { limitSource: "unknown", windows: [], usedPercent: undefined }])
    assert.equal(status(resource(patch), undefined, now).tone, "ready", "missing quota is not missing CLI auth");
  assert.notEqual(status(resource({ connected: false }), resource(), now).tone, "ready", "shared quota cannot establish SSH readiness");
  assert.notEqual(status(resource({ login: undefined }), resource(), now).tone, "ready", "shared quota cannot establish authentication");
});

test("quota failures never require CLI relogin or hide known exhaustion", async () => {
  const v = await view();
  for (const capacityError of ["HTTP 401", "Claude使用量APIの認証情報は期限切れです。", "遠隔CLIの使用量認証が拒否されました。"] ) {
    const r = resource({ capacityError });
    assert.equal(v.usageAuthenticationFailed(r), true);
    assert.equal(v.serviceReadiness(r, undefined, now).tone, "ready");
    assert.equal(v.cliAuthenticationFailed(r), false);
    assert.equal(v.quotaIsFresh(r, now), false);
    assert.match(v.serviceCapacityError(r), /CLIが使えている場合は再ログイン不要/);
    assert.equal(v.serviceReadiness({ ...r, cooldownUntil: "2026-09-22T00:00:00Z" }, undefined, now).label, "使用制限中");
    assert.equal(v.serviceReadiness({ ...r, usedPercent: 100 }, undefined, now).label, "使用枠不足");
    assert.equal(r.login.loggedIn, true);
  }
  assert.equal(v.usageAuthenticationFailed(resource({ capacityError: "HTTP 429" })), false);
  assert.doesNotMatch(v.serviceCapacityError(resource({ capacityError: 'Resourcesの「Claudeログイン管理」で確認・再ログインしてください。' })), /Claudeログイン管理/);
  const cliFailure = resource({ login: { loggedIn: false, checkedAt: new Date(now).toISOString(), detail: "未ログイン" } });
  assert.equal(v.cliAuthenticationFailed(cliFailure), true);
  assert.equal(v.serviceReadiness(cliFailure, undefined, now).tone, "blocked", "fresh quota cannot authenticate the CLI");
  assert.equal(v.cliAuthenticationFailed(resource({ login: { loggedIn: true, blocked: true } })), true);
  assert.match(v.serviceCapacityError(resource({ capacityError: "Claude使用量APIの認証が拒否されました（HTTP 403）。環境変数CLAUDE_CODE_OAUTH_TOKENが保存済みログインより優先されています。" })), /CLAUDE_CODE_OAUTH_TOKEN/);
});

test("Ollama connection is explicit, quota-independent and never certifies cloud login", async () => {
  const v = await view();
  const ollama = resource({ providerKey: "ollama-cloud", serviceKey: "ollama-cloud", agentIds: ["opencode"], windows: [], usedPercent: undefined,
    limitSource: "unknown", capacityError: "Ollama UsageのWebログインが必要です。",
    login: { runtimeReady: true, checkSupported: false, checkedAt: new Date(now).toISOString(), detail: "接続済み" } });
  assert.equal(v.serviceReadiness(ollama, undefined, now).label, "Ollama接続済み");
  assert.equal(v.serviceReadiness(ollama, undefined, now).tone, "observed");
  assert.equal(v.cliAuthenticationFailed(ollama), false); assert.equal(ollama.login.loggedIn, undefined);
  assert.equal(v.quotaIsFresh(ollama, now), false);
  assert.match(v.serviceCapacityError(ollama), /モデル実行には不要/);
  assert.equal(v.serviceReadiness({ ...ollama, login: { ...ollama.login, runtimeReady: false } }, undefined, now).label, "Ollama未接続");
  assert.notEqual(v.serviceReadiness({ ...ollama, login: { ...ollama.login, checkedAt: "invalid" } }, undefined, now).label, "Ollama接続済み");
  assert.notEqual(v.serviceReadiness({ ...ollama, login: { ...ollama.login, checkedAt: "2026-09-21T09:00:00Z" } }, undefined, now).label, "Ollama接続済み");
});

test("Antigravity reports its observed quota without claiming login verification or requesting another login", async () => {
  const { serviceReadiness: status } = await view();
  const agy = resource({ agentIds: ["antigravity"], login: { checkSupported: false, checkedAt: new Date(now).toISOString(), detail: "自動判定未対応" } });
  assert.equal(status(agy, undefined, now).label, "使用枠取得済み");
  assert.equal(status(agy, undefined, now).tone, "observed");
  assert.equal(status({ ...agy, login: undefined }, undefined, now).label, "使用枠取得済み");
  assert.equal(status({ ...agy, capacityUpdatedAt: "2026-09-21T09:00:00Z" }, undefined, now).label, "使用枠は前回値");
  const empty = { ...agy, windows: [], usedPercent: undefined, limitSource: "unknown" };
  assert.equal(status(empty, agy, now).label, "使用枠未取得", "another environment's quota does not verify this CLI");
  assert.equal(status({ ...agy, connected: false }, undefined, now).label, "SSH未接続");
  assert.equal(status({ ...agy, login: { ...agy.login, loggedIn: false, detail: "認証失敗" } }, undefined, now).label, "認証・設定の確認が必要");
  assert.equal(status({ ...agy, cooldownUntil: "2026-09-22T00:00:00Z" }, undefined, now).label, "使用制限中");
  assert.equal(status({ ...agy, capacityError: "取得失敗" }, undefined, now).label, "使用枠の取得を確認");
});
