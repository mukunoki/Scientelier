import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentCycleForPlan, contentCheckPatch, skipContentPeerPatch, contentCycleGuidance } from "./content-cycle";
import { validateContentWorkCheck } from "./work-check-format";
import { saveStructuredResult } from "./result-channel";
import { selectAgent, buildWorkUnitPrompt } from "./orchestration";
import { newCoordinator } from "./orchestrator";
import { taskContextManifest } from "./run-context";
import { returnWork, type WorkCheck } from "./work-guidance";
import type { TaskRecord, WorkUnit } from "./types";

function fixture() {
  const source={id:"source",primary:true,role:"worker",mode:"write",state:"completed",attemptedAgentIds:["codex"],
    title:"Owner",instructions:"Original approved work and acceptance",dependsOn:[],planRevision:1,workAttempt:1,
    contentCheck:{stage:"initial",round:1,goalRevision:7}} as WorkUnit;
  const task={id:"task",workflowMode:"primary",state:"running",roundNumber:1,autonomyCycle:1,autonomy:{enabled:true,maxCycles:3,targetMinutes:90},
    goal:{status:"approved",revision:7,objective:"Approved research",criteria:[{id:"c",required:true}]},
    allowedAgentIds:["codex","claude"],execution:{decompose:true,maxSubtasks:4,maxParallel:2},modelOverrides:{},
    runs:[{id:"run",workUnitId:source.id,role:"worker",agentId:"codex",providerKey:"openai",state:"completed",output:"UNTRUSTED OWNER CLAIM",startedAt:"old"}],
    workUnits:[source,{id:"report",role:"reporter",mode:"write",state:"pending",dependsOn:[source.id],attemptedAgentIds:[]},
      {id:"review",role:"reviewer",mode:"read",state:"pending",dependsOn:["report"],attemptedAgentIds:[]}]} as unknown as TaskRecord;
  const check:WorkCheck={status:"ready",summary:"Useful artifacts exist",remainingWork:"",estimatedRemainingMinutes:5,evidence:["source.tex"]};
  return {task,source,check};
}
test("new work plans capture the standard flow; saved graphs, scoped requests and disabled autonomy do not",()=>{
  const {task,source}=fixture();
  assert.deepEqual(contentCycleForPlan(task,source),source.contentCheck);
  for(const changed of [{goalPreparation:true},{roundKind:"report"},{roundKind:"consult"},{roundKind:"review"},
    {autonomy:{enabled:false}},{workPreset:{manifest:{id:"paper-explainer"}}}])assert.equal(contentCycleForPlan({...task,...changed} as TaskRecord,source),undefined);
  assert.equal(contentCycleForPlan(task,{...source,researchStage:"coding"}),undefined,"do not add a phase to every legacy research stage");
  assert.equal(contentCycleForPlan(task,{...source,mode:"read"}),undefined);
  assert.equal(contentCycleForPlan({...task,goal:{...task.goal!,status:"draft"}},source),undefined);
  assert.equal(contentCheckPatch(task,{...source,contentCheck:undefined},fixture().check),undefined,"old stored graphs stay unchanged");
});
test("one content peer and continued lead are added without resetting goal, runs, plan or dependencies",()=>{
  const {task,source,check}=fixture(),before=structuredClone(task);
  const patch=contentCheckPatch(task,source,check)!,next={...task,...patch};
  assert.deepEqual(task,before);assert.deepEqual(next.goal,task.goal);assert.equal(next.roundNumber,1);assert.equal(next.autonomyCycle,1);
  assert.deepEqual(next.runs,task.runs);assert.equal(next.workUnits.find(u=>u.id===source.id)!.state,"completed");
  const peer=next.workUnits.find(u=>u.contentCheck?.stage==="peer")!,response=next.workUnits.find(u=>u.contentCheck?.stage==="response")!;
  assert.equal(peer.mode,"read");assert.equal(peer.primary,undefined);assert.deepEqual(peer.dependsOn,[source.id]);
  assert.equal(response.primary,true);assert.equal(response.mode,"write");assert.equal(response.workAttempt,1);
  assert.deepEqual(response.dependsOn,[source.id,peer.id]);assert.match(response.instructions,/Original approved work and acceptance/);
  assert.deepEqual(next.workUnits.find(u=>u.id==="report")!.dependsOn,[response.id]);assert.deepEqual(next.workUnits.find(u=>u.id==="review")!.dependsOn,["report"]);
  assert.match(contentCycleGuidance(next,response),/contentDecision/);assert.equal(contentCycleGuidance(next,peer),"");
  assert.equal(contentCheckPatch(next,source,check),undefined,"never schedule a second content check");
  assert.equal(newCoordinator(next,[]),undefined,"no competing manager in the closing response");
  const retry=returnWork(next.workUnits,response,{...check,status:"needs-work",remainingWork:"Test one concrete change"}).find(u=>u.workAttempt===2)!;
  assert.equal(retry.contentCheck?.stage,"response");assert.match(contentCycleGuidance(next,retry),/終了判断/);
  const reviewer=next.workUnits.find(u=>u.role==="reviewer")!;
  assert.deepEqual(taskContextManifest(next,peer).dependencies,[]);assert.doesNotMatch(buildWorkUnitPrompt(next,peer),/UNTRUSTED OWNER CLAIM/);
  assert.deepEqual(taskContextManifest(next,reviewer).dependencies,[]);assert.doesNotMatch(buildWorkUnitPrompt(next,reviewer),/UNTRUSTED OWNER CLAIM/);
});
test("peer advice uses a different service, and absence/verified failure falls back without fake completion or new permissions",()=>{
  const {task,source,check}=fixture();const next={...task,...contentCheckPatch(task,source,check)};
  const peer=next.workUnits.find(u=>u.contentCheck?.stage==="peer")!;
  const settings={agentPolicies:[{agentId:"codex",enabled:true,providerKey:"openai",priority:100},{agentId:"claude",enabled:true,providerKey:"anthropic",priority:10}],contextMaxChars:20000,warningPercent:75,drainPercent:90} as any;
  const agents=[{id:"codex",installed:true},{id:"claude",installed:true}] as any;
  assert.equal(selectAgent({task:next,unit:peer,agents,settings,resources:[]}),"claude");
  assert.equal(selectAgent({task:next,unit:peer,agents:agents.slice(0,1),settings,resources:[]}),undefined);
  const skip=skipContentPeerPatch(next,peer,"No eligible service")!,skipped={...next,...skip};
  assert.equal(skipped.workUnits.some(u=>u.id===peer.id),false);assert.equal(skipped.retiredWorkUnits!.at(-1)!.state,"cancelled");
  assert.match(skipped.retiredWorkUnits!.at(-1)!.error!,/未実施/);assert.equal(skipped.workUnits.find(u=>u.contentCheck?.stage==="response")!.dependsOn.length,1);
  for(const changed of [{state:"paused"},{pendingExecution:{}},{runs:[{workUnitId:peer.id,state:"running"}]},
    {runs:[{workUnitId:peer.id,terminationUnconfirmed:true}]},{executionBlocker:{unitId:source.id,round:1,cycle:1,goalRevision:7}}])
    assert.equal(skipContentPeerPatch({...next,...changed} as TaskRecord,peer,"failure"),undefined);
});
test("capacity/package limits use owner self-check and real blockers/closure never create a phase",()=>{
  for(const changed of [{allowedAgentIds:["codex"]},{execution:{decompose:false,maxSubtasks:0}},{execution:{decompose:true,maxSubtasks:0}}]){
    const {task,source,check}=fixture();const next={...task,...changed} as TaskRecord;
    const p=contentCheckPatch(next,source,check)!;assert.ok(p);assert.equal(p.workUnits!.some(u=>u.contentCheck?.stage==="peer"),false);
    assert.match(p.workUnits!.find(u=>u.contentCheck?.stage==="response")!.instructions,/No separate peer/);
  }
  for(const changed of [{state:"paused"},{goalRevisionPending:true},{pendingExecution:{}},{pendingFollowup:{}},
    {runs:[{state:"running"}]},{runs:[{terminationUnconfirmed:true}]},{executionBlocker:{unitId:"source",round:1,cycle:1,goalRevision:7}},
    {workClosure:{round:1,cycle:1,goalRevision:7}}]){
    const {task,source,check}=fixture();assert.equal(contentCheckPatch({...task,...changed} as TaskRecord,source,check),undefined);
  }
  const {task,source,check}=fixture();for(const status of ["ask-user","environment-blocked"] as const)
    assert.equal(contentCheckPatch(task,source,{...check,status}),undefined);
  const repair={...check,status:"needs-work" as const,remainingWork:"Fix a concrete defect"};
  const repairing=contentCheckPatch(task,source,repair)!;
  assert.equal(repairing.workUnits!.find(u=>u.contentCheck?.stage==="response")!.workAttempt,2,"uses one existing repair allowance");
  assert.equal(contentCheckPatch({...task,autonomy:{...task.autonomy!,maxCycles:1}},source,repair),undefined);
  assert.equal(contentCheckPatch(task,source,{...repair,evidence:[]}),undefined);
});
test("closing decision validates inside the existing submission channel and never suppresses real blockers",async()=>{
  const decision={decision:"finish",explanation:"Definition and precision explained",improvement:"Compared and rejected one unhelpful change"};
  assert.equal(validateContentWorkCheck({status:"ready",contentDecision:decision},true)!.decision,"finish");
  assert.throws(()=>validateContentWorkCheck({status:"ready"},true),/contentDecision/);
  assert.throws(()=>validateContentWorkCheck({status:"ready",contentDecision:{...decision,decision:"continue"}},true),/needs-work/);
  assert.equal(validateContentWorkCheck({status:"ask-user"},true),undefined);assert.equal(validateContentWorkCheck({status:"environment-blocked"},true),undefined);
  const root=await mkdtemp(join(tmpdir(),"content-decision-"));
  try {
    await writeFile(join(root,"work-check-contract.json"),JSON.stringify({token:"t",contentDecision:true}));
    await assert.rejects(saveStructuredResult(root,"t",'<work-check>{"status":"ready"}</work-check>'),/終了判断は未受理/);
    await saveStructuredResult(root,"t",`<work-check>${JSON.stringify({status:"ready",contentDecision:decision})}</work-check>`);
    await saveStructuredResult(root,"t",'<work-check>{"status":"ask-user"}</work-check>');
    await writeFile(join(root,"work-check-contract.json"),JSON.stringify({token:"foreign",contentDecision:true}));
    await assert.rejects(saveStructuredResult(root,"t",'<work-check>{"status":"ready"}</work-check>'),/another run/);
  } finally {await rm(root,{recursive:true,force:true});}
});
