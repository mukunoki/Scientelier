import { randomUUID } from "node:crypto";
import type { GoalContract, GoalDraftInput, TaskRecord, WorkUnit } from "./types";
import { validateLesson } from "./paper-lesson";
import { isActiveTaskState } from "./task-state";

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 8000 || (!allowEmpty && !value.trim())) throw new Error(`${label}を8,000文字以内で入力してください。`);
  return value.trim();
}
function lines(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error(`${label}は40項目以内にしてください。`);
  return value.map(item => text(item, label));
}
export function validateGoalDraft(value: unknown, approve = false): GoalDraftInput {
  if (!value || typeof value !== "object") throw new Error("ゴール案が不正です。");
  const v = value as GoalDraftInput;
  if (!Array.isArray(v.criteria) || v.criteria.length > 40) throw new Error("達成条件は40件以内にしてください。");
  const ids = new Set<string>();
  const readCriteria = (items: GoalDraftInput["criteria"], selected: boolean) => items.map(item => {
    if (!item || typeof item !== "object" || typeof item.required !== "boolean") throw new Error("達成条件が不正です。");
    const id = text(item.id, "条件ID");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error("条件IDが重複または不正です。");
    ids.add(id);
    return { id, description: text(item.description, "達成条件", !selected), verification: text(item.verification, "検証方法", !approve || !selected), required: item.required };
  });
  const criteria = readCriteria(v.criteria, true);
  const result: GoalDraftInput = {
    objective: text(v.objective, "目的"), deliverables: lines(v.deliverables, "成果物"), criteria,
    constraints: lines(v.constraints, "制約"), outOfScope: lines(v.outOfScope, "対象外"), questions: lines(v.questions, "確認事項")
  };
  if (v.lesson !== undefined) result.lesson = validateLesson(v.lesson, approve);
  if (v.questionAnswers !== undefined) {
    if (!Array.isArray(v.questionAnswers) || v.questionAnswers.length > 40) throw new Error("確認事項への回答は40件以内にしてください。");
    const seen = new Set<string>();
    result.questionAnswers = v.questionAnswers.map(item => {
      if (!item || typeof item !== "object") throw new Error("確認事項への回答が不正です。");
      const question = text(item.question, "回答先の確認事項");
      if (seen.has(question)) throw new Error("回答先の確認事項が重複しています。");
      seen.add(question);
      return { question, answer: text(item.answer, "確認事項への回答", true) };
    });
  }
  if (v.unselected !== undefined) {
    const u = v.unselected;
    if (!u || typeof u !== "object" || !Array.isArray(u.criteria) || u.criteria.length + criteria.length > 40) throw new Error("達成条件の候補は選択中・未選択を合わせて40件以内にしてください。");
    result.unselected = { deliverables: lines(u.deliverables, "未選択の成果物"), criteria: readCriteria(u.criteria, false), constraints: lines(u.constraints, "未選択の制約"), outOfScope: lines(u.outOfScope, "未選択の対象外") };
    for (const key of ["deliverables", "constraints", "outOfScope"] as const) {
      if (result[key].length + result.unselected[key].length > 40) throw new Error("各項目の候補は選択中・未選択を合わせて40件以内にしてください。");
      if (result.unselected[key].some(item => result[key].includes(item))) throw new Error("選択中と未選択に同じ項目があります。");
    }
  }
  if (JSON.stringify(result).length > 48_000) throw new Error("ゴール案が長すぎます。全体を48,000文字以内に整理してください。");
  if (approve && (!result.deliverables.length || !criteria.some(item => item.required))) throw new Error("成果物と必須の達成条件を少なくとも1件ずつ設定してください。");
  if (approve && result.questions.length) throw new Error("確認事項への回答をゴールへ反映し、確認事項を空にしてから承認してください。");
  if (approve && result.constraints.some(c => /(?:準備|目標契約).*(?:限定|のみ)/.test(c) && /(?:調査|作成|変更|編集).*(?:行わない|禁止)/.test(c))) throw new Error("準備段階だけの作業禁止がゴールの制約に残っています。本作業を許可する範囲を確認して、制約を修正してから承認してください。");
  return result;
}

