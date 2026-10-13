import test from "node:test";
import assert from "node:assert/strict";
import { newCoordinator, coordinatorStart, applyCoordinatorDecision, coordinatorPrompt, interruptedCoordinators } from "./orchestrator";
import { defaultExecution } from "./execution-policy";
import { buildWorkUnitPrompt, nextPendingUnit } from "./orchestration";
import { resumePatch } from "./recovery";
import type { TaskRecord, WorkUnit } from "./types";

function fixture() {
  const unit = (id: string, state: string, extra: object = {}) => ({ id, title: id, role: "worker", mode: "read", state, attemptedAgentIds: [], dependsOn: [], instructions: "assigned scope", planRevision: 1, ...extra });
  return { id: "task", cwd: "/tmp", allowedAgentIds: ["codex", "claude"], workflowMode: "primary", state: "running", roundNumber: 1, execution: { ...defaultExecution },
    prompt: "Verify the result", goal: { revision: 1, status: "approved", objective: "Verify the result", criteria: [{ id: "correct", required: true }], constraints: [], outOfScope: [], deliverables: [] },
    workUnits: [unit("fast", "completed", { subtask: { key: "fast", estimatedTokens: 1000 }, output: "Evidence available at source A" }),
      unit("slow", "running", { subtask: { key: "slow", estimatedTokens: 1000 } }),
      unit("primary", "pending", { primary: true, mode: "write", plannedTokens: 8000, dependsOn: ["fast", "slow"] }),
      unit("report", "pending", { role: "reporter", dependsOn: ["primary"] }), unit("review1", "pending", { role: "reviewer", dependsOn: ["report"] }), unit("review2", "pending", { role: "reviewer", dependsOn: ["review1"] })],
    executionPlans: [{ revision: 1, round: 1, goalRevision: 1, summary: "Check evidence", reason: "Initial plan", primaryWork: "Integrate", tasks: [] }],
    runs: [{ id: "slow-run", workUnitId: "slow", state: "running", role: "worker", estimatedTokens: 1000 }] } as unknown as TaskRecord;
}
const spec = () => ({ key: "extra", title: "Verify boundary case", instructions: "Read an existing independent source", deliverable: "Evidence references", acceptance: "Compare exact definitions", criterionIds: ["correct"], dependsOn: [], estimatedTokens: 1000 });

test("time checkpoints allow bounded input-only coordination beside opted-in writing, never benchmarks",()=>{
  const t=fixture();t.autonomy={enabled:true,maxCycles:3,targetMinutes:45};
  const writer=t.workUnits.find(u=>u.id==="slow")!;writer.mode="write";writer.primaryStep=true;
  writer.subtask={...spec(),key:"slow",kind:"primary-work",allowTaskOnlyPeers:true};
  const now=new Date(Date.now()-16*60000).toISOString();
  t.runs=[{id:"slow-run",workUnitId:"slow",role:"worker",state:"running",startedAt:now,executionTiming:{source:"channel",workStartedAt:now}} as any];
  const u=newCoordinator(t,[])!;assert.ok(u);assert.equal(u.orchestrator!.timeCheckpoint,1);
  const running={...t,...coordinatorStart(t,u)};
  assert.throws(()=>applyCoordinatorDecision(running,output(u,{action:"add",reason:"Inspect files during a write",tasks:[spec()]})),/入力文/);
  const done={...running,...applyCoordinatorDecision(running,output(u,{action:"add",reason:"Reason from neutral text",tasks:[{...spec(),inputScope:"assignment"}]}))};
  assert.equal(done.orchestratorDecisions![0].timeCheckpoint,1);
  assert.equal(newCoordinator(JSON.parse(JSON.stringify(done)),[]),undefined,"checkpoint consumed across restart");
  assert.deepEqual(done.workUnits.find(w=>w.id==="slow"),t.workUnits.find(w=>w.id==="slow"));
  writer.subtask.allowTaskOnlyPeers=false;
  assert.equal(newCoordinator(t,[]),undefined,"benchmark/exclusive work cannot overlap coordinator");
});

test("soft targets reserve controller turns for later time checkpoints instead of consuming all on early completions",()=>{
  const t=fixture();t.autonomy={enabled:true,maxCycles:3,targetMinutes:45};
  t.runs=[];t.workUnits.find(u=>u.id==="slow")!.state="pending";
  const first=newCoordinator(t,["fast"])!;assert.ok(first);assert.equal(first.orchestrator!.timeCheckpoint,undefined);
  const startedTask={...t,...coordinatorStart(t,first)};
  const done={...startedTask,...applyCoordinatorDecision(startedTask,output(first,{action:"wait",reason:"Keep bounded milestones",tasks:[]}))};
  done.workUnits.find(u=>u.id==="slow")!.state="completed";
  assert.equal(newCoordinator(done,["slow"]),undefined,"keep time-review slots available");
  const start=new Date(Date.now()-16*60000).toISOString();
  done.runs=[{id:"elapsed",workUnitId:"fast",agentId:"codex",providerKey:"openai",role:"worker",state:"completed",output:"",
    startedAt:start,completedAt:new Date().toISOString(),executionTiming:{source:"channel",workStartedAt:start}}];
  assert.equal(newCoordinator(done,["slow"])?.orchestrator?.timeCheckpoint,1);
});

