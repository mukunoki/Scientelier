import test from "node:test";
import assert from "node:assert/strict";
import { currentWorkClosure, legacyWorkClosureCheckpoint, closureHandoffCheckpoint, workClosurePatch, workClosureHandoffPatch, workClosurePrompt, restoreClosureWriting } from "./work-closure";
import { nextPendingUnit } from "./orchestration";
import { resumePatch } from "./recovery";
import type { TaskRecord, WorkUnit } from "./types";
import type { WorkCheck } from "./work-guidance";

const worker = {id:"w",role:"worker",state:"completed",primary:true,workAttempt:2} as WorkUnit;
function fixture(): TaskRecord { return {goal:{status:"approved",revision:1},autonomy:{enabled:true,maxCycles:3},runs:[],
  workUnits:[worker,{id:"p",role:"reporter",state:"pending"},{id:"r",role:"reviewer",state:"pending"}]} as unknown as TaskRecord; }
const check: WorkCheck = {status:"needs-work",summary:"Tests unchanged",remainingWork:"Missing independent evidence",estimatedRemainingMinutes:12,evidence:[]};
test("legacy closure admission is separate from interrupted-unit resume and cannot admit decisions or completed rounds",()=>{
  const task={...fixture(),state:"awaiting-input" as const,awaitingReason:"result" as const,error:"残作業の差戻し回数上限です。"};
  assert.equal(legacyWorkClosureCheckpoint(task)?.id,worker.id);
  assert.equal(legacyWorkClosureCheckpoint({...task,error:"ユーザ確認が必要です。"}),undefined);
  assert.equal(legacyWorkClosureCheckpoint({...task,state:"running"}),undefined);
  assert.equal(legacyWorkClosureCheckpoint({...task,goal:{...task.goal!,status:"draft"}}),undefined);
  assert.equal(legacyWorkClosureCheckpoint({...task,...workClosurePatch(task,worker,check)}),undefined);
});
test("reserve the final attempt for partial reporting, not false success", () => {
  const t=fixture(); const patch=workClosurePatch(t,worker,check)!;
  assert.ok(patch.workClosure); assert.equal(patch.workUnits![0].checkpointHandled,true);
  assert.equal(patch.workUnits![1].state,"pending"); assert.equal(patch.autonomyState,undefined);
  assert.deepEqual(patch.workClosure!.issues,[check.summary,check.remainingWork]);
  assert.match(workClosurePrompt({...t,...patch}),/NOT successful acceptance/);
  assert.equal(workClosurePatch(t,{...worker,workAttempt:1},check),undefined);
  assert.ok(workClosurePatch({...t,autonomy:{enabled:true,maxCycles:1}}, {...worker,workAttempt:1},check));
});
test("never bypass authority questions, unfinished implementation or future stages", () => {
  const t=fixture();
  assert.equal(workClosurePatch(t,worker,{...check,status:"ask-user"}),undefined);
  assert.equal(workClosurePatch(t,worker,{...check,status:"environment-blocked"}),undefined);
  assert.equal(workClosurePatch(t,worker,{...check,summary:"bwrap: setting up uid map: Permission denied"}),undefined);
  assert.equal(workClosurePatch(t,{...worker,planPhase:true},check),undefined);
  assert.equal(workClosurePatch(t,{...worker,researchStage:"coding"},check),undefined);
  assert.equal(workClosurePatch({...t,workUnits:[...t.workUnits,{id:"pending",role:"worker",state:"pending"} as WorkUnit]},worker,check),undefined);
  assert.equal(workClosurePatch({...t,autonomy:{enabled:false,maxCycles:3}},worker,check),undefined);
});
test("report-ready with unresolved quality can move forward without consuming retries", () => {
  const t=fixture(); assert.ok(workClosurePatch(t,{...worker,workAttempt:1},{...check,status:"report-ready"}));
});
test("partial closure cannot leak into new rounds, goals or repair cycles", () => {
  const t=fixture(), partial={...t,...workClosurePatch(t,worker,check)};
  assert.ok(currentWorkClosure(partial));
  assert.equal(currentWorkClosure({...partial,roundNumber:2}),undefined);
  assert.equal(currentWorkClosure({...partial,goal:{...partial.goal!,revision:2}}),undefined);
  assert.equal(currentWorkClosure({...partial,autonomyCycle:2}),undefined);
});

