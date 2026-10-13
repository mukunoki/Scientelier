import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionWorkflow, buildWorkUnitPrompt } from "./orchestration";
import { createFollowupWorkflow } from "./iterations";
import { repairUnits } from "./autonomy";
import { focusedContext } from "./focused-context";
import { returnWork } from "./work-guidance";
import type { TaskRecord, GoalEvaluation } from "./types";
import { defaultExecution } from "./execution-policy";

function task(): TaskRecord {
  return { id: "primary", title: "Primary", prompt: "Create a verified report", cwd: "/tmp", workflowMode: "primary", strategy: "balanced",
    allowedAgentIds: ["codex"], modelOverrides: {}, runs: [], state: "queued", output: "", createdAt: "", updatedAt: "",
    workUnits: createExecutionWorkflow({ workflowMode: "primary" }) };
}

test("handoff bounds are independent of conversation thresholds and retain every dependency log", () => {
  const t = task(), original = t.workUnits[0];
  const deps = Array.from({length:6}, (_, i)=>({...original,id:`dep-${i}`,state:"completed" as const,output:"x".repeat(6000),dependsOn:[]}));
  const target = {...original,id:"target",dependsOn:deps.map(u=>u.id)};
  t.workUnits = [...deps,target];
  t.runs = deps.map(u=>({id:`run-${u.id}`,workUnitId:u.id,role:"worker",agentId:"codex",providerKey:"openai-default",state:"completed",output:"",startedAt:"",logPath:`/tmp/${u.id}.log`}));
  t.execution = {...defaultExecution,contextTokens:32000};
  const expected = focusedContext(t, target);
  for (const contextTokens of [undefined,4000,200000]) {
    t.execution.contextTokens = contextTokens;
    assert.equal(focusedContext(t, target), expected);
  }
  for (const u of deps) assert.ok(expected.includes(`/tmp/${u.id}.log`));
  assert.ok(expected.length < 18000);
  assert.doesNotMatch(focusedContext(t, {...target,role:"reviewer"}), /dep-0\.log/);
});

test("primary combines planning, execution and self-check but preserves a separate final review", () => {
  const t = task();
  assert.deepEqual(t.workUnits.map(u => u.role), ["worker", "reporter", "reviewer"]);
  assert.equal(t.workUnits[0].primary, true);
  assert.equal(t.workUnits[2].mode, "read");
  const prompt = buildWorkUnitPrompt(t, t.workUnits[0]);
  assert.match(prompt, /SAME CLI session/);
  assert.match(prompt, /plan alone is NOT completion/);
  assert.match(prompt, /<work-check>/);
  assert.match(prompt, /Do not delegate or launch additional agents/);
  assert.deepEqual(t.workUnits[2].dependsOn, [t.workUnits[1].id]);
  assert.deepEqual(createExecutionWorkflow({}).map(u => u.role), ["worker", "reporter", "reviewer"], "new graphs always use the primary strategy");
});

test("explicit planner assignment and plan approval are preserved, including followups", () => {
  const t = task();
  assert.equal(createExecutionWorkflow({ ...t, pauseAfterPlan: true })[0].planPhase, true, "approval uses the primary's saved execution plan");
  for (const options of [{ assignments: { planner: { agentId: "codex" as const, allowFallback: false } } }]) {
    const units = createExecutionWorkflow({ ...t, ...options });
    assert.equal(units[0].role, "planner"); assert.equal(units[0].mode, "read");
    assert.equal(units[1].primary, true);
  }
  const input = { instruction: "Fix it", kind: "continue" as const, assignments: {}, pauseAfterPlan: false };
  assert.equal(createFollowupWorkflow(input, t)[0].primary, true);
  assert.equal(createFollowupWorkflow({ ...input, kind: "consult" }, t)[0].mode, "read");
});

test("review context excludes success claims and worker context only includes bounded direct dependencies", () => {
  const t = task();
  t.workUnits = t.workUnits.map(u => ({ ...u, state: "completed", output: "SUCCESS_CLAIM_" + "x".repeat(20000) }));
  const review = buildWorkUnitPrompt(t, t.workUnits[2]);
  assert.doesNotMatch(review, /SUCCESS_CLAIM_/);
  assert.match(review, /Independent review context/);
  const context = focusedContext(t, t.workUnits[1]);
  assert.ok(context.length < 10000); assert.match(context, /Truncated/);
  t.workUnits[2].output = "UNRELATED_REVIEW";
  assert.doesNotMatch(focusedContext(t, t.workUnits[1]), /UNRELATED_REVIEW/);
});

test("repair and incomplete self-check retain primary ownership without inserting a planner", () => {
  const t = task();
  t.goal = { status: "approved", revision: 1, updatedAt: "", objective: "test", deliverables: ["report"], constraints: [], outOfScope: [], questions: [], criteria: [{ id: "c", description: "check", verification: "test", required: true }] };
  const evaluation: GoalEvaluation = { goalRevision: 1, cycle: 1, round: 1, reviewedAt: "", nextAction: "repair", summary: "Missing evidence", criteria: [{ criterionId: "c", status: "fail", detail: "missing", evidence: [] }], repairInstructions: "Repair evidence" };
  const repair = repairUnits(t, evaluation);
  assert.equal(repair[0].primary, true);
  assert.deepEqual(repair.map(u => u.role), ["worker", "reporter", "reviewer"]);
  const worker = { ...t.workUnits[0], state: "completed" as const };
  const units = returnWork([worker, ...t.workUnits.slice(1)], worker, { status: "needs-work", summary: "Missing", remainingWork: "Finish TeX", estimatedRemainingMinutes: 5, evidence: [] });
  assert.equal(units[0].checkpointHandled, true);
  assert.equal(units[1].primary, true);
  assert.equal(units[1].checkpointHandled, undefined);
  assert.deepEqual(units[2].dependsOn, [units[1].id]);
});
