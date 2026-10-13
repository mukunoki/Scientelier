import test from "node:test";
import assert from "node:assert/strict";
import { resumePatch, resumableUnit, recoveryContext, environmentRecoveryUnit, environmentResumePatch, recoveryDiagnosticPassed, pauseWorkflowPatch, repairPausedCrossReviews, USER_PAUSE_MESSAGE } from "./recovery";
import { createStandardWorkflow, nextPendingUnit } from "./orchestration";
import { orderAutonomousUnits } from "./autonomy";
import { timeGuidance } from "./work-guidance";
import type { TaskRecord } from "./types";
import { workClosurePatch } from "./work-closure";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

test("legacy exhausted worker can resume into partial finishing without losing evidence", () => {
  const t={state:"awaiting-input",awaitingReason:"result",error:"残作業の差戻し回数上限です。long details",goal:{status:"approved",revision:1},
    autonomy:{enabled:true,maxCycles:3},workUnits:[{id:"w",role:"worker",state:"completed",primary:true,checkpointHandled:true,workAttempt:3,dependsOn:[]},
      {id:"p",role:"reporter",state:"pending",dependsOn:["w"]},{id:"r",role:"reviewer",state:"pending",dependsOn:["p"]}],runs:[]} as unknown as TaskRecord;
  assert.equal(resumableUnit(t)?.id,"p");
  const closure=workClosurePatch(t,t.workUnits[0],{status:"needs-work",summary:"Unresolved",remainingWork:"Independent evidence",evidence:[],estimatedRemainingMinutes:10});
  assert.ok(closure);
  const resumed={...t,...resumePatch(t),...closure};
  assert.equal(resumed.workUnits[0].state,"completed"); assert.equal(resumed.workUnits[1].state,"pending");
  assert.equal(resumed.error,undefined); assert.ok(resumed.workClosure);
  assert.equal(resumableUnit({...t,error:"ユーザ確認が必要です。"}),undefined);
});
import { join } from "node:path";
import { JsonTaskStore } from "./task-store";

