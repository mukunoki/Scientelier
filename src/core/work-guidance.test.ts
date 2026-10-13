import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { elapsedWorkMinutes, insertCheckpoint, parseWorkCheck, returnWork, roleGuidance, timeGuidance, transferReportWork, WorkCheckError, workCheckRetry } from "./work-guidance";
import { createStandardWorkflow, nextPendingUnit } from "./orchestration";
import { validateAutonomy } from "./autonomy";
import type { TaskRecord, WorkUnit } from "./types";

test("user decisions separate short questions from accomplishments and preserve legacy submissions", async () => {
  const value = {status:"ask-user",summary:"Completed 183 checks",remainingWork:"Need an explicit tolerance decision",estimatedRemainingMinutes:0,evidence:[]};
  const decision = {reason:"A criterion conflicts with the actual sequence",question:"Revise the named criterion?",options:["Explicit revision with independent review","Retain criterion as unmet"]};
  const parse = (userDecision?: unknown) => parseWorkCheck(`<work-check>${JSON.stringify({...value,userDecision})}</work-check>`,{} as TaskRecord);
  assert.deepEqual((await parse(decision)).userDecision,decision);
  assert.equal((await parse()).status,"ask-user");
  for(const malformed of [{reason:4}, {...decision,options:"not an array"},{...decision,question:"x".repeat(801)}]) {
    const result=await parse(malformed);
    assert.equal(result.userDecision,undefined); assert.equal(result.remainingWork,value.remainingWork);
  }
});