test("unknown whole-prompt estimates cannot spend the reserved later controller turns",()=>{
  const t=fixture();t.autonomy={enabled:true,maxCycles:3,targetMinutes:45};
  const {t:running,u}=started(t);
  const done={...running,...applyCoordinatorDecision(running,output(u,{action:"wait",reason:"Keep plan",tasks:[]}))};
  const from=new Date(Date.now()-31*60000).toISOString(),to=new Date().toISOString();
  done.runs=[{id:"elapsed",workUnitId:"fast",role:"worker",agentId:"codex",providerKey:"openai",state:"completed",output:"",startedAt:from,completedAt:to},
    {id:"controller",workUnitId:u.id,role:"planner",agentId:"antigravity",providerKey:"google",state:"completed",output:"",startedAt:to,completedAt:to,estimatedTokens:23118,usage:{source:"unknown"}}];
  assert.equal(newCoordinator(done,[])?.orchestrator?.timeCheckpoint,2,"late checkpoint still has its reservation");
  done.runs[1].usage={source:"reported",inputTokens:10000,outputTokens:100};
  assert.ok(newCoordinator(done,[]),"measured consumption remains visible but does not suppress useful decisions");
  done.runs[1].usage={source:"unknown"};done.execution!.tokenBudget=25000;
  assert.ok(newCoordinator(done,[]),"legacy whole-task token target is not an admission gate");
});
test("orchestrator receives the task duration target and milestone estimates", () => {
  const t=fixture(); t.autonomy={enabled:true,maxCycles:3,targetMinutes:45};
  t.workUnits[1].subtask!.estimatedMinutes=12;
  const u=newCoordinator(t,["fast"])!;
  const prompt=buildWorkUnitPrompt(t,u);
  assert.match(prompt,/45 minutes/); assert.match(prompt,/critical path/);
  assert.match(prompt,/"estimatedMinutes":12/);
  assert.doesNotMatch(prompt,/NaN/);
  const prep=buildWorkUnitPrompt({...t,goalPreparation:true},t.workUnits[0]);
  assert.match(prep,/45 minutes for all stages/);
});
function started(t = fixture()) {
  const u = newCoordinator(t, ["fast"])!; assert.ok(u);
  return { t: { ...t, ...coordinatorStart(t, u) }, u };
}
const output = (u: WorkUnit, v: object) => ({ ...u, output: `<work-plan>${JSON.stringify(v)}</work-plan>` });

test("coordinator appends read-only work atomically, preserving running siblings and the final integration/review barrier", () => {
  const { t, u } = started();
  const next = { ...t, ...applyCoordinatorDecision(t, output(u, { action: "add", reason: "Independent boundary evidence removes a later integration question", tasks: [spec()] })) };
  const child = next.workUnits.find(w => w.allocatedBy === u.id)!;
  assert.equal(child.mode, "read"); assert.equal(child.primary, undefined); assert.deepEqual(child.dependsOn, ["fast"]);
  assert.ok(next.workUnits.find(w => w.id === "primary")!.dependsOn.includes(child.id));
  for (const id of ["fast", "slow", "report", "review1", "review2"]) assert.deepEqual(next.workUnits.find(w => w.id === id), t.workUnits.find(w => w.id === id));
  assert.equal(next.orchestratorDecisions![0].status, "added");
  assert.deepEqual(next.goal, t.goal); assert.deepEqual(next.execution, t.execution);
  assert.equal(nextPendingUnit(t), undefined, "manager is owned only by the event loop, not the sequential scheduler");
  assert.equal(newCoordinator({ ...t, execution: { ...t.execution!, maxParallel: 1 } }, ["fast"]), undefined);
});