function task(): TaskRecord {
  const workUnits = orderAutonomousUnits(createStandardWorkflow());
  workUnits[0].state = workUnits[1].state = "completed"; workUnits[2].state = "failed";
  return { id: "resume", title: "Resume", prompt: "Build a report", cwd: "/tmp", strategy: "balanced", allowedAgentIds: ["claude"], modelOverrides: {},
    workUnits, runs: [], state: "failed", output: "existing output", createdAt: "", updatedAt: "", roundNumber: 1, autonomy: { enabled: true, maxCycles: 3, targetMinutes: 1 },
    report: { state: "failed", texPath: "/tmp/report.tex", pdfPath: "/tmp/report.pdf" } };
}
function environmentTask(): TaskRecord {
  const t = task();
  t.remote = { id: "remote", name: "Remote", host: "example.invalid", cwd: "/work", nodeCommand: "node", startup: "", instructions: "", texCommand: "latexmk" };
  t.goal = { status: "approved" } as TaskRecord["goal"];
  t.state = "awaiting-input"; t.awaitingReason = "result"; t.autonomyState = "needs-input";
  t.report = { ...t.report, state: "draft" };
  t.error = "bwrap: setting up uid map: Permission denied";
  const base = t.workUnits[1];
  const output = (status: string) => `<work-check>${JSON.stringify({ status, summary: t.error })}</work-check>`;
  t.workUnits = [
    { ...base, id: "plan", planPhase: true, dependsOn: [], state: "completed", output: output("ready") },
    { ...base, id: "read", dependsOn: ["plan"], state: "completed", output: output("needs-work") },
    { ...base, id: "primary", primary: true, dependsOn: ["plan", "read"], state: "completed", checkpointHandled: true, output: output("ask-user") },
    { ...t.workUnits[2], id: "report", dependsOn: ["primary"], state: "pending" },
    { ...t.workUnits[3], id: "review1", dependsOn: ["report"], state: "completed", output: "stale" },
    { ...t.workUnits[3], id: "review2", dependsOn: ["review1"], state: "pending" }
  ];
  return t;
}
test("parallel review pause retains finished peers and resumes the cancelled peer with saved followup intact", () => {
  const t = task();
  const base = t.workUnits[3];
  t.workUnits = [
    { ...base, id: "done", state: "completed", dependsOn: [], crossReview: { wave: 1, providerKey: "openai", sourceUnitIds: [] }, output: "retained review" },
    { ...base, id: "stopped", state: "cancelled", dependsOn: [], attemptedAgentIds: ["opencode"], crossReview: { wave: 1, providerKey: "ollama", sourceUnitIds: [] } },
    { ...base, id: "cross", state: "pending", dependsOn: ["done", "stopped"], crossReview: { wave: 2, providerKey: "openai", sourceUnitIds: ["stopped"] } }
  ];
  t.runs = [{ id: "r", workUnitId: "stopped", role: "reviewer", agentId: "opencode", providerKey: "ollama", state: "cancelled", output: "", startedAt: "now" }];
  t.pendingFollowup = { instruction: "Simplify later", kind: "continue", assignments: {}, pauseAfterPlan: false };
  const paused = { ...t, ...pauseWorkflowPatch(t, "done") };
  assert.equal(paused.resumeFromUnitId, "stopped");
  assert.equal(paused.workUnits[0], t.workUnits[0]);
  assert.deepEqual(paused.workUnits[1].attemptedAgentIds, []);
  const resumed = { ...paused, ...resumePatch(paused) };
  assert.equal(resumed.pendingFollowup, t.pendingFollowup);
  assert.equal(resumed.workUnits[0], t.workUnits[0]);
  assert.deepEqual(resumed.workUnits.map(u => u.state), ["completed", "pending", "pending"]);
  const allDone = { ...t, workUnits: t.workUnits.map(u => ({ ...u, state: "completed" as const })) };
  const aggregationPause = { ...allDone, ...pauseWorkflowPatch(allDone, "cross") };
  assert.ok(resumePatch(aggregationPause).workUnits!.every(u => u.state === "completed"));
  assert.equal(aggregationPause.error, USER_PAUSE_MESSAGE);
  const failed = { ...aggregationPause, error: "evidence changed" };
  assert.equal(resumePatch(failed).workUnits!.at(-1)!.state, "pending", "real revalidation failures must still retry");
});
test("legacy pause repair requires the exact completed run and retained result, never an inferred pass", () => {
  const t = task(); const base = t.workUnits[3];
  const structuredResult = '<goal-evaluation>{"fixture":"still subject to normal validation"}</goal-evaluation>';
  t.state = "paused"; t.error = "Paused by the user. Resume the workflow to continue."; t.resumeFromUnitId = "done";
  t.workUnits = [
    { ...base, id: "done", state: "pending", dependsOn: [], startedAt: "2026-09-23T00:00:00.500Z", output: `summary\n${structuredResult}`, error: "Paused by the user. Resume the workflow to continue this step.", crossReview: { wave: 1, providerKey: "openai", sourceUnitIds: [] } },
    { ...base, id: "stopped", state: "pending", dependsOn: [], crossReview: { wave: 1, providerKey: "ollama", sourceUnitIds: [] } }
  ];
  t.runs = [{ id: "r", workUnitId: "done", role: "reviewer", agentId: "codex", providerKey: "openai", state: "completed", output: "", structuredResult, startedAt: "2026-09-23T00:00:00.000Z", completedAt: "2026-09-23T00:01:00.000Z" }];
  const fixed = repairPausedCrossReviews(t);
  assert.equal(fixed.workUnits[0].state, "completed"); assert.equal(fixed.resumeFromUnitId, "stopped");
  assert.equal(fixed.evaluations, t.evaluations); assert.equal(fixed.runs, t.runs);
  assert.equal(t.workUnits[0].state, "pending", "repair does not mutate the input");
  assert.equal(resumePatch(t).workUnits![0].state, "completed");
  assert.equal(repairPausedCrossReviews(fixed), fixed, "migration is idempotent");
  for (const patch of [{ state: "cancelled" }, { terminationUnconfirmed: true }, { startedAt: "other" }, { structuredResult: undefined }, { structuredResult: "different" }, { goalRevision: 99 }]) {
    const invalid = { ...t, runs: [{ ...t.runs[0], ...patch }] } as TaskRecord;
    assert.equal(repairPausedCrossReviews(invalid).workUnits[0].state, "pending");
  }
});
test("remote environment recovery retries the earliest unsuccessful response, retaining plan and goal", () => {
  const t = environmentTask(); const before = JSON.stringify(t);
  assert.equal(resumableUnit(t), undefined);
  assert.equal(environmentRecoveryUnit(t)?.id, "read");
  const patch = environmentResumePatch(t); const resumed = { ...t, ...patch };
  assert.equal(resumed.goal, t.goal); assert.equal(resumed.remote, t.remote); assert.equal(resumed.runs, t.runs);
  assert.equal(resumed.workUnits[0], t.workUnits[0]);
  assert.deepEqual(resumed.workUnits.map(u => u.state), ["completed", "pending", "pending", "pending", "pending", "pending"]);
  assert.ok(resumed.workUnits.slice(1).every(u => !u.output && !u.checkpointHandled));
  assert.equal(nextPendingUnit(resumed)?.id, "read");
  assert.equal(JSON.stringify(t), before);
});
test("remote recovery never overrides unrelated decisions, unsent followups, draft goals or live work", () => {
  const t = environmentTask();
  for (const override of [{ error: "Which dataset should I use?" }, { remote: undefined }, { state: "running" }, { state: "completed" }, { goal: { status: "draft" } }, { pendingFollowup: {} }]) {
    const invalid = { ...t, ...override } as TaskRecord;
    assert.equal(environmentRecoveryUnit(invalid), undefined);
    assert.throws(() => environmentResumePatch(invalid));
  }
  const transport = { ...t, state: "paused" as const, resumeFromUnitId: "report", workUnits: t.workUnits.slice(3) };
  assert.equal(environmentRecoveryUnit(transport)?.id, "report");
});
test("recovery requires actual sandbox probes, not permissive kernel settings or stale partial diagnostics", () => {
  const checks = ["通常コマンド（/usr/bin/true）", "Codexのバージョン", "Codex 読み取り専用サンドボックス", "Codex 作業用サンドボックス（実行するのは/usr/bin/trueだけ）"].map(name => ({ name, ok: true, detail: "ok" }));
  const diagnostic = { platform: "linux", kernel: "test", cwd: "/work", checks };
  assert.equal(recoveryDiagnosticPassed(diagnostic, true), true);
  assert.equal(recoveryDiagnosticPassed({ ...diagnostic, checks: checks.slice(0, 2) }, true), false);
  assert.equal(recoveryDiagnosticPassed({ ...diagnostic, checks: checks.map((c, i) => ({ ...c, ok: i !== 3 })) }, true), false);
  assert.equal(recoveryDiagnosticPassed({ ...diagnostic, checks: [...checks, { name: "unshare", ok: false, detail: "restricted" }] }, true), true);
  assert.equal(recoveryDiagnosticPassed({ ...diagnostic, checks: [checks[0], { name: "CLIのバージョン", ok: true, detail: "claude" }] }, false), true);
  const full = { ...diagnostic, codexPermissions: "full-access" as const, checks: checks.slice(0, 2) };
  assert.equal(recoveryDiagnosticPassed(full, true, true), true);
  assert.equal(recoveryDiagnosticPassed(full, true), false);
  assert.equal(recoveryDiagnosticPassed(diagnostic, true, true), false);
  assert.equal(recoveryDiagnosticPassed({ ...full, checks: [] }, true, true), false);
});
test("resume preserves prior units and invalidates only retried work and dependent results", () => {
  const t = task(); t.workUnits[3].state = "completed";
  const patch = resumePatch(t);
  assert.equal(resumableUnit(t)?.role, "reporter");
  assert.deepEqual(patch.workUnits?.map(u => u.state), ["completed", "completed", "pending", "pending"]);
  assert.equal(patch.workUnits?.[0], t.workUnits[0]);
  assert.equal(patch.workUnits?.[1], t.workUnits[1]);
  assert.equal(patch.report?.texPath, t.report!.texPath);
  assert.equal(patch.report?.state, "draft"); assert.equal(patch.resumeCount, 1);
  assert.equal(nextPendingUnit({ ...t, ...patch })?.role, "reporter");
});
test("valid user-decision stops cannot be bypassed with resume", () => {
  const t = { ...task(), state: "awaiting-input" as const, awaitingReason: "result" as const, autonomyState: "needs-input" as const, report: { state: "draft" as const } };
  assert.equal(resumableUnit(t), undefined); assert.throws(() => resumePatch(t));
  assert.equal(resumableUnit({ ...task(), state: "completed" }), undefined);
  assert.equal(resumableUnit({ ...task(), state: "running", resumeFromUnitId: task().workUnits[2].id }), undefined);
});
test("old stopped rounds are retained separately while the resumed round can receive its final history", () => {
  const t = task();
  t.history = [{ number: 1, kind: "initial", instruction: "original", state: "failed", workUnits: t.workUnits, report: t.report, finishedAt: new Date().toISOString() }];
  const patch = resumePatch(t);
  assert.equal(patch.history!.length, 0); assert.equal(patch.interruptedHistory!.length, 1);
  assert.equal(patch.interruptedHistory![0].report?.texPath, "/tmp/report.tex");
});
test("elapsed soft target never removes the final report or reviewer and resumed prompts retain log references", () => {
  const t = task(); const unit = t.workUnits[2];
  t.runs = [{ id: "old", workUnitId: unit.id, role: "reporter", agentId: "claude", providerKey: "anthropic", state: "cancelled", output: "partial", logPath: "/tmp/prior.log", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:40:00Z" }];
  const resumed = { ...t, ...resumePatch(t) };
  assert.match(timeGuidance(resumed), /Active work so far: 40.0 minutes/);
  assert.match(timeGuidance(resumed), /run BOTH even after the target has elapsed/);
  assert.equal(nextPendingUnit(resumed)?.role, "reporter");
  resumed.workUnits[2].state = "completed";
  assert.equal(nextPendingUnit(resumed)?.role, "reviewer");
  assert.match(recoveryContext(resumed, unit), /\/tmp\/prior.log/);
  assert.match(recoveryContext(resumed, unit), /SAME workflow round/);
});
test("app restart retains completed steps and restores a resumable interrupted reporter without execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "resume-store-test-"));
  try {
    const store = new JsonTaskStore(join(dir, "tasks.json")); await store.init();
    const saved = await store.create({ title: "Resume", prompt: "Report", cwd: dir, strategy: "balanced", allowedAgentIds: ["claude"], modelOverrides: {} });
    const t = task(); t.workUnits[2].state = "running";
    await store.update(saved.id, { state: "reporting", workUnits: t.workUnits, runs: [{ id: "interrupted", workUnitId: t.workUnits[2].id, role: "reporter", agentId: "claude", providerKey: "anthropic", state: "running", output: "partial", startedAt: new Date().toISOString() }] });
    const reloaded = new JsonTaskStore(join(dir, "tasks.json")); await reloaded.init();
    const interrupted = reloaded.get(saved.id)!;
    assert.equal(interrupted.state, "blocked");
    assert.equal(resumableUnit(interrupted)?.id, t.workUnits[2].id);
    assert.equal(interrupted.runs[0].state, "cancelled");
    assert.deepEqual(resumePatch(interrupted).workUnits?.map(u => u.state), ["completed", "completed", "pending", "pending"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
