import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultExecution } from "./execution-policy";
import { executionSettingsPatch, pendingExecutionPatch } from "./execution-updates";
import { JsonTaskStore } from "./task-store";
import { restartedTask } from "./task-restart";
import type { TaskRecord } from "./types";

function fixture(): TaskRecord {
  return {id:"live",title:"Live policy",prompt:"Keep evidence",cwd:"/tmp",workflowMode:"primary",state:"running",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{},createdAt:"",updatedAt:"",output:"",execution:{...defaultExecution},
    workUnits:[{id:"worker",role:"worker",mode:"write",title:"Worker",instructions:"Work",state:"running",attemptedAgentIds:[],dependsOn:[]}],
    runs:[{id:"run",workUnitId:"worker",agentId:"codex",providerKey:"openai",role:"worker",state:"running",startedAt:"",output:""}]} as TaskRecord;
}

test("live settings are versioned pending values, replaceable/cancellable without touching work",()=>{
  const t=fixture(),before=structuredClone(t);
  const p=executionSettingsPatch(t,{...t.execution,maxParallel:4},true,0);
  assert.equal(p.execution,undefined);assert.equal(p.workUnits,undefined);assert.deepEqual(t,before);
  Object.assign(t,p);assert.equal(t.execution!.maxParallel,2);assert.equal(t.pendingExecution!.policy.maxParallel,4);
  assert.equal(pendingExecutionPatch(t),undefined,"live work prevents applying a pending policy");
  assert.throws(()=>executionSettingsPatch(t,{...t.execution,maxParallel:3},true,0),/更新/);
  Object.assign(t,executionSettingsPatch(t,{...t.execution,maxParallel:3},true,1));assert.equal(t.pendingExecution!.policy.maxParallel,3);
  Object.assign(t,executionSettingsPatch(t,t.execution,true,2));assert.equal(t.pendingExecution,undefined);assert.equal(t.execution!.maxParallel,2);
  assert.throws(()=>executionSettingsPatch(t,{...t.execution,maxParallel:0},true),/不正/);
  assert.throws(()=>executionSettingsPatch(t,{...t.execution,reviewMode:"cross-service"},true),/レビュー/);
  Object.assign(t,executionSettingsPatch(t,{...t.execution,tokenBudget:1000,maxParallel:1},true,3));
  t.runs[0].state="completed";t.workUnits[0].state="completed";
  const applied=pendingExecutionPatch(t)!;assert.equal(applied.workUnits,undefined);assert.equal(applied.runs,undefined);
  Object.assign(t,applied);assert.equal(t.pendingExecution,undefined);assert.equal(t.execution!.tokenBudget,1000);assert.equal(t.executionRevision,5);
  assert.throws(()=>executionSettingsPatch(t,before.execution,true,4),/更新/,"a cancellation racing application cannot roll it back");
});

test("stopped settings preserve completed review format and apply without resuming",()=>{
  const t=fixture();t.state="paused";t.workUnits[0].state="completed";t.runs[0].state="completed";
  const p=executionSettingsPatch(t,{...t.execution,maxParallel:4},false);
  assert.equal(p.state,undefined);assert.equal(p.execution!.maxParallel,4);assert.equal(p.workUnits,t.workUnits);
  t.workUnits[0].role="reviewer";
  assert.throws(()=>executionSettingsPatch(t,{...t.execution,reviewMode:"cross-service"},false),/レビュー/);
});

test("pending settings survive app recovery and are inherited by an explicit new task",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"harness-execution-update-"));
  try {
    const store=new JsonTaskStore(join(dir,"tasks.json"));await store.init();
    const t=fixture();Object.assign(t,executionSettingsPatch(t,{...t.execution,maxParallel:4},true));
    t.restart={sourceTaskId:"source",mode:"carry"};
    t.state="paused";t.workUnits[0].state="pending";t.runs[0].state="cancelled";
    await store.insertRestart({...t,runs:[]});await store.update(t.id,{runs:t.runs});
    const reloaded=new JsonTaskStore(join(dir,"tasks.json"));await reloaded.init();
    const saved=reloaded.get(t.id)!;assert.equal(saved.pendingExecution!.policy.maxParallel,4);
    assert.equal(pendingExecutionPatch(saved)!.execution!.maxParallel,4);
    const fresh=restartedTask(saved,"carry",saved.cwd);assert.equal(fresh.execution!.maxParallel,4);assert.equal(fresh.pendingExecution,undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});
