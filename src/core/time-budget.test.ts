import test from "node:test";
import assert from "node:assert/strict";
import { executionTime } from "./execution-time";
import { timingFromLog } from "./execution-time-recovery";
import { scheduleMinutes, timePlanRetry, taskTimeOutlook, planTimeAssessment, timeCheckpoint, observedEstimates } from "./time-budget";
import { recordChannelState, readChannelState } from "./channel-state";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord, AgentRun, WorkUnit } from "./types";
const at=(m:number)=>new Date(m*60000).toISOString();
const run=(start:number,end:number,work?:number)=>({id:`${start}`,workUnitId:`${start}`,agentId:"codex",startedAt:at(start),completedAt:at(end),state:"completed",executionTiming:{source:"channel",...(work===undefined?{}:{workStartedAt:at(work)})}} as AgentRun);
test("remaining estimates learn actual comparable work and exclude startup, claimed durations and optional controllers",()=>{
  const completed={id:"old",state:"completed",role:"worker",mode:"write",primaryStep:true,subtask:{kind:"primary-work",estimatedMinutes:10}} as WorkUnit;
  const next={...completed,id:"next",state:"pending",dependsOn:[]} as WorkUnit;
  const r={...run(1,81,51),workUnitId:"old",output:"作業は1分でした。"};
  const task={state:"paused",workUnits:[next,{id:"controller",orchestrator:{},state:"running"}],
    history:[{workUnits:[completed]}],runs:[r],execution:{maxParallel:2}} as unknown as TaskRecord;
  assert.deepEqual(observedEstimates(task),[{kind:"primary-work",samples:1,factor:3}]);
  const outlook=taskTimeOutlook(task);assert.equal(outlook.remainingMinutes,30);assert.equal(outlook.unknownUnits,0);
  assert.equal(outlook.startupWaitMinutes,50);
  assert.equal(planTimeAssessment(task,{tasks:[{key:"next",kind:"primary-work",dependsOn:[],estimatedMinutes:10} as any],estimatedMinutes:2}).remaining,32);
  r.executionTiming=undefined;assert.deepEqual(observedEstimates(task),[]);
  assert.equal(taskTimeOutlook(task).remainingMinutes,10);
});
test("time checkpoints use active time, exclude startup/pause and coalesce overdue events",()=>{
  const task={state:"completed",autonomy:{targetMinutes:30},runs:[run(0,70,53)],workUnits:[]} as unknown as TaskRecord;
  assert.equal(timeCheckpoint(task),1);task.runs=[run(0,90,53)];assert.equal(timeCheckpoint(task),2);
  task.runs=[run(0,60,53)];assert.equal(timeCheckpoint(task),undefined);
  task.autonomy!.targetMinutes=undefined;assert.equal(timeCheckpoint(task),undefined);
});
test("recent slow measurements are not diluted by older short preparation milestones",()=>{
  const ratios=[0.5,0.5,0.5,0.5,0.5,1.8,2.8];
  const task={workUnits:ratios.map((_v,i)=>({id:String(i),role:"worker",state:"completed",completedAt:at(100+i*40),subtask:{kind:"primary-work",estimatedMinutes:10}})),
    runs:ratios.map((v,i)=>({...run(70+i*40,100+i*40,100+i*40-v*10),workUnitId:String(i)}))} as unknown as TaskRecord;
  assert.ok(Math.abs(observedEstimates(task)[0].factor-1.8)<1e-6);
});
test("observed startup waits excluded, overlapping work counted once and concurrency measured",()=>{
  const task={state:"completed",runs:[run(0,55,53),run(50,60,54)],workUnits:[]} as unknown as TaskRecord;
  const m=executionTime(task,60*60000);
  assert.equal(m.elapsedMs,7*60000);assert.equal(m.startupMs,53*60000);
  assert.equal(m.peakParallel,2);assert.equal(m.parallelMs,60000);assert.equal(m.unknownMs,0);
  task.runs.push({...run(60,62),executionTiming:undefined});assert.equal(executionTime(task).unknownMs,2*60000);
  task.runs=[{...run(1,10),state:"running",completedAt:undefined}];task.state="running";
  assert.equal(executionTime(task,20*60000).waitingRuns,1);assert.equal(executionTime(task,20*60000).elapsedMs,0);
  task.state="paused";task.updatedAt=at(5);assert.equal(executionTime(task,20*60000).startupMs,4*60000);
});
test("legacy timing recovery uses a bounded harness timestamp, never a claimed duration",()=>{
  const r=run(0,55);delete r.executionTiming;
  assert.equal(timingFromLog(r,`[${at(53)}] [status] MCP：この工程の指示取得を確認しました。\n`)?.workStartedAt,at(53));
  assert.equal(timingFromLog(r,"経過は2分でした。"),undefined);
  assert.equal(timingFromLog(r,`[${at(99)}] [status] MCP：この工程の指示取得を確認しました。`),undefined);
});
test("instruction read timestamp is first-read time, not later rereads",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"harness-time-"));
  try{await recordChannelState(dir,"t","instructions-read");const first=await readChannelState(dir,"t");await recordChannelState(dir,"t","instructions-read");await recordChannelState(dir,"t","connected");assert.deepEqual(await readChannelState(dir,"t"),first);}finally{await rm(dir,{recursive:true,force:true});}
});
test("time schedule honors dependencies, concurrency, exclusive writes and missing estimates",()=>{
  const n=[{key:"a",dependsOn:[],minutes:5},{key:"b",dependsOn:[],minutes:7},{key:"c",dependsOn:["a","b"],minutes:2,exclusive:true}];
  assert.equal(scheduleMinutes(n,2).minutes,9);assert.equal(scheduleMinutes(n,1).minutes,14);
  assert.equal(scheduleMinutes([{...n[0],exclusive:true},n[1]],2).minutes,12);
  assert.equal(scheduleMinutes([{key:"x",dependsOn:[]}],2).unknown,1);
});
test("time estimates use the same input-only overlap rule as execution",()=>{
  const nodes=[{key:"env",dependsOn:[],minutes:3,exclusive:true,allowTaskOnlyPeers:true},
    {key:"a",dependsOn:[],minutes:5,taskOnly:true},{key:"b",dependsOn:[],minutes:2,taskOnly:true},
    {key:"apply",dependsOn:["env","a","b"],minutes:4,exclusive:true}];
  assert.equal(scheduleMinutes(nodes,3).minutes,9);
  assert.equal(scheduleMinutes(nodes,1).minutes,14);
  assert.equal(scheduleMinutes(nodes.map(n=>({...n,allowTaskOnlyPeers:false})),3).minutes,12);
  assert.equal(scheduleMinutes(nodes.map(n=>({...n,taskOnly:false})),3).minutes,12);
});
test("soft time guard asks one optimization pass, never repeated rejection or changed goals",()=>{
  const u={id:"p",planPhase:true,primary:true,state:"completed",attemptedAgentIds:[]} as unknown as WorkUnit;
  const task={state:"running",runs:[],workUnits:[u,{id:"r",role:"reporter",state:"pending",dependsOn:["p"]},{id:"v",role:"reviewer",state:"pending",dependsOn:["r"]}],autonomy:{enabled:true,targetMinutes:30},execution:{maxParallel:2}} as unknown as TaskRecord;
  assert.equal(timePlanRetry(task,u,{tasks:[],estimatedMinutes:10}),undefined);
  const retry=timePlanRetry(task,u,{tasks:[],estimatedMinutes:40})!;assert.equal(retry.state,"pending");assert.equal(retry.timePlanReviewed,true);
  Object.assign(u,retry);assert.equal(timePlanRetry(task,u,{tasks:[],estimatedMinutes:40}),undefined);
  assert.equal(task.autonomy!.targetMinutes,30);assert.ok(taskTimeOutlook(task).unknownUnits>0);
  u.timePlanReviewed=undefined;
  const coordination={criticalPath:"required work exceeds target",parallelBenefit:"no useful division",contextPlan:"minimal inputs",resourcePlan:"preserve final review"};
  assert.equal(timePlanRetry(task,u,{tasks:[],estimatedMinutes:40,coordination}),undefined,"a complete coordinated estimate does not need another LLM planning turn solely for overrun");
  assert.ok(timePlanRetry(task,u,{tasks:[{key:"missing",dependsOn:[]} as any],estimatedMinutes:40,coordination}),"missing estimates still receive one optimization pass");
});
test("before service freezing, time reserve includes independent batches and one consolidation",()=>{
  const task={state:"paused",runs:[],allowedAgentIds:["codex","claude","antigravity"],workUnits:[{id:"work",role:"worker",state:"completed",dependsOn:[]},{id:"report",role:"reporter",state:"pending",mode:"write",dependsOn:["work"]},{id:"v1",role:"reviewer",state:"pending",mode:"read",dependsOn:["report"]},{id:"v2",role:"reviewer",state:"pending",mode:"read",dependsOn:["v1"]}],execution:{reviewMode:"parallel",maxParallel:2}} as unknown as TaskRecord;
  assert.equal(planTimeAssessment(task,{tasks:[],estimatedMinutes:10}).finishing,14,"report 5 + two review batches 6 + consolidation 3");
  assert.equal(taskTimeOutlook(task).remainingMinutes,14);
  task.execution!.maxParallel=1;
  assert.equal(taskTimeOutlook(task).remainingMinutes,17);
  task.execution!.maxParallel=3;
  assert.equal(taskTimeOutlook(task).remainingMinutes,11);
  task.workUnits[2].startedAt=at(1);
  assert.equal(taskTimeOutlook(task).remainingMinutes,11,"never replace a started graph with virtual seats");
});