test("exhausted research stages archive unstarted descendants and keep reporting/review dependencies", () => {
  const checkpoint={...worker,researchStage:"idea" as const,workAttempt:3,checkpointHandled:true};
  const t=fixture();
  t.workUnits=[checkpoint,
    {id:"research",title:"関連研究",role:"worker",state:"pending",dependsOn:["w"]} as WorkUnit,
    {id:"coding",title:"実装",role:"worker",state:"pending",dependsOn:["research"]} as WorkUnit,
    {id:"paper",title:"論文",role:"worker",state:"pending",dependsOn:["coding"]} as WorkUnit,
    {id:"p",role:"reporter",state:"pending",dependsOn:["paper"]} as WorkUnit,
    {id:"r",role:"reviewer",state:"pending",dependsOn:["p"]} as WorkUnit];
  const patch=workClosurePatch(t,checkpoint,check)!;
  assert.deepEqual(patch.workUnits!.map(u=>u.id),["w","p","r"]);
  assert.deepEqual(patch.workUnits![1].dependsOn,["w"]);
  assert.deepEqual(patch.workUnits![2].dependsOn,["p"]);
  assert.equal(patch.retiredWorkUnits!.length,3);
  assert.ok(patch.retiredWorkUnits!.every(u=>u.state==="cancelled"&&!u.completedAt));
  assert.equal(patch.workClosure!.issues.filter(s=>s.startsWith("未実施：")).length,3);
  assert.equal(workClosurePatch(t,{...checkpoint,workAttempt:2},check),undefined);
  assert.equal(workClosurePatch(t,checkpoint,{...check,status:"ask-user"}),undefined);
  for(const mutation of [{state:"running"},{startedAt:"2026-01-01"},{dependsOn:[]}]) {
    assert.equal(workClosurePatch({...t,workUnits:t.workUnits.map(u=>u.id==="research"?{...u,...mutation} as WorkUnit:u)},checkpoint,check),undefined);
  }
  assert.equal(workClosurePatch({...t,runs:[{workUnitId:"research"} as any]},checkpoint,check),undefined);
});

function writingFixture(): TaskRecord {
  const task = fixture();
  task.state = "paused";
  task.workUnits = [{ ...worker, researchStage: "coding", mode: "write", dependsOn: [] },
    { id: "paper", role: "worker", primary: true, planPhase: true, researchStage: "paper", mode: "write", state: "pending", dependsOn: [worker.id] } as WorkUnit,
    { id: "p", role: "reporter", mode: "write", state: "pending", dependsOn: ["paper"] } as WorkUnit,
    { id: "r", role: "reviewer", mode: "read", state: "pending", dependsOn: ["p"] } as WorkUnit];
  task.report = { state: "ready", documents: { paper: { state: "failed", error: "missing PDF" } } };
  return task;
}

test("bounded coding closure retains paper writing rather than requiring a PDF from an archived stage", () => {
  const task = writingFixture(), original = structuredClone(task);
  const patch = workClosurePatch(task, task.workUnits[0], check)!;
  assert.ok(patch.workClosure, "one repair is enough; preserve report/review capacity");
  assert.equal(patch.retiredWorkUnits, undefined);
  assert.deepEqual(patch.workUnits!.map(u => u.id), ["w", "paper", "p", "r"]);
  assert.equal(nextPendingUnit({ ...task, ...patch })?.id, "paper");
  assert.deepEqual(task, original, "routing must not mutate saved evidence");
  assert.match(workClosurePrompt({ ...task, ...patch }), /ACTIVE pending paper-writing stage/);
  assert.match(workClosurePrompt({ ...task, ...patch }), /retroactive/);
  assert.equal(workClosurePatch(task, { ...task.workUnits[0], workAttempt: 1 }, check), undefined);
  assert.equal(workClosurePatch(task, task.workUnits[0], { ...check, status: "ask-user" }), undefined);
});

