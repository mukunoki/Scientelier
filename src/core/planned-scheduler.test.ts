import test from "node:test";
import assert from "node:assert/strict";
import { runPlannedWork, orderReadyPackages } from "./planned-scheduler";
import type { TaskRecord, WorkUnit, SubtaskSpec } from "./types";
import { defaultExecution } from "./execution-policy";

function fixture(specs: Array<[string, string[], (boolean | "isolated" | "input")?, number?, Partial<SubtaskSpec>?]>, coordinate?: (task: TaskRecord, ids: string[], canApply: () => boolean) => Promise<void>, maxParallel=defaultExecution.maxParallel) {
  const task = { execution: { ...defaultExecution, maxParallel }, runs: [], workUnits: specs.map(([id, dependsOn, writer, minutes, extra]) => ({
    id, dependsOn, role: "worker", mode: writer === true || writer === "isolated" ? "write" : "read", primaryStep: writer === true, state: "pending", attemptedAgentIds: [],
    subtask: { key: id, estimatedTokens: 1000, estimatedMinutes: minutes, ...(writer === true ? {kind:"primary-work"} : writer === "input" ? {inputScope:"assignment"} : writer === "isolated" ? {kind:"isolated-work",ownedFiles:[`${id}.cpp`]} : {}), ...extra },
  })) } as unknown as TaskRecord;
  const started: string[] = [], finished: string[] = [], active = new Set<string>();
  const releases = new Map<string, (result: "completed" | "failed" | "rate-limited") => void>();
  let paused = false, peak = 0;
  const execution = runPlannedWork({ snapshot: () => task, paused: () => paused, coordinate: coordinate && ((ids, canApply) => coordinate(task, ids, canApply)), execute: async id => {
    const u = task.workUnits.find(u => u.id === id)!;
    assert.ok(active.size < task.execution!.maxParallel);
    const sharedWriter = (u: WorkUnit) => u.mode === "write" && u.subtask?.kind !== "isolated-work";
    for (const other of [...active].map(id => task.workUnits.find(u => u.id === id)!)) {
      if (sharedWriter(u)) assert.ok(u.subtask?.allowTaskOnlyPeers && other.mode === "read" && other.subtask?.inputScope === "assignment");
      if (sharedWriter(other)) assert.ok(other.subtask?.allowTaskOnlyPeers && u.mode === "read" && u.subtask?.inputScope === "assignment");
    }
    started.push(id); active.add(id); peak = Math.max(peak, active.size); u.state = "running";
    const result = await new Promise<"completed" | "failed" | "rate-limited">(resolve => { releases.set(id, resolve); });
    active.delete(id); finished.push(id); u.state = result === "rate-limited" ? "pending" : result;
    return result;
  } });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return { task, started, finished, active, execution, tick, peak: () => peak, pause: () => { paused = true; }, release: (id: string, result: "completed" | "failed" | "rate-limited" = "completed") => releases.get(id)!(result) };
}

test("preflight overlaps two input-only peers, then synthesis and measurements remain exclusive", async () => {
  const f = fixture([["environment", [], true, 3, {allowTaskOnlyPeers:true}], ["alternative", [], "input", 2], ["challenge", [], "input", 2],
    ["apply", ["environment", "alternative", "challenge"], true], ["benchmark", ["apply"], true]],undefined,3);
  await f.tick(); assert.deepEqual(f.started, ["environment", "alternative", "challenge"]); assert.equal(f.peak(), 3);
  f.release("environment"); await f.tick(); assert.ok(!f.started.includes("apply"));
  f.release("alternative"); await f.tick(); assert.ok(!f.started.includes("apply"));
  f.release("challenge"); await f.tick(); assert.deepEqual([...f.active], ["apply"]);
  f.release("apply"); await f.tick(); assert.deepEqual([...f.active], ["benchmark"]);
  f.release("benchmark"); assert.equal((await f.execution).status, "done");
});

