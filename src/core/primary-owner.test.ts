import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionWorkflow, selectAgent } from "./orchestration";
import { effectiveAssignment } from "./primary-owner";
import { defaultExecution, executionGuidance } from "./execution-policy";
import type { AgentPolicy, ProviderResourceSummary, TaskRecord } from "./types";

function fixture() {
  const task: TaskRecord = {id:"owner",title:"実装",prompt:"実装",cwd:"/tmp",strategy:"balanced",workflowMode:"primary",execution:{...defaultExecution},state:"queued",createdAt:"",updatedAt:"",output:"",allowedAgentIds:["codex","claude","antigravity"],modelOverrides:{},runs:[],workUnits:createExecutionWorkflow({})};
  const policies: AgentPolicy[] = task.allowedAgentIds.map((id,i)=>({agentId:id,providerKey:id,providerLabel:id,enabled:true,authMode:"subscription",defaultModel:`model-${id}`,priority:100-i*20}));
  const resources: ProviderResourceSummary[] = policies.map(p=>({providerKey:p.providerKey,providerLabel:p.providerLabel,agentIds:[p.agentId],authModes:["subscription"],state:"available",totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,windows:[],models:[],limitSource:"unknown"}));
  return {task,unit:task.workUnits[0],settings:{agentPolicies:policies,warningPercent:70,drainPercent:90},resources,agents:policies.map(p=>({id:p.agentId,label:p.agentId,command:p.agentId,installed:true}))};
}
test("capable primary is not replaced merely to balance subscription percentages or live load",()=>{
  const input=fixture();
  input.resources[0].usedPercent=70;
  assert.equal(selectAgent({...input,providerReservations:{codex:2}}),"codex");
  const before=structuredClone(input.task);
  const owner={id:"r",workUnitId:input.unit.id,primary:true,role:"worker" as const,agentId:"claude" as const,providerKey:"claude",model:"old-alias",state:"completed" as const,output:"",startedAt:""};
  input.task.runs.push(owner);
  assert.equal(selectAgent(input),"claude","same owner continues after planning or a mode boundary");
  assert.equal(effectiveAssignment(input.task,input.unit)?.model,undefined,"current model configuration, not stale alias, is applied");
  assert.deepEqual(before.runs,[]);
  input.task.workUnits[0].primary=false;
  assert.equal(effectiveAssignment(input.task,input.unit),undefined,"ordinary peers do not inherit primary");
});
test("primary continuity never bypasses quota/auth, enabled services or a retry choice",()=>{
  const input=fixture();
  input.task.runs=[{id:"r",workUnitId:"old",primary:true,role:"worker",agentId:"codex",providerKey:"codex",state:"completed",output:"",startedAt:""}];
  input.resources[0].state="cooldown";
  assert.equal(selectAgent(input),"claude");
  input.unit.retryAgentId="antigravity"; assert.equal(selectAgent(input),"antigravity");
  input.task.allowedAgentIds=["codex"]; assert.equal(selectAgent(input),undefined);
});
test("capability observations can select the primary even under an old quota-saver strategy",()=>{
  const input=fixture();input.task.strategy="quota-saver";
  input.settings.agentPolicies.forEach(p=>p.priority=80);
  input.resources[1].usedPercent=70;
  const benchmarks={enabled:true,hasKey:false,fetchedAt:new Date().toISOString(),models:[
    {id:"model-codex",name:"model-codex",intelligence:40,coding:40,agentic:40},
    {id:"model-claude",name:"model-claude",intelligence:90,coding:90,agentic:90}
  ]};
  assert.equal(selectAgent({...input,benchmarks}),"claude");
  input.resources[1].state="unavailable";
  assert.equal(selectAgent({...input,benchmarks}),"codex","capability never bypasses availability");
});
test("explicit owner selection wins but never leaks into independent review",()=>{
  const input=fixture();
  input.task.assignments={worker:{agentId:"antigravity",allowFallback:false}};
  assert.equal(selectAgent(input),"antigravity");
  const review=input.task.workUnits.find(u=>u.role==="reviewer")!;
  assert.equal(effectiveAssignment(input.task,review),undefined);
  const prompt=executionGuidance(input.task,input.unit);
  assert.match(prompt,/token estimates do NOT gate/);
  assert.match(prompt,/Actual rate-limit windows/);
  assert.equal(defaultExecution.contextTokens,undefined);
});
