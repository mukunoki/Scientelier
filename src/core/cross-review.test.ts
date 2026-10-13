import test from "node:test";
import assert from "node:assert/strict";
import { createCrossReviews, crossReviewSources, crossReviewPrompt, combineCrossReviews, crossReviewEvaluations, readyCrossReviews } from "./cross-review";
import { selectAgent, buildWorkUnitPrompt } from "./orchestration";
import { initialGoal } from "./goals";
import { defaultExecution, validateExecution, budgetStatus } from "./execution-policy";
import { combineReviewPair } from "./review-pair";
import { resumePatch } from "./recovery";
import { reduceCrossReviewTask, cliHandoffTask } from "./cli-handoff";
import { executionSettingsPatch } from "./execution-updates";
import { decideIteration } from "./autonomy";
import type { AgentId, GoalEvaluation, TaskRecord } from "./types";

function fixture(): TaskRecord {
  return { id: "cross", title: "subject", prompt: "subject", cwd: "/tmp", state: "queued", strategy: "balanced", workflowMode: "primary",
    reviewPolicy: "adversarial-pair", execution: { ...defaultExecution, scheduling: "throughput", reviewMode: "cross-service", maxParallel: 3 },
    autonomy: { enabled: true, maxCycles: 3 }, goal: { ...initialGoal("subject"), status: "approved", questions: [] },
    allowedAgentIds: ["codex", "claude", "gemini"], modelOverrides: {}, runs: [], output: "", createdAt: "", updatedAt: "",
    workUnits: [{ id: "producer", role: "worker", mode: "write", state: "completed", title: "work", instructions: "", dependsOn: [], attemptedAgentIds: [] }] };
}
function finish(task: TaskRecord, index: number, concerns: string[] = []) {
  const unit = task.workUnits.filter(u => u.crossReview)[index]; unit.state = "completed"; unit.startedAt = "2026-01-01T00:00:00Z";
  const agent = ({ openai: "codex", anthropic: "claude", google: "gemini" } as Record<string, AgentId>)[unit.crossReview!.providerKey]; unit.assignedAgentId = agent;
  task.runs.push({ id: unit.id + "-run", workUnitId: unit.id, role: "reviewer", agentId: agent, providerKey: unit.crossReview!.providerKey, state: "completed", startedAt: unit.startedAt, output: "" });
  const e: GoalEvaluation = { goalRevision: 1, cycle: 1, round: 1, reviewedAt: "2026-01-01T01:00:00Z", reviewUnitId: unit.id, reviewPass: unit.crossReview!.wave, reviewerAgentId: agent,
    criteria: [{ criterionId: "report", status: "pass", detail: `Finding ${unit.id}`, evidence: [] }], concerns, nextAction: "repair", repairInstructions: concerns.length ? "Repair the defect" : "", summary: `Private-${unit.crossReview!.providerKey}` };
  (task.evaluations ??= []).push(e); return e;
}
function failedSeat():TaskRecord {
  const t=fixture();t.workUnits=createCrossReviews(t,["openai","anthropic","google"]);finish(t,0,["Keep this concern"]);finish(t,1);
  t.state="paused";const u=t.workUnits.find(u=>u.crossReview?.providerKey==="google"&&u.crossReview.wave===1)!;u.state="failed";t.resumeFromUnitId=u.id;
  t.runs.push({id:"failure",workUnitId:u.id,role:"reviewer",agentId:"antigravity",providerKey:"google",state:"failed",startedAt:"",output:"",displayOutput:"Partial concern: check rounding"});return t;
}
test("failed unaccepted third seat can retire while two independent services cross-check preserved findings",()=>{
  const t=failedSeat(),original=JSON.stringify(t),next=reduceCrossReviewTask(t,"failure");
  assert.equal(JSON.stringify(t),original);assert.equal(next.runs,t.runs);assert.equal(next.evaluations,t.evaluations);
  assert.equal(next.retiredWorkUnits?.length,2);assert.equal(next.crossReviewReplans?.length,1);
  assert.equal(next.workUnits.filter(u=>u.crossReview).length,4);
  const ready=readyCrossReviews({...next,...resumePatch(next)});assert.equal(ready.length,2);
  for(const u of ready){const sources=crossReviewSources(next,u);assert.equal(sources.length,1);assert.notEqual(sources[0].provider,u.crossReview!.providerKey);assert.match(crossReviewPrompt(next,u),/check rounding/);}
  finish(next,2);finish(next,3);assert.ok(combineCrossReviews(next).concerns!.includes("Keep this concern"));
});
test("review reduction rejects missing receipts, dissent suppression, single-service and started cross waves",()=>{
  for(const mutate of [
    (t:TaskRecord)=>{t.evaluations=[];},
    (t:TaskRecord)=>{t.workUnits.find(u=>u.crossReview?.providerKey==="anthropic"&&u.crossReview.wave===1)!.state="failed";},
    (t:TaskRecord)=>{const u=t.workUnits.find(u=>u.crossReview?.wave===2)!;u.state="completed";},
    (t:TaskRecord)=>{t.evaluations!.push({...t.evaluations![0],reviewUnitId:t.runs.at(-1)!.workUnitId,concerns:["Must not discard"]});},
    (t:TaskRecord)=>{t.runs[0].providerKey="wrong";},
    (t:TaskRecord)=>{t.state="running";}
  ]){const t=failedSeat();mutate(t);assert.throws(()=>reduceCrossReviewTask(t,"failure"));}
});
test("cross review freezes distinct services, waits at a wave barrier and shares only other-service findings", () => {
  const t = fixture(); t.workUnits = createCrossReviews(t, ["openai", "anthropic", "google", "openai"]);
  const first = t.workUnits.filter(u => u.crossReview?.wave === 1), second = t.workUnits.filter(u => u.crossReview?.wave === 2);
  assert.equal(first.length, 3); assert.equal(second.length, 3);
  for (const u of first) { assert.equal(u.mode, "read"); assert.deepEqual(u.dependsOn, ["producer"]); assert.match(crossReviewPrompt(t, u), /Do not read their logs/); }
  assert.match(crossReviewPrompt(t, second[0]), /まだ実行できません/);
  first.forEach(u => u.state = "completed");
  assert.equal(readyCrossReviews(t).length, 0, "handoff receipt alone cannot release cross-review barrier");
  first.forEach((_, i) => finish(t, i));
  assert.equal(readyCrossReviews(t).length, 3);
  for (const u of second) {
    assert.deepEqual(u.dependsOn, first.map(u => u.id));
    const sources = crossReviewSources(t, u); assert.equal(sources.length, 2); assert.ok(sources.every(s => s.provider !== u.crossReview!.providerKey));
    const prompt = buildWorkUnitPrompt(t, u); assert.match(prompt, /Cross-service review/); assert.doesNotMatch(prompt, /Review sequence rule:/);
  }
  assert.doesNotMatch(buildWorkUnitPrompt(t, first[0]), /Private-/);
  assert.throws(() => combineCrossReviews(t), /完了して/);
  second.forEach((_, i) => finish(t, i + 3, i === 0 ? ["minority defect"] : []));
  assert.ok(combineReviewPair(t).concerns!.includes("minority defect"));
  t.runs.at(-1)!.providerKey = "openai";
  assert.throws(() => combineCrossReviews(t), /担当サービス/);
  assert.throws(() => createCrossReviews(fixture(), ["openai"]), /2種類/);
});
test("resuming a partial wave preserves peers and invalidates all downstream cross verdicts", () => {
  const t = fixture(); t.workUnits = createCrossReviews(t, ["openai", "anthropic"]);
  finish(t, 0); finish(t, 1); finish(t, 2); finish(t, 3);
  const units = t.workUnits.filter(u => u.crossReview); units[1].state = "failed"; t.state = "paused"; t.resumeFromUnitId = units[1].id;
  const resumed = { ...t, ...resumePatch(t) };
  assert.equal(resumed.workUnits.find(u => u.id === units[0].id)!.state, "completed");
  assert.ok(resumed.workUnits.filter(u => u.id !== "producer" && u.id !== units[0].id).every(u => u.state === "pending"));
  assert.equal(crossReviewEvaluations(resumed).length, 1);
  resumed.workUnits.find(u => u.id === units[1].id)!.state = "completed"; resumed.workUnits.find(u => u.id === units[1].id)!.startedAt = "2026-01-02T00:00:00Z";
  assert.equal(crossReviewEvaluations(resumed).length, 1, "stale evaluation cannot validate a new attempt");
});
test("throughput prefers free services, permits same-service sessions and strictly routes frozen reviews", () => {
  const t = fixture(); const policies = t.allowedAgentIds.map((agentId, i) => ({ agentId, enabled: true, providerKey: ["openai", "anthropic", "google"][i], providerLabel: agentId, priority: 80, authMode: "subscription" as const }));
  const input = { task: t, unit: { ...t.workUnits[0], mode: "read" as const, state: "pending" as const }, agents: policies.map(p => ({ id: p.agentId, label: "", command: "", installed: true })), settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 }, resources: [] };
  assert.equal(selectAgent({ ...input, providerReservations: { openai: 1, anthropic: 1 } }), "gemini");
  t.allowedAgentIds = ["codex"];
  assert.equal(selectAgent({ ...input, providerReservations: { openai: 2 } }), "codex");
  assert.equal(selectAgent({ ...input, unit: { ...input.unit, role: "reviewer", crossReview: { wave: 1, providerKey: "anthropic", sourceUnitIds: [] } } }), undefined);
  assert.equal(validateExecution({ ...defaultExecution, scheduling: "throughput", reviewMode: "cross-service", maxParallel: 8 }).maxParallel, 8);
  assert.throws(() => validateExecution({ ...defaultExecution, reviewMode: "skip" }));
  t.allowedAgentIds = ["codex", "claude", "gemini"];
  t.workUnits.push({ ...input.unit, id: "review", role: "reviewer" });
  assert.equal(budgetStatus(t).reserve, 30000);
});