test("invalid evidence is returned for bounded correction, never guessed or accepted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "check-outside-"));
  const task = { cwd: dir } as TaskRecord;
  const wrap = (evidence: string[]) => `<work-check>${JSON.stringify({status:"ready",summary:"Checked",remainingWork:"",estimatedRemainingMinutes:1,evidence})}</work-check>`;
  try {
    const path = join(dir, "evidence with spaces.json");
    await writeFile(path, "{}");
    await writeFile(join(outside, "data.json"), "{}");
    await symlink(join(outside, "data.json"), join(dir, "escape.json"));
    assert.deepEqual((await parseWorkCheck(wrap([path]), task)).evidence, [path]);
    for (const wrong of [`${path} : 全criterion ID別の証拠`, `${path} と other.json`, "missing.json", "escape.json", dir]) {
      await assert.rejects(parseWorkCheck(wrap([wrong]), task), (error: unknown) => {
        assert.ok(error instanceof WorkCheckError);
        assert.match(error.message, /パスだけを1項目に1つ/);
        const unit: WorkUnit = {...createStandardWorkflow()[1], assignedAgentId:"codex", attemptedAgentIds:["codex","claude"]};
        const retry = workCheckRetry(unit,error)!;
        assert.equal(retry.state,"pending"); assert.equal(retry.workCheckRetries,1);
        assert.deepEqual(retry.attemptedAgentIds,["claude"]);
        assert.equal(workCheckRetry({...unit,workCheckRetries:2},error),undefined);
        assert.equal(workCheckRetry(unit,new Error("unrelated")),undefined);
        return true;
      });
    }
    let received = "";
    await assert.rejects(parseWorkCheck(wrap([`${path} : prose`]),task,async p=>{received=p; throw new Error("remote missing");}),WorkCheckError);
    assert.equal(received,`${path} : prose`,"remote paths are not silently truncated either");
  } finally { await rm(dir,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});

test("soft duration preserves overrun and measures active work without goal preparation or paused time", () => {
  const task = { state:"running", autonomy: { enabled: true, maxCycles: 3, targetMinutes: 10 }, runs: [
    { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T01:00:00Z", goalPreparation: true },
    { startedAt: "2026-01-01T01:00:00Z", completedAt: "2026-01-01T01:20:00Z" },
    { startedAt: "2026-01-01T02:00:00Z", state: "running" }
  ] } as TaskRecord;
  assert.equal(elapsedWorkMinutes(task, Date.parse("2026-01-01T02:05:00Z")), 25);
  assert.match(timeGuidance(task), /SOFT TARGET, never a timeout/);
  assert.match(timeGuidance(task), /10 minutes/);
  assert.equal(validateAutonomy(task.autonomy).targetMinutes, 10);
  assert.throws(() => validateAutonomy({ ...task.autonomy, targetMinutes: -1 }));
  assert.throws(() => validateAutonomy({ ...task.autonomy, targetMinutes: NaN }));
});

test("remaining duration counts parallel intervals once and guides critical-path planning", () => {
  const task = {autonomy:{enabled:true,maxCycles:3,targetMinutes:30},runs:[
    {startedAt:"2026-01-01T00:00:00Z",completedAt:"2026-01-01T00:20:00Z"},
    {startedAt:"2026-01-01T00:10:00Z",completedAt:"2026-01-01T00:25:00Z"},
    {state:"running"}
  ]} as unknown as TaskRecord;
  assert.equal(elapsedWorkMinutes(task),25);
  assert.match(timeGuidance(task),/Remaining approximate time: 5.0 minutes/);
  assert.match(timeGuidance(task),/critical path/);
  assert.match(timeGuidance(task),/mandatory independent reviews/);
  task.autonomy!.targetMinutes=10;
  assert.match(timeGuidance(task),/Remaining approximate time: 0.0 minutes/);
  assert.match(timeGuidance(task),/Target reached\/exceeded/);
});

test("explicit report-only handoff verifies source and preserves pending report/reviews, without a worker loop", async () => {
  const dir = await mkdtemp(join(tmpdir(),"report-handoff-"));
  const units = createStandardWorkflow();
  const worker = {...units[1],primary:true,state:"completed" as const};
  const report = {...units[3],dependsOn:[worker.id]};
  const review = {...units[2],dependsOn:[report.id]};
  const task = {cwd:dir,report:{texPath:join(dir,"report.tex")},workUnits:[worker,report,review]} as TaskRecord;
  const check = {status:"report-ready",summary:"Code and tests completed",remainingWork:"Compile TeX and inspect every PDF page",estimatedRemainingMinutes:10,evidence:[task.report!.texPath!]};
  const wrap = (v: unknown) => `<work-check>${JSON.stringify(v)}</work-check>`;
  try {
    await assert.rejects(parseWorkCheck(wrap(check),task));
    await writeFile(task.report!.texPath!,"Substantive verified TeX source");
    const parsed = await parseWorkCheck(wrap(check),task);
    const routed = transferReportWork(task,worker,parsed);
    assert.equal(routed.length,3); assert.equal(routed[0].checkpointHandled,true);
    assert.equal(routed[1].state,"pending"); assert.match(routed[1].instructions,/Compile TeX/);
    assert.deepEqual(routed[2],review); assert.equal(nextPendingUnit({...task,workUnits:routed})?.role,"reporter");
    assert.throws(()=>returnWork(task.workUnits,worker,parsed));
    assert.throws(()=>transferReportWork(task,worker,{...parsed,status:"ask-user"}));
    assert.throws(()=>transferReportWork(task,{...worker,planPhase:true},parsed));
    assert.throws(()=>transferReportWork({...task,workUnits:[worker,review]},worker,parsed));
    await assert.rejects(parseWorkCheck(wrap({...check,evidence:[]}),task));
    await assert.rejects(parseWorkCheck(wrap({...check,remainingWork:""}),task));
    let verified = 0;
    await parseWorkCheck(wrap(check),task,async()=>{verified++;}); assert.equal(verified,1);
    await assert.rejects(parseWorkCheck(wrap(check),task,async()=>{throw new Error("remote missing");}),/remote missing/);
    assert.equal(report.state,"pending"); assert.equal(worker.checkpointHandled,undefined);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test("planner checkpoint is required after each worker, including returned work", () => {
  const units = createStandardWorkflow(); units[0].state = "completed"; units[1].state = "completed";
  const inserted = insertCheckpoint(units, units[1]);
  const task = { workUnits: inserted } as TaskRecord;
  const check = nextPendingUnit(task)!;
  assert.equal(check.checkpointFor, units[1].id); assert.equal(check.role, "planner");
  assert.equal(insertCheckpoint(inserted, units[1]), inserted);
  check.state = "completed";
  const returned = returnWork(inserted, check, { status: "needs-work", summary: "Missing source", remainingWork: "Write actual research", estimatedRemainingMinutes: 20, evidence: [] });
  const worker = nextPendingUnit({ ...task, workUnits: returned })!;
  assert.equal(worker.role, "worker"); assert.equal(worker.workAttempt, 2);
  worker.state = "completed";
  const checkedAgain = insertCheckpoint(returned, worker);
  assert.equal(nextPendingUnit({ ...task, workUnits: checkedAgain })!.checkpointFor, worker.id);
  assert.match(roleGuidance(units[0]), /Do not perform the literature survey/);
  assert.match(roleGuidance(units[1]), /substantive research/);
  assert.match(roleGuidance(units[3]), /Do not replace an absent worker/);
});
test("progress review rejects missing files or invalid decisions, and respects user blockers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-check-test-"));
  const task = { cwd: dir } as TaskRecord;
  const payload = { status: "ready", summary: "Usable results", remainingWork: "", estimatedRemainingMinutes: 10, evidence: ["result.tex"] };
  const wrap = (v: unknown) => `<work-check>${JSON.stringify(v)}</work-check>`;
  try {
    await assert.rejects(() => parseWorkCheck(wrap(payload), task));
    await writeFile(join(dir, "result.tex"), "subject content");
    assert.equal((await parseWorkCheck(wrap(payload), task)).status, "ready");
    await assert.rejects(() => parseWorkCheck(wrap({ ...payload, evidence: [] }), task));
    await assert.rejects(() => parseWorkCheck("done", task));
    assert.equal((await parseWorkCheck(wrap({ ...payload, status: "ask-user", evidence: [], remainingWork: "Approved constraints prohibit editing" }), task)).status, "ask-user");
    for (const summary of ["bwrap: setting up uid map: Permission denied", "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"]) {
      const denied = await parseWorkCheck(wrap({ ...payload, status: "needs-work", summary, remainingWork: "Retry after environment repair", evidence: [] }), task);
      assert.equal(denied.status, "environment-blocked"); assert.match(denied.blocker!.recovery, /復旧/);
    }
    assert.equal((await parseWorkCheck(wrap({ ...payload, status: "needs-work", summary: "An ordinary test failed", remainingWork: "Repair implementation" }), task)).status, "needs-work");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
