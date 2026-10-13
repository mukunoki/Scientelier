import test from "node:test";
import assert from "node:assert/strict";
import { modelFamily, meetsModelRequirements, pinnedWritingSnapshot, assertSkillRequirements } from "./work-requirements";
import { validatePlanTasks, validateWorkRequirements } from "./plan-format";
import { createExecutionWorkflow, selectAgent, buildWorkUnitPrompt } from "./orchestration";
import { applyExecutionPlan, replanAfterFailure } from "./execution-plan";
import { assignmentRecoveryCandidates, repairAssignment } from "./assignment-recovery";
import type { TaskRecord, SubtaskSpec, AgentStatus, AgentPolicy } from "./types";

const revision="a".repeat(64);
test("parallel blind groups require disjoint configured families without peer completion dependencies",()=>{
  const base={key:"a",title:"Check",instructions:"Read neutral evidence",deliverable:"Evidence",acceptance:"Verify",criterionIds:["c"],dependsOn:[],estimatedTokens:500};
  const tasks=[{...base,requirements:{independenceGroup:"sources",modelFamilies:["openai"]}}, {...base,key:"b",requirements:{independenceGroup:"sources",modelFamilies:["anthropic"]}}];
  const contract={criterionIds:["c"],requiredCriterionIds:["c"],maxSubtasks:4};
  const parsed=validatePlanTasks(tasks,contract);assert.equal(parsed[0].dependsOn.length,0);assert.equal(parsed[1].dependsOn.length,0);
  const t=fixture();const u={...t.workUnits[0],subtask:parsed[1],dependsOn:[]};
  assert.equal(meetsModelRequirements(t,u,"opus"),true);assert.equal(meetsModelRequirements(t,u,"gpt-6-astra"),false);assert.equal(meetsModelRequirements(t,u,undefined),false);
  const prompt=buildWorkUnitPrompt(t,u);assert.match(prompt,/Peer conclusions and logs are intentionally not supplied/);assert.doesNotMatch(prompt,/PEER_VERDICT_SECRET/);
  assert.throws(()=>validatePlanTasks([tasks[0]],contract));
  assert.throws(()=>validatePlanTasks([tasks[0],{...tasks[1],requirements:tasks[0].requirements}],contract),/重複/);
});
function fixture():TaskRecord {
  const task:TaskRecord={id:"fixture",title:"Source verification",prompt:"Check references",cwd:"/tmp",strategy:"balanced",workflowMode:"primary",allowedAgentIds:["codex","claude","antigravity","opencode"],modelOverrides:{},state:"awaiting-input",createdAt:"",updatedAt:"",output:"",runs:[],workUnits:createExecutionWorkflow({workflowMode:"primary"}),
    execution:{reuseContext:true,decompose:true,maxSubtasks:4,maxParallel:1,scheduling:"throughput"},goal:{revision:1,status:"approved",updatedAt:"",objective:"Verify",deliverables:["report"],criteria:[{id:"c",description:"Sources",required:true,verification:"Primary sources"}],constraints:[],outOfScope:[],questions:[]}};
  const a:SubtaskSpec={key:"a",title:"Writer A",kind:"primary-work",instructions:"Verify original sources",deliverable:"Evidence",acceptance:"Verify",criterionIds:["c"],dependsOn:[],estimatedTokens:500};
  const b:SubtaskSpec={...a,key:"b",title:"Checker B",kind:"investigation",dependsOn:["a"],requirements:{independentFrom:["a"],skills:[{id:"writing-rules",revision}]}};
  Object.assign(task,applyExecutionPlan(task,task.workUnits[0],{summary:"Two independent checks",reason:"Sources",primaryWork:"Integrate only",acceptance:"Verify both",criterionIds:["c"],estimatedTokens:500,estimatedMinutes:10,escalation:"Authority only",tasks:[a,b]}));
  const writer=task.workUnits.find(u=>u.subtask?.key==="a")!;writer.state="completed";writer.output="PEER_VERDICT_SECRET";
  task.runs=[{id:"a-run",workUnitId:writer.id,agentId:"codex",providerKey:"openai",model:"gpt-6-astra",role:"worker",state:"completed",startedAt:"",goalRevision:1,output:"",finishingSkill:{revision,rules:"Frozen original rules",capturedAt:""}}];
  return task;
}

test("hard plan requirements round-trip; malformed, ignored and unsequenced constraints fail",()=>{
  const t=fixture(),tasks=t.executionPlans![0].tasks;
  const contract={criterionIds:["c"],requiredCriterionIds:["c"],maxSubtasks:4,allowPrimarySteps:true};
  assert.deepEqual(validatePlanTasks(tasks,contract),tasks);
  assert.throws(()=>validatePlanTasks([{...tasks[1],dependsOn:[]}],contract),/直接依存/);
  assert.throws(()=>validatePlanTasks([{...tasks[0],provider:"google"}],contract),/requirements/);
  for(const value of [{modelFamilies:["auto"]},{independentFrom:[]},{skills:[{id:"../secret"}]},{skills:[{id:"writing-rules",revision:"wrong"}]},{skills:[{id:"x"},{id:"x"}]}])assert.throws(()=>validateWorkRequirements(value));
});

