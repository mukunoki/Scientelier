import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialGoal, validateGoalDraft, updateGoalContract, parseGoalProposal, goalPreparationUnit, goalPrompt } from "./goals";
import { JsonTaskStore } from "./task-store";
import { buildWorkUnitPrompt, createStandardWorkflow } from "./orchestration";

test("goal approval requires deliverables, required criteria, verification and resolved questions", () => {
  const goal = initialGoal("FP4の表現範囲を説明する");
  assert.throws(() => validateGoalDraft(goal, true), /確認事項/);
  const valid = { ...goal, questions: [] };
  assert.equal(validateGoalDraft(valid, true).objective, goal.objective);
  assert.throws(() => validateGoalDraft({ ...valid, deliverables: [] }, true), /成果物/);
  assert.throws(() => validateGoalDraft({ ...valid, criteria: [] }, true), /必須/);
  assert.throws(() => validateGoalDraft({ ...valid, criteria: [{ ...valid.criteria[0], verification: "" }] }, true), /検証方法/);
  assert.throws(() => validateGoalDraft({ ...valid, criteria: [...valid.criteria, valid.criteria[0]] }), /重複/);
  assert.throws(() => validateGoalDraft({ ...valid, constraints: [false] }));
  const preparationOnly = { ...valid, constraints: ["現在の作業は目標契約の準備に限定し、調査実行、報告書作成、ファイル変更は行わない。"] };
  assert.doesNotThrow(() => validateGoalDraft(preparationOnly));
  assert.throws(() => validateGoalDraft(preparationOnly, true), /準備段階/);
  assert.throws(() => validateGoalDraft({ ...valid, objective: "x".repeat(8001) }));
  assert.throws(() => validateGoalDraft({ ...valid, constraints: Array(40).fill("x".repeat(8000)) }), /長すぎ/);
});

test("AI proposal is validated and cannot supply approval, revision or completion state", () => {
  const draft = { ...initialGoal("Explain"), status: "approved", revision: 999, approvedAt: "fake", questions: [] };
  const proposal = parseGoalProposal(`<goal-draft>${JSON.stringify(draft)}</goal-draft>`);
  assert.equal("status" in proposal, false); assert.equal("revision" in proposal, false);
  assert.throws(() => parseGoalProposal("ordinary prose"));
  assert.throws(() => parseGoalProposal("<goal-draft>{bad}</goal-draft>"));
  assert.throws(() => parseGoalProposal(`<goal-draft>{}</goal-draft><goal-draft>{}</goal-draft>`));
});

