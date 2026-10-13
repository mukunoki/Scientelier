import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FinishingSkillSnapshot, TaskRecord, WorkUnit } from "./types";
import { scriptReuseGuidance } from "./script-reuse";
import { documentCheckGuidance } from "./document-checks";
import { relatedResearchGuidance } from "./related-research";
import { LESSON_SKILLS } from "./paper-lesson";
import { usesContentRefinement } from "./content-refinement";

export interface WorkSkill { id: string; description: string; content: string; }
const definitions = [
  ["content-refinement", "実装・着想・分析を深め、別AIの改善案を実作業と評価へ戻すとき"],
  ["hypothesis-design", "仮説・反証条件と最小の判別実験を設計するとき"],
  ["minimal-reproduction", "障害・不一致を再現し、原因切り分けと回帰テストを行うとき"],
  ["fair-benchmark", "実測性能・精度を比較するとき"],
  ["change-impact", "変更によって無効になる検証・再生成対象を特定するとき"],
  ["decision-memory", "過去に試した方法・棄却理由を継続作業へ引き継ぐとき"],
  ["reproducibility", "成果物と保存手順だけで再現可能か確認するとき"],
  ["skill-trial", "自作・変更したスキルの適用条件と効果を試験するとき"]
] as const;
const builtinCache = new Map<string, string>();
let canonicalVerification: string | undefined;

function sharedVerificationRevision(writing?: FinishingSkillSnapshot): string | undefined {
  if (!writing) return;
  if (createHash("sha256").update(writing.rules).digest("hex") !== writing.revision) return;
  canonicalVerification ??= readFileSync(join(__dirname, "../../assets/finishing-skills/report-writing-verification/SKILL.md"), "utf8").trim();
  // A section label alone proves no coverage. Require the complete canonical
  // body; older/customized versions fall back to self-contained runtime checks.
  if (canonicalVerification.startsWith("---\nname: report-writing-verification\n") && canonicalVerification.length > 100
    && writing.rules.includes(canonicalVerification)) return writing.revision;
}
function builtin(id: string): string {
  // IDs originate only in the fixed catalog, never from tool arguments or paths.
  if (!builtinCache.has(id)) {
    const content = readFileSync(join(__dirname, "../../assets/work-skills", id, "SKILL.md"), "utf8");
    if (content.length > 12000 || !content.startsWith(`---\nname: ${id}\n`)) throw new Error(`Invalid bundled skill: ${id}`);
    builtinCache.set(id, content);
  }
  return builtinCache.get(id)!;
}

/** Snapshot the role-specific catalog once per run. Only explicitly adopted
 * user skills are distributed; supporting scripts are never auto-executed. */
export function collectWorkSkills(task: TaskRecord, unit: WorkUnit, writing?: FinishingSkillSnapshot): WorkSkill[] {
  if (task.goalPreparation || unit.orchestrator) return [];
  const sharedRevision = sharedVerificationRevision(writing);
  const skills: WorkSkill[] = [
    { id: "script-reuse", description: "定型作業のスクリプト化・プロジェクト内スキルの再利用", content: scriptReuseGuidance(task, unit) },
    { id: "document-checks", description: "文書を執筆・検証する場合の数値・用語・参照の機械検査", content: documentCheckGuidance(unit, sharedRevision) },
    { id: "related-research", description: "関連研究を紹介・検証する場合の原論文との内容照合", content: relatedResearchGuidance(unit, sharedRevision) }
  ];
  const mode = unit.researchStage ?? task.workPreset?.manifest.id;
  for (const [id, description] of definitions) {
    if (id === "content-refinement" && !usesContentRefinement(task, unit)) continue;
    // A specialist receives only a menu, not authorization to do another role's
    // work. Avoid exposing prior decision verdicts to independent reviewers.
    if (id === "decision-memory" && (unit.role === "reviewer" || unit.subtask?.requirements?.independentFrom?.length || unit.subtask?.requirements?.independenceGroup)) continue;
    if (["hypothesis-design", "fair-benchmark"].includes(id) &&
      (unit.role === "reporter" || ["research", "paper", "poster", "paper-explainer"].includes(mode ?? ""))) continue;
    const managed = task.managedSkills?.find(s=>s.id===id);
    if (task.managedSkills && !managed) continue;
    skills.push(managed ?? { id, description, content: builtin(id) });
  }
  if (task.managedSkills) skills.push(...task.managedSkills.filter(s=>!definitions.some(([id])=>id===s.id) && !(LESSON_SKILLS as readonly string[]).includes(s.id)));
  // Lesson rules are frozen at task creation, not silently changed mid-lesson.
  if (task.workPreset?.manifest.focus === "paper-explainer") skills.push(...task.lessonSkills ?? LESSON_SKILLS.map(id => ({ id, description: id, content: builtin(id) })));
  return skills;
}

export function workSkillsPrompt(task: TaskRecord, unit: WorkUnit, deferred = false, skillDirectory?: string): string {
  const skills = collectWorkSkills(task, unit);
  if (!skills.length) return "";
  const routing = "# 必要な作業スキルの選択\n最初の実行計画では使用するスキルIDと適用工程を既存のsummaryまたはcoordination.contextPlanの文字列へ短く記す。従来のプランナーは通常の引き継ぎ本文へ記す。skillsやskillPlanなど新しいJSONキーは追加しない。担当者は実際に該当する作業の前に該当スキルを読む。script-reuseは計画/実作業の基本、文書を扱う場合はdocument-checks、関連研究を紹介/検証する場合はrelated-researchを省略しない。残りは適用条件に合うものだけ選び、全件を読むための作業を作らない。新しい試行上限・提出形式・工程や権限は追加しない。失敗した方法の記憶は現行の証拠で再確認し、独立レビューの判定を誘導しない。自作スキルはexperimental→試験→作業フォルダ内validatedとし、全タスク共通への昇格はユーザー承認が必要。安全性・承認範囲・独立レビューはスキルで上書きできない。";
  const refinement = skills.some(s => s.id === "content-refinement")
    ? "\n内容を深める計画・代案検討・改善の実作業ではcontent-refinementを読む。主担当は報告の体裁より実装・解析・着想の洗練へ配分し、別AIの提案を試して採否を判断する。単純な修正や有用な分担がない場合は短い自己点検でよい。" : "";
  if (!deferred) return [routing + refinement, ...skills.map(s => s.content)].join("\n\n");
  return [routing + refinement,
    (skillDirectory ? '詳細は以下の保存版ファイルを読み取りツールで読む。MCPは不要。ファイルは変更しない。' : '詳細は agent_harness.get_skill({"id":"対象ID"}) でこの実行の保存版を取得する。名前が未表示ならツールを検索する。') + '読むのは必要な詳細だけとし、取得できない場合はその制約を報告して該当する作業を未確認のまま完了させない。スキル本文や生ログを引き継ぎへ丸ごと複製せず、ID・利用理由・証拠パスを渡す。',
    ...skills.map(s => `- ${s.id}: ${s.description}${skillDirectory ? ` — ${JSON.stringify(join(skillDirectory, `${s.id}.md`))}` : ""}`)
  ].join("\n");
}