function legacyWritingFixture(): TaskRecord {
  const task = writingFixture();
  const paper = task.workUnits[1];
  Object.assign(task, workClosurePatch(task, task.workUnits[0], check));
  task.retiredWorkUnits = [{ ...paper, state: "cancelled", error: "再作業上限のため未実施。部分成果の報告・独立レビューへ移行。" }];
  task.workUnits = task.workUnits.filter(u => u.id !== paper.id).map(u => u.id === "p" ? { ...u, dependsOn: [worker.id] } : u);
  task.resumeFromUnitId = "p";
  return task;
}

test("explicit resume restores the same retired paper ID before reporter, preserving the round and prior results", () => {
  const task = legacyWritingFixture(), original = structuredClone(task);
  const repair = restoreClosureWriting(task)!;
  assert.ok(repair);
  const resumed = { ...task, ...repair, ...resumePatch({ ...task, ...repair }) };
  assert.equal(nextPendingUnit(resumed)?.id, "paper");
  assert.deepEqual(resumed.workUnits.find(u => u.id === "p")!.dependsOn, ["w", "paper"]);
  assert.deepEqual(resumed.retiredWorkUnits, []);
  assert.equal(resumed.roundNumber, task.roundNumber);
  assert.deepEqual(resumed.goal, task.goal);
  assert.deepEqual(resumed.runs, task.runs);
  assert.deepEqual(resumed.workUnits[0], task.workUnits[0]);
  assert.equal(restoreClosureWriting(resumed), undefined, "restore once, not on each reporter retry");
  assert.deepEqual(task, original);
});

test("writing recovery cannot revive user-cancelled, started, unrelated or completed rounds, or bypass authority/exit gates", () => {
  for (const alter of [
    (t: TaskRecord) => { t.workClosure!.finishedAt = "now"; },
    (t: TaskRecord) => { t.goalRevisionPending = true; },
    (t: TaskRecord) => { t.retiredWorkUnits![0].error = "Cancelled by user"; },
    (t: TaskRecord) => { t.retiredWorkUnits![0].startedAt = "now"; },
    (t: TaskRecord) => { t.runs = [{ workUnitId: "paper" } as any]; },
    (t: TaskRecord) => { t.runs = [{ state: "completed", terminationUnconfirmed: true } as any]; },
    (t: TaskRecord) => { t.workUnits.at(-1)!.state = "completed"; },
    (t: TaskRecord) => { t.workUnits.find(u => u.role === "reporter")!.output = '<work-check>{"status":"ask-user"}</work-check>'; },
    (t: TaskRecord) => { t.report!.documents!.paper!.state = "ready"; },
    (t: TaskRecord) => { t.retiredWorkUnits!.push({ ...t.retiredWorkUnits![0], id: "unperformed-coding", researchStage: "coding" }); },
    (t: TaskRecord) => { t.pendingFollowup = { kind: "continue", instruction: "separate round", assignments: {}, pauseAfterPlan: false }; }
  ]) { const task = legacyWritingFixture(); alter(task); assert.equal(restoreClosureWriting(task), undefined); }
});

function closureWritingHandoffFixture(): TaskRecord {
  const task = writingFixture();
  Object.assign(task, workClosurePatch(task, task.workUnits[0], check));
  task.workUnits = task.workUnits.map(u => u.id === "paper" ? { ...u, state: "completed", planPhase: false, workAttempt: 1 } : u);
  return task;
}