test("routing checks explicit family, not CLI/provider; unknowns never certify independence",()=>{
  const t=fixture(),b=t.workUnits.find(u=>u.subtask?.key==="b")!;
  assert.equal(modelFamily("ollama/deepseek-v4.1-flash:cloud"),"deepseek");assert.equal(modelFamily("auto"),undefined);
  assert.equal(meetsModelRequirements(t,b,"gpt-6-astra"),false);
  assert.equal(meetsModelRequirements(t,b,undefined),false);
  assert.equal(meetsModelRequirements(t,b,"gemini-3.8-flash-high"),true);
  const agents:AgentStatus[]=t.allowedAgentIds.map(id=>({id,label:id,command:id,installed:true}));
  const policies:AgentPolicy[]=agents.map(a=>({agentId:a.id,enabled:true,providerKey:a.id,providerLabel:a.id,authMode:"subscription",priority:50,defaultModel:a.id==="opencode"?"ollama/deepseek-v4.1-flash:cloud":"gpt-6-astra"}));
  const input={task:t,unit:b,agents,settings:{agentPolicies:policies,warningPercent:70,drainPercent:85},resources:[]};
  assert.equal(selectAgent(input),"opencode","different CLI with the same OpenAI family is still excluded");
  assert.equal(selectAgent({...input,agents:agents.filter(a=>a.id!=="opencode")}),undefined);
  t.runs[0].model=undefined;assert.equal(selectAgent(input),undefined);
});

test("pinned writing rules are the saved revision, not today's rules or the wrapper hash",()=>{
  const t=fixture(),b=t.workUnits.find(u=>u.subtask?.key==="b")!;
  assert.equal(pinnedWritingSnapshot(t,b)?.rules,"Frozen original rules");
  assert.throws(()=>assertSkillRequirements(b,[]),/未配布/);
  assert.throws(()=>assertSkillRequirements(b,[{id:"writing-rules",revision:"b".repeat(64)}]),/指定版/);
  assertSkillRequirements(b,[{id:"writing-rules",revision}]);
  assert.doesNotMatch(buildWorkUnitPrompt(t,b),/PEER_VERDICT_SECRET/);
  assert.match(buildWorkUnitPrompt(t,b),/Independent specialist/);
  t.goal!.revision=2;assert.throws(()=>pinnedWritingSnapshot(t,b),/保存版/);
});

test("explicit repair restores a retired B without repeating A or weakening downstream review",()=>{
  const t=fixture(),b=t.workUnits.find(u=>u.subtask?.key==="b")!,a=t.workUnits.find(u=>u.subtask?.key==="a")!;
  b.state="failed";Object.assign(t,replanAfterFailure(t,"Wrong family"));
  const primary=t.workUnits.find(u=>u.primary&&u.planRevision)!;primary.state="completed";primary.checkpointHandled=true;
  t.state="awaiting-input";t.awaitingReason="result";
  const before=JSON.stringify(t),candidates=assignmentRecoveryCandidates(t);assert.equal(candidates[0].id,b.id);
  const patch=repairAssignment(t,b.id,{...b.subtask!.requirements,modelFamilies:["gemini","deepseek"]});
  assert.equal(JSON.stringify(t),before,"repair is a pure patch, not mutation of saved history");
  assert.notEqual(patch.resumeFromUnitId,b.id);assert.equal(patch.state,"paused");
  assert.deepEqual(patch.workUnits!.find(u=>u.id===a.id),a);
  assert.equal(patch.workUnits!.find(u=>u.id===primary.id)!.planPhase,false);
  assert.ok(patch.workUnits!.find(u=>u.id===primary.id)!.dependsOn.includes(patch.resumeFromUnitId!));
  assert.equal(t.retiredWorkUnits!.find(u=>u.id===b.id)!.state,"failed");
  assert.deepEqual(patch.workUnits!.filter(u=>["reporter","reviewer"].includes(u.role)).map(u=>u.id),t.workUnits.filter(u=>["reporter","reviewer"].includes(u.role)).map(u=>u.id));
  assert.equal(patch.goal,undefined);assert.equal(patch.execution,undefined);assert.equal(patch.allowedAgentIds,undefined);
  assert.throws(()=>repairAssignment(t,b.id,{skills:[]}),/配列/);
  assert.throws(()=>repairAssignment(t,b.id,{}),/取り除く/);
  t.pendingFollowup={kind:"consult",instruction:"Do not resume",assignments:{},pauseAfterPlan:false};assert.equal(assignmentRecoveryCandidates(t).length,0);
});
