import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExecutionPlan, parseExecutionPlan } from "./execution-plan";
import { PlanFormatError, type PlanInput } from "./plan-format";
import { buildWorkUnitPrompt, createExecutionWorkflow } from "./orchestration";
import { contentRefinementContext, usesContentRefinement } from "./content-refinement";
import { collectWorkSkills } from "./work-skills";
import { runPlannedWork } from "./planned-scheduler";
import { JsonTaskStore } from "./task-store";
import type { SubtaskSpec, TaskRecord } from "./types";

function task(): TaskRecord {
  return { id: "refinement", title: "Improve one coupled problem", prompt: "Implement approved behavior", cwd: "/tmp", strategy: "balanced", workflowMode: "primary",
    execution: { reuseContext: true, decompose: true, maxSubtasks: 4, maxParallel: 2 }, allowedAgentIds: ["codex", "claude"], modelOverrides: {},
    state: "running", workUnits: createExecutionWorkflow({ workflowMode: "primary" }), runs: [], output: "", createdAt: "", updatedAt: "",
    goal: { revision: 1, status: "approved", updatedAt: "", objective: "Implement approved behavior", criteria: [{ id: "c", required: true, description: "Correct", verification: "Test" }], deliverables: ["Source and report"], constraints: [], outOfScope: [], questions: [] } };
}
function packageFor(key: string, dependsOn: string[] = [], kind?: "primary-work"): SubtaskSpec {
  return { key, kind, title: key, instructions: "Bounded approved task", deliverable: "Evidence and findings", acceptance: "Verify evidence", criterionIds: ["c"], estimatedTokens: 1000, estimatedMinutes: 2, dependsOn };
}
const input = () => ({ summary: "Improve substance before reporting", reason: "Meaningful uncertainty", primaryWork: "Integrate tested changes and draft", acceptance: "Verify approved behavior", criterionIds: ["c"], estimatedTokens: 8000, estimatedMinutes: 20, escalation: "New authority only",
  tasks: [packageFor("initial", [], "primary-work"), packageFor("alternative", ["initial"]), packageFor("challenge", ["initial"]), packageFor("apply", ["alternative", "challenge"], "primary-work")],
  refinement: { objective: "Evaluate an alternative design and a counterexample", proposalKeys: ["alternative", "challenge"], applicationKey: "apply", stopWhen: "No promising authorized within-budget improvement remains" } });
const encode = (v: unknown) => `<execution-plan>${JSON.stringify(v)}</execution-plan>`;
function apply(t: TaskRecord, v: PlanInput = input()) {
  const owner = t.workUnits[0]; owner.state = "completed";
  Object.assign(t, applyExecutionPlan(t, owner, parseExecutionPlan(encode(v), t, owner)!));
}