test("waiting is explicit; malformed, duplicate, cyclic, write-capable and scope-changing allocations are rejected", () => {
  const { t, u } = started();
  assert.equal(applyCoordinatorDecision(t, output(u, { action: "wait", reason: "Existing work covers all requirements", tasks: [] })).orchestratorDecisions![0].status, "waiting");
  for (const v of [
    { action: "add", reason: "reason", tasks: [] }, { action: "wait", reason: "reason", tasks: [spec()] },
    { action: "add", reason: "reason", tasks: [spec()], goal: "changed" },
    ...[{ kind: "primary-work" }, { mode: "write" }, { key: "slow" }, { title: "slow" }, { criterionIds: ["invented"] }, { dependsOn: ["slow"] }, { dependsOn: ["extra"] }].map(patch => ({ action: "add", reason: "reason", tasks: [{ ...spec(), ...patch }] }))
  ]) assert.throws(() => applyCoordinatorDecision(t, output(u, v)));
  assert.throws(() => applyCoordinatorDecision({ ...t, goal: { ...t.goal!, revision: 2 } }, output(u, { action: "wait", reason: "reason", tasks: [] })));
  assert.deepEqual(t.workUnits.find(w => w.id === "primary")!.dependsOn, ["fast", "slow"]);
});

test("coordination ignores token telemetry but bounds calls and additional packages", () => {
  const t = fixture(); t.execution!.tokenBudget = 22000;
  assert.ok(newCoordinator(t, ["fast"]));
  t.execution!.tokenBudget = 40000;
  const { t: running, u } = started(t);
  running.runs.push({ workUnitId: u.id, estimatedTokens: 3000, role: "planner" } as any);
  assert.equal(applyCoordinatorDecision(running, output(u, { action: "add", reason: "useful independent inspection", tasks: [{ ...spec(), estimatedTokens: 16000 }] })).orchestratorDecisions![0].status, "added");
  const done = { ...running, ...applyCoordinatorDecision(running, output(u, { action: "wait", reason: "wait", tasks: [] })) };
  assert.equal(newCoordinator(done, ["fast"]), undefined, "a handled event is never replayed");
  done.execution = { ...done.execution!, tokenBudget: undefined };
  done.orchestratorDecisions = [0,1,2].map(i => ({ ...done.orchestratorDecisions![0], id: String(i) }));
  assert.equal(newCoordinator(done, ["fast"]), undefined);
  done.orchestratorDecisions = [{ ...done.orchestratorDecisions[0], addedUnitIds: ["1","2","3","4"] }];
  assert.equal(newCoordinator(done, ["fast"]), undefined);
});

