import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPresetStore, presetSections, workPresetPrompt } from "./work-presets";
import { initialGoal, updateGoalContract } from "./goals";
import { JsonTaskStore } from "./task-store";
import { buildWorkUnitPrompt } from "./orchestration";
import { captureRound, nextRoundPatch } from "./iterations";
import type { CreateTaskInput } from "./types";

const builtin = join(process.cwd(), "assets", "work-presets");
const input: CreateTaskInput = { title: "Preset fixture", prompt: "Inspect the evidence", cwd: "/tmp", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {}, goalMode: "manual" };
async function fixture(run: (library: WorkPresetStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "harness-presets-"));
  try { await run(new WorkPresetStore(builtin, join(directory, "presets")), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("bundled modes provide validated, editable goal defaults and all six rule sections", async () => fixture(async library => {
  const catalog = await library.catalog(); assert.deepEqual(catalog.errors, []);
  assert.deepEqual(catalog.presets.map(p => p.manifest.id), ["research-project", "idea", "research", "coding", "hpc-refactoring", "paper", "poster", "paper-explainer"]);
  assert.equal(catalog.defaultPresetId, "research-project");
  for (const preset of catalog.presets) {
    assert.equal(preset.source, "builtin"); assert.match(preset.revision, /^[a-f0-9]{64}$/);
    const sections = presetSections(preset.rules); assert.equal(Object.keys(sections).length, 6);
    const goal = initialGoal("Subject", preset);
    assert.equal(goal.status, "draft"); if (preset.manifest.id !== "paper-explainer") assert.ok(goal.questions.length); assert.equal(goal.criteria[0].id, "report");
    assert.ok(goal.criteria.length > 1); assert.ok(goal.deliverables.length >= 1);
    if (preset.manifest.primaryDocument === "paper") assert.equal(goal.deliverables.filter(s=>/TeX/.test(s)).length,1,"one manuscript, not report plus paper");
    assert.equal(initialGoal("Other").criteria.length, 1, "old no-preset behavior remains unchanged");
  }
}));

test("HPC migration rules reach each role, remain editable and do not change research stages or permissions", async () => fixture(async (library, directory) => {
  const preset = await library.capture("hpc-refactoring");
  const research = await library.capture("research-project"), coding = await library.capture("coding");
  assert.equal(preset.manifest.focus, "implementation");
  assert.equal(preset.documentTemplate, undefined, "technical report, not an additional paper");
  const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
  const task = await store.create({ ...input, workflowMode: "primary" }, preset);
  assert.deepEqual(task.goal!.criteria.map(c => c.id), ["report", "reference", "migration_scope", "replay", "numerics", "integration", "performance", "reproducibility"]);
  const base = { ...task.workUnits[0], primary: true, planPhase: false, role: "worker" as const, mode: "write" as const };
  const before = JSON.stringify({ goal: task.goal, execution: task.execution, agents: task.allowedAgentIds });
  const goalPrompt = workPresetPrompt({ ...task, goalPreparation: true }, { ...base, mode: "read" });
  assert.match(goalPrompt, /ISO_C_BINDING/); assert.match(goalPrompt, /Goal preparation remains read-only/);
  const plan = workPresetPrompt(task, { ...base, planPhase: true, mode: "read" });
  assert.match(plan, /移行単位の台帳/); assert.match(plan, /専門担当・レビューが読み取り専用/);
  const worker = workPresetPrompt(task, base);
  for (const rule of [/CPU再現テストを先に/, /MPI/, /二重投入を避ける/, /閾値を緩めて通す/, /承認された資源/]) assert.match(worker, rule);
  const reviewer = workPresetPrompt(task, { ...base, primary: false, role: "reviewer", mode: "read" });
  assert.match(reviewer, /NaN\/Inf/); assert.match(reviewer, /既存の複数AI・クロスレビュー方針/);
  assert.doesNotMatch(reviewer, /## 作業/);
  const reporter = workPresetPrompt(task, { ...base, primary: false, role: "reporter" });
  assert.match(reporter, /技術レポートを標準TeX\/PDF/); assert.match(reporter, /未検証/);
  assert.equal(JSON.stringify({ goal: task.goal, execution: task.execution, agents: task.allowedAgentIds }), before);
  const saved = await library.saveRules(preset.manifest.id, preset.revision, preset.rules.replace("## 作業\n", "## 作業\n移行固有の追加指示。\n"));
  assert.match(saved.rules, /移行固有の追加指示/);
  assert.equal(store.get(task.id)!.workPreset!.revision, preset.revision, "existing tasks retain captured rules");
  // Capture timestamps change on every read; revisions cover the actual content and composed stages.
  assert.equal((await library.capture("research-project")).revision, research.revision);
  assert.equal((await library.capture("coding")).revision, coding.revision);
}));

test("one rule per mode is directly editable, saves atomically and rejects stale/concurrent versions", async () => fixture(async (library, directory) => {
  const original = await library.capture("coding");
  const copy = await library.saveRules("coding", original.revision, original.rules);
  assert.equal(copy.source, "user"); assert.equal(copy.manifest.id, original.manifest.id);
  assert.equal(copy.rules, original.rules); assert.equal(copy.commonRules, original.commonRules);
  const changed = copy.rules.replace("## 作業\n", "## 作業\nOnly use the approved fixture.\n");
  const results = await Promise.allSettled([library.saveRules(copy.manifest.id, copy.revision, changed), library.saveRules(copy.manifest.id, copy.revision, changed + "\nSecond edit")]);
  assert.deepEqual(results.map(r => r.status), ["fulfilled", "rejected"]);
  assert.equal(JSON.parse(await readFile(join(directory, "presets", copy.manifest.id, "settings.json"), "utf8")).rules, changed);
  assert.equal((await library.catalog()).presets.length, 8);
  assert.equal(await readFile(join(builtin, "coding", "rules.md"), "utf8"), original.rules);
  await assert.rejects(() => library.capture(copy.manifest.id, copy.revision), /変更/);
  await assert.rejects(() => library.saveRules(copy.manifest.id, "", changed), /版番号/);
}));

test("combined preset settings preserve legacy text, validate defaults atomically and keep captured tasks unchanged", async () => fixture(async (library, directory) => {
  const original = await library.capture("paper");
  const folder = join(directory, "presets", "paper"); await mkdir(folder, { recursive: true });
  const legacy = original.rules + "\n既存のカスタム指示"; await writeFile(join(folder, "rules.md"), legacy);
  const before = await library.capture("paper"); assert.equal(before.rules, legacy);
  const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
  const task = await store.create(input, before);
  const goal = { deliverables: ["新しい論文候補"], criteria: [{ id: "new_test", description: "新しい条件", verification: "具体的に検証", required: true }], questions: [] };
  const saved = await library.saveRules("paper", before.revision, legacy + "\n新ルール", goal);
  assert.deepEqual(saved.manifest.goal, goal); assert.equal(saved.documentTemplate?.source, before.documentTemplate?.source);
  assert.equal(await readFile(join(folder, "rules.md"), "utf8"), legacy);
  assert.deepEqual(store.get(task.id)!.workPreset, before);
  const reloaded = new WorkPresetStore(builtin, join(directory, "presets"));
  assert.equal((await reloaded.capture("paper")).revision, saved.revision);
  assert.deepEqual(initialGoal("next", saved).questions, []);
  assert.ok(initialGoal("next", saved).deliverables.includes("新しい論文候補"));
  for (const bad of [{ ...goal, tokenBudget: 10 }, { ...goal, criteria: [{ ...goal.criteria[0], verification: "" }] }, { ...goal, questions: Array(21).fill("too many") }]) await assert.rejects(library.saveRules("paper", saved.revision, saved.rules + "must not save", bad));
  assert.equal((await library.capture("paper")).revision, saved.revision);
  await assert.rejects(library.saveRules("paper", saved.revision, original.rules + "あ".repeat(15000), { deliverables: Array(20).fill("あ".repeat(1000)), criteria: [], questions: Array(9).fill("あ".repeat(1000)) }), /100KB/);
  assert.equal((await library.capture("paper")).revision, saved.revision, "oversize UTF-8 settings must not replace a readable saved version");
  const common = await library.getCommon();
  await library.saveCommon(common.revision, common.rules + "\n全モード向けの追加原則");
  await assert.rejects(library.saveCommon(common.revision, common.rules), /変更/);
  await assert.rejects(library.saveRules("paper", saved.revision, saved.rules, goal), /変更/);
  for (const p of (await library.catalog()).presets) assert.match(p.commonRules, /全モード向け/);
  assert.doesNotMatch(store.get(task.id)!.workPreset!.commonRules, /全モード向け/);
  const current = await library.capture("paper");
  const legacyCaller = await library.saveRules("paper", current.revision, current.rules + "\n旧API呼び出し");
  assert.deepEqual(legacyCaller.manifest.goal, goal, "rules-only callers preserve custom defaults");
  await writeFile(join(folder, "settings.json"), "broken");
  await assert.rejects(library.capture("paper"), /読み込めません/);
  await rm(join(directory, "presets", "common.md"));
  await symlink(join(builtin, "common.md"), join(directory, "presets", "common.md"));
  await assert.rejects(library.getCommon(), /通常/);
}));

test("task captures original rules and defaults through edits, approval, followups and restart", async () => fixture(async (library, directory) => {
  const original = await library.capture("research"), copy = await library.saveRules("research", original.revision, original.rules);
  const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
  let task = await store.create(input, copy);
  const captured = structuredClone(task.workPreset);
  copy.rules = "Mutated caller value";
  assert.deepEqual(store.get(task.id)!.workPreset, captured);
  await library.saveRules(copy.manifest.id, copy.revision, original.rules.replace("## 作業\n", "## 作業\nNew work instruction.\n"));
  assert.deepEqual(store.get(task.id)!.workPreset, captured);
  const approved = updateGoalContract(task, { ...task.goal, questions: [] }, task.goal!.revision, true);
  task = await store.update(task.id, approved);
  task.state = "awaiting-input"; task.history = [captureRound(task)];
  task = await store.update(task.id, { ...task, ...nextRoundPatch(task, { instruction: "Continue", kind: "continue", assignments: {}, pauseAfterPlan: false }) });
  const restarted = new JsonTaskStore(join(directory, "tasks.json")); await restarted.init();
  assert.deepEqual(restarted.get(task.id)!.workPreset, captured);
  const next = await store.create(input, await library.capture(copy.manifest.id));
  assert.match(next.workPreset!.rules, /New work instruction/); assert.equal(next.goal!.status, "draft");
}));

test("rules are selected by role, including goal refinement and independent review, without authority changes", async () => fixture(async (library, directory) => {
  const preset = await library.capture("coding");
  preset.rules = ["共通", "ゴール設計", "主担当の計画", "作業", "検証", "レポート"].map((s, i) => `## ${s}\nSECTION_${i}`).join("\n");
  const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
  const task = await store.create({ ...input, goalMode: "ai" }, preset);
  assert.match(buildWorkUnitPrompt(task, task.workUnits[0]), /SECTION_1/);
  assert.doesNotMatch(buildWorkUnitPrompt(task, task.workUnits[0]), /SECTION_[2345]/);
  task.goalPreparation = false;
  const base = { ...task.workUnits[0], primary: true, role: "worker" as const, mode: "write" as const };
  const before = JSON.stringify({ goal: task.goal, execution: task.execution, agents: task.allowedAgentIds });
  assert.match(workPresetPrompt(task, { ...base, planPhase: true }), /SECTION_2/);
  assert.doesNotMatch(workPresetPrompt(task, { ...base, planPhase: true }), /SECTION_[135]/);
  assert.match(workPresetPrompt(task, base), /SECTION_3/);
  const reviewer = { ...base, role: "reviewer" as const, primary: false, mode: "read" as const };
  assert.match(workPresetPrompt(task, reviewer), /SECTION_4/); assert.doesNotMatch(workPresetPrompt(task, reviewer), /SECTION_[1235]/);
  assert.match(workPresetPrompt(task, { ...reviewer, role: "reporter" }), /SECTION_5/);
  assert.match(workPresetPrompt(task, reviewer), /never grant permissions/);
  assert.equal(JSON.stringify({ goal: task.goal, execution: task.execution, agents: task.allowedAgentIds }), before);
  assert.equal(workPresetPrompt({ ...task, workPreset: undefined }, base), "");
}));

test("malformed rules, unsafe paths and unsupported manifest authority fail closed without hiding valid modes", async () => fixture(async (library, directory) => {
  const p = await library.capture("poster");
  for (const rules of ["", "bad rule", p.rules + "\n## 検証\nDuplicate", p.rules.replace("## 作業", "## 任意の見出し"), p.rules + "x".repeat(16000)]) assert.throws(() => presetSections(rules));
  await assert.rejects(() => library.capture("../../outside"));
  const bad = join(directory, "presets", "bad"); await mkdir(bad, { recursive: true });
  await writeFile(join(bad, "preset.json"), JSON.stringify({ ...p.manifest, id: "bad", tokenBudget: 900000 }));
  await writeFile(join(bad, "rules.md"), p.rules);
  let catalog = await library.catalog(); assert.equal(catalog.presets.length, 8); assert.deepEqual(catalog.errors, [], "legacy copies are ignored, never deleted");
  assert.ok(await readFile(join(bad, "preset.json"), "utf8"));
  await writeFile(join(bad, "preset.json"), JSON.stringify({ ...p.manifest, id: "bad" }));
  await rm(join(bad, "rules.md")); await symlink(join(builtin, "poster", "rules.md"), join(bad, "rules.md"));
  await symlink(join(builtin, "research"), join(directory, "presets", "research"));
  const poster = join(directory, "presets", "poster"); await mkdir(poster);
  await symlink(join(builtin, "poster", "rules.md"), join(poster, "rules.md"));
  catalog = await library.catalog(); assert.equal(catalog.presets.length, 5); assert.equal(catalog.errors.length, 3);
  assert.equal(catalog.presets.some(p=>p.manifest.id === "research-project"),false,"a broken constituent cannot silently fall back to integrated rules");
  await assert.rejects(() => library.capture("bad"));
}));
