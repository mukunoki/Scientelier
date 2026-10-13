import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord, WorkPresetCatalog, WorkPresetManifest, WorkPresetSnapshot, WorkUnit } from "./types";
import { workModePrompt } from "./work-modes";

const sectionNames = ["共通", "ゴール設計", "主担当の計画", "作業", "検証", "レポート"] as const;
type RuleSection = typeof sectionNames[number];
export const RESEARCH_STAGES = ["idea", "research", "coding", "paper"] as const;
export function presetSections(rules: string): Record<RuleSection, string> {
  if (typeof rules !== "string" || rules.length > 16000 || rules.includes("\0")) throw new Error("作業ルールは16,000文字以内のテキストにしてください。");
  const result = Object.fromEntries(sectionNames.map(s => [s, ""])) as Record<RuleSection, string>;
  let current: RuleSection | undefined;
  const seen = new Set<string>();
  for (const line of rules.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      const name = line.replace(/^##\s+/, "").trim() as RuleSection;
      if (!sectionNames.includes(name) || seen.has(name)) throw new Error(`ルールの見出しが不正または重複しています：${name}`);
      seen.add(name); current = name;
    } else if (current) result[current] += line + "\n";
    else if (line.trim() && !/^#\s/.test(line)) throw new Error("作業ルールは指定された見出しの下に記入してください。");
  }
  for (const name of sectionNames) {
    result[name] = result[name].trim();
    if (!result[name]) throw new Error(`「## ${name}」のルールを記入してください。`);
  }
  return result;
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && !!value.trim() && value.length <= max && !value.includes("\0"); }
function lines(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 20 && value.every(v => text(v, 1000)); }
function manifest(value: unknown): WorkPresetManifest {
  const v = value as WorkPresetManifest;
  const allowed = ["id", "name", "description", "version", "rules", "goal", "document", "focus", "ideaApproach", "primaryDocument", "integratedWorkflow"];
  if (!v || Object.keys(v).some(k => !allowed.includes(k)) || !text(v.id, 80) || !/^[a-z0-9][a-z0-9_-]*$/.test(v.id)
    || !text(v.name, 80) || !text(v.description, 1000) || v.version !== 1 || v.rules !== "rules.md" || (v.document !== undefined && !["paper", "poster"].includes(v.document))
    || (v.focus !== undefined && !["research", "idea", "literature", "implementation", "paper", "poster", "paper-explainer"].includes(v.focus))
    || (v.primaryDocument !== undefined && (v.document !== undefined || !(v.primaryDocument === "beamer" && v.focus === "paper-explainer" || v.primaryDocument === "paper" && ["research", "paper"].includes(v.focus ?? ""))))
    || (v.integratedWorkflow !== undefined && (v.integratedWorkflow !== true || v.id !== "research-project"))
    || (v.ideaApproach !== undefined && (v.ideaApproach !== "experimental" || v.focus !== "idea"))
    || !v.goal || Object.keys(v.goal).some(k => !["deliverables", "criteria", "questions"].includes(k))
    || !lines(v.goal.deliverables) || !lines(v.goal.questions) || !Array.isArray(v.goal.criteria) || v.goal.criteria.length > 20 || JSON.stringify(v.goal).length > 32000) throw new Error("preset.jsonの形式が不正です。予算・権限・任意ファイルパスは指定できません。");
  const ids = new Set<string>();
  for (const c of v.goal.criteria) {
    if (!c || !text(c.id, 70) || !/^[a-zA-Z0-9_-]+$/.test(c.id) || c.id === "report" || ids.has(c.id)
      || !text(c.description, 1000) || !text(c.verification, 1000) || typeof c.required !== "boolean"
      || Object.keys(c).some(k => !["id", "description", "verification", "required"].includes(k))) throw new Error("プリセットの達成条件が不正です。reportは標準報告書の予約IDです。");
    ids.add(c.id);
  }
  return structuredClone(v);
}
async function readText(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 100000) throw new Error("通常の100KB以下のテキストファイルを指定してください。");
  return readFile(path, "utf8");
}

