import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairUnits, currentReviewPair, combineReviewPair, excludedReviewClis, writerClis, reviewNumber } from "./review-pair";
import { createStandardWorkflow, selectAgent, buildWorkUnitPrompt } from "./orchestration";
import { captureEvidence, decideIteration, evidenceUnchanged, parseEvaluation, repairUnits } from "./autonomy";
import { budgetStatus } from "./execution-policy";
import type { AgentId, AgentPolicy, GoalEvaluation, TaskRecord } from "./types";

function fixture(): TaskRecord {
  const workUnits = pairUnits(createStandardWorkflow()).map(u => ({ ...u, state: "completed" as const, assignedAgentId: (u.reviewPass === 1 ? "claude" : u.reviewPass === 2 ? "gemini" : "codex") as AgentId }));
  return { id: "pair", title: "Pair", prompt: "Verify", cwd: "/tmp", strategy: "balanced", allowedAgentIds: ["codex", "claude", "gemini"], modelOverrides: {},
    reviewPolicy: "adversarial-pair", autonomy: { enabled: true, maxCycles: 3 }, workUnits, runs: workUnits.map(u => ({ id: u.id, workUnitId: u.id, role: u.role, agentId: u.assignedAgentId!, state: "completed", output: "", startedAt: "", providerKey: u.assignedAgentId! })),
    output: "", state: "reviewing", createdAt: "", updatedAt: "", goal: { revision: 1, status: "approved", updatedAt: "", objective: "Verify", deliverables: [], constraints: [], outOfScope: [], questions: [], criteria: [{ id: "report", required: true, description: "Verify report", verification: "Inspect actual output" }] } };
}
function evaluation(task: TaskRecord, pass: 1 | 2, status: "pass" | "fail" = "pass", concerns: string[] = []): GoalEvaluation {
  return { goalRevision: 1, round: 1, cycle: 1, reviewedAt: "", reviewPass: pass, reviewUnitId: task.workUnits.find(u => u.reviewPass === pass)!.id,
    reviewerAgentId: pass === 1 ? "claude" : "gemini", concerns, criteria: [{ criterionId: "report", status, detail: "Verified", evidence: [] }], nextAction: "repair", repairInstructions: status === "fail" ? "Fix the defect" : "", summary: "Verdict " + pass };
}
test("pair graph, budget reserve and combined verdict require both fresh independent reviews", () => {
  const task = fixture(); const units = pairUnits(createStandardWorkflow());
  assert.deepEqual(units.map(u => u.role), ["planner", "worker", "reporter", "reviewer", "reviewer"]);
  assert.equal(pairUnits(units), units);
  assert.ok(units[3].dependsOn.includes(units[2].id)); assert.deepEqual(units[4].dependsOn, [units[3].id]);
  assert.equal(budgetStatus({ ...task, workUnits: units, runs: [] }).reserve, 13000);
  task.evaluations = [evaluation(task, 1)]; assert.throws(() => combineReviewPair(task));
  task.evaluations.push(evaluation(task, 2)); assert.equal(decideIteration(task, combineReviewPair(task)), "satisfied");
  task.evaluations[0] = evaluation(task, 1, "fail"); assert.equal(decideIteration(task, combineReviewPair(task)), "working");
  task.evaluations[0] = evaluation(task, 1, "pass", ["Investigate a counterexample"]);
  const combined = combineReviewPair(task); assert.equal(decideIteration(task, combined), "working");
  const repair = repairUnits(task, combined); assert.match(repair[0].instructions, /counterexample/); assert.equal(repair.filter(u => u.reviewPass).length, 2);
  assert.equal(currentReviewPair({ ...task, workUnits: repair, autonomyCycle: 2 }).length, 0);
  task.evaluations[1].reviewerAgentId = "claude"; assert.throws(() => combineReviewPair(task), /異なるCLI/);
  task.evaluations[1].reviewerAgentId = "codex"; assert.doesNotThrow(() => combineReviewPair(task), "a writer may review in a fresh conversation if the two reviewers differ");
});
test("routing prefers nonwriters, allows writer fallback, but never reuses the first reviewer", () => {
  const task = fixture(), second = task.workUnits.find(u => u.reviewPass === 2)!;
  const policies: AgentPolicy[] = (["codex", "claude", "gemini"] as AgentId[]).map(id => ({ agentId: id, enabled: true, providerKey: id, providerLabel: id, authMode: "subscription", priority: 80 }));
  const input = { task, unit: second, agents: policies.map(p => ({ id: p.agentId, label: p.agentId, command: p.agentId, installed: true })), settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 }, resources: [] };
  assert.equal(selectAgent(input), "gemini");
  assert.equal(selectAgent({ ...input, task: { ...task, allowedAgentIds: ["codex", "claude"] } }), "codex");
  assert.equal(selectAgent({ ...input, agents: input.agents.map(a => ({ ...a, installed: a.id !== "gemini" })) }), "codex");
  assert.equal(selectAgent({ ...input, task: { ...task, allowedAgentIds: ["claude"] } }), undefined);
  assert.equal(selectAgent({ ...input, unit: { ...second, attemptedAgentIds: ["gemini"] } }), "codex");
  const first = task.workUnits.find(u => u.reviewPass === 1)!;
  assert.equal(selectAgent({ ...input, unit: first, task: { ...task, assignments: { reviewer: { agentId: "codex", allowFallback: false } } } }), "codex");
  first.output = "FIRST_REVIEW_SECRET_SUCCESS";
  task.history = [{ number: 1, kind: "initial", instruction: "Verify", state: "completed", workUnits: [first], finishedAt: "" }];
  assert.doesNotMatch(buildWorkUnitPrompt(task, second), /FIRST_REVIEW_SECRET_SUCCESS/);
  assert.match(buildWorkUnitPrompt(task, second), /Mandatory independent review/);
  const repaired = { ...task, workUnits: repairUnits(task, evaluation(task, 2, "fail")), autonomyCycle: 2,
    assignments: { reviewer: { agentId: "gemini" as const, allowFallback: false } } };
  repaired.runs = [...task.runs, { ...task.runs.find(r => r.role === "worker")!, id: "repair-worker", workUnitId: repaired.workUnits[0].id }];
  const next = repaired.workUnits.find(u => u.reviewPass === 1)!;
  assert.deepEqual(excludedReviewClis(repaired, next), new Set(["gemini"]), "repair does not reset the preceding reviewer");
  assert.equal(selectAgent({ ...input, task: repaired, unit: next }), "claude", "the initial reviewer pin must not force reuse across a repair boundary");
  assert.equal(reviewNumber(repaired, next), 3);
  const firstRun = task.runs.find(r => r.role === "reviewer")!;
  const failedFirst = { ...task, runs: task.runs.filter(r => r.id !== second.id), workUnits: repaired.workUnits };
  assert.deepEqual(excludedReviewClis(failedFirst, next), new Set([firstRun.agentId]), "a failure at the first review immediately alternates after repair");
  assert.equal(reviewNumber(failedFirst, next), 2);
  const reportOnly = { ...task, workUnits: pairUnits(task.workUnits.filter(u => u.role === "reporter")) };
  reportOnly.runs = [...task.runs, { ...task.runs[0], id: "rebuild", role: "reporter", workUnitId: reportOnly.workUnits[0].id, agentId: "claude" }];
  assert.deepEqual(writerClis(reportOnly), new Set(["codex", "claude"]), "report-only rounds retain writer identity as a preference");
  assert.deepEqual(excludedReviewClis(reportOnly, reportOnly.workUnits[1]), new Set(["gemini"]), "later report-only rounds still alternate from the preceding reviewer");
});
test("concerns cannot be omitted, and changes to a PDF invalidate a review even if not cited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pair-artifacts-"));
  try {
    const task = fixture(); task.cwd = directory;
    const texPath = join(directory, "report.tex"), pdfPath = join(directory, "report.pdf");
    await writeFile(texPath, "subject"); await writeFile(pdfPath, "%PDF-1.7 original");
    task.report = { state: "ready", texPath, pdfPath };
    const raw = { ...evaluation(task, 1), criteria: [{ criterionId: "report", status: "pass", detail: "Checked", evidence: [{ path: texPath, detail: "Source" }] }] };
    const wrap = (value: unknown) => "<goal-evaluation>" + JSON.stringify(value) + "</goal-evaluation>";
    assert.throws(() => parseEvaluation(wrap({ ...raw, concerns: undefined }), task), /concerns/);
    assert.ok(parseEvaluation(wrap({ ...raw, repairInstructions: "One further issue" }), task).concerns?.length);
    const saved = await captureEvidence(parseEvaluation(wrap(raw), task), task, new Date(Date.now() + 100).toISOString());
    assert.equal(await evidenceUnchanged(saved, task), true);
    await writeFile(pdfPath, "%PDF-1.7 changed");
    assert.equal(await evidenceUnchanged(saved, task), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