test("parallel independent reviews have one all-source consolidator and a receipt barrier", () => {
  const t = fixture(); t.execution!.reviewMode = "parallel";
  t.workUnits = createCrossReviews(t, ["openai", "anthropic", "google"], "parallel");
  const first = t.workUnits.filter(u => u.crossReview?.wave === 1), aggregate = t.workUnits.at(-1)!;
  assert.equal(first.length, 3); assert.equal(t.workUnits.filter(u => u.crossReview?.wave === 2).length, 1);
  assert.equal(aggregate.crossReview!.aggregate, true);
  assert.deepEqual(aggregate.dependsOn, first.map(u => u.id));
  assert.deepEqual(aggregate.crossReview!.sourceUnitIds, aggregate.dependsOn);
  assert.equal(readyCrossReviews(t).length, 3);
  finish(t, 0); finish(t, 1);
  assert.deepEqual(readyCrossReviews(t).map(u => u.id), [first[2].id]);
  first[2].state = "completed"; assert.equal(readyCrossReviews(t).length, 0, "exit alone is not a review receipt");
  finish(t, 2); assert.deepEqual(readyCrossReviews(t).map(u => u.id), [aggregate.id]);
  assert.equal(crossReviewSources(t, aggregate).length, 3, "include its own provider's independent findings too");
  const prompt = buildWorkUnitPrompt(t, aggregate);
  assert.match(prompt, /Review consolidation/); assert.match(prompt, /ALL supplied wave-1/);
  assert.match(prompt, /minority/); assert.match(prompt, /Private-openai/); assert.match(prompt, /Private-anthropic/);
  assert.doesNotMatch(buildWorkUnitPrompt(t, first[0]), /Private-/);
  assert.throws(() => combineCrossReviews(t), /完了して/);
  finish(t, 3); assert.equal(decideIteration(t, combineCrossReviews(t)), "satisfied");
  assert.equal(budgetStatus(t).reserve, 0);
  t.allowedAgentIds=["codex","claude"];
  assert.equal(decideIteration(t,combineCrossReviews(t)),"satisfied","changing future CLI candidates does not erase an accepted historical receipt");
});