export function initialGoal(objective: string, preset?: TaskRecord["workPreset"]): GoalContract {
  const lesson = preset?.manifest.primaryDocument === "beamer";
  const paper = preset?.manifest.primaryDocument === "paper";
  return {
    objective: text(objective, "目的"), deliverables: [...(paper ? [] : [lesson ? "読むためのBeamer解説教材（TeX・PDF・図の素材）" : "IPSJ研究報告形式のTeXとPDF"]), ...(preset?.manifest.goal.deliverables ?? [])],
    criteria: [{ id: "report", description: lesson ? "指定した前提知識から自習できるBeamer教材を作る（枚数・発表時間上限なし）" : paper ? "研究・開発の内容を指定形式の一つの論文TeXとPDFにまとめる（別の技術レポートは不要）" : "主題に関係する内容だけをIPSJ形式のTeXとPDFにまとめる", verification: "TeXのビルドが成功し、PDFの全ページを表示して体裁を確認する", required: true }, ...structuredClone(preset?.manifest.goal.criteria ?? [])],
    constraints: [], outOfScope: [], questions: preset ? [...preset.manifest.goal.questions] : ["レポート以外に必要な成果物と、主題に固有の達成条件を設定してください。"],
    revision: 1, status: "draft", updatedAt: new Date().toISOString()
  };
}

export function goalEditable(task: TaskRecord): boolean {
  const revisionDraft = task.goalRevisionPending && task.goal?.status === "draft" && task.scopeTransition?.round === (task.roundNumber ?? 1);
  return Boolean(task.goal && !isActiveTaskState(task.state)
    && !task.runs.some(run => !run.goalPreparation && (!revisionDraft || task.workUnits.some(u => u.id === run.workUnitId))));
}

export function updateGoalContract(task: TaskRecord, value: unknown, revision: number, approve: boolean): Partial<TaskRecord> {
  if (!goalEditable(task)) throw new Error("ゴールは本作業を開始する前に編集・承認してください。");
  if (task.goal!.revision !== revision) throw new Error("ゴールが更新されています。最新の内容を開き直してください。");
  const draft = validateGoalDraft(value, approve);
  if (task.workPreset?.manifest.primaryDocument === "beamer") {
    if (!draft.lesson || !task.lessonSources?.length) throw new Error("論文PDFと説明範囲の設定が必要です。");
    if (approve && (!draft.criteria.some(c => c.id === "report" && c.required) || !draft.deliverables.some(s => /beamer/i.test(s)))) throw new Error("論文解説モードではBeamer成果物とreportの必須条件を保持してください。");
  }
  const now = new Date().toISOString();
  return {
    ...(approve ? { goalRevisionPending: undefined } : {}),
    goal: { ...draft, revision: revision + 1, status: approve ? "approved" : "draft", updatedAt: now, ...(approve ? { approvedAt: now } : {}) },
    goalHistory: [...(task.goalHistory ?? []), structuredClone(task.goal!)],
    goalPreparation: false,
    state: approve ? "queued" : "awaiting-input", awaitingReason: approve ? undefined : "goal", error: undefined
  };
}

export function goalPreparationUnit(goal: GoalContract, notes: string): WorkUnit {
  const instructions = [
    "Help the user define an achievable goal contract. This is goal preparation ONLY: inspect relevant local files read-only when useful, but do not implement, edit files, build reports, submit jobs, or run state-changing commands.",
    `Respond in Japanese. Preserve the user's scope. Separate required criteria from optional improvements; give each a concrete verification method. Include ${goal.lesson ? "the Beamer lesson TeX/PDF deliverable, NOT an IPSJ report" : "the standard IPSJ TeX/PDF deliverable"}. Ask only consequential missing questions; do not invent answers or permission. Record unanswered questions in questions. Do not mark anything approved or achieved.`,
    "Use the document choices in the current draft: if one research manuscript is specified, it satisfies the subject-report requirement; do not invent a second technical report or a separate journal paper. Explicitly requested multiple documents remain required. A single manuscript contains actual research/development content, not a compliance diary.",
    "The UI presents a checklist. Write each deliverable and criterion as one concise, self-contained bullet; put verification details in verification, not repeated in description. Do not shorten by omitting material scope, numerical thresholds or constraints. unselected holds candidates the user EXCLUDED, not approved requirements. Do not reintroduce these into selected lists unless the user's clarification explicitly requests it.",
    "The draft describes the FUTURE substantive work after approval, not this preparation phase. Do not copy temporary instructions such as preparation only / do not research / do not edit into its constraints. If the current draft already contains such a conflicting restriction, ask the user to clarify its scope rather than silently removing an approved restriction. Remove questions only when the user's clarification actually resolves them.",
    `Current draft: ${JSON.stringify(goal)}`,
    "questionAnswers contains the user's answers paired with each question. Incorporate these into the relevant objective, deliverables, criteria, constraints or outOfScope. An answer does not automatically resolve a question: retain consequential unresolved or contradictory points in questions. Do not invent answers. User answers are preparation notes, not approval to execute work.",
    `User clarification: ${text(notes, "補足", true)}`,
    "Your final handoff MUST contain exactly one <goal-draft>JSON</goal-draft> block, then the required workflow completion marker. JSON fields: objective (string), deliverables (string[]), criteria ({id: unique ASCII ID, description: string, verification: string, required: boolean}[]), constraints (string[]), outOfScope (string[]), questions (string[]). Maximum 40 items per array. No execution metadata in the proposed report. Do not output the block in commentary or tool results."
  ].join("\n\n");
  return { id: randomUUID(), role: "planner", title: "Goal preparation", instructions, mode: "read", state: "pending", dependsOn: [], attemptedAgentIds: [] };
}

