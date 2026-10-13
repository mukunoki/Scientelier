import test from "node:test";
import assert from "node:assert/strict";
import { executionMetrics } from "./execution-metrics";
import { transcriptUsage, validRunUsage, captureRunUsage } from "./run-usage";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskRecord } from "./types";
const at = (minutes: number) => new Date(minutes*60000).toISOString();
const run = (start: number, end?: number) => ({startedAt:at(start),completedAt:end === undefined ? undefined : at(end),state:end === undefined ? "running" : "completed"});
test("execution clock excludes approval gaps, goal preparation and old rounds, unions parallel runs", () => {
  const t = {state:"running",roundNumber:2,history:[{number:1,finishedAt:at(20)}],updatedAt:at(100),runs:[
    run(0,10),{...run(21,25),goalPreparation:true},run(30,40),run(35,45),run(60)
  ]} as unknown as TaskRecord;
  assert.equal(executionMetrics(t,70*60000).elapsedMs,25*60000);
  assert.equal(executionMetrics(t,70*60000).ticking,true);
  t.state="awaiting-input";t.updatedAt=at(65);
  assert.equal(executionMetrics(t,100*60000).elapsedMs,20*60000);
  assert.equal(executionMetrics(t,200*60000).ticking,false);
  assert.equal(executionMetrics(t,200*60000).elapsedMs,20*60000);
});
test("usage reports partial coverage, never treats unknown or estimates as zero measured tokens", () => {
  const t = {state:"completed",runs:[{...run(1,2),usage:{source:"reported",inputTokens:100,outputTokens:20,cachedInputTokens:50}},
    {...run(2,3),usage:{source:"unknown"}},{...run(3,4),usage:{source:"estimated",inputTokens:1000,outputTokens:200}}]} as unknown as TaskRecord;
  const metrics = executionMetrics(t);
  assert.equal(metrics.totalRuns,3);assert.equal(metrics.measuredRuns,1);
  assert.equal(metrics.usage.inputTokens,100);assert.equal(metrics.usage.outputTokens,20);
  assert.equal(executionMetrics({...t,runs:[]}).usage.source,"unknown");
});
test("whole-task history includes earlier attempts without charging approval gaps or changing round metrics", () => {
  const t = {state:"completed",roundNumber:2,history:[{number:1,finishedAt:at(20)}],runs:[
    {...run(0,10),agentId:"codex",usage:{source:"reported",inputTokens:100,outputTokens:10}},
    {...run(21,25),goalPreparation:true},run(30,40),run(35,45)
  ]} as unknown as TaskRecord;
  const all = executionMetrics(t,100*60000,"task"), current = executionMetrics(t,100*60000);
  assert.equal(all.elapsedMs,25*60000); assert.equal(current.elapsedMs,15*60000);
  assert.equal(all.intervals.length,3); assert.equal(current.intervals.length,2);
  assert.equal(all.parallelMs,5*60000); assert.equal(all.peakParallel,2);
  assert.equal(all.usage.inputTokens,100); assert.equal(current.usage.source,"unknown");
});
test("Codex subtracts previous-session counters and does not count duplicate events", () => {
  const event = (minute:number,input:number,output:number) => JSON.stringify({timestamp:at(minute),type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:input,output_tokens:output,cached_input_tokens:0}}}});
  const text = [event(1,100,10),event(3,150,15),event(3,150,15),event(4,180,20)].join("\n");
  assert.deepEqual(transcriptUsage("codex",text,2*60000),{source:"reported",inputTokens:80,outputTokens:10,cachedInputTokens:0});
  assert.equal(transcriptUsage("codex",event(1,100,10)+"\n"+event(3,20,2),2*60000),undefined);
  assert.equal(transcriptUsage("codex",'{}\nbroken',0),undefined);
});
test("model usage groups launches across environments, excludes old rounds, and refreshes cumulative receipts without duplication", () => {
  const measured = (input: number) => ({source:"reported",inputTokens:input,outputTokens:10,cachedInputTokens:5});
  const t = {state:"running",roundNumber:2,history:[{number:1,finishedAt:at(20)}],runs:[
    {...run(1,2),agentId:"codex",model:"old",usage:measured(999)},
    {...run(21,22),agentId:"codex",model:"goal",goalPreparation:true,usage:measured(999)},
    {...run(30,31),agentId:"codex",model:"model-a",executionLocation:"remote",usage:measured(100)},
    {...run(32),agentId:"codex",model:"model-a",executionLocation:"local",usage:measured(200)},
    {...run(32),agentId:"claude",model:"model-b",usage:{source:"unknown"}},
    {...run(33),agentId:"codex",usage:measured(50)},
    {...run(34),agentId:"codex",model:"model-a",usage:{source:"estimated",inputTokens:999,outputTokens:99}}
  ]} as unknown as TaskRecord;
  const m = executionMetrics(t,40*60000);
  assert.equal(m.models.length,3);
  assert.deepEqual(m.models[0],{agentId:"codex",model:"model-a",measuredRuns:2,totalRuns:3,usage:{source:"reported",inputTokens:300,outputTokens:20,cachedInputTokens:10}});
  assert.equal(m.models[1].usage.source,"unknown");
  assert.equal(m.models[2].model,undefined);
  t.runs[3].usage = {source:"reported",inputTokens:250,outputTokens:20,cachedInputTokens:5};
  const next = executionMetrics(t,41*60000);
  assert.equal(next.models[0].usage.inputTokens,350);
  assert.equal(next.models[0].usage.outputTokens,30);
  assert.equal(next.usage.inputTokens,400);
});
test("Claude counts cache once, deduplicates streaming messages and excludes prior turns", () => {
  const event = (minute:number,id:string,output:number) => JSON.stringify({timestamp:at(minute),type:"assistant",message:{id,usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:5,cache_creation_input_tokens:2}}});
  assert.deepEqual(transcriptUsage("claude",[event(1,"old",100),event(3,"current",2),event(3,"current",4)].join("\n"),2*60000),{source:"reported",inputTokens:17,outputTokens:4,cachedInputTokens:5});
});
test("usage receipt is run-scoped; missing or invalid native telemetry never blocks completion", async () => {
  const dir=await mkdtemp(join(tmpdir(),"harness-usage-test-"));
  try {
    await writeFile(join(dir,"metrics-config.json"),JSON.stringify({token:"run",startedAt:0}));
    await captureRunUsage("opencode",{usage:{source:"reported",inputTokens:30,outputTokens:5}},dir,"run");
    const before=await readFile(join(dir,"usage.json"),"utf8");
    assert.equal(JSON.parse(before).usage.inputTokens,30);
    await captureRunUsage("opencode",{usage:{source:"reported",inputTokens:999,outputTokens:1}},dir,"other");
    assert.equal(await readFile(join(dir,"usage.json"),"utf8"),before);
    assert.equal(validRunUsage({source:"reported",inputTokens:-1,outputTokens:4}),false);
    await captureRunUsage("claude",{transcript_path:"/missing"},dir,"run");
  } finally {await rm(dir,{recursive:true,force:true});}
});
