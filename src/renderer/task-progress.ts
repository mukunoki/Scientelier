// Read-only projection of saved task records. Never infer success from a process
// exit, generated prose, or a completed work-unit count. No polling or LLM calls.
type TaskPanel = "overview" | "goal" | "plan" | "followup" | "execution" | "evidence" | "work-report" | "report" | "history" | "hpc" | "research" | "quality";
type CriterionProgressState = "recorded-pass" | "needs-work" | "recheck" | "unverified";
interface CriterionProgress {
  criterion: GoalCriterion;
  status: CriterionProgressState;
  findings: Array<{ at: string; reviewer: string; status: string; detail: string; evidence: Array<{ path: string; detail: string }> }>;
}
const criterionProgressLabels: Record<CriterionProgressState, string> = {
  "recorded-pass": "合格記録あり", "needs-work": "修正が必要", recheck: "再確認が必要", unverified: "未確認"
};
const progressDisclosures = new Map<string, boolean>();

function taskPanelGroup(panel: TaskPanel): "overview" | "goal" | "plan" | "execution" | "evidence" | "work-report" | "report" | "history" {
  if (panel === "followup") return "overview";
  if (["quality", "research", "hpc", "evidence"].includes(panel)) return "evidence";
  return panel as "overview" | "goal" | "plan" | "execution" | "work-report" | "report" | "history";
}

function taskCriterionProgress(task: TaskRecord): CriterionProgress[] {
  const round = task.roundNumber ?? 1;
  const evaluations = (task.evaluations ?? []).filter(e => e.goalRevision === task.goal?.revision && e.round === round && e.cycle === (task.autonomyCycle ?? 1));
  // Retain one current receipt per reviewer unit. A newer peer's pass must not
  // hide another peer's failure; retired review seats are not current evidence.
  const receipts = new Map<string, NonNullable<TaskRecord["evaluations"]>[number]>();
  for (const e of evaluations) {
    if (e.reviewUnitId && !task.workUnits.some(u => u.id === e.reviewUnitId && u.state === "completed")) continue;
    const key = e.reviewUnitId ?? "combined";
    if (!receipts.has(key) || e.reviewedAt >= receipts.get(key)!.reviewedAt) receipts.set(key, e);
  }
  return (task.goal?.criteria ?? []).map(criterion => {
    const findings = [...receipts.values()].flatMap(e => {
      const c = e.criteria.find(c => c.criterionId === criterion.id);
      return c ? [{ at: e.reviewedAt, reviewer: e.reviewerAgentId ?? "総合判定", status: c.status, detail: c.detail, evidence: c.evidence }] : [];
    });
    const changedSince = findings.some(f => task.workUnits.some(u => u.mode !== "read" && !u.planPhase &&
      ((u.startedAt && u.startedAt > f.at) || (u.completedAt && u.completedAt > f.at) || u.state === "running")));
    const historical = (task.evaluations ?? []).some(e => e.criteria.some(c => c.criterionId === criterion.id));
    const status: CriterionProgressState = findings.length
      ? changedSince ? "recheck" : findings.some(f => f.status === "fail") ? "needs-work"
        : findings.every(f => f.status === "pass") ? "recorded-pass" : "unverified"
      : historical ? "recheck" : "unverified";
    return { criterion, status, findings };
  });
}

function taskUpcomingWork(task: TaskRecord): Array<{ unit: WorkUnit; reason: string }> {
  const unfinished = task.workUnits.filter(u => u.state !== "completed" && u.state !== "running");
  // Priority is presentation only; the scheduler is the sole authority on launch.
  const priority = (u: WorkUnit) => u.id === task.resumeFromUnitId ? 0 : u.state !== "pending" ? 1 : 2;
  return unfinished.map((unit, index) => ({ unit, index })).sort((a, b) => priority(a.unit) - priority(b.unit) || a.index - b.index).map(({ unit }) => {
    const dependencies = unit.dependsOn.map(id => task.workUnits.find(u => u.id === id) ?? task.retiredWorkUnits?.find(u => u.id === id));
    const missing = dependencies.some(u => !u);
    const waiting = dependencies.filter((u): u is WorkUnit => !!u && u.state !== "completed");
    const reason = unit.state !== "pending" ? "中断・停止した作業。復旧後に再開"
      : missing ? "前提作業の状態確認が必要"
      : waiting.length ? `前提待ち：${waiting.map(u => u.title).join("、")}`
      : task.state === "queued" ? "実行待ち（担当・接続・使用枠を確認して開始）"
      : ["paused", "blocked", "failed", "cancelled", "awaiting-input"].includes(task.state) ? "前提作業は終了。タスクの再開・確認待ち"
      : "前提作業は終了。担当・使用枠・同時実行数の判定待ち";
    return { unit, reason };
  });
}