test("coordination is a separate brief conversation with bounded findings, no worker tools, no report instructions", () => {
  const { t, u } = started(); t.workUnits[0].output = "x".repeat(50000) + "EVIDENCE_REFERENCE";
  const prompt = coordinatorPrompt(t, u);
  assert.match(prompt, /EVIDENCE_REFERENCE/); assert.ok(prompt.length < 16000);
  assert.match(prompt, /no filesystem exploration/); assert.match(prompt, /Default to wait/);
  assert.doesNotMatch(buildWorkUnitPrompt(t, u), /# Lead-owned execution plan|TeX build instructions/);
});

test("controller does not duplicate full goals, presets, resource tables or long previous plans",()=>{
  const {t,u}=started();
  t.goal!.objective="Objective "+"long text ".repeat(5000);
  t.instruction="Instruction "+"details ".repeat(5000);
  t.executionPlans![0].summary="Plan "+"details ".repeat(5000);
  t.executionPlans![0].primaryWork="Work "+"details ".repeat(5000);
  t.workUnits[0].output="x".repeat(50000)+"FINAL_FINDING";
  const p=coordinatorPrompt(t,u);
  assert.ok(Buffer.byteLength(p,"utf8")<8500);
  assert.match(p,/FINAL_FINDING/);assert.match(p,/original.*contracts.*binding/);
  assert.doesNotMatch(p,/# Mandatory report writing rules|# Working report/);
});

test("interrupted coordination keeps completed evidence and resumes real work, not an orphan manager", () => {
  const { t, u } = started(); t.workUnits.find(w => w.id === u.id)!.state = "running";
  t.state = "paused"; t.resumeFromUnitId = u.id;
  t.workUnits.find(w => w.id === "slow")!.state = "cancelled";
  const recovered = { ...t, ...interruptedCoordinators(t) };
  assert.equal(recovered.orchestratorDecisions![0].status, "skipped");
  const resumed = { ...recovered, ...resumePatch(recovered) };
  assert.equal(resumed.workUnits.find(w => w.id === "fast")!.state, "completed");
  assert.equal(resumed.workUnits.find(w => w.id === "slow")!.state, "pending");
  assert.equal(resumed.workUnits.find(w => w.id === u.id)!.state, "completed");
  assert.equal(interruptedCoordinators(recovered), undefined);
  const crashAfterReceipt = { ...t, workUnits: t.workUnits.map(w => w.id === u.id ? { ...w, state: "completed" as const } : w) };
  assert.equal(interruptedCoordinators(crashAfterReceipt)!.orchestratorDecisions![0].status, "skipped");
});

test("serial boundaries share planning policy and consume each original completion only once across reload", () => {
  const t = fixture(); t.execution!.maxParallel = 1;
  t.workUnits.find(u => u.id === "slow")!.state = "pending";
  t.runs = [];
  const {t: running, u} = started(t);
  assert.match(coordinatorPrompt(running, u), /Shared adaptive work strategy/);
  const done = {...running, ...applyCoordinatorDecision(running, output(u, {action:"wait",reason:"Plan still fits",tasks:[]}))};
  assert.equal(newCoordinator(JSON.parse(JSON.stringify(done)), ["fast"]), undefined);
  const extra = {...done.workUnits[0], id:"extra", allocatedBy:u.id};
  done.workUnits.push(extra);
  assert.equal(newCoordinator(done, ["extra"]), undefined);
  done.workUnits.find(w => w.id === "slow")!.state = "completed";
  assert.ok(newCoordinator(done, ["slow"]));
});

test("adjustment supplements never-started work without rewriting its original contract", () => {
  const {t, u} = started();
  const original = t.workUnits.find(w => w.id === "primary")!;
  const note = "Verify the boundary at evidence/case.json; retain every original check";
  const next = {...t, ...applyCoordinatorDecision(t, output(u, {action:"adjust",reason:"New boundary evidence",tasks:[{...spec(),purpose:"verify"}],refinements:[{unitId:"primary",note}]}))};
  const updated = next.workUnits.find(w => w.id === "primary")!;
  assert.equal(updated.instructions, original.instructions);
  assert.equal(updated.mode, original.mode);
  assert.deepEqual(updated.subtask, original.subtask);
  assert.deepEqual(updated.coordinationNotes, [{decisionId:u.id,note}]);
  assert.match(buildWorkUnitPrompt(next, updated), /Saved-plan refinements/);
  assert.ok(buildWorkUnitPrompt(next, updated).includes(note));
  assert.equal(next.orchestratorDecisions![0].status, "adjusted");
  assert.deepEqual(next.orchestratorDecisions![0].refinements, [{unitId:"primary",note}]);
  assert.equal(next.workUnits.find(w => w.allocatedBy === u.id)!.subtask!.purpose, "verify");
  assert.deepEqual(next.goal, t.goal);
  assert.deepEqual(next.workUnits.filter(w => ["slow","report","review1","review2"].includes(w.id)), t.workUnits.filter(w => ["slow","report","review1","review2"].includes(w.id)));
});

test("adjustment rejects stale, started, blind or privileged targets atomically", () => {
  const decision = (id:string) => ({action:"adjust",reason:"New evidence",tasks:[],refinements:[{unitId:id,note:"Check evidence"}]});
  for (const id of ["slow","fast","report","review1","missing"]) {
    const {t,u} = started(); assert.throws(() => applyCoordinatorDecision(t, output(u, decision(id))));
  }
  for (const mutate of [
    (_t:TaskRecord,w:WorkUnit) => {w.state="running";},
    (_t:TaskRecord,w:WorkUnit) => {w.startedAt="earlier";},
    (_t:TaskRecord,w:WorkUnit) => {w.attemptedAgentIds=["codex"];},
    (t:TaskRecord,w:WorkUnit) => {t.runs.push({workUnitId:w.id,state:"cancelled"} as any);},
    (_t:TaskRecord,w:WorkUnit) => {w.instructions+=" changed";},
    (_t:TaskRecord,w:WorkUnit) => {w.dependsOn=[];},
    (_t:TaskRecord,w:WorkUnit) => {w.subtask={...spec(),requirements:{independentFrom:["fast"]}};},
    (t:TaskRecord,_w:WorkUnit) => {t.pendingExecution={policy:defaultExecution,savedAt:"now"};},
  ]) {
    const {t,u}=started(); mutate(t,t.workUnits.find(w=>w.id==="primary")!);
    const before=JSON.stringify(t);
    assert.throws(()=>applyCoordinatorDecision(t,output(u,decision("primary"))));
    assert.equal(JSON.stringify(t),before);
  }
  const {t,u}=started();
  for (const refinements of [[],[{unitId:"primary",note:""}],[{unitId:"primary",note:"x".repeat(1801)}],
    [{unitId:"primary",note:"a"},{unitId:"primary",note:"b"}],
    [{unitId:"primary",note:"a"},{unitId:"slow",note:"b"}],
    [{unitId:"primary",note:"a",mode:"write"}]]) {
    assert.throws(()=>applyCoordinatorDecision(t,output(u,{...decision("primary"),refinements})));
    assert.equal(t.workUnits.find(w=>w.id==="primary")!.coordinationNotes,undefined);
  }
});