test("observation wakes a running opted-in milestone at each soft checkpoint without repeated controller turns", async () => {
  const t = { state:"running", updatedAt:new Date().toISOString(), roundNumber:1, autonomy:{targetMinutes:30},
    execution:{...defaultExecution,maxParallel:2},runs:[],workUnits:[{id:"work",role:"worker",mode:"write",primaryStep:true,
      state:"pending",dependsOn:[],subtask:{kind:"primary-work",allowTaskOnlyPeers:true,estimatedTokens:1000}}] } as unknown as TaskRecord;
  let finish!:()=>void; const checkpoints:number[]=[];
  const execution=runPlannedWork({snapshot:()=>t,paused:()=>false,observationMs:5,execute:async()=>{
    t.workUnits[0].state="running";
    const start=new Date(Date.now()-11*60000).toISOString();
    t.runs.push({id:"run",workUnitId:"work",agentId:"codex",providerKey:"openai",output:"",role:"worker",state:"running",startedAt:start,
      executionTiming:{source:"channel",workStartedAt:start}});
    await new Promise<void>(resolve=>{finish=resolve;});
    t.workUnits[0].state="completed";t.runs[0].state="completed";t.runs[0].completedAt=new Date().toISOString();return "completed";
  },coordinate:async ids=>{
    if(ids.length)return;
    assert.equal(t.workUnits[0].state,"running","the writer remains active; no timeout or forced handoff");
    const checkpoint=checkpoints.length+1;checkpoints.push(checkpoint);
    t.orchestratorDecisions=[...(t.orchestratorDecisions??[]),{round:1,timeCheckpoint:checkpoint} as any];
  }});
  const until=async(predicate:()=>boolean)=>{
    const deadline=Date.now()+1000;
    while(!predicate()){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}
  };
  try {
    await until(()=>checkpoints.length===1);await new Promise(r=>setTimeout(r,25));assert.deepEqual(checkpoints,[1]);
    const start=new Date(Date.now()-21*60000).toISOString();t.runs[0].startedAt=start;t.runs[0].executionTiming!.workStartedAt=start;
    await until(()=>checkpoints.length===2);await new Promise(r=>setTimeout(r,25));assert.deepEqual(checkpoints,[1,2]);
  } finally {finish();await execution;}
  assert.equal(t.workUnits[0].state,"completed");
});

test("opt-in shared writers do not overlap workspace readers or isolated writers", async () => {
  const f = fixture([["environment", [], true, 1, {allowTaskOnlyPeers:true}], ["reader", []], ["isolated", [], "isolated"]]);
  await f.tick(); assert.deepEqual(f.started, ["environment"]);
  f.release("environment"); await f.tick(); assert.deepEqual([...f.active].sort(), ["isolated", "reader"]);
  f.release("reader"); f.release("isolated"); assert.equal((await f.execution).status, "done");
});

test("a ready preflight joins a running input-only peer, but a benchmark must drain it", async () => {
  const f = fixture([["bootstrap", []], ["proposal", [], "input", 10], ["preflight", ["bootstrap"], true, 1, {allowTaskOnlyPeers:true}], ["benchmark", ["preflight"], true]]);
  await f.tick(); assert.deepEqual([...f.active].sort(), ["bootstrap", "proposal"]);
  f.release("bootstrap"); await f.tick(); assert.deepEqual([...f.active].sort(), ["preflight", "proposal"]);
  f.release("preflight"); await f.tick(); assert.deepEqual([...f.active], ["proposal"]);
  f.release("proposal"); await f.tick(); assert.deepEqual([...f.active], ["benchmark"]);
  f.release("benchmark"); assert.equal((await f.execution).status, "done");
});

test("input-only concurrency respects cap, pause and pending policy without terminating siblings", async () => {
  for (const stop of ["pause", "settings", "failure"] as const) {
    const f = fixture([["env", [], true, 3, {allowTaskOnlyPeers:true}], ["a", [], "input"], ["b", [], "input"]]);
    await f.tick(); assert.deepEqual(f.started, ["env", "a"]); assert.equal(f.peak(), 2);
    if (stop === "pause") f.pause();
    if (stop === "settings") f.task.pendingExecution = {policy:{...defaultExecution,maxParallel:1},savedAt:"now"};
    f.release("env", stop === "failure" ? "failed" : "completed"); await f.tick();
    assert.deepEqual(f.started, ["env", "a"]); assert.ok(f.active.has("a"));
    f.release("a"); assert.equal((await f.execution).status, stop === "failure" ? "failed" : stop === "pause" ? "paused" : "settings");
    assert.equal(f.task.workUnits.find(u=>u.id==="b")!.state,"pending");
  }
});

test("isolated writers overlap, refill idle slots, then drain before exclusive integration", async () => {
  const f = fixture([["slow", [], "isolated", 10], ["fast", [], "isolated"], ["next", ["fast"], "isolated"], ["integrate", ["slow", "next"], true]]);
  await f.tick(); assert.deepEqual(f.started, ["slow", "fast"]);
  f.release("fast"); await f.tick(); assert.deepEqual(f.started, ["slow", "fast", "next"]);
  f.release("next"); await f.tick(); assert.ok(!f.started.includes("integrate"));
  f.release("slow"); await f.tick(); assert.equal(f.started.at(-1), "integrate");
  f.release("integrate"); assert.equal((await f.execution).status, "done"); assert.equal(f.peak(), 2);
});