test("per-question user answers persist, guide refinement, and do not silently approve scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-goal-answers-"));
  try {
    const path = join(directory, "tasks.json"); const store = new JsonTaskStore(path); await store.init();
    const task = await store.create({ title: "回答", prompt: "比較実験", cwd: directory, strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {}, goalMode: "manual" });
    const questionAnswers = [{ question: "評価環境は？", answer: "Apple M5で小規模に評価" }, { question: "評価指標は？", answer: "精度と実行時間" }];
    const draft = { ...task.goal!, questions: questionAnswers.map(item => item.question), questionAnswers };
    const saved = await store.update(task.id, updateGoalContract(task, draft, task.goal!.revision, false));
    const reloaded = new JsonTaskStore(path); await reloaded.init();
    assert.deepEqual(reloaded.get(task.id)?.goal?.questionAnswers, questionAnswers);
    assert.throws(() => validateGoalDraft(draft, true), /確認事項/);
    const instructions = goalPreparationUnit(saved.goal!, "その他は変更なし").instructions;
    for (const item of questionAnswers) { assert.ok(instructions.includes(item.question)); assert.ok(instructions.includes(item.answer)); }
    assert.match(instructions, /Incorporate these into the relevant objective/);
    assert.match(instructions, /does not automatically resolve/);
    const partial = parseGoalProposal(`<goal-draft>${JSON.stringify({ ...draft, questions: ["評価指標は？"], questionAnswers: [{ question: "評価指標は？", answer: "AIが捏造した回答" }] })}</goal-draft>`, saved.goal);
    assert.deepEqual(partial.questionAnswers, [questionAnswers[1]], "retain unanswered clarifications without trusting AI-generated answers");
    const complete = parseGoalProposal(`<goal-draft>${JSON.stringify({ ...draft, questions: [], constraints: ["Apple M5で小規模に評価"], questionAnswers: undefined })}</goal-draft>`, saved.goal);
    assert.deepEqual(complete.questionAnswers, []);
    assert.equal("status" in complete, false);
    assert.ok(!goalPrompt({ ...saved.goal!, status: "approved", questions: [] }).includes("Apple M5"), "answer notes are not independent execution authority");
    for (const invalid of [null, {}, [null], [{ question: "", answer: "x" }], [{ question: "Q", answer: 1 }], [{ question: "Q", answer: "x".repeat(8001) }], [questionAnswers[0], questionAnswers[0]], Array(41).fill(questionAnswers[0])]) {
      assert.throws(() => validateGoalDraft({ ...draft, questionAnswers: invalid }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unchecked checklist candidates persist separately and never satisfy or enter the execution goal", () => {
  const base = { ...initialGoal("選んだ項目だけを実行"), questions: [] };
  const unselected = { deliverables: ["未選択の動画"], criteria: [{ id: "candidate", description: "未選択のGPU検証", verification: "", required: true }], constraints: ["未選択の制約"], outOfScope: ["未選択の対象外"] };
  const draft = validateGoalDraft({ ...base, unselected }, true);
  assert.deepEqual(draft.unselected, unselected);
  const prompt = goalPrompt({ ...base, ...draft, status: "approved" });
  for (const value of ["未選択の動画", "未選択のGPU検証", "未選択の制約", "未選択の対象外"]) assert.ok(!prompt.includes(value));
  assert.throws(() => validateGoalDraft({ ...draft, criteria: [] }, true), /必須/);
  assert.throws(() => validateGoalDraft({ ...draft, deliverables: [] }, true), /成果物/);
  assert.throws(() => validateGoalDraft({ ...draft, questions: ["未回答"] }, true), /確認事項/);
  assert.throws(() => validateGoalDraft({ ...draft, criteria: [...draft.criteria, ...unselected.criteria], unselected: { ...unselected, criteria: [] } }, true), /検証方法/);
  assert.throws(() => validateGoalDraft({ ...draft, unselected: { ...unselected, criteria: base.criteria } }), /重複/);
  assert.throws(() => validateGoalDraft({ ...draft, unselected: { ...unselected, deliverables: base.deliverables } }), /同じ項目/);
  assert.throws(() => validateGoalDraft({ ...draft, unselected: { ...unselected, criteria: Array.from({ length: 40 }, (_, i) => ({ ...unselected.criteria[0], id: `u${i}` })) } }), /40件/);
  assert.throws(() => validateGoalDraft({ ...draft, unselected: { ...unselected, constraints: [false] } }));
  const proposed = parseGoalProposal(`<goal-draft>${JSON.stringify(base)}</goal-draft>`, { ...base, unselected });
  assert.deepEqual(proposed.unselected, unselected, "AI refinement preserves user candidates even when its JSON omits them");
});

test("goal drafts, approvals and revision history survive restart without promoting old tasks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-goal-test-"));
  try {
    const path = join(directory, "tasks.json"); const store = new JsonTaskStore(path); await store.init();
    const input = { title: "FP4", prompt: "Explain FP4", cwd: directory, strategy: "balanced" as const, allowedAgentIds: ["codex" as const], modelOverrides: {} };
    const legacy = await store.create(input);
    const task = await store.create({ ...input, goalMode: "manual" });
    assert.equal(task.state, "awaiting-input"); assert.equal(task.awaitingReason, "goal");
    const candidates = { deliverables: ["選び直せる成果物"], criteria: [], constraints: [], outOfScope: [] };
    const approved = await store.update(task.id, updateGoalContract(task, { ...task.goal, questions: [], unselected: candidates }, 1, true));
    assert.equal(approved.goal?.status, "approved"); assert.equal(approved.state, "queued");
    assert.equal(approved.goalHistory?.[0].status, "draft");
    assert.throws(() => updateGoalContract(approved, approved.goal, 1, true), /更新/);
    assert.throws(() => updateGoalContract({ ...approved, state: "running" }, approved.goal, 2, false), /本作業/);
    const modified = await store.update(task.id, updateGoalContract(approved, { ...approved.goal, objective: "Changed objective" }, 2, false));
    assert.equal(modified.goal?.approvedAt, undefined); assert.equal(modified.awaitingReason, "goal");
    const reloaded = new JsonTaskStore(path); await reloaded.init();
    assert.deepEqual(reloaded.get(task.id)?.goal, modified.goal);
    assert.deepEqual(reloaded.get(task.id)?.goal?.unselected, candidates);
    assert.equal(reloaded.get(task.id)?.goalHistory?.[1].status, "approved");
    assert.equal(reloaded.get(legacy.id)?.goal, undefined);
    const ai = await store.create({ ...input, goalMode: "ai" });
    assert.equal(ai.workUnits.length, 1); assert.equal(ai.workUnits[0].mode, "read");
    const prep = buildWorkUnitPrompt(ai, goalPreparationUnit(ai.goal!, "初心者向けに"));
    assert.match(prep, /goal preparation ONLY/); assert.doesNotMatch(prep, /# Working report/);
    const execution = buildWorkUnitPrompt(approved, createStandardWorkflow()[1]);
    assert.match(execution, /User-approved goal/); assert.match(execution, /Do not weaken/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
