import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function presentation() {
  const files = await Promise.all(["task-state", "execution", "services"].map(name => readFile(`dist/renderer/${name}.js`, "utf8")));
  return runInNewContext(`${files.join("\n")}\n({taskDisplayStatus,taskStopGuidance,taskEffortBreakdown,compactTokenCount,serviceAvailability})`, {
    state: { queue: { activeTaskIds: [] } }, setInterval: () => 0
  });
}
function task(patch: Record<string, unknown> = {}): any {
  return { id: "task", state: "awaiting-input", awaitingReason: "result", roundNumber: 2, autonomyCycle: 3,
    goal: { status: "approved", revision: 4 }, workUnits: [{ id: "done", state: "completed" }], runs: [], ...patch };
}
test("current status never conflates partial closure, approval, process end and verified goal", async () => {
  const v = await presentation();
  const c = { round: 2, cycle: 3, goalRevision: 4, finishedAt: "2026-10-01T00:00:00Z" };
  assert.equal(v.taskDisplayStatus(task({ workClosure: c })).label, "作業終了・残課題あり");
  assert.equal(v.taskDisplayStatus(task({ workClosure: c, state: "running" })).label, "実行中");
  assert.equal(v.taskDisplayStatus(task({ workClosure: c, state: "paused" })).label, "一時停止");
  assert.equal(v.taskDisplayStatus(task({ workClosure: c, state: "failed" })).label, "対応が必要");
  assert.equal(v.taskDisplayStatus(task({ workClosure: c, resumeFromUnitId: "done" })).label, "対応が必要");
  assert.equal(v.taskDisplayStatus(task({ workClosure: c, error: "ユーザ確認が必要です。条件を変更するか。" })).label, "回答が必要");
  assert.equal(v.taskDisplayStatus(task({ workClosure: { ...c, cycle: 2 } })).label, "作業終了・達成未確認");
  assert.equal(v.taskDisplayStatus(task({ autonomyState: "satisfied" })).label, "達成確認済み");
  assert.equal(v.taskDisplayStatus(task({ state: "completed" })).label, "作業終了・達成未確認");
  assert.equal(v.taskDisplayStatus(task({ awaitingReason: "plan" })).label, "計画の承認待ち");
  assert.equal(v.taskDisplayStatus(task({ error: "ユーザ確認が必要です。条件を変更するか。" })).label, "回答が必要");
  assert.equal(v.taskDisplayStatus(task({ state: "failed" })).label, "対応が必要");
});
test("stop guidance distinguishes a user decision, iteration boundary, authentication and unsafe handoff", async () => {
  const v = await presentation();
  const before = task({ state: "paused", error: "Paused by the user." });
  assert.equal(v.taskStopGuidance(before).action, undefined);
  assert.match(v.taskStopGuidance(before).next, /回答は不要/);
  assert.equal(v.taskStopGuidance(task({ error: "修正サイクルの上限です。" })).action, "answer");
  assert.match(v.taskStopGuidance(task({ error: "修正サイクルの上限です。" })).next, /成果・検証.*追加指示/);
  assert.equal(v.taskStopGuidance(task({ error: "UNAUTHENTICATED (code 401)" })).action, "services");
  assert.equal(v.taskStopGuidance(task({ error: "前の担当の停止を確認できないため、次の担当を起動しません。" })).action, "execution");
  assert.equal(before.state, "paused", "a view does not resume or change authorization");
});
test("effort categories union concurrent spans, exclude gaps and retain legacy uncertainty", async () => {
  const v = await presentation();
  const t = task({ workUnits: [{ id: "work", role: "worker" }, { id: "review", role: "reviewer" }], executionMetrics: { intervals: [
    { start: 0, workStart: 10, end: 40, unitId: "work", runId: "a" },
    { start: 20, workStart: 20, end: 60, unitId: "review", runId: "b" },
    { start: 80, workStart: 80, end: 90, unitId: "work", uncertain: true }
  ] } });
  const before = JSON.stringify(t);
  assert.deepEqual(JSON.parse(JSON.stringify(v.taskEffortBreakdown(t))), { "起動・指示待ち": 10, "実作業": 30, "独立レビュー": 20, "区分不明": 10 });
  assert.equal(JSON.stringify(t), before);
  assert.equal(v.compactTokenCount(10000), "1万");
  assert.equal(v.compactTokenCount(45000000), "4,500万");
});
test("task-specific availability is distinct from quota acquisition and another environment", async () => {
  const v = await presentation(), now = Date.now();
  const r = { agentIds: ["codex"], enabled: true, connected: true, cliInstalled: true, state: "available", windows: [], limitSource: "unknown",
    capacityError: "usage HTTP 401", login: { loggedIn: true, checkedAt: new Date(now).toISOString(), detail: "CLI認証済み" } };
  assert.match(v.serviceAvailability(r, task({ allowedAgentIds: ["codex"] }), now).label, /利用可能/);
  assert.equal(v.serviceAvailability(r, task({ allowedAgentIds: ["claude"] }), now).label, "タスク対象外");
  assert.equal(v.serviceAvailability({ ...r, connected: false }, undefined, now).label, "SSH未接続");
  assert.equal(v.serviceAvailability({ ...r, login: undefined }, undefined, now).label, "実行状態は未確認");
  assert.equal(v.serviceAvailability({ ...r, login: { checkSupported: false }, agentIds: ["antigravity"], capacityError: undefined,
    limitSource: "reported-live", capacityUpdatedAt: new Date(now).toISOString(), windows: [{ id: "week", usedPercent: 12, resetAt: new Date(now + 60000).toISOString() }] }, undefined, now).label,
    "使用枠取得済み・実行時確認", "fresh quota is useful evidence, not proof of a model execution");
});