test("dependent reader starts immediately without waiting for an unrelated slow sibling", async () => {
  const f = fixture([["slow", [], false, 10], ["fast", []], ["dependent", ["fast"]]]);
  await f.tick(); assert.deepEqual(f.started, ["slow", "fast"]);
  f.release("fast"); await f.tick(); assert.deepEqual(f.started, ["slow", "fast", "dependent"]);
  assert.ok(f.active.has("slow")); f.release("dependent"); f.release("slow");
  assert.equal((await f.execution).status, "done"); assert.equal(f.peak(), 2);
});

test("environment receipt fences new packages and drains active siblings without replanning", async () => {
  const f=fixture([["slow",[],false,10],["fast",[]],["next",["fast"]]]);
  await f.tick(); assert.deepEqual(f.started,["slow","fast"]);
  f.task.executionBlocker={kind:"tool",summary:"必須ツールなし",recovery:"ツールを確認",unitId:"slow",
    round:f.task.roundNumber??1,cycle:f.task.autonomyCycle??1,goalRevision:f.task.goal?.revision,at:"now"};
  f.release("fast"); await f.tick(); assert.deepEqual(f.started,["slow","fast"]);
  assert.ok(f.active.has("slow"),"owned terminal is not forcibly terminated");
  f.release("slow"); const result=await f.execution;
  assert.equal(result.status,"failed"); assert.equal(result.unitId,"slow");
});

test("pending policy drains every sibling without starting dependencies, and failure/pause take precedence",async()=>{
  for(const reason of ["settings","failure","pause"]) {
    const f=fixture([["slow",[]],["fast",[]],["next",["fast"]]]);
    await f.tick();f.task.pendingExecution={policy:{...defaultExecution,maxParallel:1},savedAt:"now"};
    if(reason==="pause")f.pause();
    f.release("fast",reason==="failure"?"failed":"completed");await f.tick();
    assert.deepEqual([...f.started].sort(),["fast","slow"]);assert.ok(f.active.has("slow"));
    f.release("slow");const result=await f.execution;
    assert.equal(result.status,reason==="failure"?"failed":reason==="pause"?"paused":"settings");
    assert.equal(f.task.workUnits.find(u=>u.id==="next")!.state,"pending");
  }
});

test("primary milestone starts before unrelated pending research, drains readers, and never overlaps writes", async () => {
  const f = fixture([["a", []], ["b", []], ["write", ["a"], true], ["verify", ["write"]]]);
  await f.tick(); f.release("a"); await f.tick(); assert.deepEqual(f.started, ["a", "b"]);
  f.release("b"); await f.tick(); assert.equal(f.started.at(-1), "write");
  assert.deepEqual([...f.active], ["write"]); f.release("write"); await f.tick(); f.release("verify");
  assert.equal((await f.execution).status, "done");
  const early = fixture([["write", [], true], ["research", []]]);
  await early.tick(); assert.deepEqual(early.started, ["write"]);
  early.release("write"); await early.tick(); early.release("research"); await early.execution;
});

test("failure or pause stops admission, retains completed work, and drains active siblings", async () => {
  for (const stop of ["failure", "pause"]) {
    const f = fixture([["a", []], ["b", []], ["c", ["a"]]]);
    await f.tick(); if (stop === "pause") f.pause(); f.release("a", stop === "failure" ? "failed" : "completed");
    await f.tick(); assert.equal(f.started.length, 2); assert.ok(f.active.has("b"));
    f.release("b"); assert.equal((await f.execution).status, stop === "failure" ? "failed" : "paused");
    assert.equal(f.active.size, 0); assert.equal(f.task.workUnits.find(u => u.id === "b")!.state, "completed");
  }
});

test("token estimates do not throttle parallel work and rate-limit retry retains completed dependencies", async () => {
  const t = { execution: { ...defaultExecution, tokenBudget: 1000 }, runs: [], workUnits: ["a", "b"].map(id => ({ id, role: "worker", mode: "read", state: "pending", dependsOn: [], subtask: { estimatedTokens: 1000 } })) } as unknown as TaskRecord;
  let peak = 0, active = 0;
  const result = await runPlannedWork({ snapshot: () => t, paused: () => false, execute: async id => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--;
    t.workUnits.find(u => u.id === id)!.state = "completed";
    t.runs.push({ workUnitId: id, estimatedTokens: 1000 } as any); return "completed";
  } });
  assert.equal(peak, 2); assert.equal(result.status, "done");
  const retry = fixture([["a", []], ["b", ["a"]]]);
  await retry.tick(); retry.release("a"); await retry.tick(); retry.release("b", "rate-limited"); await retry.tick();
  assert.deepEqual(retry.started, ["a", "b", "b"]); retry.release("b"); await retry.execution;
});

