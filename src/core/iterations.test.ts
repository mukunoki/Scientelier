import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRound, createFollowupWorkflow, interruptedFollowupPatch, interruptedFollowupUnit, needsPlanApproval, nextRoundPatch, validateFollowup } from "./iterations";
import { buildWorkUnitPrompt, createStandardWorkflow } from "./orchestration";
import { initialGoal } from "./goals";
import { resumePatch } from "./recovery";
import { executionMetrics } from "./execution-metrics";
import { JsonTaskStore } from "./task-store";
import { ReportService } from "./report-service";
import type { FollowupInput, TaskRecord } from "./types";

const input: FollowupInput = { instruction: "図2を改善してください", kind: "continue", assignments: {}, pauseAfterPlan: false };
function task(): TaskRecord {
  return { id: "test", title: "Research", prompt: "Original objective", cwd: "/tmp", allowedAgentIds: ["codex", "claude"],
    strategy: "balanced", modelOverrides: {}, workUnits: createStandardWorkflow(), runs: [], state: "completed", output: "previous result",
    createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z" };
}

function interruptedTask(): TaskRecord {
  const t = task();
  t.goal = { ...initialGoal(t.prompt), status: "approved", questions: [] };
  t.state = "awaiting-input"; t.awaitingReason = "result"; t.autonomyState = "needs-input";
  t.error = "ユーザ確認が必要です。Git作者の設定を指定してください。";
  t.roundNumber = 1; t.instruction = "承認済みの目的に沿って実装する";
  for (const u of t.workUnits) {
    if (["planner", "worker"].includes(u.role)) { u.state = "completed"; u.completedAt = "2026-09-11T01:00:00Z"; }
    if (u.role === "worker") {
      u.primary = true; u.delegationHandled = true; u.checkpointHandled = true;
      u.output = '<work-check>{"status":"ask-user","summary":"Git作者の設定が必要","remainingWork":"コミット後、仕上げへ進む","estimatedRemainingMinutes":5,"evidence":[]}</work-check>';
    }
  }
  t.runs = [{ id: "saved-run", workUnitId: t.workUnits.find(u => u.role === "worker")!.id, role: "worker", agentId: "codex", providerKey: "openai-default",
    state: "completed", output: "saved output", displayOutput: "saved output\n", startedAt: "2026-09-11T00:50:00Z", completedAt: "2026-09-11T01:00:00Z",
    usage: { source: "reported", inputTokens: 100, outputTokens: 20 } }];
  t.executionPlans = [{ round: 1, goalRevision: t.goal.revision, revision: 1, createdAt: t.createdAt, sourceUnitId: t.workUnits[0].id,
    summary: "既存の計画", reason: "実装と確認", primaryWork: "実装を続ける", acceptance: "テストする", criterionIds: t.goal.criteria.map(c => c.id),
    estimatedTokens: 8000, estimatedMinutes: 20, escalation: "権限変更のみ確認", tasks: [], primaryUnitId: t.workUnits[1].id, taskUnitIds: {} }];
  t.report = { state: "draft", texPath: "/tmp/existing.tex", pdfPath: "/tmp/existing.pdf" };
  t.history = [captureRound(t)];
  return t;
}

test("answering an accepted interruption resumes the same graph, round, artifacts and accounting", () => {
  const t = interruptedTask(), before = JSON.stringify(t);
  assert.throws(() => resumePatch(t), /回答/); // No answer, no implicit approval.
  const unit = interruptedFollowupUnit(t)!;
  const patch = interruptedFollowupPatch(t, { ...input, instruction: "指定した作者設定でコミットして続行" })!;
  const resumed = { ...t, ...patch };
  assert.equal(resumed.roundNumber, 1); assert.equal(resumed.instruction, t.instruction);
  assert.equal(resumed.goal, t.goal); assert.equal(resumed.executionPlans, t.executionPlans); assert.equal(resumed.runs, t.runs);
  assert.equal(resumed.workUnits[0], t.workUnits[0]);
  assert.deepEqual(resumed.workUnits.map(u => [u.id, u.dependsOn]), t.workUnits.map(u => [u.id, u.dependsOn]));
  assert.equal(resumed.workUnits.find(u => u.id === unit.id)!.state, "pending");
  assert.equal(resumed.workUnits.find(u => u.id === unit.id)!.checkpointHandled, undefined);
  assert.equal(resumed.report!.texPath, t.report!.texPath); assert.equal(resumed.report!.pdfPath, t.report!.pdfPath);
  assert.equal(resumed.resumeCount, 1); assert.equal(resumed.history!.length, 0); assert.equal(resumed.interruptedHistory!.length, 1);
  assert.equal(executionMetrics(resumed).elapsedMs, executionMetrics(t).elapsedMs);
  assert.deepEqual(executionMetrics(resumed).usage, executionMetrics(t).usage);
  const prompt = buildWorkUnitPrompt(resumed, resumed.workUnits.find(u => u.id === unit.id)!);
  assert.match(prompt, /指定した作者設定/); assert.match(prompt, /SAME workflow round/); assert.match(prompt, /not interpret an answer as an implicit change/);
  assert.equal(JSON.stringify(t), before);
});

test("paused/failed continuation resets dependent results, preserves finished peers and appends answers", () => {
  const t = interruptedTask(); t.state = "paused"; t.resumeFromUnitId = t.workUnits.find(u => u.role === "reporter")!.id;
  const first = { ...t, ...interruptedFollowupPatch(t, input) };
  assert.equal(first.workUnits.find(u => u.role === "worker"), t.workUnits.find(u => u.role === "worker"));
  first.state = "failed"; first.resumeFromUnitId = t.resumeFromUnitId;
  const second = { ...first, ...interruptedFollowupPatch(first, { ...input, instruction: "不足ファイルは復旧しました" }) };
  assert.equal(second.roundNumber, 1); assert.equal(second.resumeCount, 2);
  assert.equal(second.resumeInstructions!.length, 2);
  assert.equal(second.workUnits.find(u => u.role === "reporter")!.state, "pending");
  assert.equal(second.workUnits.find(u => u.role === "reviewer")!.state, "pending");
  assert.match(buildWorkUnitPrompt(second, second.workUnits.find(u => u.role === "reporter")!), /不足ファイルは復旧しました/);
});

test("new work and explicit scope transitions remain separate rounds; live work/plan approval are not interruptions", () => {
  const t = interruptedTask();
  for (const kind of ["consult", "review", "report"] as const) assert.equal(interruptedFollowupPatch(t, { ...input, kind }), undefined);
  const scopeChange = { goalRevision: t.goal!.revision, removeConstraints: [], removeOutOfScope: [], implementation: false, confirmed: true as const };
  assert.equal(interruptedFollowupPatch(t, { ...input, scopeChange }), undefined);
  for (const override of [{ state: "running" }, { state: "completed" }, { awaitingReason: "plan" }, { goalPreparation: true }, { goalRevisionPending: true }, { goal: { ...t.goal, status: "draft" } }])
    assert.equal(interruptedFollowupPatch({ ...t, ...override } as TaskRecord, input), undefined);
  assert.throws(() => interruptedFollowupPatch(t, { ...input, instruction: " " }));
  assert.throws(() => interruptedFollowupPatch(t, { ...input, assignments: { worker: { agentId: "opencode", allowFallback: true } } }));
});

test("unaccepted or stale questions cannot be used as a continuation checkpoint", () => {
  const t = interruptedTask(), unit = t.workUnits.find(u => u.role === "worker")!;
  unit.checkpointHandled = false; assert.equal(interruptedFollowupUnit(t), undefined);
  unit.checkpointHandled = true; unit.output = 'ask-user'; assert.equal(interruptedFollowupUnit(t), undefined);
  unit.output = '<work-check>{"status":"ready"}</work-check>'; assert.equal(interruptedFollowupUnit(t), undefined);
});

test("a combined review question resumes its latest owner, never a stale or replaced verdict", () => {
  const t = interruptedTask(); t.error = "原典の取得場所を指定してください。";
  t.workUnits.forEach(u => { u.state = "completed"; });
  const reviewer = t.workUnits.find(u => u.role === "reviewer")!;
  const source = { goalRevision: t.goal!.revision, round: 1, cycle: 1, reviewUnitId: reviewer.id, nextAction: "ask-user" };
  const combined = { ...source, reviewUnitId: undefined };
  t.evaluations = [source, combined] as TaskRecord["evaluations"];
  assert.equal(interruptedFollowupUnit(t)?.id, reviewer.id);
  const resumed = { ...t, ...interruptedFollowupPatch(t, input) };
  assert.equal(resumed.workUnits.find(u => u.id === reviewer.id)!.state, "pending");
  assert.equal(resumed.workUnits[0], t.workUnits[0]);
  t.evaluations = [source, { ...source, nextAction: "repair" }, combined] as TaskRecord["evaluations"];
  assert.equal(interruptedFollowupUnit(t), undefined);
  t.evaluations = [{ ...source, round: 2 }, combined] as TaskRecord["evaluations"];
  assert.equal(interruptedFollowupUnit(t), undefined);
});

test("same-round answers survive store reload without starting work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-resume-answers-"));
  try {
    const path = join(directory, "tasks.json"), store = new JsonTaskStore(path); await store.init();
    const t = interruptedTask(), created = await store.create(t);
    await store.update(created.id, { ...t, id: created.id, ...interruptedFollowupPatch(t, input), state: "paused" });
    const restored = new JsonTaskStore(path); await restored.init();
    const saved = restored.get(created.id)!;
    assert.equal(saved.roundNumber, 1); assert.equal(saved.resumeInstructions![0].instruction, input.instruction);
    assert.deepEqual(saved.workUnits.map(u => u.id), t.workUnits.map(u => u.id));
    assert.deepEqual(saved.runs, t.runs); assert.equal(saved.state, "paused");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("followup modes select only the needed steps and preserve read-only consultation/review", () => {
  for (const [kind, expected] of [["consult", ["planner"]], ["review", ["reviewer"]], ["report", ["reporter"]], ["continue", ["worker", "reporter", "reviewer"]]] as const) {
    const units = createFollowupWorkflow({ ...input, kind });
    assert.deepEqual(units.map((u) => u.role), expected);
    units.forEach((unit, index) => assert.deepEqual(unit.dependsOn, index ? [units[index - 1].id] : []));
    if (kind === "consult" || kind === "review") assert.equal(units[0].mode, "read");
  }
});

test("round continuation preserves original goal, logs, report and earlier handoffs", () => {
  const previous = task(); previous.workUnits[0].output = "Preserve this decision";
  previous.history = [captureRound(previous)];
  const current = { ...previous, ...nextRoundPatch(previous, input) };
  assert.equal(current.roundNumber, 2);
  assert.equal(current.prompt, previous.prompt);
  assert.equal(current.runs, previous.runs);
  assert.equal(current.report, previous.report);
  assert.equal(current.history?.[0].workUnits[0].output, "Preserve this decision");
  assert.notEqual(current.workUnits[0].id, previous.workUnits[1].id);
  const prompt = buildWorkUnitPrompt(current, current.workUnits[0]);
  assert.match(prompt, /Original objective/); assert.match(prompt, /図2/);
  assert.equal(current.workflowMode,"primary"); assert.ok(current.execution);
  assert.throws(() => nextRoundPatch({ ...previous, state: "running" }, input));
  assert.throws(() => validateFollowup({ ...input, assignments: { worker: { agentId: "gemini", allowFallback: false } } }, previous));
  assert.throws(() => validateFollowup({ ...input, instruction: " " }, previous));
});

test("plan gate pauses exactly after the completed plan, and approval clears it", () => {
  const current: TaskRecord = { ...task(), workflowMode:"primary", goal:{revision:1} as TaskRecord["goal"], pauseAfterPlan: true, workUnits: createFollowupWorkflow({ ...input, pauseAfterPlan: true }) };
  assert.equal(needsPlanApproval(current), false);
  current.workUnits[0].state = "completed";
  current.executionPlans = [{round:1,goalRevision:1}] as TaskRecord["executionPlans"];
  assert.equal(needsPlanApproval(current), true);
  assert.equal(needsPlanApproval({ ...current, planApproved: true }), false);
  assert.equal(needsPlanApproval({ ...current, workUnits: [current.workUnits[0]] }), false);
});

test("awaiting-input, history and pending instruction survive restart without auto-execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-rounds-"));
  try {
    const path = join(directory, "tasks.json"); const store = new JsonTaskStore(path); await store.init();
    const saved = await store.create({ ...task(), modelOverrides: {} });
    await store.update(saved.id, { state: "awaiting-input", awaitingReason: "result", pendingFollowup: input, history: [captureRound(saved)] });
    const restored = new JsonTaskStore(path); await restored.init();
    const current = restored.get(saved.id)!;
    assert.equal(current.state, "awaiting-input"); assert.deepEqual(current.pendingFollowup, input);
    assert.equal(current.history?.length, 1); assert.equal(current.runs.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("report versions retain exact TeX/PDF bytes after the working report changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-versions-"));
  try {
    const texPath = join(directory, "report.tex"); const pdfPath = join(directory, "report.pdf");
    await writeFile(texPath, "original TeX"); await writeFile(pdfPath, "%PDF-1.7 test bytes");
    const service = new ReportService();
    const previous = { ...task(), report: { state: "ready" as const, texPath, pdfPath } };
    const first = await service.snapshotVersion(previous);
    await writeFile(texPath, "revised TeX"); await writeFile(pdfPath, "%PDF-1.7 revision");
    const second = await service.snapshotVersion({ ...previous, roundNumber: 2 });
    assert.equal(await readFile(first!.texPath!, "utf8"), "original TeX");
    assert.equal(await readFile(first!.pdfPath!, "utf8"), "%PDF-1.7 test bytes");
    assert.equal(await readFile(second!.texPath!, "utf8"), "revised TeX");
    assert.notEqual(first?.previewUrl, second?.previewUrl);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