test("unfinished closure writing hands off once without restarting self-check or granting acceptance", () => {
  const task = closureWritingHandoffFixture(), original = structuredClone(task);
  const paper = task.workUnits.find(u => u.id === "paper")!;
  const result = { ...check, summary: "Paper drafted; numerical implementation remains failed", remainingWork: "Reporter: inspect both PDFs. Review: retain failures." };
  const patch = workClosureHandoffPatch(task, paper, result)!;
  assert.ok(patch);
  const consumed = { ...task, ...patch };
  assert.equal(nextPendingUnit(consumed)?.id, "p");
  assert.equal(consumed.workUnits.length, task.workUnits.length);
  assert.equal(consumed.workUnits.find(u => u.id === "paper")!.workAttempt, 1);
  assert.equal(consumed.workUnits.find(u => u.id === "paper")!.checkpointHandled, true);
  assert.deepEqual(consumed.goal, original.goal);
  assert.deepEqual(consumed.runs, original.runs);
  assert.ok(consumed.workClosure!.issues.includes(result.summary));
  assert.ok(consumed.workClosure!.issues.includes(result.remainingWork));
  assert.equal(consumed.autonomyState, undefined);
  assert.deepEqual(task, original);
  assert.deepEqual(workClosureHandoffPatch(consumed, consumed.workUnits.find(u => u.id === "paper")!, result), patch, "recovery is idempotent, not another retry budget");
});

test("closure handoff never bypasses user/environment/exit barriers, unstarted work or finished rounds", () => {
  const task = closureWritingHandoffFixture(), paper = task.workUnits.find(u => u.id === "paper")!;
  for (const result of [{ ...check, status: "ask-user" as const }, { ...check, status: "environment-blocked" as const },
    { ...check, summary: "bwrap: setting up uid map: Permission denied" }]) assert.equal(workClosureHandoffPatch(task, paper, result), undefined);
  for (const alter of [
    (t: TaskRecord) => { t.workClosure!.finishedAt = "now"; },
    (t: TaskRecord) => { t.goalRevisionPending = true; },
    (t: TaskRecord) => { t.goal!.revision++; },
    (t: TaskRecord) => { t.workUnits.find(u => u.id === "p")!.dependsOn = ["missing-producer"]; },
    (t: TaskRecord) => { t.workUnits.find(u => u.id === "w")!.state = "pending"; },
    (t: TaskRecord) => { t.workUnits.find(u => u.id === "r")!.state = "completed"; },
    (t: TaskRecord) => { t.runs = [{ state: "completed", terminationUnconfirmed: true } as any]; },
    (t: TaskRecord) => { t.runs = [{ state: "running" } as any]; }
  ]) { const changed = structuredClone(task); alter(changed); assert.equal(workClosureHandoffPatch(changed, paper, check), undefined); }
  assert.equal(workClosureHandoffPatch(task, { ...paper, planPhase: true }, check), undefined);
  assert.equal(workClosureHandoffPatch(task, { ...paper, id: "foreign" }, check), undefined);
});

test("old stopped writing retries can resume into handoff only in the matching unfinished closure", () => {
  const task = closureWritingHandoffFixture();
  Object.assign(task, { state: "awaiting-input", awaitingReason: "result", error: "残作業の差戻し回数上限です。" });
  task.workUnits.find(u => u.id === "paper")!.checkpointHandled = true;
  assert.equal(closureHandoffCheckpoint(task)?.id, "paper");
  assert.equal(closureHandoffCheckpoint({ ...task, state: "paused" }), undefined);
  assert.equal(closureHandoffCheckpoint({ ...task, error: "ユーザ確認が必要です。" }), undefined);
  assert.equal(closureHandoffCheckpoint({ ...task, workClosure: undefined }), undefined);
  assert.equal(closureHandoffCheckpoint({ ...task, workClosure: { ...task.workClosure!, finishedAt: "now" } }), undefined);
});