function progressWorkDescription(task: TaskRecord, unit: WorkUnit): string {
  const plan = [...(task.executionPlans ?? [])].reverse().find(p => p.primaryUnitId === unit.id || Object.values(p.taskUnitIds).includes(unit.id));
  const member = plan?.tasks.find(t => plan.taskUnitIds[t.key] === unit.id);
  return repairWorkPresentation(task, unit)?.work ?? member?.deliverable ?? (plan?.primaryUnitId === unit.id ? plan.primaryWork : unit.subtask?.deliverable) ?? "";
}

function savedTaskWorkUnits(task: TaskRecord): WorkUnit[] {
  // Report-only legacy rounds can lack workUnits. Current records win over
  // archived copies of the same unit; never rewrite the source histories.
  const units = [...task.workUnits, ...(task.retiredWorkUnits ?? []),
    ...(task.autonomyHistory ?? []).flatMap(h => h.workUnits ?? []),
    ...(task.history ?? []).flatMap(h => h.workUnits ?? []),
    ...(task.interruptedHistory ?? []).flatMap(h => h.workUnits ?? [])];
  const unique = new Map<string, WorkUnit>();
  for (const unit of units) if (unit && !unique.has(unit.id)) unique.set(unit.id, unit);
  return [...unique.values()];
}

function progressNode<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function progressButton(label: string, action: () => void): HTMLButtonElement {
  const button = progressNode("button", label, "secondary-button compact"); button.type = "button"; button.onclick = action; return button;
}
function openTaskPanel(task: TaskRecord, panel: TaskPanel): void {
  state.selectedTaskPanels.set(task.id, panel); renderDetail();
}
function progressDisclosure(task: TaskRecord, key: string, title: string): HTMLDetailsElement {
  const details = document.createElement("details"); details.className = "progress-disclosure";
  details.append(progressNode("summary", title));
  const id = `${task.id}:${key}`; details.open = progressDisclosures.get(id) ?? false;
  details.ontoggle = () => { if (details.isConnected) progressDisclosures.set(id, details.open); }; return details;
}

function buildCriterionProgress(task: TaskRecord): HTMLElement {
  const section = progressNode("section", "", "progress-criteria");
  const progress = taskCriterionProgress(task);
  const required = progress.filter(p => p.criterion.required);
  section.append(progressNode("h3", "できたこと・残っていること"));
  section.append(progressNode("p", required.length
    ? `必須条件 ${required.length}件 · 合格記録 ${required.filter(p => p.status === "recorded-pass").length}件 · 修正・再確認・未確認 ${required.filter(p => p.status !== "recorded-pass").length}件`
    : "達成条件はまだ登録されていません。", "progress-meta"));
  for (const p of progress) {
    const row = progressDisclosure(task, `criterion:${p.criterion.id}`, ""); row.classList.add("progress-criterion", p.status);
    const summary = row.querySelector("summary")!;
    summary.append(progressNode("span", `${p.criterion.required ? "" : "任意 · "}${p.criterion.description}`), progressNode("span", criterionProgressLabels[p.status], "progress-state"));
    // The expanded heading shows the whole condition; do not repeat it in the body.
    row.append(progressNode("p", `確認方法：${p.criterion.verification}`));
    if (!p.findings.length) row.append(progressNode("p", p.status === "recheck" ? "以前の評価はありますが、現在のゴール・作業回・修正サイクルに対応する判定はありません。" : "有効なレビュー記録はまだありません。作業終了だけでは合格にしません。"));
    for (const f of p.findings) {
      const detail=historyReportBody(f.detail);detail.classList.add("work-description");
      row.append(progressNode("p", `${f.reviewer} · ${new Date(f.at).toLocaleString("ja-JP")} · ${f.status === "pass" ? "合格" : f.status === "fail" ? "不合格" : "未確認"}`), detail);
      for (const evidence of f.evidence) row.append(progressNode("p", `${evidence.path} — ${evidence.detail}`, "progress-meta"));
    }
    section.append(row);
  }
  section.append(progressNode("p", "合格記録は評価時点の判定です。現在のファイルとの一致や全レビューの完了を保証する表示ではありません。", "progress-meta"));
  return section;
}