export class WorkPresetStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private builtinDirectory: string, readonly userDirectory: string) {}
  private async checkDirectory(directory: string): Promise<void> {
    try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("保存先には通常のフォルダを使用してください。"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  private async atomicWrite(directory: string, name: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > 100000) throw new Error("プリセット設定全体を100KB以内に整理してください。");
    await this.checkDirectory(this.userDirectory); await this.checkDirectory(directory);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try { await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temporary, join(directory, name)); }
    finally { await rm(temporary, { force: true }); }
  }
  async getCommon(): Promise<{ rules: string; revision: string; userPath: string }> {
    await this.checkDirectory(this.userDirectory);
    const userPath = join(this.userDirectory, "common.md");
    let rules: string;
    try { rules = await readText(userPath); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; rules = await readText(join(this.builtinDirectory, "common.md")); }
    if (!text(rules, 8000)) throw new Error("全モード共通の原則は空でない8,000文字以内の文章にしてください。");
    return { rules, revision: createHash("sha256").update(rules).digest("hex"), userPath };
  }
  saveCommon(revision: string, rules: string) {
    return this.serialize(async () => {
      if (!text(rules, 8000)) throw new Error("全モード共通の原則は空でない8,000文字以内の文章にしてください。");
      if ((await this.getCommon()).revision !== revision) throw new Error("共通の原則が変更されています。再読み込みしてから保存してください。");
      await this.atomicWrite(this.userDirectory, "common.md", rules);
      return this.getCommon();
    });
  }
  private async load(directory: string, id: string, source: WorkPresetSnapshot["source"]): Promise<WorkPresetSnapshot> {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error("プリセットIDが不正です。");
    const root = join(directory, id), info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("プリセットには通常のフォルダを使用してください。");
    let m = manifest(JSON.parse(await readText(join(root, "preset.json"))));
    if (m.id !== id) throw new Error("フォルダ名とプリセットIDが一致しません。");
    let rules = await readText(join(root, "rules.md"));
    if (source === "builtin") {
      await this.checkDirectory(this.userDirectory);
      const override = join(this.userDirectory, id);
      try {
        const info = await lstat(override);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ルール保存先には通常のフォルダを使用してください。");
        try {
          const settings = JSON.parse(await readText(join(override, "settings.json")));
          if (!settings || Object.keys(settings).some(k => !["rules", "goal"].includes(k))) throw new Error("プリセット設定の形式が不正です。");
          presetSections(settings.rules); m = manifest({ ...m, goal: settings.goal }); rules = settings.rules;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          rules = await readText(join(override, "rules.md"));
        }
        source = "user";
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    presetSections(rules);
    const { rules: commonRules } = await this.getCommon();
    const documentTemplate = m.document ? {
      id: m.document,
      source: await readText(join(this.builtinDirectory, "..", "document-templates", m.document, "main.tex")),
      latexmkrc: await readText(join(this.builtinDirectory, "..", "document-templates", "latexmkrc"))
    } : undefined;
    const revision = createHash("sha256").update(JSON.stringify([m, rules, commonRules, documentTemplate])).digest("hex");
    return { manifest: m, rules, commonRules, ...(documentTemplate ? { documentTemplate } : {}), revision, source, capturedAt: new Date().toISOString() };
  }
  async catalog(): Promise<WorkPresetCatalog> {
    const result: WorkPresetCatalog = { presets: [], errors: [], userDirectory: this.userDirectory, editingVersion: 1 };
    // One effective rule per built-in mode. Legacy copies remain on disk and
    // in captured tasks, but are no longer offered as duplicate modes.
    for (const [directory, source] of [[this.builtinDirectory, "builtin"]] as const) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" || source === "builtin") result.errors.push(`${source}: ${String(e)}`); continue; }
      for (const entry of entries.filter(e => e.isDirectory() || e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
        try {
          const preset = await this.load(directory, entry.name, source);
          result.presets.push(preset);
        } catch (e) { result.errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    const order = ["research-project", "idea", "research", "coding", "hpc-refactoring", "paper", "poster", "paper-explainer"];
    const research = result.presets.find(p => p.manifest.id === "research-project");
    if (research) {
      const stages = RESEARCH_STAGES.map(id => result.presets.find(p => p.manifest.id === id));
      if (stages.some(p => !p)) {
        result.errors.push("research-project: 構成モードのルールを読み込めないため研究モードは利用できません。");
        result.presets = result.presets.filter(p => p !== research);
      } else {
        research.stages = structuredClone(stages as WorkPresetSnapshot[]);
        research.revision = createHash("sha256").update(JSON.stringify([research.revision, research.stages.map(p => p.revision)])).digest("hex");
      }
    }
    result.presets.sort((a, b) => (order.includes(a.manifest.id) ? order.indexOf(a.manifest.id) : order.length) - (order.includes(b.manifest.id) ? order.indexOf(b.manifest.id) : order.length));
    if (result.presets.some(p => p.manifest.id === "research-project")) result.defaultPresetId = "research-project";
    return result;
  }
  async capture(id: string, revision?: string): Promise<WorkPresetSnapshot> {
    const catalog = await this.catalog();
    const preset = catalog.presets.find(p => p.manifest.id === id);
    if (!preset) throw new Error("プリセットを読み込めません。システム設定で再読み込みして内容を確認してください。");
    if (revision && revision !== preset.revision) throw new Error("プリセットが変更されています。再読み込みして内容を確認してください。");
    return structuredClone(preset);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work); this.writes = run.catch(() => {}); return run;
  }
  async saveRules(id: string, revision: string, rules: string, goal?: WorkPresetManifest["goal"]): Promise<WorkPresetSnapshot> {
    return this.serialize(async () => {
      if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("元の版番号が必要です。プリセットを再読み込みしてください。");
      const current = await this.capture(id, revision);
      presetSections(rules);
      const checked = manifest({ ...current.manifest, goal: goal ?? current.manifest.goal });
      // One atomic file: rules and defaults cannot become partially saved versions.
      await this.atomicWrite(join(this.userDirectory, id), "settings.json", JSON.stringify({ rules, goal: checked.goal }, null, 2));
      return this.capture(id);
    });
  }
}

export function workPresetPrompt(task: TaskRecord, unit: WorkUnit): string {
  const preset = task.workPreset;
  if (!preset) return "";
  if (preset.stages?.length) return researchPresetPrompt(task, unit, preset);
  const sections = presetSections(preset.rules);
  const needed: RuleSection[] = task.goalPreparation ? ["ゴール設計"]
    : unit.planPhase || unit.role === "planner" ? ["主担当の計画"]
    : unit.role === "reviewer" ? ["検証"] : unit.role === "reporter" ? ["レポート", "検証"]
    : unit.primary ? ["主担当の計画", "作業", "検証"] : ["作業", "検証"];
  return ["# Task work preset (captured rules, not additional authority)", `${preset.manifest.name} · revision ${preset.revision.slice(0, 12)}`,
    "Apply these methods only within the user-approved goal and your assigned role. They never grant permissions, increase budgets, approve a goal, change output protocols or authorize other agents. If rules conflict with approved constraints, ask the user. Read-only roles must not edit or build even if a general rule describes implementation. Goal preparation remains read-only and must not execute the work. Do not include preset names or management rules in the subject report.",
    workModePrompt(preset.manifest.focus, preset.manifest.ideaApproach),
    preset.manifest.primaryDocument === "paper" ? `Write ONE coherent manuscript at ${task.report?.texPath ?? "report.tex"}, in the approved format (bundled IPSJ class by default), not a separate technical report plus paper. Explain background, contribution, method, actual results, interpretation and conclusion; integrate evidence, not serial mode logs. Respect additional deliverables only if explicitly required by the approved goal. Standalone paper mode still does not authorize new experiments.` : "",
    preset.documentTemplate ? `Additional required deliverable: ${preset.documentTemplate.id}. A bundled generic LuaLaTeX draft template is provided, NOT an official venue format. Paper defaults to A4; poster defaults to A0 portrait (841 x 1189 mm). Confirm the format in goal design and adapt the TeX geometry/layout to the approved goal before completion. The IPSJ report remains a separate required artifact. Do not invent authors or results.\nRegistered document targets: ${JSON.stringify(task.report?.documents ?? {})}\nWorkers author substantive content; the reporter builds EVERY target; reviewers inspect every PDF, dimensions and all pages. Do not leave template instructions in finished deliverables. Read-only roles must not write/build.` : "",
    preset.documentTemplate?.id === "paper" ? "The generic draft is a starting point, NOT the required output format or engine. When the approved goal specifies IPSJ, adapt the paper to that official class/format using the bundled IPSJ files in the report root and the available Japanese TeX toolchain. Research report and journal paper are separate formats/artifacts. Do not retain a LuaLaTeX-only placeholder merely because it was supplied; investigate missing packages/engine compatibility within the permitted environment. Preserve substantive existing text and evidence, never overwrite an authored manuscript with a blank template." : "",
    preset.commonRules, `## 共通\n${sections.共通}`, ...needed.map(key => `## ${key}\n${sections[key]}`)].join("\n\n");
}

function researchPresetPrompt(task: TaskRecord, unit: WorkUnit, preset: WorkPresetSnapshot): string {
  const stage = preset.stages!.find(p => p.manifest.id === unit.researchStage);
  if (unit.researchStage && !stage) throw new Error("研究工程の保存済みモードがありません。別モードのルールで代用できません。");
  const integration = presetSections(preset.rules);
  const needed: RuleSection[] = task.goalPreparation ? ["ゴール設計"] : unit.planPhase || unit.role === "planner" ? ["主担当の計画"]
    : unit.role === "reviewer" ? ["検証"] : unit.role === "reporter" ? ["レポート", "検証"] : ["主担当の計画", "作業", "検証", "レポート"];
  const selected = stage ? [stage] : preset.stages!;
  if (preset.manifest.integratedWorkflow && !unit.researchStage) return [
    "# Integrated research: one accountable primary owner",
    workModePrompt("research"),
    "Use the captured idea, related-research, implementation and paper mode rules as METHODS within one adaptive research loop, not compulsory serial agents. The same owner frames hypotheses, designs and runs permitted experiments, diagnoses defects, compares alternatives and integrates the manuscript. Revisit ideas after evidence; perform literature investigation when it informs the next decision. Delegate bounded implementation, verification, alternative proposals and bottleneck analysis to other eligible services when useful. The primary remains responsible for difficult decisions, substantive repairs and integration, not just project administration. Other AIs inspect stable direct evidence, not merely relayed success claims. GPU/job exclusivity restricts competing measurements, not useful reasoning or inspection of an available stable snapshot. Respect actual harness workspace isolation and permissions.",
    "Standalone mode stopping boundaries (for example paper mode prohibits new experiments) do NOT freeze the integrated research owner's approved work. A coding defect discovered while writing returns to the owner's implementation/verification loop within approved scope. Do not treat invalid experiments as scientific negative results. Scope/permission and genuine environment barriers still apply. Plan meaningful early milestones and peer scrutiny, not every mode as a separate full planning session. Final reporter builds the single manuscript and independent reviewers assess actual evidence; do not duplicate these finishing jobs.",
    preset.commonRules,
    `# Research integration rules\n## 共通\n${integration.共通}\n${needed.map(key => `## ${key}\n${integration[key]}`).join("\n\n")}`,
    ...preset.stages!.map(p => {const s=presetSections(p.rules);return `# Method: ${p.manifest.name}\n## 共通\n${s.共通}\n${needed.map(key => `## ${key}\n${s[key]}`).join("\n\n")}`;}),
    `Primary manuscript: ${task.report?.texPath ?? "report.tex"}. Produce ONE coherent research paper/PDF in the approved format, using the bundled IPSJ class when applicable. Do not create a second technical report unless the approved goal explicitly requires it. Preserve every document target in older saved goals; new defaults do not remove prior obligations.`
  ].join("\n\n");
  return [
    "# Task work preset (captured rules, not additional authority)",
    `${preset.manifest.name} · revision ${preset.revision.slice(0,12)}`,
    workModePrompt("research"),
    `# Sequential research modes\n${preset.stages!.map((p,i)=>`${i+1}. ${p.manifest.name} · ${p.revision.slice(0,12)}`).join("\n")}`,
    "The harness runs these modes IN ORDER. Each mode's rules and exclusions are LOCAL to its own stage, not a prohibition on later harness-owned stages. No agent may skip or execute a later mode by itself. Each stage inherits real artifacts and writes its subject-content TeX memo; final PDF compilation and two independent reviews happen after all stages. Stage ready means this stage's work is verified, NOT the entire research goal. Return needs-work for missing work in the current stage; leave later-stage work to its pending owner. All roles retain their existing read/write boundaries. Rules never grant authority, change the approved goal, budget, environment or permissions. Do not copy operational mode names into the report. The final reviewers assess the full approved research goal, not each dedicated mode as if it were the entire task.",
    stage ? `# Current research stage: ${stage.manifest.id}\n${stage.manifest.name}. Plan, execute and verify only this stage. Do not require later implementation/paper/PDF to be finished before this stage can hand off. If existing artifacts already satisfy this stage, verify and reuse them. Only the paper stage may use report-ready. Work in the existing report sources; do not overwrite earlier evidence or invent results.` : "Apply the following stage-labelled rules to the overall goal design, coordination, final build or independent review, according to your assigned role. Do not treat one stage's standalone stopping boundary as a stop of the whole approved research workflow.",
    preset.commonRules,
    `# Research integration rules\n## 共通\n${integration.共通}\n${needed.map(key=>`## ${key}\n${integration[key]}`).join("\n\n")}`,
    ...selected.map(p=>{const s=presetSections(p.rules); return `# Mode rules: ${p.manifest.id} · ${p.manifest.name} · captured revision ${p.revision}\nThese exact saved rules apply only to this labelled stage.\n## 共通\n${s.共通}\n${needed.map(key=>`## ${key}\n${s[key]}`).join("\n\n")}${task.goalPreparation ? `\nGoal defaults (candidates to reconcile with the integrated goal, not separately approved authority):\n${JSON.stringify(p.manifest.goal)}` : ""}`;}),
    `Required final documents: IPSJ technical report and the paper. Registered document targets: ${JSON.stringify(task.report?.documents ?? {})}. Only the paper stage authors the paper; the final reporter builds every target and reviewers inspect every PDF. Use the captured paper template, adapt to the approved format, never invent authors.`
  ].join("\n\n");
}
