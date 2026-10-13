// Presentation only. Never use this lenient parser to authorize workflow progress.
function repairWorkPresentation(task: TaskRecord, unit: WorkUnit): { work: string; conditions: string; concerns: string; instructions?: string } | undefined {
  const prefix = "Repair ONLY these unmet required conditions: ";
  if (unit.role !== "worker" || !unit.instructions.startsWith(prefix)) return;
  const lines = unit.instructions.split("\n");
  let conditions = "詳細指示で確認してください。", concerns = "詳細指示で確認してください。";
  let missingCount: number | undefined, concernCount: number | undefined;
  try {
    const values: unknown = JSON.parse(lines[0].slice(prefix.length));
    if (Array.isArray(values) && values.every(c => c && typeof c.criterionId === "string" && typeof c.detail === "string")) {
      missingCount = values.length;
      conditions = values.length ? values.map(c => {
        const label = task.goal?.criteria.find(g => g.id === c.criterionId)?.description ?? c.criterionId;
        return `・${label}${c.detail ? `\n  ${c.detail}` : ""}`;
      }).join("\n") : "必須条件の未達なし（追加検討事項は別途対応）";
    }
  } catch { /* Never present an unreadable array as an empty one. */ }
  const concernPrefix = "Further required investigation within the approved goal: ";
  const line = lines.find(l => l.startsWith(concernPrefix));
  if (line) try {
    const values: unknown = JSON.parse(line.slice(concernPrefix.length));
    if (Array.isArray(values) && values.every(c => typeof c === "string" && c.trim())) {
      concernCount = values.length;
      concerns = values.length ? values.map(c => `・${c}`).join("\n") : "追加検討事項なし";
    }
  } catch { /* Keep unknown explicit. */ }
  const instructions = unit.instructions.match(/(?:^|\n)Reviewer instructions: ([\s\S]*?)\nPreserve already passing behavior, scope and the approved goal\./)?.[1].trim();
  return {
    work: missingCount === 0 && concernCount && concernCount > 0
      ? "レビューの追加検討事項を調査し、必要な修正と再検証を行う。"
      : missingCount && missingCount > 0 ? "未達の必須条件を修正し、追加検討事項とあわせて再検証する。"
      : "レビューの差し戻し内容を確認し、必要な対応と再検証を行う。",
    conditions, concerns,
    instructions: instructions === "Resolve the unmet criteria and outstanding concerns, then verify the corrected artifacts again."
      ? "未達条件・追加検討事項に対応し、修正後の成果物を再検証する。" : instructions || undefined
  };
}

interface SubjectWorkReport { proposals: string[]; activities: string[]; results: string[]; interpretation: string[]; nextSteps: string[]; issues: string[]; }
function subjectWorkReport(value: unknown): SubjectWorkReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (JSON.stringify(value).length > 24000) return;
  const report = {} as SubjectWorkReport;
  for (const key of ["proposals", "activities", "results", "interpretation", "nextSteps", "issues"] as const) {
    const items = (value as Record<string,unknown>)[key] ?? [];
    if (!Array.isArray(items) || items.length > 12 || items.some(s => typeof s !== "string" || !s.trim() || s.length > 1600)) return;
    report[key] = items.map(s => s.trim());
  }
  return Object.values(report).some(items => items.length) ? report : undefined;
}
function reportedWorkOutcome(unit?: WorkUnit): { status: string; summary: string; remainingWork?: string; workReport?: SubjectWorkReport; userDecision?: { reason: string; question: string; options: string[] } } | undefined {
  if (!unit || unit.state !== "completed" || !["worker", "planner"].includes(unit.role)) return;
  const blocks = [...(unit.output ?? "").matchAll(/<work-check>([\s\S]*?)<\/work-check>/g)];
  if (blocks.length !== 1 || blocks[0][1].length > 48000) return;
  try {
    const value = JSON.parse(blocks[0][1]);
    if (["ready", "report-ready", "needs-work", "ask-user"].includes(value.status) && typeof value.summary === "string") return { ...value, workReport: subjectWorkReport(value.workReport) };
  } catch { /* A malformed report is never presented as a verified result. */ }
}

// Presentation only: never infer approval, goal edits, or an automatic retry
// from a model's proposed options. Older tasks still expose remainingWork.
function taskUserDecision(task: TaskRecord): { reason: string; question: string; options: string[] } | undefined {
  if (!["awaiting-input", "blocked", "paused"].includes(task.state) || !task.error?.startsWith("ユーザ確認が必要です。")) return;
  const check = [...task.workUnits].reverse().map(reportedWorkOutcome).find(Boolean);
  if (check?.status !== "ask-user") return;
  const decision = check.userDecision;
  if (decision && [decision.reason, decision.question].every(s => typeof s === "string" && s.trim() && s.length <= 800)
    && Array.isArray(decision.options) && decision.options.length <= 3
    && decision.options.every(s => typeof s === "string" && s.trim() && s.length <= 800)) return decision;
  const question = check.remainingWork?.trim() || check.summary;
  const criterionConflict = /(?:条件|基準|仕様)/.test(question) && /(?:変更|改訂|緩和|事後|未達)/.test(question);
  return { reason: criterionConflict ? "承認済みの合格条件と実際の作業に食い違いがあり、条件の扱いを決める必要があります。"
    : "担当だけでは決められない事項があり、回答を待っています。", question, options: [] };
}
function unitStatusLabel(task: TaskRecord, unit: WorkUnit): string {
  const check = reportedWorkOutcome(unit);
  if (check?.status === "ask-user") return "要対応・作業未完了";
  if (check?.status === "needs-work") return "担当終了・未完了報告";
  if (check?.status === "report-ready") return "実作業完了・PDF仕上げへ";
  if (unit.state === "pending" && task.autonomyState === "needs-input") return "待機・先行工程の対応待ち";
  return historyStateLabels[unit.state] ?? unit.state;
}
function runStatusLabel(task: TaskRecord, run: AgentRun): string {
  if (run.state !== "completed") return historyStateLabels[run.state] ?? (run.state === "rate-limited" ? "使用制限中" : run.state);
  const unit = [...task.workUnits, ...(task.retiredWorkUnits ?? [])].find(u => u.id === run.workUnitId);
  if (!unit) return "作業終了";
  const check = reportedWorkOutcome(unit);
  if (check?.status === "report-ready") return "実作業完了・PDF仕上げへ";
  return check && check.status !== "ready" ? check.status === "ask-user" ? "応答受領・要対応" : "担当終了・未完了報告" : "作業終了";
}

function unfinishedWorkExplanation(task: TaskRecord, unit: WorkUnit): string | undefined {
  const check = reportedWorkOutcome(unit);
  if (check?.status !== "needs-work") return;
  const successors = task.workUnits.filter(u => u.dependsOn.includes(unit.id));
  const states: Record<string, string> = { pending: "待機", running: "実行中", completed: "担当終了", failed: "失敗", blocked: "停止", cancelled: "中断" };
  const next = successors.length ? `登録済みの後続工程：${successors.map(u => `${u.title}（${states[u.state] ?? u.state}${u.assignedAgentId ? `・${u.assignedAgentId}` : "・担当未割当"}）`).join("、")}`
    : "この記録からは引き継ぎ先を確認できません。現在の計画・担当を確認してください。";
  return `この担当の応答は終了しましたが、作業が必要だと報告しています。別担当への引き継ぎや残課題の解決が済んだことを意味しません。\n${typeof check.remainingWork === "string" && check.remainingWork.trim() ? `報告時の残課題：${check.remainingWork}\n` : ""}${next}`;
}
