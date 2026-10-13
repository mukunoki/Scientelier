import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEvidence, decideIteration, evidenceUnchanged, orderAutonomousUnits, parseEvaluation, repairUnits, validateAutonomy } from "./autonomy";
import { createStandardWorkflow } from "./orchestration";
import type { TaskRecord, GoalEvaluation } from "./types";

function task(cwd = "/tmp"): TaskRecord {
  return { id: "auto", title: "Auto", prompt: "Verify", cwd, strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, runs: [], output: "", state: "reviewing", createdAt: "", updatedAt: "", workUnits: orderAutonomousUnits(createStandardWorkflow()), autonomy: { enabled: true, maxCycles: 5 },
    goal: { objective: "Verify", deliverables: ["output.txt"], revision: 2, status: "approved", updatedAt: "", constraints: [], outOfScope: [], questions: [], criteria: [{ id: "a", description: "Required", required: true, verification: "Check output" }, { id: "b", description: "Optional", required: false, verification: "Inspect" }] } };
}
function evaluation(t = task(), status = "fail"): GoalEvaluation {
  return parseEvaluation(`<goal-evaluation>${JSON.stringify({ goalRevision: 2, criteria: [{ criterionId: "a", status, detail: "Verified result", evidence: status === "pass" ? [{ path: "output.txt", detail: "Inspected actual file" }] : [] }, { criterionId: "b", status: "unverified", detail: "Optional", evidence: [] }], nextAction: "repair", repairInstructions: "Fix required condition a", summary: "Result" })}</goal-evaluation>`, t);
}
test("autonomy orders PDF before final review and bounds repair without optional scope expansion", () => {
  const t = task(); assert.deepEqual(t.workUnits.map(u => u.role), ["planner", "worker", "reporter", "reviewer"]);
  const next = repairUnits(t, evaluation(t)); assert.deepEqual(next.map(u => u.role), ["worker", "reporter", "reviewer"]);
  assert.match(next[0].instructions, /Repair ONLY/); assert.doesNotMatch(next[0].instructions, /Optional/);
  assert.throws(() => validateAutonomy({ enabled: true, maxCycles: 0 })); assert.throws(() => validateAutonomy({ enabled: true, maxCycles: 99 }));
  assert.equal(decideIteration(t, evaluation(t, "pass")), "satisfied");
  assert.equal(decideIteration(t, evaluation(t)), "working");
  assert.equal(decideIteration(t, { ...evaluation(t), cycle: 5 }), "cycle-limit");
  assert.equal(decideIteration(t, { ...evaluation(t, "pass"), nextAction: "ask-user" }), "needs-input");
  assert.equal(decideIteration({ ...t, evaluations: [evaluation(t), evaluation(t)] }, { ...evaluation(t), cycle: 3 }), "stalled");
});
test("review requires exact goal revision and every criterion, with evidence for each pass", () => {
  const t = task(); const e = evaluation(t, "pass");
  const wrap = (v: unknown) => `<goal-evaluation>${JSON.stringify(v)}</goal-evaluation>`;
  assert.throws(() => parseEvaluation("done", t));
  assert.throws(() => parseEvaluation(wrap({ ...e, goalRevision: 1 }), t));
  assert.throws(() => parseEvaluation(wrap({ ...e, criteria: [e.criteria[0], e.criteria[0]] }), t));
  assert.throws(() => parseEvaluation(wrap({ ...e, criteria: [] }), t));
  e.criteria[0].evidence = [];
  assert.equal(parseEvaluation(wrap(e), t).criteria[0].status, "unverified");
});
test("verified shrinking concerns count as progress, but rewording or deletion alone does not", () => {
  const t=task();
  const result=(cycle:number, concerns:string[], hash:string):GoalEvaluation=>({...evaluation(t,"pass"),cycle,concerns,
    criteria:[{criterionId:"a",status:"pass",detail:"Checked",evidence:[{path:"test.log",detail:"Validation",hash}]}]});
  t.evaluations=[result(1,["A","B","C"],"old"),result(2,["B","C"],"old")];
  assert.equal(decideIteration(t,result(3,["C"],"new")),"working");
  assert.equal(decideIteration(t,result(3,["C"],"old")),"stalled");
  assert.equal(decideIteration(t,result(3,["C rewritten"],"new")),"stalled");
  assert.equal(decideIteration(t,result(3,["B","C","D"],"new")),"stalled");
  assert.equal(decideIteration(t,result(5,["C"],"new")),"cycle-limit");
});
test("evidence is scoped, fingerprinted and invalidated after mutation or removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-evidence-"));
  const outside = await mkdtemp(join(tmpdir(), "harness-outside-"));
  try {
    const t = task(directory); const path = join(directory, "output.txt"); await writeFile(path, "verified output");
    const e = await captureEvidence(evaluation(t, "pass"), t, new Date(Date.now() + 1).toISOString());
    assert.equal(e.criteria[0].status, "pass"); assert.ok(e.criteria[0].evidence[0].hash);
    assert.equal(await evidenceUnchanged(e, t), true);
    await writeFile(path, "changed"); assert.equal(await evidenceUnchanged(e, t), false);
    assert.equal((await captureEvidence(evaluation(t, "pass"), t, "2000-01-01T00:00:00Z")).criteria[0].status, "unverified");
    await rm(path); assert.equal(await evidenceUnchanged(e, t), false);
    await writeFile(join(outside, "secret"), "out of scope"); await symlink(join(outside, "secret"), path);
    const invalid = await captureEvidence(evaluation(t, "pass"), t, new Date().toISOString());
    assert.equal(invalid.criteria[0].status, "unverified"); assert.match(invalid.criteria[0].detail, /フォルダ外/);
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