test("a clean consolidator cannot erase minority defects, uncertainty or user-only questions", () => {
  for (const verdict of ["fail", "unverified", "concern", "ask-user"] as const) {
    const t = fixture(); t.workUnits = createCrossReviews(t, ["openai", "anthropic"], "parallel");
    const minority = finish(t, 0, ["Unresolved boundary defect"]); finish(t, 1); finish(t, 2);
    if (verdict === "fail" || verdict === "unverified") minority.criteria[0].status = verdict;
    if (verdict === "ask-user") minority.nextAction = "ask-user";
    const result = combineReviewPair(t);
    assert.ok(result.concerns!.includes("Unresolved boundary defect"));
    assert.equal(decideIteration(t, result), verdict === "ask-user" ? "needs-input" : "working");
    if (verdict === "fail" || verdict === "unverified") assert.equal(result.criteria[0].status, verdict);
    assert.match(result.summary, /独立レビュー2件を統合/);
  }
});

test("parallel topology rejects mixed/missing sources and reused or single-CLI reviews", () => {
  for (const corrupt of [
    (t: TaskRecord) => { t.workUnits.at(-1)!.crossReview!.sourceUnitIds.pop(); },
    (t: TaskRecord) => { t.workUnits.at(-1)!.dependsOn.pop(); },
    (t: TaskRecord) => { t.workUnits.push({ ...t.workUnits.at(-1)!, id: "duplicate" }); },
    (t: TaskRecord) => { t.runs.at(-1)!.continuedFrom = "worker-session"; },
    (t: TaskRecord) => { t.runs[1].agentId = "codex"; t.evaluations![1].reviewerAgentId = "codex"; },
    (t: TaskRecord) => { t.workUnits.at(-1)!.mode = "write"; }
  ]) {
    const t = fixture(); t.workUnits = createCrossReviews(t, ["openai", "anthropic"], "parallel");
    finish(t, 0); finish(t, 1); finish(t, 2); corrupt(t);
    assert.throws(() => combineCrossReviews(t));
  }
});