function buildProgressOverview(task: TaskRecord): HTMLElement {
  const root = progressNode("section", "", "task-progress-overview");
  // A draft is one approval form, not a summary followed by the same form again.
  if (task.goal?.status === "draft") {
    root.append(buildTaskOverview(task)); return root;
  }
  // Summaries link to the authoritative views; never duplicate the full ledger
  // or promote an agent's prose to acceptance evidence.
  const status = progressNode("section", "", "progress-summary");
  status.append(progressNode("h3", "進捗の要点"));
  const counts = progressNode("div", "", "progress-counts");
  for (const [label, value] of [
    ["タスク", taskDisplayStatus(task).label],
    ["担当の工程終了", `${task.workUnits.filter(u => u.state === "completed").length}件`],
    ["実行中", `${task.workUnits.filter(u => u.state === "running").length}件`],
    ["未着手・再開待ち", `${task.workUnits.filter(u => u.state !== "completed" && u.state !== "running").length}件`]
  ]) {
    const item = progressNode("div", ""); item.append(progressNode("span", label), progressNode("strong", value)); counts.append(item);
  }
  status.append(counts, progressNode("p", "工程終了とゴール達成は別です。条件ごとの判定は「成果・検証」で確認できます。", "progress-meta"));
  const adjustment = taskReviewAdjustment(task);
  if (adjustment) status.append(progressNode("p", `レビューを時間調整：独立${adjustment.mode === "single" ? 1 : 2}回。クロス検証は未実施です。判断理由は「履歴」で確認できます。`, "progress-meta"));
  root.append(status);
  const purpose = progressNode("section", "", "progress-purpose");
  purpose.append(progressNode("h3", "最終目的"));
  const objective = task.goal?.objective ?? task.prompt;
  const shortPurpose = progressNode("p", overviewExcerpt(objective, 180)); shortPurpose.title = objective;
  purpose.append(shortPurpose, progressButton("目的・条件を確認", () => openTaskPanel(task, "goal"))); root.append(purpose);
  const findings = taskCriterionProgress(task).filter(p => p.criterion.required);
  const achieved = findings.filter(p => p.status === "recorded-pass");
  const remaining = findings.filter(p => p.status !== "recorded-pass");
  const resultColumns = progressNode("div", "", "progress-columns");
  const done = progressNode("section", "", "progress-done"); done.append(progressNode("h3", "できたこと"));
  overviewItems(done, achieved.map(p => p.criterion.description), "独立した合格記録はまだありません。担当の報告は「作業報告」で確認できます。");
  if (achieved.length) done.append(progressNode("p", "最新評価時点の記録です。全体の達成確認とは別です。", "progress-meta"));
  const issues = progressNode("section", "", "progress-remaining"); issues.append(progressNode("h3", "重要な残課題"));
  overviewItems(issues, remaining.map(p => `${criterionProgressLabels[p.status]}：${p.criterion.description}`), taskPartialClosure(task)?.finishedAt
    ? "残課題の詳細は「作業報告」で確認してください。" : "必須条件への未確認記録はありません。全体の達成はタスクの状態で確認してください。");
  issues.append(progressButton("根拠・残課題を確認", () => openTaskPanel(task, "evidence")));
  resultColumns.append(done, issues); root.append(resultColumns, buildTaskEfficiencySummary(task));
  // The overview is a work summary, not another copy of the evidence ledger.
  const columns = progressNode("div", "", "progress-columns");
  const now = progressNode("section", "", "progress-current"); now.append(progressNode("h3", "いま行っている作業"));
  const running = task.workUnits.filter(u => u.state === "running");
  if (!running.length) {
    now.append(progressNode("p", taskHasFinishedWorkReport(task) ? "今回の作業は終了しています。" : taskIsActive(task) ? "次の担当の準備・結果確認中です。" : `${taskDisplayStatus(task).label}。実行中の工程はありません。`, "progress-meta"));
    // Stop details and answers already live above the tabs. Do not repeat a
    // possibly stale worker report here after another agent has resolved it.
  }
  for (const unit of running) {
    const row = progressNode("article", "", "progress-work running");
    row.append(progressNode("h4", workUnitTitle(unit)));
    const work = progressWorkDescription(task, unit); if (work) { const body=historyReportBody(work);body.classList.add("work-description");row.append(body); }
    const run = task.runs.filter(r => r.workUnitId === unit.id).at(-1);
    const agent = run?.agentId ?? unit.assignedAgentId;
    row.append(progressNode("p", `${agent ? agentLabel(agent) : "担当の確定待ち"}${run?.model ? ` · ${run.model}` : ""}`, "progress-meta"));
    row.append(progressButton("この担当の端末を開く", () => {
      if (agent) { state.selectedTerminalAgents.set(task.id, agent); if (run) terminalRunSelections.set(terminalKey(task.id, agent), run.id); terminalTiledTasks.delete(task.id); }
      openTaskPanel(task, "execution");
    })); now.append(row);
  }
  const next = progressNode("section", "", "progress-next"); next.append(progressNode("h3", "次の一手"));
  const upcoming = taskUpcomingWork(task);
  for (const { unit, reason } of upcoming.slice(0, 3)) {
    const row = progressNode("article", "", `progress-work ${unit.state}`);
    row.append(progressNode("h4", workUnitTitle(unit)), progressNode("p", reason, "progress-meta")); next.append(row);
  }
  if (!taskIsActive(task)) {
    if (taskUserDecision(task)) next.append(progressNode("p", "上の確認事項に回答してから続けます。回答だけで合格条件は変更しません。"));
    else if (taskHasFinishedWorkReport(task) && (remaining.length || taskPartialClosure(task)?.finishedAt)) {
      next.append(progressNode("p", "残課題を対象に追加作業を依頼できます。完了した成果は引き継ぎ、合格条件は維持します。"));
      next.append(progressButton("残課題を追加指示へ", () => prepareRemainingInstruction(task, remaining.map(p => p.criterion.description))));
    } else next.append(progressNode("p", taskStopGuidance(task).next, "progress-meta"));
  } else if (!upcoming.length) next.append(progressNode("p", "現在の担当の結果を受け、統括役が残りの作業を判断します。", "progress-meta"));
  if (upcoming.length > 3) next.append(progressNode("p", `ほか${upcoming.length - 3}件。全体の順序と担当は「計画・担当」で確認できます。`, "progress-meta"));
  columns.append(now, next); root.append(columns);
  return root;
}

