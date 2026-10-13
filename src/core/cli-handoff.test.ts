import test from "node:test";
import assert from "node:assert/strict";
import { cliHandoffTask, cliHandoffUnit } from "./cli-handoff";
import { resumePatch } from "./recovery";
import { selectAgent, type AgentSelectionInput } from "./orchestration";
import { createCrossReviews } from "./cross-review";
import type { TaskRecord, AgentRun } from "./types";

function fixture():TaskRecord {
  return {id:"task",title:"Task",prompt:"Work",cwd:"/tmp",strategy:"balanced",state:"paused",createdAt:"",updatedAt:"",output:"",
    goal:{status:"approved"} as TaskRecord["goal"],allowedAgentIds:["opencode","codex"],modelOverrides:{},
    assignments:{worker:{agentId:"opencode",allowFallback:false}},
    workUnits:[{id:"work",role:"worker",title:"Implementation",instructions:"Preserve existing code",mode:"write",state:"failed",dependsOn:[],attemptedAgentIds:["opencode"]}],
    runs:[{id:"old",workUnitId:"work",agentId:"opencode",role:"worker",providerKey:"ollama",state:"failed",output:"partial",startedAt:"",terminal:true}]};
}
test("manual CLI handoff preserves artifacts/history and pins only the failed unit",()=>{
  const task=fixture(),before=JSON.stringify(task);
  const next=cliHandoffTask(task,"old","claude","anthropic"),resumed={...next,...resumePatch(next)};
  assert.equal(resumed.workUnits[0].retryAgentId,"claude");assert.equal(resumed.workUnits[0].state,"pending");
  assert.equal(resumed.assignments,task.assignments);assert.equal(resumed.runs,task.runs);assert.equal(resumed.goal,task.goal);
  assert.ok(resumed.allowedAgentIds.includes("claude"));assert.equal(JSON.stringify(task),before);
});
test("stale attempts, completed work, decisions, pending instructions and live work cannot transfer",()=>{
  const task=fixture();
  for(const update of [{state:"running"},{state:"completed"},{state:"awaiting-input",awaitingReason:"result"},{goal:{status:"draft"}},
    {pendingFollowup:{}},{workUnits:[{...task.workUnits[0],state:"completed"}]},
    {runs:[...task.runs,{...task.runs[0],id:"new",state:"failed"}]},
    {runs:[...task.runs,{...task.runs[0],id:"live",workUnitId:"other",state:"running"}]}]) {
    assert.throws(()=>cliHandoffUnit({...task,...update} as TaskRecord,"old"));
  }
  assert.throws(()=>cliHandoffTask(task,"old","opencode","ollama"));
  assert.throws(()=>cliHandoffTask(task,"old","gemini","google"));
});
test("explicit selection overrides role preference but not quotas, installation or independence",()=>{
  const task=cliHandoffTask(fixture(),"old","claude","anthropic"),unit=task.workUnits[0];
  const input:AgentSelectionInput={task,unit,agents:["claude","codex","opencode"].map(id=>({id,installed:true})) as AgentSelectionInput["agents"],
    settings:{agentPolicies:["claude","codex","opencode"].map(agentId=>({agentId,enabled:true,providerKey:agentId,priority:50}))} as AgentSelectionInput["settings"],resources:[]};
  assert.equal(selectAgent(input),"claude");
  assert.equal(selectAgent({...input,agents:input.agents.filter(a=>a.id!=="claude")}),undefined);
  assert.equal(selectAgent({...input,resources:[{providerKey:"claude",state:"cooldown"}] as AgentSelectionInput["resources"]}),undefined);
  const review={...unit,role:"reviewer" as const};
  const peer={...task.runs[0],workUnitId:"earlier",agentId:"claude",role:"reviewer",state:"completed"} as AgentRun;
  assert.equal(selectAgent({...input,unit:review,task:{...task,reviewPolicy:"adversarial-pair",runs:[peer,...task.runs]}}),undefined);
});
test("cross-review handoff changes both unfinished waves without duplicating a provider",()=>{
  const task=fixture();task.workUnits=[];
  task.workUnits=createCrossReviews(task,["openai","ollama"]);
  const seat=task.workUnits.find(u=>u.crossReview?.providerKey==="ollama")!;seat.state="failed";
  task.runs[0].workUnitId=seat.id;
  const next=cliHandoffTask(task,"old","claude","anthropic");
  assert.equal(next.workUnits.filter(u=>u.crossReview?.providerKey==="anthropic").length,2);
  assert.deepEqual(next.workUnits.map(u=>u.dependsOn),task.workUnits.map(u=>u.dependsOn));
  assert.deepEqual(next.workUnits.map(u=>u.crossReview?.sourceUnitIds),task.workUnits.map(u=>u.crossReview?.sourceUnitIds));
  assert.throws(()=>cliHandoffTask(task,"old","codex","openai"),/既に別/);
  task.workUnits.find(u=>u.crossReview?.providerKey==="ollama"&&u.crossReview.wave===2)!.state="completed";
  assert.throws(()=>cliHandoffTask(task,"old","claude","anthropic"),/受理/);
});