test("consolidator may use another available CLI without relabelling independent seats", () => {
  const t = fixture(); t.workUnits = createCrossReviews(t, ["openai", "anthropic"], "parallel");
  finish(t, 0); finish(t, 1); const aggregate = t.workUnits.at(-1)!;
  const settings = { warningPercent: 70, drainPercent: 85, agentPolicies: ["codex", "claude"].map((id, i) => ({ agentId: id as AgentId, enabled: true, providerKey: ["openai", "anthropic"][i], providerLabel: id, priority: 80, authMode: "subscription" as const })) };
  const input = {task:t,unit:aggregate,settings,resources:[],agents:[{id:"claude" as const,label:"Claude",command:"claude",installed:true}]};
  assert.equal(selectAgent(input), "claude", "frozen provider applies only to independent seats");
  t.state = "paused"; aggregate.state = "failed"; t.resumeFromUnitId = aggregate.id;
  t.runs.push({id:"failed-consolidator",workUnitId:aggregate.id,role:"reviewer",agentId:"codex",providerKey:"openai",state:"failed",startedAt:"",output:""});
  const transferred = cliHandoffTask(t, "failed-consolidator", "claude", "anthropic");
  assert.deepEqual(transferred.workUnits.slice(0,-1), t.workUnits.slice(0,-1));
  assert.equal(transferred.workUnits.at(-1)!.retryAgentId, "claude");
  Object.assign(t, transferred); const result = finish(t, 2);
  result.reviewerAgentId = "claude"; Object.assign(t.runs.at(-1)!, {agentId:"claude",providerKey:"anthropic"});
  assert.equal(decideIteration(t, combineCrossReviews(t)), "satisfied");
});

test("retiring an unaccepted failed independent seat preserves the single consolidator", () => {
  const t = fixture(); t.workUnits = createCrossReviews(t,["openai","anthropic","google"],"parallel");
  finish(t, 1, ["Keep minority concern"]); finish(t, 2); t.state="paused";
  const failed = t.workUnits.find(u=>u.crossReview?.providerKey==="openai"&&u.crossReview.wave===1)!;
  failed.state="failed";t.resumeFromUnitId=failed.id;
  t.runs.push({id:"failure",workUnitId:failed.id,role:"reviewer",agentId:"codex",providerKey:"openai",state:"failed",startedAt:"",output:""});
  const next=reduceCrossReviewTask(t,"failure");
  assert.equal(next.retiredWorkUnits!.length,1);
  assert.equal(next.workUnits.at(-1)!.crossReview!.aggregate,true);
  assert.equal(crossReviewSources(next,next.workUnits.at(-1)!).length,2);
  finish(next,2);assert.ok(combineCrossReviews(next).concerns!.includes("Keep minority concern"));
});

test("policy changes rebuild only unstarted review graphs and reserve N plus one starts", () => {
  const t = fixture(); t.state="paused"; t.workUnits=createCrossReviews(t,["openai","anthropic"]);
  const patch=executionSettingsPatch(t,{...t.execution,reviewMode:"parallel"},false);
  assert.ok(patch.workUnits!.filter(u=>u.role==="reviewer").every(u=>!u.crossReview));
  Object.assign(t,patch);assert.equal(budgetStatus(t).reserve,20000,"three allowed CLIs plus one consolidator");
  t.workUnits=createCrossReviews(t,["openai","anthropic"],"parallel");
  assert.equal(budgetStatus(t).reserve,15000,"actual graph reserved once");
  assert.equal(executionSettingsPatch(t,{...t.execution,maxParallel:4},false).workUnits,t.workUnits);
  finish(t,0); assert.throws(()=>executionSettingsPatch(t,{...t.execution,reviewMode:"cross-service"},false),/開始済み/);
  assert.equal(validateExecution({...defaultExecution,reviewMode:"parallel"}).reviewMode,"parallel");
});
