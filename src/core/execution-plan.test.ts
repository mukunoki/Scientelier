import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExecutionPlan, parseExecutionPlan, replanAfterFailure, roundPlans, MAX_PLAN_REVISIONS, executionPlanContract, executionPlanRetry } from "./execution-plan";
import { PlanFormatError, validatePlanTasks } from "./plan-format";
import { createExecutionWorkflow, buildWorkUnitPrompt, nextPendingUnit } from "./orchestration";
import { needsPlanApproval } from "./iterations";
import { defaultExecution } from "./execution-policy";
import { readySubtasks } from "./decomposition";
import { resumePatch } from "./recovery";
import { JsonTaskStore } from "./task-store";
import { WorkPresetStore } from "./work-presets";
import { generalImplementation } from "./workspace-policy";
import type { TaskRecord, SubtaskSpec } from "./types";

function task(): TaskRecord {
  return { id: "plan-test", title: "Report", prompt: "Explain evidence", cwd: "/tmp", strategy: "balanced", workflowMode: "primary", execution: { ...defaultExecution }, allowedAgentIds: ["codex", "claude"], modelOverrides: {}, runs: [], state: "running", workUnits: createExecutionWorkflow({ workflowMode: "primary" }), createdAt: "", updatedAt: "", output: "",
    goal: { revision: 1, status: "approved", updatedAt: "", objective: "Explain evidence", deliverables: ["PDF"], criteria: [{ id: "c", description: "correct", verification: "check sources", required: true }], constraints: [], outOfScope: [], questions: [] } };
}
const specialist = (key: string, dependsOn: string[] = []): SubtaskSpec => ({ key, title: `Specialist ${key}`, instructions: "Inspect sources", deliverable: "Findings", acceptance: "Verify independent sources", criterionIds: ["c"], dependsOn, estimatedTokens: 1000 });
const input = (tasks: SubtaskSpec[] = []) => ({ summary: "Primary owns integration", reason: "Initial plan", primaryWork: "Implement and verify report", acceptance: "Check artifacts", criterionIds: ["c"], estimatedTokens: 8000, estimatedMinutes: 20, escalation: "Ask user for new authority", tasks });
const output = (value: unknown) => `<execution-plan>${JSON.stringify(value)}</execution-plan>`;
test("efficiency plan preserves dependencies, bounded primary milestones and mandatory integration", () => {
  const t = task();
  const v = { ...input([{ ...specialist("implement"), kind: "primary-work" as const, estimatedMinutes: 5 }, specialist("verify", ["implement"])]),
    coordination: { criticalPath: "implement -> verify -> integrate", parallelBenefit: "independent checks only", contextPlan: "paths and direct dependencies", resourcePlan: "spread providers, preserve review budget" } };
  const parsed = parseExecutionPlan(output(v), t, t.workUnits[0])!;
  assert.deepEqual(parsed.coordination, v.coordination);
  apply(t, parsed);
  const milestone = t.workUnits.find(u => u.primaryStep)!;
  assert.equal(milestone.mode, "write"); assert.equal(milestone.primary, undefined);
  assert.match(buildWorkUnitPrompt(t, milestone), /ONE bounded implementation/);
  assert.doesNotMatch(buildWorkUnitPrompt(t, milestone), /# Lead-owned execution plan|# Read-only delegated work|You are a read-only specialist/);
  assert.equal(t.workUnits.find(u => u.subtask?.key === "verify")!.dependsOn[0], milestone.id);
  assert.equal(t.workUnits.find(u => u.id === t.executionPlans![0].primaryUnitId)!.dependsOn.length, 3);
  assert.match(buildWorkUnitPrompt(task(), task().workUnits[0]), /critical dependency chain|criticalPath/);
  assert.throws(() => validatePlanTasks(v.tasks, { criterionIds: ["c"], requiredCriterionIds: [], maxSubtasks: 4 }), /kind/);
  for (const bad of [{ ...v, coordination: {} }, { ...v, tasks: [{ ...v.tasks[0], kind: "parallel-writer" }] }, { ...v, tasks: [{ ...v.tasks[0], estimatedMinutes: "5" }] }]) {
    assert.throws(() => parseExecutionPlan(output(bad), task(), task().workUnits[0]), PlanFormatError);
  }
});
test("large honest estimates are telemetry even with a legacy token target", () => {
  const t = task(), owner = t.workUnits[0];
  const large = { ...input([specialist("a"), specialist("b")]), estimatedTokens: 900000, estimatedMinutes: 300 };
  large.tasks[0].estimatedTokens = 60000; large.tasks[1].estimatedTokens = 50000;
  assert.equal(parseExecutionPlan(output(large), t, owner)?.estimatedTokens, 900000);
  large.tasks[0].estimatedTokens = 200000;
  assert.equal(parseExecutionPlan(output(large), t, owner)?.tasks[0].estimatedTokens, 200000);
  t.execution!.tokenBudget = 100000;
  assert.ok(parseExecutionPlan(output(large), t, owner));
  assert.equal(t.execution!.tokenBudget, 100000);
});

test("general isolated implementation is stage-scoped and requires explicit integration before consumers", () => {
  const t=task(), owner=t.workUnits[0];
  const isolated={...specialist("a"),kind:"isolated-work" as const,ownedFiles:["a.cpp","test_a.cpp"]};
  assert.throws(()=>parseExecutionPlan(output(input([isolated])),t,owner),/kind/);
  t.workPreset={manifest:{id:"coding"}} as any;
  assert.equal(parseExecutionPlan(output(input([isolated])),t,owner)!.tasks[0].kind,"isolated-work");
  assert.throws(()=>parseExecutionPlan(output(input([isolated,specialist("read",["a"])])),t,owner),/統合工程/);
  const integrator={...specialist("integrate",["a"]),kind:"primary-work" as const};
  assert.equal(parseExecutionPlan(output(input([isolated,integrator,specialist("read",["integrate"])])),t,owner)!.tasks.length,3);
  t.workPreset!.manifest.id="research-project";
  owner.researchStage="research";assert.equal(executionPlanContract(t,owner).allowIsolatedWork,false);
  owner.researchStage="coding";assert.equal(executionPlanContract(t,owner).allowIsolatedWork,true);
  owner.mode="read";assert.equal(executionPlanContract(t,owner).allowIsolatedWork,false);
});

test("experimental idea scope enables isolated prototypes, old idea/paper stages do not", () => {
  const t=task(), owner=t.workUnits[0];
  t.workPreset={manifest:{id:"idea",focus:"idea",ideaApproach:"experimental"}} as any;
  assert.equal(executionPlanContract(t,owner).allowIsolatedWork,true);
  assert.equal(executionPlanContract(t,owner).allowAlternativeWork,true);
  delete t.workPreset!.manifest.ideaApproach;
  assert.equal(executionPlanContract(t,owner).allowIsolatedWork,false);
  const experimental={manifest:{id:"idea",focus:"idea",ideaApproach:"experimental"}};
  t.workPreset={manifest:{id:"research-project"},stages:[experimental,{manifest:{id:"paper",focus:"paper"}}]} as any;
  owner.researchStage="idea";assert.equal(executionPlanContract(t,owner).allowAlternativeWork,true);
  owner.researchStage="paper";assert.equal(executionPlanContract(t,owner).allowAlternativeWork,false);
  owner.researchStage="idea";owner.mode="read";assert.equal(executionPlanContract(t,owner).allowAlternativeWork,false);
});

test("captured integrated research permits isolated implementations and alternatives without widening old stages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-workspace-policy-"));
  try {
    const t = task();
    t.workPreset = await new WorkPresetStore(join(process.cwd(), "assets/work-presets"), directory).capture("research-project");
    t.workUnits = createExecutionWorkflow(t);
    const owner = t.workUnits[0], goal = structuredClone(t.goal);
    assert.equal(owner.researchStage, undefined);
    assert.equal(executionPlanContract(t, owner).allowIsolatedWork, true);
    assert.equal(executionPlanContract(t, owner).allowAlternativeWork, true);
    const specs: SubtaskSpec[] = ["a", "b"].map((key, index) => ({ ...specialist(key), kind: "isolated-work", estimatedMinutes: 2,
      ownedFiles: [`variants/${key}/kernel.cpp`, `variants/${key}/test.cpp`],
      requirements: { independenceGroup: "prototypes", modelFamilies: [index ? "anthropic" : "openai"] },
      comparison: { input: "fixed baseline", evaluation: "same correctness tests", approach: `Independent method ${key}` } }));
    const plan = parseExecutionPlan(output(input(specs)), t, owner)!;
    Object.assign(t, applyExecutionPlan(t, owner, plan));
    const workers = t.workUnits.filter(u => u.subtask?.kind === "isolated-work");
    assert.equal(workers.length, 2);
    assert.ok(workers.every(u => u.mode === "write" && !u.primary && !u.researchStage && generalImplementation(t, u)), "runtime preparation must recognize the same scope as planning");
    assert.ok(workers.every(u => t.workUnits.find(w => w.id === t.executionPlans![0].primaryUnitId)!.dependsOn.includes(u.id)), "owner integrates both results");
    assert.deepEqual(t.goal, goal, "isolation does not change approved requirements or permissions");
    assert.equal(executionPlanContract(t, { ...owner, mode: "read" }).allowIsolatedWork, false);
    for (const researchStage of ["research", "paper"]) {
      assert.equal(executionPlanContract(t, { ...owner, researchStage }).allowAlternativeWork, false, "a saved stage label retains its boundary");
    }
    delete t.workPreset.manifest.integratedWorkflow;
    assert.equal(executionPlanContract(t, owner).allowIsolatedWork, false, "old research without integrated metadata is not upgraded");
    assert.equal(executionPlanContract(t, { ...owner, researchStage: "coding" }).allowIsolatedWork, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("input-only scope is validated, saved, and gets no mutable workspace context or writer rules", () => {
  const t=task();
  const specs:SubtaskSpec[]=[{...specialist("env"),kind:"primary-work",allowTaskOnlyPeers:true}, {...specialist("proposal"),inputScope:"assignment"},
    {...specialist("apply",["env","proposal"]),kind:"primary-work"}];
  apply(t,input(specs));
  const peer=t.workUnits.find(u=>u.subtask?.key==="proposal")!;
  assert.equal(peer.subtask?.inputScope,"assignment");
  const prompt=buildWorkUnitPrompt(t,peer);
  assert.match(prompt,/input-only reasoning specialist|Input-only handoff/);
  assert.doesNotMatch(prompt,/# Working report|Workspace:|TeX:|Previous agents' handoffs|# Lead-owned execution plan/);
  assert.match(buildWorkUnitPrompt(t,t.workUnits.find(u=>u.subtask?.key==="env")!),/resource-sensitive measurements/);
  for(const bad of [{...specialist("bad"),inputScope:"workspace"},{...specialist("bad"),kind:"primary-work",inputScope:"assignment"},
    {...specialist("bad"),allowTaskOnlyPeers:true},{...specialist("bad"),kind:"primary-work",allowTaskOnlyPeers:"true"}])
    assert.throws(()=>parseExecutionPlan(output(input([bad as SubtaskSpec])),task(),task().workUnits[0]),PlanFormatError);
});

test("plan contract is checked before launch and format retries are bounded without weakening scope", () => {
  const t = task(), owner = t.workUnits[0];
  const before = structuredClone(t.goal);
  assert.match(buildWorkUnitPrompt(t, owner), /Validated plan submission requirements/);
  for (const [field, value] of [["estimatedTokens", "8000"], ["estimatedMinutes", undefined], ["criterionIds", ["invented"]], ["tasks", undefined], ["estimatedTokens", Number.MAX_SAFE_INTEGER + 1]] as const) {
    try { parseExecutionPlan(output({ ...input(), [field]: value }), t, owner); assert.fail(); }
    catch (error) {
      assert.ok(error instanceof PlanFormatError); assert.ok(error.message.includes(field));
      const patch = executionPlanRetry(owner, error)!;
      assert.equal(patch.state, "pending"); assert.equal(patch.planFormatRetries, 1);
      assert.match(buildWorkUnitPrompt(t, { ...owner, ...patch }), /Repair the rejected plan only/);
      assert.equal(executionPlanRetry({ ...owner, planFormatRetries: 2 }, error), undefined);
    }
  }
  assert.equal(executionPlanRetry(owner, new Error("unrelated environment failure")), undefined);
  assert.deepEqual(t.goal, before);
  t.goal!.criteria.push({ ...t.goal!.criteria[0] });
  assert.throws(() => executionPlanContract(t, owner), /実行前/);
  t.goal!.criteria.pop(); t.execution!.maxParallel = 0;
  assert.throws(() => executionPlanContract(t, owner), /戦略設定/);
});
function apply(t: TaskRecord, v = input()) {
  const owner = t.workUnits.find(u => u.primary && u.state === "pending")!;
  owner.state = "completed"; owner.output = output(v);
  Object.assign(t, applyExecutionPlan(t, owner, parseExecutionPlan(owner.output, t, owner)!));
  return owner;
}

test("approved primary must submit a plan before substantive work; zero specialists is valid", () => {
  const t = task(), u = t.workUnits[0];
  const prompt = buildWorkUnitPrompt(t, u);
  assert.match(prompt, /INITIAL OR REQUIRED REPLAN/);
  assert.doesNotMatch(prompt, /You own the substantive research|# Optional bounded delegation/);
  assert.throws(() => parseExecutionPlan("Just start working", t, u), /実行計画/);
  assert.throws(() => parseExecutionPlan('<work-check>{"status":"ready"}</work-check>', t, u));
  assert.equal(parseExecutionPlan('<work-check>{"status":"ask-user"}</work-check>', t, u), undefined);
  const beforeGoal = structuredClone(t.goal), beforeExecution = structuredClone(t.execution);
  apply(t);
  assert.equal(t.executionPlans!.length, 1); assert.equal(t.executionPlans![0].tasks.length, 0);
  assert.equal(nextPendingUnit(t)?.title, "主担当 · 実作業と統合");
  assert.deepEqual(t.goal, beforeGoal); assert.deepEqual(t.execution, beforeExecution);
  assert.equal(t.workUnits.filter(u => u.role === "reporter").length, 1);
  assert.equal(t.workUnits.at(-1)?.role, "reviewer");
});

test("plan validation rejects unsupported authority, invalid coverage, graph and budget", () => {
  const t = task(), owner = t.workUnits[0];
  for (const v of [null, { ...input(), goal: "weakened" }, { ...input(), tokenBudget: 999999 }, { ...input(), reason: "" }, { ...input(), estimatedTokens: -1 }, { ...input(), estimatedMinutes: -1 }, { ...input(), criterionIds: ["invented"] }, input([specialist("a", ["a"])]), input([specialist("a"), specialist("a")]), input([{ ...specialist("a"), mode: "write" } as SubtaskSpec])]) assert.throws(() => parseExecutionPlan(output(v), t, owner));
  assert.throws(() => parseExecutionPlan(output(input()) + output(input()), t, owner));
  assert.throws(() => parseExecutionPlan(output(input()) + "<work-check>{}</work-check>", t, owner));
  t.goal!.criteria.push({ id: "second", description: "Another required criterion", verification: "Check", required: true });
  assert.throws(() => parseExecutionPlan(output(input()), t, owner), /担当のない/);
  t.goal!.criteria.pop(); t.execution!.decompose = false;
  assert.throws(() => parseExecutionPlan(output(input([specialist("a")])), t, owner));
  assert.ok(parseExecutionPlan(output(input()), t, owner));
  t.execution!.tokenBudget = 15999;
  assert.ok(parseExecutionPlan(output(input()), t, owner), "legacy token target is telemetry only");
  t.execution!.tokenBudget = 16000; assert.ok(parseExecutionPlan(output(input()), t, owner));
});

test("saved plan is the approval boundary and does not launch readers or writer before approval", () => {
  const t = task(); t.pauseAfterPlan = true;
  assert.equal(needsPlanApproval(t), false);
  apply(t, input([specialist("a"), specialist("b", ["a"])]));
  assert.equal(needsPlanApproval(t), true);
  assert.deepEqual(readySubtasks(t).map(u => u.subtask!.key), ["a"]);
  t.planApproved = true; assert.equal(needsPlanApproval(t), false);
  const a = t.workUnits.find(u => u.subtask?.key === "a")!; a.state = "completed";
  assert.deepEqual(readySubtasks(t).map(u => u.subtask!.key), ["b"]);
});

test("event-driven revision retains completed evidence, final stages and independent review context", () => {
  const t = task(); apply(t, input([specialist("a")]));
  const a = t.workUnits.find(u => u.subtask)!; a.state = "completed"; a.output = "Verified finding";
  const first = structuredClone(t.executionPlans![0]);
  apply(t, { ...input([specialist("new")]), reason: "New contradictory evidence" });
  assert.deepEqual(t.executionPlans![0], first); assert.equal(t.executionPlans!.length, 2);
  assert.equal(t.workUnits.find(u => u.id === a.id)?.output, "Verified finding");
  assert.equal(t.workUnits.filter(u => u.role === "reporter").length, 1);
  assert.equal(t.workUnits.filter(u => u.role === "reviewer").length, 1);
  assert.doesNotMatch(buildWorkUnitPrompt(t, t.workUnits.find(u => u.role === "reviewer")!), /New contradictory evidence|Lead-owned execution plan|Verified finding/);
  const reporter = t.workUnits.find(u => u.role === "reporter")!;
  assert.deepEqual(reporter.dependsOn, [t.executionPlans!.at(-1)!.primaryUnitId]);
});

test("failed batch replans only after readers settle and preserves successful siblings and withdrawn logs", () => {
  const t = task(); apply(t, input([specialist("a"), specialist("b"), specialist("c", ["b"])]));
  const [a, b] = t.workUnits.filter(u => u.subtask);
  a.state = "running"; b.state = "failed"; b.error = "Source inaccessible";
  assert.equal(replanAfterFailure(t, b.error), undefined);
  a.state = "completed"; a.output = "Useful evidence";
  Object.assign(t, replanAfterFailure(t, b.error));
  assert.equal(t.retiredWorkUnits?.length, 2); assert.equal(t.retiredWorkUnits![0].error, b.error);
  assert.equal(t.workUnits.find(u => u.id === a.id)?.state, "completed");
  assert.equal(nextPendingUnit(t)?.planPhase, true);
  assert.ok(t.workUnits.every(u => u.dependsOn.every(id => t.workUnits.some(d => d.id === id))));
  assert.match(buildWorkUnitPrompt(t, nextPendingUnit(t)!), /Source inaccessible|Useful evidence/);
  apply(t); assert.equal(t.executionPlans!.length, 2);
  assert.equal(t.workUnits.find(u => u.id === a.id)?.output, "Useful evidence");
});

test("launch barriers preserve the entire plan even if another sibling failed first", () => {
  const t = task(); apply(t, input([specialist("a"), specialist("b")]));
  const [a, b] = t.workUnits.filter(u => u.subtask);
  a.state = "failed"; a.error = "Substantive check failed";
  b.state = "blocked"; b.launchBlocked = true; b.error = "No available CLI";
  const before = structuredClone(t);
  assert.equal(replanAfterFailure(t, a.error), undefined);
  assert.deepEqual(t, before, "no revisions, retirement or evidence loss for resource failures");
  b.state = "completed";
  assert.ok(replanAfterFailure(t, a.error), "a resolved old launch flag must not block genuine replanning");
});

test("plan loop stays bounded per round independently of token telemetry", () => {
  const t = task();
  for (let i = 0; i < MAX_PLAN_REVISIONS; i++) apply(t, { ...input(), reason: `New event ${i}` });
  const owner = nextPendingUnit(t)!;
  assert.throws(() => parseExecutionPlan(output(input()), t, owner), /上限/);
  assert.equal(parseExecutionPlan("normal work-check", t, owner), undefined);
  assert.match(buildWorkUnitPrompt(t, owner), /revision limit is reached/);
  t.execution!.tokenBudget = 1000;
  t.roundNumber = 2; assert.equal(roundPlans(t).length, 0);
  assert.ok(parseExecutionPlan(output(input()), { ...t, execution: defaultExecution }, { ...owner, planPhase: true }));
});

test("plan and withdrawn history survive restart; resume preserves completed plan and sibling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-plan-test-"));
  try {
    const store = new JsonTaskStore(join(dir, "tasks.json")); await store.init();
    const saved = await store.create({ title: "Plan", prompt: "Report", cwd: dir, strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} });
    const t = task(); t.id = saved.id; apply(t, input([specialist("a"), specialist("b")]));
    const [a, b] = t.workUnits.filter(u => u.subtask); a.state = "completed"; b.state = "running";
    await store.update(t.id, t);
    const restored = new JsonTaskStore(join(dir, "tasks.json")); await restored.init();
    const record = restored.get(t.id)!; assert.equal(record.state, "blocked");
    assert.deepEqual(record.executionPlans, t.executionPlans);
    const patch = resumePatch(record);
    assert.equal(patch.workUnits!.find(u => u.id === a.id)?.state, "completed");
    assert.equal(patch.workUnits!.find(u => u.id === t.executionPlans![0].sourceUnitId)?.state, "completed");
    assert.equal(patch.workUnits!.find(u => u.id === b.id)?.state, "pending");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