test("long dependent chains get priority without overriding write exclusivity", () => {
  const units = [{ id: "short", dependsOn: [] }, { id: "root", dependsOn: [] }, { id: "long", dependsOn: ["root"] }]
    .map(u => ({ ...u, state: "pending", mode: "read", subtask: { estimatedMinutes: u.id === "long" ? 20 : 1 } })) as WorkUnit[];
  assert.deepEqual(orderReadyPackages({ workUnits: units } as TaskRecord).map(u => u.id), ["root", "short"]);
});

test("an idle slot asks the coordinator and runs its new package while the slow sibling continues", async () => {
  let release!: () => void;
  const events: string[][] = [];
  const f = fixture([["slow", []], ["fast", []]], async (t, ids, canApply) => {
    events.push(ids);
    if (events.length > 1) return;
    await new Promise<void>(r => { release = r; });
    assert.ok(canApply());
    t.workUnits.push({ id: "extra", allocatedBy: "decision", title: "extra", instructions: "verify", role: "worker", mode: "read", state: "pending", attemptedAgentIds: [], dependsOn: ["fast"], subtask: { estimatedTokens: 500 } } as unknown as WorkUnit);
  });
  await f.tick(); f.release("fast"); await f.tick();
  assert.deepEqual(events, [["fast"]]); assert.deepEqual([...f.active], ["slow"]);
  release(); await f.tick(); assert.ok(f.active.has("slow") && f.active.has("extra"));
  f.release("slow"); f.release("extra"); assert.equal((await f.execution).status, "done");
  assert.deepEqual(events, [["fast"], ["slow"]], "added packages cannot recursively request coordination");
});

test("coordination precedes ready work; never overlaps a writer and pause/failure drains it without new admission", async () => {
  let calls = 0;
  const planned = fixture([["slow", []], ["fast", []], ["next", ["fast"]]], async () => { calls++; });
  await planned.tick(); planned.release("fast"); await planned.tick(); assert.equal(calls, 1);
  planned.release("slow"); planned.release("next"); await planned.execution;
  for (const event of ["pause", "failure", "writer"] as const) {
    let finish!: () => void, allowed = true, asked = false;
    const f = fixture([["slow", []], ["fast", []], ...(event === "writer" ? [["write", ["slow"], true] as [string, string[], boolean]] : [])], async (_task, _ids, canApply) => {
      if (asked) return;
      asked = true;
      await new Promise<void>(r => { finish = r; }); allowed = canApply();
    });
    await f.tick(); f.release("fast"); await f.tick(); assert.ok(finish);
    if (event === "pause") f.pause();
    f.release("slow", event === "failure" ? "failed" : "completed"); await f.tick();
    assert.equal(f.started.length, 2, "no writer before management turn settles");
    finish(); await f.tick();
    if (event === "writer") { assert.equal(allowed, true); assert.equal(f.started.at(-1), "write"); f.release("write"); }
    else assert.equal(allowed, false);
    assert.equal((await f.execution).status, event === "writer" ? "done" : event === "failure" ? "failed" : "paused");
  }
});

test("serial completion reviews pending instructions before the next worker starts", async () => {
  let finish!: () => void;
  const f = fixture([["first", []], ["second", ["first"]]], async (t, ids) => {
    if (!ids.includes("first")) return;
    await new Promise<void>(resolve => { finish = resolve; });
    t.workUnits.find(u => u.id === "second")!.coordinationNotes = [{decisionId:"manager",note:"Check the newly found boundary"}];
  });
  f.task.execution!.maxParallel = 1;
  await f.tick(); f.release("first"); await f.tick();
  assert.deepEqual(f.started, ["first"]); assert.ok(finish);
  finish(); await f.tick(); assert.deepEqual(f.started, ["first", "second"]);
  assert.equal(f.task.workUnits[1].coordinationNotes?.[0].note, "Check the newly found boundary");
  f.release("second"); assert.equal((await f.execution).status, "done");
});

test("slow optional coordination holds descendants but does not block unrelated saved work",async()=>{
  let finish!:()=>void, asked=false;
  const f=fixture([["slow",[]],["trigger",[]],["affected",["trigger"]],["unrelated",[]]],async(_t,ids)=>{
    if(asked)return;asked=true;assert.deepEqual(ids,["trigger"]);
    await new Promise<void>(resolve=>{finish=resolve;});
  });
  await f.tick();f.release("trigger");await f.tick();
  assert.deepEqual([...f.started].sort(),["slow","trigger"]);
  f.release("slow");await f.tick();
  assert.ok(f.active.has("unrelated"),"safe unrelated work proceeds while controller waits");
  assert.ok(!f.started.includes("affected"),"dependent findings are still reviewed before admission");
  finish();await f.tick();assert.ok(f.started.includes("affected"));
  f.release("unrelated");f.release("affected");assert.equal((await f.execution).status,"done");
});
