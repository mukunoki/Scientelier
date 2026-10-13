import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPresetStore, workPresetPrompt, RESEARCH_STAGES } from "./work-presets";
import { JsonTaskStore } from "./task-store";
import { buildWorkUnitPrompt, createExecutionWorkflow, nextPendingUnit } from "./orchestration";
import { createFollowupWorkflow, needsPlanApproval } from "./iterations";
import { orderAutonomousUnits, repairUnits } from "./autonomy";
import { pairUnits } from "./review-pair";
import { applyExecutionPlan, parseExecutionPlan, roundPlans } from "./execution-plan";
import { continuation, defaultExecution } from "./execution-policy";
import { focusedContext } from "./focused-context";
import { roleGuidance } from "./work-guidance";
import { restartedTask } from "./task-restart";
import type { TaskRecord } from "./types";

async function fixture(run: (presets: WorkPresetStore, store: JsonTaskStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "harness-work-modes-"));
  try {
    const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
    await run(new WorkPresetStore(join(process.cwd(), "assets/work-presets"), join(directory, "presets")), store);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const input = { title: "Modes fixture", prompt: "Approved subject", cwd: "/tmp", strategy: "balanced" as const,
  workflowMode: "primary" as const, goalMode: "manual" as const, allowedAgentIds: ["codex" as const, "claude" as const], modelOverrides: {} };

test("dedicated modes retain boundaries while research/paper use one primary manuscript", async () => fixture(async (presets, store) => {
  for (const [id, focus, rule] of [["research", "literature", /関連研究調査に専念/], ["coding", "implementation", /コーディング（実装）に専念/], ["paper", "paper", /論文執筆に専念/], ["idea", "idea", /着想探索と実証に専念/], ["research-project", "research", /統合研究：着想検討/]] as const) {
    const preset = await presets.capture(id), task = await store.create(input, preset);
    assert.equal(preset.manifest.focus, focus);
    assert.equal(preset.documentTemplate, undefined);
    assert.equal(preset.manifest.primaryDocument, ["research-project", "paper"].includes(id) ? "paper" : undefined);
    assert.equal(task.workUnits.some(u => u.researchStage), false);
    for (const unit of task.workUnits) assert.match(workPresetPrompt(task, unit), rule);
    const draft = await store.create({ ...input, goalMode: "ai" }, preset);
    assert.equal(draft.workUnits.length, 1); assert.equal(draft.workUnits[0].ideaPhase, undefined);
    assert.match(buildWorkUnitPrompt(draft, draft.workUnits[0]), rule);
    assert.match(buildWorkUnitPrompt(draft, draft.workUnits[0]), /not executing it/);
  }
}));

test("new idea mode explores multiple methods with prototype writes, while legacy scopes and approved constraints remain",async()=>fixture(async(presets,store)=>{
  const preset=await presets.capture("idea"); assert.equal(preset.manifest.ideaApproach,"experimental");
  const task=await store.create(input,preset); task.goal!.status="approved"; task.goal!.constraints=["FP64命令禁止","別マシンへ移動しない"];
  const worker={...task.workUnits[0],planPhase:false};
  assert.equal(worker.mode,"write");
  const prompt=buildWorkUnitPrompt(task,worker);
  assert.match(prompt,/複数の方法/); assert.match(prompt,/実機上で予備評価/); assert.match(prompt,/書き込み禁止モードではない/);
  assert.match(prompt,/FP64命令禁止/); assert.match(prompt,/別マシンへ移動しない/);
  assert.doesNotMatch(prompt,/検証は設計までとし実行しない|コードや実験結果がないことを不足扱いしない/);
  assert.match(workPresetPrompt({...task,goalPreparation:true},task.workUnits[0]),/Goal preparation remains read-only/);
  const legacy=structuredClone(preset); delete legacy.manifest.ideaApproach;
  assert.match(workPresetPrompt({...task,workPreset:legacy},worker),/実装・実験実行・論文執筆には自動で進まない/);
  const integrated=await presets.capture("research-project");
  assert.equal(integrated.stages![0].revision,preset.revision,"research uses the same experimental idea rule revision");
  assert.deepEqual(integrated.stages![0].manifest,preset.manifest);
  assert.equal(integrated.stages![0].rules,preset.rules);
}));

test("research captures the edited constituent modes, fingerprints changes and preserves existing tasks", async () => fixture(async (presets, store) => {
  const old = await presets.capture("research-project");
  assert.deepEqual(old.stages!.map(p=>p.manifest.id),RESEARCH_STAGES);
  for (const id of RESEARCH_STAGES) {
    const p = await presets.capture(id);
    await presets.saveRules(id,p.revision,p.rules.replace("## 作業\n",`## 作業\nWORK_${id}_CUSTOM\n`).replace("## 検証\n",`## 検証\nREVIEW_${id}_CUSTOM\n`).replace("## ゴール設計\n",`## ゴール設計\nGOAL_${id}_CUSTOM\n`));
  }
  const current = await presets.capture("research-project");
  assert.notEqual(current.revision,old.revision);
  await assert.rejects(presets.capture("research-project",old.revision),/変更/);
  const task = await store.create(input,current);
  for (const id of RESEARCH_STAGES) {
    const stage = {...task.workUnits[0],researchStage:id,planPhase:false};
    const prompt = workPresetPrompt(task,stage);
    assert.match(prompt,new RegExp(`WORK_${id}_CUSTOM`));
    for (const other of RESEARCH_STAGES.filter(p=>p !== id)) assert.doesNotMatch(prompt,new RegExp(`WORK_${other}_CUSTOM`));
  }
  const reviewer = task.workUnits.find(u=>u.role === "reviewer")!;
  for (const id of RESEARCH_STAGES) assert.match(workPresetPrompt(task,reviewer),new RegExp(`REVIEW_${id}_CUSTOM`));
  const goal = await store.create({...input,goalMode:"ai"},current);
  for (const id of RESEARCH_STAGES) assert.match(workPresetPrompt(goal,goal.workUnits[0]),new RegExp(`GOAL_${id}_CUSTOM`));
  const p = await presets.capture("idea"); await presets.saveRules("idea",p.revision,p.rules+"\nFUTURE_IDEA_RULE");
  assert.doesNotMatch(JSON.stringify(store.get(task.id)!.workPreset),/FUTURE_IDEA_RULE/);
  assert.doesNotMatch(JSON.stringify(old),/WORK_idea_CUSTOM/);
}));

test("legacy composed research stages stay ordered across plans, handoffs, repair and restart", async () => fixture(async (presets,store)=>{
  const legacy=await presets.capture("research-project"); delete legacy.manifest.integratedWorkflow;
  const task = await store.create(input,legacy);
  task.goal!.status="approved"; task.execution={...defaultExecution}; task.reviewPolicy="adversarial-pair";
  task.workUnits=orderAutonomousUnits(pairUnits(task.workUnits));
  assert.deepEqual(task.workUnits.filter(u=>u.researchStage).map(u=>u.researchStage),RESEARCH_STAGES);
  for (const id of RESEARCH_STAGES) {
    const owner=nextPendingUnit(task)!; assert.equal(owner.researchStage,id); assert.equal(owner.planPhase,true);
    const plan={summary:"Stage plan",reason:"Stage started",primaryWork:"Do current stage only",acceptance:"Verify this stage",criterionIds:[task.goal!.criteria[0].id],estimatedTokens:1500,estimatedMinutes:5,escalation:"Only missing authority",tasks:[]};
    assert.ok(parseExecutionPlan(`<execution-plan>${JSON.stringify(plan)}</execution-plan>`,task,owner),"later-stage criteria need not be claimed here");
    owner.state="completed";
    Object.assign(task,applyExecutionPlan(task,owner,plan));
    const worker=nextPendingUnit(task)!; assert.equal(worker.researchStage,id); assert.equal(worker.planPhase,undefined);
    assert.equal(roundPlans(task,id).length,1);
    const nextStage=task.workUnits.find(u=>u.planPhase && u.state === "pending");
    if(nextStage) assert.ok(nextStage.dependsOn.includes(worker.id));
    worker.state="completed"; worker.checkpointHandled=true; worker.output=`${id}_UNVERIFIED_CLAIM`;
    task.runs.push({id:`run-${id}`,workUnitId:worker.id,primary:true,state:"completed",sessionId:"saved",agentId:"codex",goalRevision:task.goal!.revision,startedAt:"",output:""} as TaskRecord["runs"][number]);
    if(nextStage) assert.equal(continuation(task,nextStage,"codex").run,undefined,"do not inherit the prior mode's session restrictions");
  }
  assert.equal(nextPendingUnit(task)?.role,"reporter");
  for(const reviewer of task.workUnits.filter(u=>u.role === "reviewer")) assert.doesNotMatch(buildWorkUnitPrompt(task,reviewer),/idea_UNVERIFIED_CLAIM/);
  const repair=repairUnits(task,{goalRevision:task.goal!.revision,cycle:1,round:1,reviewedAt:"",nextAction:"repair",summary:"Missing evidence",criteria:[],concerns:["Correct evidence"],repairInstructions:"Fix implementation and update paper"});
  assert.deepEqual(repair.filter(u=>u.researchStage).map(u=>u.researchStage),RESEARCH_STAGES);
  assert.equal(repair.filter(u=>u.role === "reviewer").length,2);
  const followup=createFollowupWorkflow({kind:"continue",instruction:"Improve existing result",assignments:{},pauseAfterPlan:false},task);
  assert.deepEqual(followup.filter(u=>u.researchStage).map(u=>u.researchStage),RESEARCH_STAGES);
  const next=restartedTask({...task,state:"completed"},"fresh","/tmp/research-restart");
  assert.deepEqual(next.workPreset,task.workPreset);
  assert.deepEqual(next.workUnits.filter(u=>u.researchStage).map(u=>u.researchStage),RESEARCH_STAGES);
}));

test("legacy integrated ideation keeps its graph, with normal report and two-review gates", async () => fixture(async (presets, store) => {
  const captured = await presets.capture("research-project"); delete captured.stages; delete captured.manifest.integratedWorkflow;
  const task = await store.create(input, captured);
  for (const mode of ["primary", "staged"] as const) for (const separate of [false, true]) {
    task.workflowMode = mode;
    task.assignments = separate ? { planner: { agentId: "claude", allowFallback: true } } : {};
    task.workUnits = orderAutonomousUnits(pairUnits(createExecutionWorkflow(task)));
    const idea = task.workUnits[0];
    assert.ok(idea.ideaPhase); assert.equal(idea.mode, "read"); assert.equal(idea.primary, undefined);
    assert.equal(nextPendingUnit(task)?.id, idea.id);
    assert.deepEqual(task.workUnits[1].dependsOn, [idea.id]);
    assert.match(roleGuidance(idea), /initial, read-only ideation phase/);
    assert.doesNotMatch(roleGuidance(idea), /Plan only:/);
    idea.state = "completed"; idea.output = "Provisional ideas";
    task.pauseAfterPlan = true;
    assert.equal(needsPlanApproval(task), false, "ideation is not plan approval");
    assert.equal(nextPendingUnit(task)?.id, task.workUnits[1].id);
    const roles = task.workUnits.map(u => u.role);
    assert.deepEqual(roles.slice(-3), ["reporter", "reviewer", "reviewer"]);
    assert.deepEqual(task.workUnits.slice(-2).map(u => u.reviewPass), [1, 2]);
  }
  task.workflowMode = "primary";
  for (const kind of ["continue", "report", "review", "consult"] as const) {
    assert.equal(createFollowupWorkflow({ kind, instruction: "Continue existing work", assignments: {}, pauseAfterPlan: false }, task).some(u => u.ideaPhase), false);
  }
  const legacy = structuredClone(task.workPreset!); delete legacy.manifest.focus;
  assert.equal(createExecutionWorkflow({ ...task, workPreset: legacy }).some(u => u.ideaPhase), false, "old snapshot IDs do not trigger migrations");
  assert.equal(createExecutionWorkflow({ ...task, workPreset: undefined }).some(u => u.ideaPhase), false);
  for (const mode of ["carry", "fresh"] as const) {
    const next = restartedTask({ ...task, state: "completed" }, mode, "/tmp/mode-restart");
    assert.deepEqual(next.goal, task.goal); assert.deepEqual(next.workPreset, task.workPreset);
    assert.equal(next.workUnits.filter(u => u.ideaPhase).length, 1);
    assert.equal(next.workUnits.filter(u => u.reviewPass).length, 2);
  }
}));

test("legacy ideation survives dynamic planning but does not bias independent reviews", async () => fixture(async (presets, store) => {
  const captured = await presets.capture("research-project"); delete captured.stages; delete captured.manifest.integratedWorkflow;
  const task = await store.create(input, captured);
  task.goal!.status = "approved";
  task.workUnits = orderAutonomousUnits(task.workUnits);
  const idea = task.workUnits[0], owner = task.workUnits[1];
  idea.state = "completed"; idea.output = "IDEA_UNIQUE: provisional hypothesis with a falsification test";
  assert.match(focusedContext(task, owner), /IDEA_UNIQUE/);
  owner.state = "completed"; owner.output = "The dynamic plan";
  Object.assign(task, applyExecutionPlan(task, owner, { summary: "A complete research plan", reason: "initial", primaryWork: "Survey, implement, evaluate and write based on the hypothesis", acceptance: "Verify required artifacts", criterionIds: task.goal!.criteria.map(c => c.id), estimatedTokens: 8000, estimatedMinutes: 20, escalation: "Ask for conflicting scope", tasks: [] }));
  const worker = task.workUnits.find(u => u.primary && !u.planPhase)!;
  assert.match(focusedContext(task, worker), /IDEA_UNIQUE/);
  assert.match(focusedContext(task, worker), /provisional hypotheses, NOT verified findings/);
  for (const reviewer of task.workUnits.filter(u => u.role === "reviewer")) assert.doesNotMatch(buildWorkUnitPrompt(task, reviewer), /IDEA_UNIQUE/);
  const saved = await store.update(task.id, task);
  assert.equal(saved.workUnits.filter(u => u.ideaPhase).length, 1);
  assert.equal(saved.workUnits[0].output, idea.output);
}));