function overviewExcerpt(text: string, max = 130): string {
  const line = reportBulletItems(text)[0] ?? "記録なし";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
function overviewItems(host: HTMLElement, values: string[], empty: string): void {
  if (!values.length) { host.append(progressNode("p", empty, "progress-meta")); return; }
  const list = document.createElement("ul");
  for (const value of values.slice(0, 3)) { const item = progressNode("li", overviewExcerpt(value)); item.title = value; list.append(item); }
  host.append(list);
  if (values.length > 3) host.append(progressNode("p", `ほか${values.length - 3}件。「成果・検証」で全件を確認できます。`, "progress-meta"));
}
function prepareRemainingInstruction(task: TaskRecord, conditions: string[]): void {
  const input = document.querySelector<HTMLTextAreaElement>("#task-detail .followup-composer textarea");
  if (!input) return;
  // Preparation only. Preserve typed/saved text and require an explicit start.
  if (!input.value.trim()) {
    const issues = conditions.length ? conditions : taskPartialClosure(task)?.issues ?? [];
    input.value = `承認済みのゴール・合格条件を維持し、次の残課題を確認して必要な作業を計画・実行してください。完了済みの実装・実験は変更がなければ再利用し、確認不能な項目は未確認のまま報告してください。\n${issues.slice(0, 3).map(s => `- ${s.slice(0, 500)}`).join("\n")}`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.focus(); input.scrollIntoView({ block: "nearest" });
}

function buildTaskEvidence(task: TaskRecord): HTMLElement {
  const root = progressNode("section", "", "task-progress-overview");
  root.append(buildCriterionProgress(task));
  const concerns = new Set((task.evaluations ?? []).filter(e => e.goalRevision === task.goal?.revision && e.round === (task.roundNumber ?? 1) && e.cycle === (task.autonomyCycle ?? 1)).flatMap(e => e.concerns ?? []));
  if (concerns.size) {
    const section = progressNode("section", "", "progress-concerns"); section.append(progressNode("h3", "この修正サイクルで挙がった指摘"));
    section.append(progressNode("p", "解消の判定は最新のレビュー・品質台帳で確認してください。", "progress-meta"));
    const list=document.createElement("ul");for (const concern of concerns) {const item=document.createElement("li");historyInline(item,concern);list.append(item);} section.append(list);root.append(section);
  }
  return root;
}

// Only move a finished result out of the warning area. A new failure, question,
// or interrupted stage must keep its recovery controls above the tabs.
function taskHasFinishedWorkReport(task: TaskRecord): boolean {
  return !task.resumeFromUnitId && !taskUserDecision(task)
    && (task.state === "completed" || (task.state === "awaiting-input" && task.awaitingReason === "result"))
    && task.workUnits.length > 0 && task.workUnits.every(u => u.state === "completed");
}

function buildTaskWorkReport(task: TaskRecord): HTMLElement {
  const root = progressNode("section", "", "task-progress-overview task-work-report");
  root.append(progressNode("h3", "作業報告"));
  const owner = [...task.workUnits].reverse().find(u => u.primary && !u.planPhase && reportedWorkOutcome(u));
  const outcome = reportedWorkOutcome(owner);
  const subject = outcome?.workReport;
  for (const [key, title] of [["proposals", "提案・検討した方法"], ["activities", "実装・実験・分析"], ["results", "得られた結果"], ["interpretation", "結果の解釈"], ["nextSteps", "次の方針"]] as const) {
    if (!subject?.[key].length) continue;
    const section = progressNode("section", "", "work-report-subject");
    section.append(progressNode("h4", title));
    for (const item of subject[key]) section.append(historyReportBody(`- ${item}`));
    root.append(section);
  }
  if (!subject && outcome?.summary) {
    const section = progressNode("section", "", "work-report-subject");
    section.append(progressNode("h4", "担当の作業報告（従来形式）"), historyReportBody(outcome.summary)); root.append(section);
  }
  if (subject?.issues.length) {
    const issues = progressNode("details", "", "work-report-issues");
    issues.append(progressNode("summary", "問題・検証上の留保"));
    for (const item of subject.issues) issues.append(historyReportBody(`- ${item}`));
    root.append(issues);
  }
  if (!taskHasFinishedWorkReport(task)) {
    root.append(progressNode("p", outcome ? "最新の主担当の報告です。作業は継続・停止中で、全体の達成を示すものではありません。" : "実作業の報告はまだありません。提案・実験・結果が提出されるとここに表示します。", "progress-meta"));
    return root;
  }
  const closure = taskPartialClosure(task);
  const result = progressNode("section", "", "work-report-result");
  result.append(progressNode("h4", closure?.finishedAt ? "作業終了 — 未達・未確認事項あり"
    : task.autonomyState === "satisfied" ? "作業終了 — ゴールの達成を確認" : "今回の作業が終了しました"));
  result.append(historyReportBody(closure?.finishedAt
    ? "レポートと独立レビューまで実施し、今回の作業を終了しました。\n全体合格ではありません。未達・未確認事項は以下のとおりです。"
    : "工程の終了とゴールの達成は別です。条件ごとの判定と根拠は「成果・検証」で確認できます。"));
  root.append(result);
  if (closure?.finishedAt) {
    const remaining = progressNode("details", "", "work-report-remaining");
    remaining.append(progressNode("summary", "問題・未確認事項と検証の詳細"));
    for (const issue of [...new Set(closure.issues)]) remaining.append(historyReportBody(issue));
    if (!closure.issues.length) remaining.append(progressNode("p", "残課題の詳細記録はありません。未達項目がないことを意味しません。"));
    root.append(remaining);
  } else {
    const reviews = (task.evaluations ?? []).filter(e => e.goalRevision === task.goal?.revision
      && e.round === (task.roundNumber ?? 1) && e.cycle === (task.autonomyCycle ?? 1));
    for (const review of reviews) {
      const section = progressNode("details", "");
      section.append(progressNode("summary", `独立レビュー${review.reviewerAgentId ? ` · ${agentLabel(review.reviewerAgentId)}` : ""}`), historyReportBody(review.summary));
      root.append(section);
    }
  }
  root.append(historyReportBody("PDFは「レポート」、条件ごとの検証結果は「成果・検証」で確認できます。\n追加の作業を依頼する場合は、下の追加指示欄へ入力してください。"));
  return root;
}

function buildTaskDetailNavigation(task: TaskRecord, selected: TaskPanel): HTMLElement {
  const bar = progressNode("div", "", "task-detail-navigation");
  if (selected === "followup") bar.append(progressButton("← 概要に戻る", () => openTaskPanel(task, "overview")), progressNode("span", "次回の担当・進め方"));
  if (taskPanelGroup(selected) === "evidence") {
    const label = progressNode("label", "表示内容 "); const select = document.createElement("select"); select.setAttribute("aria-label", "成果・検証の表示内容");
    const options: Array<[TaskPanel, string]> = [["evidence", "達成条件・検証結果"]];
    if (task.qualityCycle) options.push(["quality", "品質検査・証拠"]);
    if (task.researchCycle) options.push(["research", "研究候補・実験・証拠"]);
    if (task.workPreset?.manifest.id === "hpc-refactoring") options.push(["hpc", "移行・検証・ジョブ"]);
    for (const [value, title] of options) select.add(new Option(title, value));
    select.value = selected; select.onchange = () => openTaskPanel(task, select.value as TaskPanel); label.append(select); bar.append(label);
  }
  bar.hidden = !bar.childElementCount; return bar;
}
