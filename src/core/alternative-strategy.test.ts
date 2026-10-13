import test from "node:test";
import assert from "node:assert/strict";
import { validatePlanTasks, validatePlanFormat, type PlanContract } from "./plan-format";
import { applyExecutionPlan, executionPlanPrompt } from "./execution-plan";
import { createExecutionWorkflow, buildWorkUnitPrompt } from "./orchestration";
import { continuation } from "./execution-policy";
import { readySubtasks } from "./decomposition";
import { focusedContext } from "./focused-context";
import { meetsModelRequirements } from "./work-requirements";
import type { SubtaskSpec, TaskRecord } from "./types";

const contract: PlanContract = { criterionIds:["c"], requiredCriterionIds:["c"], maxSubtasks:8, allowPrimarySteps:true, allowIsolatedWork:true, allowAlternativeWork:true };
function candidates(): SubtaskSpec[] {
  return ["a","b"].map((key,i)=>({key,title:`独立案 ${key}`,instructions:"固定問題を独立に解く",deliverable:"解法と証拠",acceptance:"共通検査",criterionIds:["c"],dependsOn:[],estimatedTokens:1000,estimatedMinutes:5,
    comparison:{input:"問題の版 v1、source.json SHA256 abc",evaluation:"必須テストを満たし、精度を優先。同点は保守性。全案不合格なら不採用。",approach:i?"解析的な解法":"探索的な解法"},
    requirements:{independenceGroup:"solve",modelFamilies:[i?"anthropic":"openai"]}}));
}
function fixture(): TaskRecord {
  return {id:"alternatives",title:"同じ問題",prompt:"解法を探す",cwd:"/tmp",strategy:"balanced",workflowMode:"primary",allowedAgentIds:["codex","claude"],modelOverrides:{},runs:[],state:"running",createdAt:"",updatedAt:"",output:"",
    execution:{reuseContext:true,decompose:true,maxSubtasks:8,maxParallel:2},workUnits:createExecutionWorkflow({workflowMode:"primary"}),
    goal:{revision:1,status:"approved",updatedAt:"",objective:"解く",deliverables:["結果"],criteria:[{id:"c",description:"正しさ",required:true,verification:"テスト"}],constraints:[],outOfScope:[],questions:[]}};
}
const plan=(tasks=candidates())=>({summary:"独立案を比較",reason:"解法の不確実性",primaryWork:"比較して統合",acceptance:"採用案を再検証",criterionIds:["c"],estimatedTokens:2000,estimatedMinutes:4,escalation:"新しい権限",tasks});

test("independent alternatives preserve contracts, run without peer dependencies, and join before selection",()=>{
  const specs=validatePlanTasks(candidates(),contract);assert.deepEqual(specs,candidates());
  const t=fixture(),owner=t.workUnits[0];owner.state="completed";owner.output="PEER_VERDICT_SECRET";
  Object.assign(t,applyExecutionPlan(t,owner,plan(specs)));
  assert.equal(readySubtasks(t).length,2);
  const children=t.workUnits.filter(u=>u.subtask);
  for(const child of children) {
    assert.deepEqual(child.dependsOn,[owner.id]);
    assert.match(child.instructions,/他候補の出力/);
    assert.doesNotMatch(focusedContext(t,child),/PEER_VERDICT_SECRET/);
    assert.equal(continuation(t,child,"codex","gpt-6-astra").run,undefined);
  }
  assert.equal(meetsModelRequirements(t,children[1],"gpt-6-astra"),false);
  assert.equal(meetsModelRequirements(t,children[1],"opus"),true);
  const integrator=t.workUnits.find(u=>u.primary&&!u.planPhase&&u.planRevision)!;
  assert.ok(children.every(c=>integrator.dependsOn.includes(c.id)));
  assert.match(integrator.instructions,/比較表/);assert.match(integrator.instructions,/全案不採用/);
  assert.match(integrator.instructions,/最終独立レビューの代わりではありません/);
  assert.ok(t.workUnits.some(u=>u.role==="reviewer"));
  assert.match(executionPlanPrompt(fixture(),fixture().workUnits[0]),/Independent alternatives/);
});

test("comparison rejects incoherent inputs, criteria, dependency shortcuts, shared methods and fake diversity",()=>{
  const invalid: Array<(a:SubtaskSpec[])=>void>=[
    a=>{a[1].comparison!.input="another version";},
    a=>{a[1].comparison!.evaluation="weaker checks";},
    a=>{delete a[1].comparison;},
    a=>{a[1].comparison!.approach=a[0].comparison!.approach;},
    a=>{a[1].dependsOn=["a"];},
    a=>{a[1].requirements!.modelFamilies=["openai"];},
    a=>{a[0].requirements!.independentFrom=["b"];},
    a=>{a[0].estimatedMinutes=0;},
    a=>{a[0].kind="primary-work";},
    a=>{a.push({...a[0],key:"early",comparison:undefined,requirements:undefined,kind:"primary-work",dependsOn:["a"]});},
    a=>{a.push({...a[0],key:"consumer",comparison:undefined,requirements:undefined,dependsOn:["a","b"]});}
  ];
  for(const change of invalid){const specs=candidates();change(specs);assert.throws(()=>validatePlanTasks(specs,contract));}
  const specs=candidates();
  specs.push({...specs[0],key:"choose",comparison:undefined,requirements:undefined,kind:"primary-work",dependsOn:["a","b"]});
  const t=fixture();Object.assign(t,applyExecutionPlan(t,t.workUnits[0],plan(validatePlanTasks(specs,contract))));
  assert.match(t.workUnits.find(u=>u.subtask?.key==="choose")!.instructions,/比較表/);
});

test("isolated prototypes retain ownership and permission gates; alternatives are not an HPC authority bypass",()=>{
  const specs=candidates().map(s=>({...s,kind:"isolated-work" as const,ownedFiles:[`variants/${s.key}/code.cpp`,`variants/${s.key}/test.json`]}));
  assert.equal(validatePlanTasks(specs,contract).length,2);
  assert.throws(()=>validatePlanTasks(specs,{...contract,allowAlternativeWork:false}),/HPC/);
  assert.throws(()=>validatePlanTasks(specs,{...contract,allowIsolatedWork:false}),/kind/);
  const overlap=structuredClone(specs);overlap[1].ownedFiles=overlap[0].ownedFiles;
  assert.throws(()=>validatePlanTasks(overlap,contract),/重複/);
  const t=fixture();Object.assign(t,applyExecutionPlan(t,t.workUnits[0],plan(specs)));
  const child=t.workUnits.find(u=>u.subtask)!;
  assert.equal(child.mode,"write");
  assert.match(buildWorkUnitPrompt(t,child),/assigned ownedFiles/);
  assert.doesNotMatch(focusedContext(t,child),/Read-only scope is unchanged/);
});

test("candidate estimates are telemetry, not a limit on useful parallel work",()=>{
  const parsed=validatePlanFormat(plan(),contract);
  assert.equal(parsed.tasks.length,2);
  assert.ok(parsed.estimatedTokens+parsed.tasks.reduce((sum,t)=>sum+t.estimatedTokens,0)>3000);
  assert.equal(validatePlanFormat(plan([]),contract).tasks.length,0,"small work can stay serial");
});
