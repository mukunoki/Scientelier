import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPresetStore } from "./work-presets";
import { JsonTaskStore } from "./task-store";
import { implementationTransitionPatch, approvedScopeChangePatch } from "./scope-transition";
import { captureRound, nextRoundPatch, validateFollowup } from "./iterations";
import { goalEditable, updateGoalContract } from "./goals";
import { createExecutionWorkflow, buildWorkUnitPrompt } from "./orchestration";
import type { FollowupInput } from "./types";

test("criterion changes require exact explicit approval and retain objective, required flags and prior history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "criterion-approval-"));
  try {
    const store = new JsonTaskStore(join(dir, "tasks.json")); await store.init();
    const task = await store.create({title:"Numeric work",prompt:"Implement verified BLAS",cwd:dir,strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{},goalMode:"manual"});
    task.goal = {...task.goal!, status:"approved", revision:8, questions:[], constraints:["No FP64"],criteria:[
      {id:"numerical_specification",description:"Fix tolerances before implementation",verification:"Check original timestamps",required:true},
      {id:"report",description:"Produce PDF",verification:"Inspect all pages",required:true}
    ]};
    const old = structuredClone(task);
    const edit = {id:"numerical_specification",description:"Disclose later tolerance changes",verification:"Independent assessment of chronology and tolerances"};
    const input: FollowupInput = {instruction:"Apply the explicitly revised criterion and review it",kind:"continue",assignments:{},pauseAfterPlan:false,
      scopeChange:{goalRevision:8,removeConstraints:[],removeOutOfScope:[],criterionEdits:[edit],implementation:false,confirmed:true}};
    const patch = approvedScopeChangePatch(task,input);
    assert.equal(patch.goal!.objective,old.goal!.objective);
    assert.deepEqual(patch.goal!.criteria[0],{...edit,required:true});
    assert.deepEqual(patch.goal!.criteria[1],old.goal!.criteria[1]);
    assert.deepEqual(patch.goal!.constraints,["No FP64"]);
    assert.deepEqual(patch.goalHistory!.at(-1),old.goal);
    assert.equal(patch.goal!.revision,9); assert.equal(patch.reviewPolicy,"adversarial-pair");
    assert.deepEqual(task,old);
    assert.throws(()=>approvedScopeChangePatch({...task,...patch},input),/更新/);
    for (const invalid of [[{...edit,id:"unknown"}],[edit,edit],[{...edit,description:" "}],[{...edit,required:false}],"invalid"]) {
      assert.throws(()=>validateFollowup({...input,scopeChange:{...input.scopeChange!,criterionEdits:invalid as typeof edit[]}},task),/合格条件/);
    }
    const ordinary = validateFollowup({...input,instruction:"OK",scopeChange:undefined},task);
    assert.equal(ordinary.scopeChange,undefined); assert.deepEqual(task,old);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("confirmed scope changes remove only selected restrictions, reject stale approvals and apply beyond idea mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-scope-approval-"));
  try {
    const library = new WorkPresetStore(join(process.cwd(), "assets/work-presets"), join(dir, "presets"));
    const store = new JsonTaskStore(join(dir, "tasks.json")); await store.init();
    const coding = await library.capture("coding");
    for (const id of ["idea", "coding", "research-project", undefined]) {
      const task = await store.create({ title: "Scope", prompt: "Original technical objective", cwd: dir, strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, goalMode: "manual" }, id ? await library.capture(id) : undefined);
      const limit = "着想検討と必要範囲の先行例確認に専念する。", exclusion = "演算カーネルの実装、性能ベンチマークや数値実験の実行。";
      task.goal = { ...task.goal!, status: "approved", revision: 5, questions: [], constraints: ["演算経路にはFP64命令を使用しない。", limit, "別環境に移行しない。"], outOfScope: [exclusion, "公開・投稿。"] };
      task.state = "awaiting-input"; task.awaitingReason = "result";
      const old = structuredClone(task);
      const input: FollowupInput = { instruction: "Apple M5でFP32と整数演算による実装・精度検証・性能比較を実施する。", kind: "continue", assignments: {}, pauseAfterPlan: false,
        scopeChange: { goalRevision: 5, removeConstraints: [limit], removeOutOfScope: [exclusion], implementation: true, confirmed: true } };
      const patch = approvedScopeChangePatch(task, input, coding);
      assert.deepEqual(task, old, "constructing a patch cannot mutate the saved task");
      assert.equal(patch.goal!.revision, 6); assert.equal(patch.goal!.status, "approved");
      assert.deepEqual(patch.goal!.constraints, ["演算経路にはFP64命令を使用しない。", "別環境に移行しない。"]);
      assert.deepEqual(patch.goal!.outOfScope, ["公開・投稿。"]);
      assert.deepEqual(patch.goalHistory!.at(-1), old.goal);
      assert.equal(patch.remote, undefined); assert.equal(patch.execution, undefined); assert.equal(patch.allowedAgentIds, undefined);
      assert.equal((patch.workPreset ?? task.workPreset)!.manifest.focus, id === "research-project" ? "research" : "implementation");
      task.history = [captureRound(task)];
      const current = {...task,...nextRoundPatch(task,input),...patch};
      assert.equal(current.state, "queued"); assert.equal(current.goalRevisionPending, undefined);
      assert.equal(current.workUnits.some(u=>u.ideaPhase), false);
      const prompt = buildWorkUnitPrompt(current,current.workUnits[0]);
      const approved = JSON.parse(prompt.match(/# User-approved goal[^\n]*\n([^\n]+)/)![1]);
      assert.deepEqual(approved.constraints, patch.goal!.constraints); assert.deepEqual(approved.outOfScope, ["公開・投稿。"]);
      assert.throws(()=>approvedScopeChangePatch(current,input,coding),/更新/);
      assert.throws(()=>validateFollowup({...input,kind:"review"},task),/確認画面/);
      assert.throws(()=>validateFollowup({...input,scopeChange:{...input.scopeChange!,removeConstraints:["未知の条件"]}},task),/解除対象/);
      assert.throws(()=>validateFollowup({...input,scopeChange:{...input.scopeChange!,confirmed:false as unknown as true}},task),/確認画面/);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("explicit idea transition drafts a new goal, retaining artifacts, old rules, restrictions and budgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-transition-"));
  try {
    const library = new WorkPresetStore(join(process.cwd(), "assets/work-presets"), join(dir, "presets"));
    const store = new JsonTaskStore(join(dir, "tasks.json")); await store.init();
    let task = await store.create({ title: "Idea", prompt: "Design an idea without experiments", cwd: dir, strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {} }, await library.capture("idea"));
    task.goal = { ...task.goal!, status: "approved", questions: [], constraints: ["本段階では実験しない", "外部へのデータ転送は禁止"], outOfScope: ["新しい設備の購入"] };
    task.state = "completed";
    task.workUnits[0].state = "completed"; task.workUnits[0].output = "Existing idea evidence";
    task.runs = [{ id: "old-run", workUnitId: task.workUnits[0].id, agentId: "codex", providerKey: "openai", role: "worker", state: "completed", output: "Idea handoff", startedAt: task.createdAt, usage: { inputTokens: 500, outputTokens: 100, source: "reported" } }];
    task.history = [captureRound(task)];
    const before = structuredClone(task), input = { kind: "continue" as const, instruction: "提案Aを実装し、入力100件で基準法と実測比較する", assignments: {}, pauseAfterPlan: true, implementation: true };
    const pending = validateFollowup(input, task); assert.equal(pending.implementation, true);
    assert.deepEqual(task, before);
    const coding = await library.capture("coding");
    task = { ...task, ...nextRoundPatch(task, input), ...implementationTransitionPatch(task, input, coding) };
    assert.equal(task.state, "awaiting-input"); assert.equal(task.goal!.status, "draft"); assert.equal(task.goalRevisionPending, true);
    assert.equal(task.workPreset!.manifest.focus, "implementation"); assert.equal(task.goal!.objective, input.instruction);
    assert.deepEqual(task.goal!.constraints, before.goal!.constraints); assert.deepEqual(task.goal!.outOfScope, before.goal!.outOfScope);
    assert.equal(task.goal!.criteria.length, before.goal!.criteria.length + 1);
    assert.deepEqual(task.runs, before.runs); assert.deepEqual(task.execution, before.execution); assert.equal(task.cwd, before.cwd);
    assert.equal(task.history![0].workPreset!.manifest.focus, "idea"); assert.deepEqual(task.goalHistory!.at(-1), before.goal);
    assert.equal(task.workUnits.length, 0); assert.equal(goalEditable(task), true);
    assert.equal(goalEditable({ ...task, scopeTransition: undefined }), false);
    const preparation = buildWorkUnitPrompt({ ...task, goalPreparation: true }, before.workUnits[0]);
    assert.match(preparation, /Prepare the NEW goal/); assert.match(preparation, /Do not execute anything/);
    await store.update(task.id, task);
    const restored = new JsonTaskStore(join(dir, "tasks.json")); await restored.init();
    assert.equal(goalEditable(restored.get(task.id)!), true, "restart does not discard the scope-change draft");
    const patch = updateGoalContract(task, { ...task.goal, constraints: ["外部へのデータ転送は禁止"] }, task.goal!.revision, true);
    task = { ...task, ...patch, workUnits: createExecutionWorkflow(task) };
    assert.equal(task.goal!.status, "approved"); assert.equal(task.goalRevisionPending, undefined);
    assert.equal(goalEditable(task), false, "scope change does not permanently unlock goal editing");
    assert.equal(task.workUnits.some(u => u.ideaPhase), false);
    const worker = { ...task.workUnits.find(u => u.primary)!, planPhase: false };
    const prompt = buildWorkUnitPrompt(task, worker);
    assert.match(prompt, /User-approved scope transition/); assert.match(prompt, /コーディング（実装）に専念/);
    assert.doesNotMatch(prompt, /着想検討に専念する/);
    assert.throws(() => validateFollowup(input, task), /アイディアモード/);
    assert.throws(() => validateFollowup({ ...input, kind: "review" }, before), /修正・続行/);
    assert.throws(() => implementationTransitionPatch(before, { ...input, implementation: false }, coding));
    assert.throws(() => implementationTransitionPatch(before, { ...input, instruction: "a".repeat(8001) }, coding), /8,000/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