test("refinement binds actual dependency graph, runs peers together and applies after both without changing final stages", async () => {
  const t = task(), originalGoal = structuredClone(t.goal), originalPolicy = structuredClone(t.execution);
  apply(t); const sequence: string[] = [], active = new Set<string>(); let peak = 0;
  const result = await runPlannedWork({ snapshot: () => t, paused: () => false, execute: async id => {
    const unit = t.workUnits.find(u => u.id === id)!;
    const key = unit.subtask!.key; sequence.push(key); unit.state = "running"; active.add(key); peak = Math.max(peak, active.size);
    if (unit.mode === "write") assert.equal(active.size, 1, "shared writer does not race stable-version readers");
    if (key === "apply") {
      assert.ok(t.workUnits.filter(u => ["alternative", "challenge"].includes(u.subtask?.key ?? "")).every(u => u.state === "completed"));
      const prompt = buildWorkUnitPrompt(t, unit, { deferSkills: true });
      assert.match(prompt, /内容改善の採否・実作業への反映/);
      assert.match(prompt, /Alternative finding/); assert.match(prompt, /Challenge finding/);
      assert.match(prompt, /転記するだけで済ませません/);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    unit.output = key === "alternative" ? "Alternative finding" : key === "challenge" ? "Challenge finding" : "Approved bounded result";
    unit.state = "completed"; active.delete(key); return "completed";
  }});
  assert.equal(result.status, "done"); assert.equal(peak, 2);
  assert.equal(sequence[0], "initial"); assert.equal(sequence.at(-1), "apply");
  const final = t.workUnits.find(u => u.id === t.executionPlans![0].primaryUnitId)!;
  assert.ok(final.dependsOn.every(id => t.workUnits.find(u => u.id === id)?.state === "completed"));
  assert.equal(t.workUnits.filter(u => u.role === "reporter").length, 1);
  assert.ok(t.workUnits.some(u => u.role === "reviewer"));
  assert.deepEqual(t.goal, originalGoal); assert.deepEqual(t.execution, originalPolicy);
});

test("portable refinement validation rejects race, invented tasks, authority and bad types, but accepts transitive synthesis", () => {
  const t = task(), parse = (v: unknown) => parseExecutionPlan(encode(v), t, t.workUnits[0]);
  for (const value of [null, {}, { ...input().refinement, permission: "full" }, { ...input().refinement, objective: "" }, { ...input().refinement, stopWhen: "" }, { ...input().refinement, proposalKeys: "alternative" }, { ...input().refinement, proposalKeys: [null] }, { ...input().refinement, proposalKeys: ["missing"] }, { ...input().refinement, proposalKeys: ["alternative", "alternative"] }, { ...input().refinement, proposalKeys: ["initial"] }, { ...input().refinement, applicationKey: "alternative" }, { ...input().refinement, applicationKey: "missing" }]) {
    assert.throws(() => parse({ ...input(), refinement: value }), PlanFormatError);
  }
  const race = input(); race.tasks[3].dependsOn = ["alternative"];
  assert.throws(() => parse(race), /すべての検討担当/);
  const transitive = input();
  transitive.tasks = [packageFor("alternative"), packageFor("challenge", ["alternative"]), packageFor("synthesis", ["challenge"]), packageFor("apply", ["synthesis"], "primary-work")];
  assert.deepEqual(parse(transitive)!.refinement, transitive.refinement);
  t.execution!.decompose = false; assert.throws(() => parse(input()));
  t.execution!.decompose = true; t.execution!.tokenBudget = 1000; assert.ok(parse(input()), "useful peer improvement is not gated by total tokens");
});

test("old and solo plans require no new gate; saved bindings survive persistence and reject stale rounds", async () => {
  const t = task(), solo = { ...input(), tasks: [], refinement: { ...input().refinement, proposalKeys: [], applicationKey: undefined } };
  assert.ok(parseExecutionPlan(encode({ ...solo, refinement: undefined }), t, t.workUnits[0]));
  apply(t, solo);
  const primary = t.workUnits.find(u => u.id === t.executionPlans![0].primaryUnitId)!;
  assert.match(contentRefinementContext(t, primary), /主担当だけで行う場合/);
  assert.equal(contentRefinementContext(t, { ...primary, id: "retry-unit", workAttempt: 2 }), contentRefinementContext(t, primary));
  const directory = await mkdtemp(join(tmpdir(), "refinement-store-"));
  try {
    const file = join(directory, "tasks.json"), store = new JsonTaskStore(file); await store.init();
    const created = await store.create({ title: t.title, prompt: t.prompt, cwd: t.cwd, strategy: t.strategy, allowedAgentIds: t.allowedAgentIds, modelOverrides: {} });
    t.id = created.id; t.state = "paused"; await store.update(t.id, t);
    const restored = new JsonTaskStore(file); await restored.init(); const saved = restored.get(t.id)!;
    assert.deepEqual(saved.executionPlans![0].refinement, t.executionPlans![0].refinement);
    assert.equal(contentRefinementContext(saved, saved.workUnits.find(u => u.id === primary.id)!), contentRefinementContext(t, primary));
    assert.equal(contentRefinementContext({ ...t, roundNumber: 2 }, primary), "");
    assert.equal(contentRefinementContext({ ...t, goal: { ...t.goal!, revision: 2 } }, primary), "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("refinement skill and prompts do not contaminate final or blind reviews, respect retirement and limited rounds", () => {
  const t = task(); apply(t);
  const alternative = t.workUnits.find(u => u.subtask?.key === "alternative")!, challenge = t.workUnits.find(u => u.subtask?.key === "challenge")!;
  alternative.state = "completed"; alternative.output = "SECRET_RIVAL_CONCLUSION";
  challenge.subtask!.requirements = { independenceGroup: "blind-candidates", modelFamilies: ["anthropic"] };
  const prompt = buildWorkUnitPrompt(t, challenge, { deferSkills: true });
  assert.match(prompt, /内容改善の検討/); assert.doesNotMatch(prompt, /SECRET_RIVAL_CONCLUSION/);
  for (const role of ["reporter", "reviewer"] as const) {
    const unit = t.workUnits.find(u => u.role === role)!;
    assert.equal(contentRefinementContext(t, unit), "");
    assert.ok(!collectWorkSkills(t, unit).some(s => s.id === "content-refinement"));
    if (role === "reviewer") assert.doesNotMatch(buildWorkUnitPrompt(t, unit), /SECRET_RIVAL_CONCLUSION/);
  }
  for (const roundKind of ["consult", "review", "report"] as const) assert.equal(usesContentRefinement({ ...t, roundKind }, challenge), false);
  assert.equal(usesContentRefinement(t, { ...challenge, researchStage: "paper-explainer" }), false);
  assert.equal(usesContentRefinement({ ...t, goalPreparation: true }, challenge), false);
  assert.ok(collectWorkSkills(t, challenge).some(s => s.id === "content-refinement"));
  assert.ok(!collectWorkSkills({ ...t, managedSkills: [] }, challenge).some(s => s.id === "content-refinement"));
  const common = Array.from({ length: 6 }, (_, i) => ({ id: `custom-${i}`, description: "Custom", content: "Body" }));
  const project = common.map(s => ({ ...s, id: `project-${s.id}` }));
  const managed = [...collectWorkSkills(task(), task().workUnits[0]), ...common, ...project].filter(s => !["script-reuse", "document-checks", "related-research"].includes(s.id));
  assert.equal(collectWorkSkills({ ...t, managedSkills: managed }, t.workUnits.find(u => u.primaryStep)!).length + 1, 24, "writing snapshot plus maximum custom catalog fits the unchanged 24-skill transport bound");
});
