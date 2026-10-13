import test from "node:test";
import assert from "node:assert/strict";
import { reportRecovery, reportReplanPatch, reportPrerequisiteProblems } from "./report-recovery";
import { applyExecutionPlan, MAX_PLAN_REVISIONS } from "./execution-plan";
import { nextPendingUnit } from "./orchestration";
import type { TaskRecord, WorkUnit } from "./types";

function fixture(concerns = ["全6文献の一次資料・異種AI二重照合が未完了"]): TaskRecord {
  const unit = (id: string, role: WorkUnit["role"], state: WorkUnit["state"], dependsOn: string[]): WorkUnit => ({ id, role, title: id, state, dependsOn, mode: role === "reviewer" ? "read" : "write", attemptedAgentIds: [], instructions: "Keep evidence" });
  return { id: "t", title: "t", prompt: "p", cwd: "/tmp", strategy: "balanced", workflowMode: "primary", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, state: "paused", createdAt: "", updatedAt: "", output: "",
    goal: { status: "approved", revision: 1, updatedAt: "", objective: "Investigate", deliverables: ["PDF"], criteria: [{ id: "c", description: "verified", verification: "check", required: true }], constraints: ["No new experiments"], outOfScope: [], questions: [] },
    autonomy: { enabled: true, maxCycles: 3 }, autonomyCycle: 1, roundNumber: 1, resumeFromUnitId: "report",
    report: { state: "failed", texPath: "/tmp/report.tex", pdfPath: "/tmp/report.pdf" },
    workUnits: [{ ...unit("worker", "worker", "completed", []), primary: true }, { ...unit("report", "reporter", "pending", ["worker"]), output: `<editorial-check>${JSON.stringify({ revision: "rules", status: "blocked", summary: "PDF rebuilt", sources: ["/tmp/report.tex"], concerns })}</editorial-check>` }, unit("review1", "reviewer", "pending", ["report"]), unit("review2", "reviewer", "pending", ["review1"])],
    runs: [{ id: "run", workUnitId: "report", agentId: "codex", providerKey: "openai", role: "reporter", state: "completed", startedAt: "", output: "", goalRevision: 1, finishingSkill: { rules: "rules", revision: "rules", capturedAt: "" } }] };
}

test("legacy failure receipts explain source prerequisites, not a TeX build failure", () => {
  const t = fixture(), issue = reportRecovery(t)!;
  assert.equal(issue.kind, "prerequisite"); assert.equal(issue.canReplan, true); assert.equal(issue.pdfAvailable, false);
  t.runs[0].reportArtifactCheck = { available: true, checkedAt: "now" };
  assert.equal(reportRecovery(t)!.pdfAvailable, true);
  assert.equal(t.report!.state, "failed", "a valid PDF never certifies the unresolved reference checks");
  t.runs[0].finishingSkill!.revision = "changed";
  assert.equal(reportRecovery(t), undefined);
  t.runs[0].finishingSkill!.revision = "rules"; t.runs[0].goalRevision = 2;
  assert.equal(reportRecovery(t), undefined);
});

test("partial document failure remains recoverable when the main report is ready and the blocked receipt was saved", () => {
  const t = fixture(["paper/main.texは未執筆", "xkeyval.sty not found"]);
  t.report = { state: "ready", documents: { paper: { state: "failed", error: "PDF missing" } } };
  t.runs[0].finishingCheck = JSON.parse(t.workUnits[1].output!.slice("<editorial-check>".length, -"</editorial-check>".length));
  assert.equal(reportRecovery(t)!.kind, "environment");
  t.report.documents!.paper!.state = "ready";
  assert.equal(reportRecovery(t), undefined);
  t.report.state = "draft"; t.report.documents!.paper!.state = "draft";
  assert.equal(reportRecovery(t), undefined, "drafts are not failures");
});

test("bounded closure never reopens the same upstream scientific repair loop", () => {
  const t = fixture();
  t.workClosure = { round: 1, cycle: 1, goalRevision: 1, startedAt: "now", reason: "repair cap", issues: ["registration unverified"] };
  assert.equal(reportRecovery(t)!.canReplan, false);
  assert.equal(reportReplanPatch(t, reportRecovery(t)!, true), undefined);
});

test("archived writing exposes normal Resume, not a disabled exhausted prerequisite replan", () => {
  const t = fixture();
  t.workClosure = { round: 1, cycle: 1, goalRevision: 1, startedAt: "now", reason: "cap", issues: ["protocol missing"] };
  t.report = { state: "ready", documents: { paper: { state: "failed", error: "ENOENT: access '/long/local/mirror/path/paper/main.pdf'" } } };
  t.retiredWorkUnits = [{ id: "paper", title: "論文執筆", role: "worker", primary: true, planPhase: true, researchStage: "paper", mode: "write", state: "cancelled",
    dependsOn: ["worker"], attemptedAgentIds: [], instructions: "Write existing evidence",
    error: "再作業上限のため未実施。部分成果の報告・独立レビューへ移行。" }];
  const issue = reportRecovery(t)!;
  assert.equal(issue.kind, "document");
  assert.equal(issue.resumeStage, "paper");
  assert.match(issue.summary, /「再開」/);
  assert.equal(issue.pdfAvailable, true);
  assert.equal(issue.canReplan, false);
  assert.equal(issue.unavailableReason, undefined);
  assert.deepEqual(issue.concerns, ["論文PDF（paper/main.pdf）がまだ作成されていません。"]);
});