export function parseGoalProposal(output: string, previous?: GoalContract): GoalDraftInput {
  const blocks = [...output.matchAll(/<goal-draft>([\s\S]*?)<\/goal-draft>/g)];
  if (blocks.length !== 1 || blocks[0][1].length > 100_000) throw new Error("AIのゴール案を取り込めませんでした。実行画面の回答を確認し、手動で編集するか再提案してください。");
  try {
    const proposal = validateGoalDraft(JSON.parse(blocks[0][1]));
    if (previous?.lesson && !proposal.lesson) throw new Error("説明レベルの提案がありません。lessonを含めて再提案してください。");
    if (previous?.lesson && proposal.lesson) {
      // Recommendations may evolve; user selections and declared knowledge do
      // not. New topics are proposals until the next explicit goal approval.
      const prior = previous.lesson;
      proposal.lesson = { ...proposal.lesson, audience: prior.audience, interests: prior.interests, language: prior.language, references: prior.references,
        topics: proposal.lesson.topics.map(t => ({ ...t, depth: prior.topics.find(p => p.id === t.id)?.depth ?? t.depth })) };
      for (const topic of prior.topics) if (!proposal.lesson.topics.some(t => t.id === topic.id)) proposal.lesson.topics.push(topic);
    }
    // Only the user can supply answer notes. Keep unresolved answers when the AI
    // omits them; resolved answers remain available in the goal's revision history.
    delete proposal.questionAnswers;
    if (previous?.questionAnswers) proposal.questionAnswers = previous.questionAnswers.filter(item => proposal.questions.includes(item.question));
    if (previous?.unselected) {
      const options = proposal.unselected ?? { deliverables: [], criteria: [], constraints: [], outOfScope: [] };
      for (const key of ["deliverables", "constraints", "outOfScope"] as const) options[key] = [...new Set([...options[key], ...previous.unselected[key]])].filter(value => !proposal[key].includes(value));
      options.criteria = [...new Map([...previous.unselected.criteria, ...options.criteria].map(c => [c.id, c])).values()].filter(c => !proposal.criteria.some(p => p.id === c.id || p.description === c.description));
      proposal.unselected = options;
    }
    return validateGoalDraft(proposal);
  }
  catch (error) { throw new Error(`AIのゴール案が不正です: ${error instanceof Error ? error.message : String(error)}`); }
}

export function goalPrompt(goal?: GoalContract): string {
  if (!goal || goal.status !== "approved") return "";
  return `# User-approved goal (revision ${goal.revision})\n${JSON.stringify({ objective: goal.objective, deliverables: goal.deliverables, criteria: goal.criteria, constraints: goal.constraints, outOfScope: goal.outOfScope, lesson: goal.lesson })}\nThese are the acceptance conditions, not proof of completion. Work only within this scope. Do not weaken, remove, or approve changes to these conditions. Report evidence by criterion ID and explicitly identify unmet or unverified criteria. A process exit or handoff is not goal attainment. If scope changes are needed, ask the user.`;
}