test("completed editorial receipts with unresolved prerequisites still route to the owner, never release",()=>{
  const t=fixture();
  t.workUnits[1].output='<editorial-check>'+JSON.stringify({revision:"rules",status:"completed",summary:"PDF and all pages checked",sources:["/tmp/report.tex"],concerns:[],prerequisites:["一次資料の刊行本文は取得不能。文献照合は未確認。"]})+'</editorial-check>';
  const issue=reportRecovery(t)!;assert.equal(issue.kind,"prerequisite");assert.equal(issue.concerns.length,1);
  t.runs[0].finishingCheck=JSON.parse(t.workUnits[1].output.slice('<editorial-check>'.length,-'</editorial-check>'.length));
  assert.equal(reportRecovery(t)!.kind,"prerequisite","a saved valid editorial receipt must not hide unmet prerequisites");
  const patch=reportReplanPatch(t,issue,true)!;assert.ok(patch);
  assert.equal(patch.workUnits!.find(u=>u.id==="review1")!.state,"pending");
  assert.equal(patch.workUnits!.find(u=>u.id==="report")!.state,"pending");
  assert.deepEqual(reportPrerequisiteProblems({blockers:[
    {id:"report-references",owner:"reporter",title:"文献",reason:"一次資料未取得"},
    {id:"report-numbers",owner:"worker",title:"実験",reason:"生データ不足"},
    {id:"report-document",owner:"reporter",title:"PDF",reason:"図のはみ出し"}]} as any),["文献: 一次資料未取得","実験: 生データ不足"]);
});

test("recovery inserts owner planning before report and preserves earlier work and final reviews", () => {
  const t = fixture(), original = structuredClone(t);
  const patch = reportReplanPatch(t, reportRecovery(t)!, true)!;
  assert.ok(patch); Object.assign(t, patch);
  assert.deepEqual(t.workUnits[0], original.workUnits[0]); assert.deepEqual(t.goal, original.goal); assert.deepEqual(t.runs, original.runs);
  const owner = t.workUnits.find(u => u.planPhase)!;
  assert.equal(nextPendingUnit(t)?.id, owner.id);
  assert.equal(t.workUnits.filter(u => u.role === "reviewer").length, 2);
  assert.match(owner.instructions, /requirements.independentFrom/); assert.match(owner.instructions, /Never waive/);
  owner.state = "completed";
  Object.assign(t, applyExecutionPlan(t, owner, { summary: "retrieve and check", reason: "source gaps", primaryWork: "Integrate verified bibliography", acceptance: "check evidence", criterionIds: ["c"], estimatedTokens: 1000, estimatedMinutes: 10, escalation: "specific missing source", tasks: [] }));
  const integration = t.workUnits.find(u => u.primary && !u.planPhase && u.state === "pending")!;
  assert.equal(nextPendingUnit(t)?.id, integration.id);
  assert.ok(t.workUnits.find(u => u.id === "report")!.dependsOn.includes(integration.id));
  integration.state = "completed";
  assert.equal(nextPendingUnit(t)?.id, "report");
  assert.equal(t.report?.state, "draft");
});

test("automatic retries respect autonomy, cycle limits and the two-replan bound", () => {
  const t = fixture(); t.autonomy!.enabled = false;
  assert.equal(reportReplanPatch(t, reportRecovery(t)!, true), undefined);
  assert.ok(reportReplanPatch(t, reportRecovery(t)!));
  t.autonomy!.enabled = true; t.autonomyCycle = 3;
  assert.equal(reportReplanPatch(t, reportRecovery(t)!, true), undefined);
  t.reportRepairs = Array.from({ length: 2 }, (_, i) => ({ round: 1, goalRevision: 1, reporterId: "report", ownerId: `old-${i}`, reason: "same source unavailable", at: "" }));
  assert.equal(reportRecovery(t)!.canReplan, false);
  assert.throws(() => reportReplanPatch(t, reportRecovery(t)!), /2回/);
  t.reportRepairs = []; t.executionPlans = Array.from({ length: MAX_PLAN_REVISIONS }, () => ({ round: 1, goalRevision: 1 } as any));
  assert.match(reportRecovery(t)!.unavailableReason!, /上限/);
});

test("authentication, missing tools, user decisions and malformed receipts do not trigger replanning", () => {
  for (const [concern, kind] of [["latexmk: command not found", "environment"], ["ユーザーの承認が必要です。文献の条件変更", "user-input"], ["図がはみ出しています", "document"]]) {
    const t = fixture([concern]); const issue = reportRecovery(t)!;
    assert.equal(issue.kind, kind); assert.equal(reportReplanPatch(t, issue, true), undefined);
  }
  const t = fixture(); t.workUnits[1].output = t.workUnits[1].output!.repeat(2);
  assert.equal(reportRecovery(t), undefined);
});

test("recovery never bypasses active/retirement barriers, pending input or prerequisite dependencies", () => {
  for (const alter of [
    (t: TaskRecord) => { t.runs[0].terminationUnconfirmed = true; },
    (t: TaskRecord) => { t.runs[0].state = "running"; },
    (t: TaskRecord) => { t.workUnits[0].state = "pending"; },
    (t: TaskRecord) => { t.pendingFollowup = { kind: "continue", instruction: "new decision", assignments: {}, pauseAfterPlan: false }; },
    (t: TaskRecord) => { t.goalRevisionPending = true; }
  ]) { const t = fixture(); alter(t); const issue = reportRecovery(t)!; assert.equal(issue.canReplan, false); assert.throws(() => reportReplanPatch(t, issue)); }
});
