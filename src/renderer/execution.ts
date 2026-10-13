interface ExecutionPolicy { scheduling?: "balanced" | "throughput"; reviewMode?: "pair" | "cross-service" | "parallel"; reuseContext: boolean; decompose: boolean; maxSubtasks: number; maxParallel: number; tokenBudget?: number; contextTokens?: number; }
interface ExecutionPlan {
  refinement?: { objective: string; proposalKeys: string[]; applicationKey?: string; stopWhen: string };
  coordination?: { criticalPath: string; parallelBenefit: string; contextPlan: string; resourcePlan: string };
  revision: number; round: number; goalRevision: number; createdAt: string; sourceUnitId: string;
  summary: string; reason: string; primaryWork: string; acceptance: string; criterionIds: string[];
  estimatedTokens: number; estimatedMinutes: number; escalation: string;
  tasks: Array<{ kind?: "investigation" | "primary-work" | "isolated-work"; ownedFiles?: string[]; estimatedMinutes?: number; key: string; title: string; instructions: string; deliverable: string; acceptance: string; criterionIds: string[]; dependsOn: string[]; estimatedTokens: number }>;
  primaryUnitId: string; taskUnitIds: Record<string, string>;
}
const executionDefaults: ExecutionPolicy = { reuseContext: true, decompose: true, maxSubtasks: 4, maxParallel: 2, reviewMode: "parallel" };
const executionDrafts = new Map<string, ExecutionPolicy>();
const executionDraftRevisions = new Map<string, number>();
function taskReviewAdjustment(task: TaskRecord) {
  const ids = task.workUnits.filter(u => u.role === "reviewer").map(u => u.id);
  return [...(task.reviewAdjustments ?? [])].reverse().find(a => a.round === (task.roundNumber ?? 1) && a.cycle === (task.autonomyCycle ?? 1)
    && a.goalRevision === task.goal?.revision && a.unitIds.length === (a.mode === "single" ? 1 : 2) && a.unitIds.length === ids.length
    && new Set(a.unitIds).size === ids.length && ids.every(id => a.unitIds.includes(id)) && task.workUnits.filter(u => u.role === "reviewer").every(u => !u.crossReview));
}
let savedExecutionDefaults: ExecutionPolicy = { ...executionDefaults };

function initializeExecutionSettings(defaults?: ExecutionPolicy): void {
  savedExecutionDefaults = { ...(defaults ?? executionDefaults) };
  refreshTaskExecutionDialog();
  renderExecutionSettings();
  renderDispatchExecutionNote();
  api.onExecutionDefaultsChanged(value => { savedExecutionDefaults = { ...value }; renderDispatchExecutionNote(); });
}

function renderDispatchExecutionNote(): void {
  const note = document.getElementById("dispatch-execution-note");
  if (!note) return;
  const remote = !!byId<HTMLSelectElement>("task-remote").value;
  note.textContent = `新規タスクの設定：${savedExecutionDefaults.scheduling === "throughput" ? "効率重視" : "バランス重視"}・最大${remote ? 1 : savedExecutionDefaults.maxParallel}並列。${remote ? "遠隔は安全のため初期値1並列。" : ""}主担当が必要な分担を設計します。PDFと独立レビューを実施します。`;
}

function refreshTaskExecutionDialog(): void {
  const dialog = document.querySelector<HTMLDialogElement>(".task-execution-dialog");
  if (!dialog) return;
  const task = state.tasks.find(t => t.id === dialog.dataset.taskId);
  const fieldset = dialog.querySelector("fieldset");
  if (fieldset) fieldset.disabled = !task || fieldset.dataset.saving === "true";
  const review = dialog.querySelector<HTMLSelectElement>('[aria-label="レビュー方式"]');
  if (review && task) review.disabled = taskIsActive(task) || task.workUnits.some(u => u.role === "reviewer" && task.runs.some(r => r.workUnitId === u.id));
  const status = dialog.querySelector<HTMLElement>(".execution-update-status");
  if (status && task) status.textContent = executionUpdateStatus(task);
  const cancel = dialog.querySelector<HTMLButtonElement>(".execution-update-cancel");
  if (cancel && task) cancel.hidden = !task.pendingExecution;
}

function executionUpdateStatus(task: TaskRecord): string {
  const label = (p?: ExecutionPolicy) => `${p?.scheduling === "throughput" ? "効率重視" : "通常"}・最大${p?.maxParallel ?? 2}並列`;
  return `適用中：${label(task.execution)}。${task.pendingExecution
    ? `変更予約：${label(task.pendingExecution.policy)}。実行中の担当と結果確認が終わった区切りで適用します。`
    : task.executionAppliedAt ? "保存済み。次に起動する担当はこの設定を使います。" : "変更予約はありません。"}`;
}

function renderExecutionSettings(): void {
  byId("execution-settings-editor").replaceChildren(buildExecutionSettings());
}

/** Kept outside the rerendered task panel so resource/task updates cannot erase
 * an in-progress selection. This is preparation, not a command to start work. */
function showInitialCliSettings(task: TaskRecord): void {
  const previous = document.querySelector<HTMLDialogElement>(".initial-cli-dialog");
  if (previous?.open) return;
  previous?.remove(); // A close event may still be queued when reopened quickly.
  const dialog = document.createElement("dialog"); dialog.className = "restart-dialog initial-cli-dialog";
  dialog.setAttribute("aria-label", "開始時のCLIを設定");
  const title = document.createElement("h3"); title.textContent = "開始時のCLIを設定";
  const note = document.createElement("p"); note.textContent = "ゴール承認後の本作業で、最初の工程に使うCLIを指定します。AIのゴール案作成や起動済みの端末は変更しません。以後の専門担当・レビューは既存の割り当て方針に従います。保存だけでは開始しません。";
  const initial = task.initialAssignment?.round === (task.roundNumber ?? 1) ? task.initialAssignment : undefined;
  const form = document.createElement("div"); form.className = "initial-cli-fields";
  const cliLabel = document.createElement("label"); cliLabel.textContent = "CLI";
  const cli = document.createElement("select"); cli.setAttribute("aria-label", "開始時のCLI");
  cli.add(new Option("既存の担当設定に従う（未指定なら自動）", ""));
  for (const id of task.allowedAgentIds.filter(id => id !== "gemini")) {
    const policy = state.orchestrationSettings?.agentPolicies.find(p => p.agentId === id);
    cli.add(new Option(`${agentLabel(id)}${policy?.enabled === false ? "（利用OFF）" : ""}`, id));
  }
  cli.value = initial?.agentId ?? ""; cliLabel.append(cli);
  const modelLabel = document.createElement("div");
  const modelTitle = document.createElement("span"); modelTitle.textContent = "モデル";
  const model = document.createElement("input"); model.value = initial?.model ?? ""; model.disabled = !cli.value;
  let picker = modelPicker((cli.value || "codex") as AgentId, model, "タスク／システム設定に従う", false);
  modelLabel.append(modelTitle, picker);
  cli.onchange = () => {
    model.value = ""; model.disabled = !cli.value;
    const next = modelPicker((cli.value || "codex") as AgentId, model, "タスク／システム設定に従う", false);
    picker.replaceWith(next); picker = next;
  };
  const fallbackLabel = document.createElement("label"); fallbackLabel.className = "followup-check";
  const fallback = document.createElement("input"); fallback.type = "checkbox"; fallback.checked = initial?.allowFallback ?? true;
  fallback.setAttribute("aria-label", "開始CLIが使用不可なら代替CLIを許可"); fallbackLabel.append(fallback, "使用できない場合は、許可済みの別CLIを使う");
  form.append(cliLabel, modelLabel, fallbackLabel);
  const error = document.createElement("p"); error.className = "form-error"; error.setAttribute("role", "alert");
  const actions = document.createElement("div"); actions.className = "detail-actions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-button"; cancel.textContent = "キャンセル";
  const save = document.createElement("button"); save.type = "button"; save.className = "primary-button"; save.textContent = "保存";
  let saving = false;
  cancel.onclick = () => dialog.close();
  dialog.addEventListener("cancel", e => { if (saving) e.preventDefault(); });
  save.onclick = async () => {
    if (saving) return; saving = true; error.textContent = "";
    save.disabled = cancel.disabled = cli.disabled = fallback.disabled = true;
    try {
      const input: RoleAssignment = { agentId: (cli.value || undefined) as AgentId | undefined, model: model.value || undefined, allowFallback: fallback.checked };
      const saved = await api.configureInitialCli(task.id, input, task.updatedAt);
      state.tasks = state.tasks.map(t => t.id === saved.id ? saved : t);
      dialog.close(); renderTasks(); renderDetail(); showToast("開始時のCLI設定を保存しました。");
    } catch (e) { error.textContent = errorMessage(e); }
    finally { saving = false; save.disabled = cancel.disabled = cli.disabled = fallback.disabled = false; }
  };
  dialog.addEventListener("close", () => dialog.remove());
  actions.append(cancel, save); dialog.append(title, note, form, error, actions); document.body.append(dialog); dialog.showModal();
}

function showTaskExecutionSettings(task: TaskRecord): void {
  if (document.querySelector(".task-execution-dialog")) return;
  const dialog = document.createElement("dialog"); dialog.className = "restart-dialog task-execution-dialog"; dialog.dataset.taskId = task.id;
  dialog.setAttribute("aria-label", "このタスクの実行戦略");
  const heading = document.createElement("h2"); heading.textContent = `実行戦略 · ${task.title}`;
  const close = document.createElement("button"); close.type = "button"; close.textContent = "閉じる"; close.className = "secondary-button compact";
  close.onclick = () => dialog.close(); dialog.addEventListener("close", () => dialog.remove());
  dialog.append(heading, buildExecutionSettings(task), close); document.body.append(dialog); dialog.showModal();
}
const planExpansion = new Map<string, boolean>();
const workCardExpansion = new Map<string, boolean>();

function buildOrchestratorStatus(task: TaskRecord): HTMLElement | undefined {
  if (task.workflowMode !== "primary" || !task.execution?.decompose) return;
  const decisions = (task.orchestratorDecisions ?? []).filter(d => d.round === (task.roundNumber ?? 1));
  const status = document.createElement("div"); status.className = "orchestrator-status";
  const label = document.createElement("strong");
  label.textContent = `統括判断 · ${decisions.some(d => d.status === "deciding") ? "未着手の作業を確認中" : !taskIsActive(task) ? "待機" : decisions.length >= 3 ? "判断上限・既存計画を継続" : "完了結果を待機中"}`;
  const note = document.createElement("span");
  note.textContent = `判断 ${decisions.length}/3回 · 追加 ${decisions.reduce((n, d) => n + d.addedUnitIds.length, 0)}/${task.execution.maxSubtasks}件 · 待機中のLLM呼び出しなし`;
  status.append(label, note);
  if (decisions.length) {
    const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "配分の判断・理由"; details.append(summary);
    const key = `${task.id}:${task.roundNumber ?? 1}:orchestrator`;
    details.open = planExpansion.get(key) ?? false;
    details.addEventListener("toggle", () => { if (details.isConnected) planExpansion.set(key, details.open); });
    for (const d of decisions) {
      const row = document.createElement("p");
      row.textContent = `${d.status === "adjusted" ? `${d.refinements?.length ?? 0}件へ指示補足・${d.addedUnitIds.length}件追加` : d.status === "added" ? `${d.addedUnitIds.length}件を追加` : d.status === "waiting" ? "既存計画を継続" : d.status === "skipped" ? "判断見送り" : "判断中"}：${d.reason}`;
      details.append(row);
    }
    status.append(details);
  }
  return status;
}

function buildExecutionPlanView(task: TaskRecord): HTMLElement {
  const section = document.createElement("section"); section.className = "execution-plan-view";
  const text = (tag: string, value: string, parent: HTMLElement = section) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
  const prose = (value: string, parent: HTMLElement) => { const body=historyReportBody(value);body.classList.add("work-description");parent.append(body); };
  text("h3", "実行計画・体制");
  const instructionsButton = document.createElement("button"); instructionsButton.type = "button";
  instructionsButton.textContent = "指示書の全文表示・TXT書き出し";
  instructionsButton.onclick = () => showTaskInstructions(task.id);
  section.append(instructionsButton);
  if (!taskIsActive(task) && !task.goalPreparation && task.goal?.status === "approved" && task.executionPlans?.length
    && ["paused", "blocked", "failed", "cancelled", "awaiting-input"].includes(task.state)) {
    const repair = progressButton("担当・スキルの配置を修復…", () => void showAssignmentRecovery(task));
    repair.title = "計画で要求されたCLI・モデル系統・スキルの配置を修復します。通常の担当変更は「次回の担当・進め方」を使います。";
    section.append(repair);
  }
  const coordinator = buildOrchestratorStatus(task);
  if (coordinator) section.append(coordinator);
  const plans = task.executionPlans ?? [];
  const latest = plans.at(-1);
  const current = latest?.round === (task.roundNumber ?? 1) && latest?.goalRevision === task.goal?.revision ? latest : undefined;
  if (current) {
    text("p", `現在の方針：${current.summary}`);
    if (current.coordination || current.refinement) {
      const strategy = document.createElement("details"); strategy.className = "execution-plan-strategy";
      const key = `${task.id}:${current.revision}:strategy`;
      strategy.open = planExpansion.get(key) ?? false;
      strategy.addEventListener("toggle", () => { if (strategy.isConnected) planExpansion.set(key, strategy.open); });
      text("summary", "分担・作業効率の戦略", strategy);
      if (current.coordination) for (const [key, label] of [["criticalPath", "完了までの依存関係"], ["parallelBenefit", "並列化の効果"], ["contextPlan", "文脈・引き継ぎ"], ["resourcePlan", "サービス・予算配分"]] as const) text("p", `${label}：${current.coordination[key]}`, strategy);
      if (current.refinement) {
        const r = current.refinement, title = (key: string) => current.tasks.find(t => t.key === key)?.title ?? key;
        const list = document.createElement("ul");
        text("li", `内容改善の焦点：${r.objective}`, list);
        text("li", r.proposalKeys.length ? `改善案の担当：${r.proposalKeys.map(title).join(" ／ ")} → ${r.applicationKey ? title(r.applicationKey) : "主担当の統合・評価"}` : "主担当が代案・弱点を点検し、実作業と評価へ反映", list);
        text("li", `追加探索を区切る目安：${r.stopWhen}`, list);
        strategy.append(list);
      }
      section.append(strategy);
    }
    text("p", "依存先が完了した作業から随時開始。主担当の書き込み工程は、共有ファイル保護のため単独で実行します。").className = "plan-muted";
    text("p", `第${current.revision}版 · 修正サイクル${task.autonomyCycle ?? 1} · 作業単位ごとに担当を表示`).className = "plan-muted";
  }
  if (!plans.length) text("p", task.workUnits.some(u => u.ideaPhase) ? "ゴール承認後、着想検討の結果を主担当へ引き継ぎ、調査・実装と評価・論文執筆の計画を作ります。" : task.goal?.status === "draft" ? "ゴールを承認して実行すると、最初に主担当が計画を作ります。" : "実行計画はまだありません。新しい主担当方式の実行時に作成します。既存の工程は変更しません。");
  const allUnits = [...task.workUnits, ...(task.retiredWorkUnits ?? []), ...(task.history ?? []).flatMap(h => h.workUnits), ...(task.autonomyHistory ?? []).flatMap(h => h.workUnits)];
  // Topological layers describe eligibility, not a promise that every sibling
  // runs concurrently. Only independent read-only specialists are placed side by side.
  const remaining = [...task.workUnits], ordered: WorkUnit[] = [];
  const groups: WorkUnit[][] = [];
  while (remaining.length) {
    const layer = remaining.filter(u => u.dependsOn.every(id => !remaining.some(v => v.id === id)));
    if (!layer.length) { groups.push(...remaining.map(u => [u])); ordered.push(...remaining); break; }
    const parallel = layer.filter(u => (!!u.subtask || !!u.crossReview) && u.mode === "read");
    for (const u of layer) {
      if (parallel.length > 1 && parallel.includes(u)) {
        if (u === parallel[0]) { groups.push(parallel); ordered.push(...parallel); }
      } else { groups.push([u]); ordered.push(u); }
      remaining.splice(remaining.indexOf(u), 1);
    }
  }
  const numberFor = (id: string) => {
    const i = ordered.findIndex(u => u.id === id);
    return i < 0 ? allUnits.find(u => u.id === id)?.title ?? "過去の作業" : String(i + 1).padStart(2, "0");
  };
  const cards = document.createElement("div"); cards.className = "execution-work-list"; section.append(cards);
  const cardFor = (unit: WorkUnit, parent: HTMLElement) => {
    const repair = repairWorkPresentation(task, unit);
    const plan = [...plans].reverse().find(p => p.primaryUnitId === unit.id || Object.values(p.taskUnitIds).includes(unit.id));
    const member = plan?.tasks.find(m => plan.taskUnitIds[m.key] === unit.id);
    const primary = !unit.planPhase && plan?.primaryUnitId === unit.id;
    const runs = task.runs.filter(r => r.workUnitId === unit.id && !r.goalPreparation);
    const run = runs.at(-1);
    // Failed attempts may be from a different CLI than the next assignment.
    const agent = unit.assignedAgentId ?? (unit.state !== "pending" ? run?.agentId : undefined);
    const model = unit.state !== "pending" && agent && run?.agentId === agent ? run.model : undefined;
    const role = unit.orchestrator ? "統括役" : unit.ideaPhase ? "着想検討担当" : unit.planPhase ? "計画担当" : unit.primaryStep ? "主担当の実作業（単独実行）" : unit.subtask?.kind === "isolated-work" ? "実装担当（分離作業）" : unit.subtask ? "専門担当" : unit.primary ? "主担当" : ({ planner:"プランナー", worker:"ワーカー", reporter:"レポーター", reviewer:"レビュワー" }[unit.role]);
    const place = unit.orchestrator ? "local" : unit.state !== "pending" && run?.executionLocation ? run.executionLocation
      : task.remote ? "remote" : "local";
    const waiting = unit.dependsOn.filter(id => task.workUnits.find(u => u.id === id)?.state !== "completed");
    const title = repair ? "レビュー指摘への対応・再検証" : member?.title ?? (primary ? plan!.primaryWork.split("\n")[0] : unit.role === "reporter" ? "レポートを整え、PDFを全ページ確認" : unit.title);
    const card = document.createElement("details"); card.className = `execution-work-card ${unit.state}`; card.dataset.unitId = unit.id;
    const key = `${task.id}:${unit.id}:${unit.state}`;
    card.open = workCardExpansion.get(key) ?? unit.state === "running";
    card.addEventListener("toggle", () => { if (card.isConnected) workCardExpansion.set(key, card.open); });
    const summary = document.createElement("summary"); card.append(summary);
    text("span", numberFor(unit.id), summary).className = "work-card-number";
    const heading = document.createElement("span"); summary.append(heading);
    text("span", title.length > 100 ? title.slice(0, 100) + "…" : title, heading).className = "work-card-title";
    text("span", `${agent ? agentLabel(agent) : "CLI自動割当"}${model ? ` / ${model}` : ""} · ${role} · ${place === "local" ? "このMac" : "遠隔"}`, heading).className = "work-card-meta";
    text("span", `${unit.state === "running" ? "● " : ""}${unit.state === "pending" && waiting.length ? waiting.map(numberFor).join("・") + "待ち" : unitStatusLabel(task, unit)}`, summary).className = "work-card-state";
    const body = document.createElement("div"); body.className = "work-card-body"; card.append(body);
    const fields = document.createElement("dl"); body.append(fields);
    const field = (label: string, value?: string) => { if (value) {
      text("dt", label, fields); const entry=text("dd", "", fields);
      const content=historyReportBody(value);content.classList.add("work-description");entry.append(content);
    } };
    if (run?.skillUsage) field("スキル取得", `${run.skillUsage.reads.map(s => `${s.id}@${s.revision.slice(0, 8)} ×${s.calls}`).join("、")} · 本文の推定 ${run.skillUsage.estimatedTokens.toLocaleString()} tokens（課金実測・適用済みの証明ではありません）${run.skillUsage.truncated ? " · 記録上限到達" : ""}`);
    const decision = task.orchestratorDecisions?.find(d => d.id === (unit.allocatedBy ?? unit.id));
    if (decision) field(unit.orchestrator ? "統括判断の理由" : "追加配分の理由", decision.reason);
    if (unit.subtask?.purpose) field("分担の目的", ({speed:"時間短縮",balance:"サービス負荷の分散",verify:"独立検証・品質向上",explore:"別案・反例の探索"})[unit.subtask.purpose]);
    if (unit.subtask?.kind === "isolated-work") {
      field("実装方式", "分離したGit作業領域で実装。担当の終了と共有成果への統合・合格判定は別です。");
      field("担当ファイル", (unit.subtask.ownedFiles ?? []).join("\n"));
    }
    for (const note of unit.coordinationNotes ?? []) field("完了結果を受けた指示補足", note.note);
    const roleWork = unit.crossReview?.aggregate ? "全AIの独立判定を整理し、食い違いと少数意見を含めて根拠を確認する。修正が必要な点を主担当へ返す。" : unit.crossReview?.wave === 2 ? "他サービスの独立判定を成果物・証拠と照合し、指摘の妥当性とゴール全体を検証する。"
      : unit.role === "reporter" ? "執筆ルールで全文を確認し、TeXをビルドしてPDFの全ページを確認する。"
      : unit.role === "reviewer" ? "実際の成果物と検証証拠から、ゴールの達成条件を独立して判定する。" : undefined;
    field("作業", repair?.work ?? (primary ? plan!.primaryWork : member?.instructions ?? roleWork ?? unit.instructions.split("\n")[0]));
    if (unit.crossReview) {
      field("担当サービス", unit.crossReview.aggregate ? unit.assignedAgentId ?? "利用可能なCLIから自動選択（新規会話）" : unit.crossReview.providerKey);
      field("判定の受け渡し", unit.crossReview.wave === 1 ? "他サービスの判定は見ずに独立して提出" : unit.crossReview.sourceUnitIds.map(id => task.workUnits.find(u => u.id === id)?.title ?? id).join("\n"));
    }
    if (repair) {
      field("未達条件", repair.conditions);
      field("追加検討", repair.concerns);
      field("差戻し指示", repair.instructions);
    }
    field("成果物", member?.deliverable ?? unit.subtask?.deliverable ?? (unit.ideaPhase ? "仮説・候補比較・推奨理由・反証条件・最小検証案（主担当への引継ぎ）" : unit.role === "reporter" ? "TeX・PDF・確認用ページ画像" : unit.role === "reviewer" ? "達成条件の判定・根拠・修正が必要な事項" : undefined));
    field("完了条件", primary ? plan!.acceptance : member?.acceptance ?? unit.subtask?.acceptance ?? (unit.role === "reporter" ? "執筆ルールの完了確認と、必要なPDFの検証を通過する。" : unit.crossReview ? "全独立判定と統括・クロス検証が揃い、必要条件が合格し、未解決事項がないこと。指摘が残れば作業担当へ戻す。" : unit.role === "reviewer" ? "必要条件の合格と未解決事項がないことを確認する。タスク完了候補には別CLIで2回連続の合格が必要。" : undefined));
    field("停止理由", unit.error);
    if(unit.subtask?.capability) field("重視する能力", {reasoning:"総合・推論（参考指標）",coding:"コーディング",agentic:"ツール利用・自律実行",speed:"速度（定型・低リスク作業）"}[unit.subtask.capability]);
    const successors = task.workUnits.filter(u => u.dependsOn.includes(unit.id));
    text("p", `受け取る：${unit.dependsOn.map(numberFor).join("・") || "承認済みのゴール・指示"} → 渡す：${successors.map(u => numberFor(u.id)).join("・") || "結果の確認"}`, body).className = "work-card-handoff";
    if (unit.role === "reviewer") text("p", unit.crossReview ? "不合格・未解決事項がある場合は、全判定の統合後に主担当へ差し戻します。修正後は新たな独立レビューで確認します。" : "不合格・追加検討事項がある場合は修正作業へ差し戻し、連続合格数をリセットします。", body).className = "plan-muted";
    const detail = document.createElement("details"); detail.className = "work-card-extra"; body.append(detail);
    detail.open = workCardExpansion.get(`${key}:extra`) ?? false;
    detail.addEventListener("toggle", () => { if (detail.isConnected) workCardExpansion.set(`${key}:extra`, detail.open); });
    text("summary", `詳細指示・見積り・実行履歴（${runs.length}回）`, detail);
    text("p", unit.instructions, detail);
    const tokens = primary ? plan?.estimatedTokens : member?.estimatedTokens ?? unit.subtask?.estimatedTokens;
    if (tokens) text("p", `${tokens.toLocaleString()} tokens（推定）${primary ? ` · 目安${plan!.estimatedMinutes}分（超過可）` : ""}`, detail);
    if (unit.assignmentReason) text("p", `割当理由：${unit.assignmentReason}`, detail);
    const ids = primary ? plan?.criterionIds : member?.criterionIds ?? unit.subtask?.criterionIds;
    if (ids?.length) text("p", `達成条件：${ids.map(id => task.goal?.criteria.find(c => c.id === id)?.description ?? id).join(" / ")}`, detail);
    for (const attempt of runs) text("p", `${agentLabel(attempt.agentId)}${attempt.model ? ` / ${attempt.model}` : ""} · ${attempt.state} · ${attempt.startedAt ?? "時刻不明"}${attempt.error ? ` · ${attempt.error}` : ""}`, detail);
    parent.append(card);
  };
  for (const group of groups) {
    if (group.length === 1) cardFor(group[0], cards);
    else {
      text("p", `${group[0].crossReview ? group[0].crossReview.aggregate ? "全独立判定を統括・根拠確認" : group[0].crossReview.wave === 1 ? "各サービスの独立レビュー" : "他サービスの判定をクロス検証" : "独立した調査・検証"}（並行実行可能／上限${task.execution?.maxParallel ?? 1}件）`, cards).className = "plan-muted";
      const row = document.createElement("div"); row.className = "execution-work-parallel"; cards.append(row);
      group.forEach(u => cardFor(u, row));
    }
  }
  const history = document.createElement("details"); history.className = "execution-plan-history";
  const historyKey = `${task.id}:history`; history.open = planExpansion.get(historyKey) ?? false;
  history.addEventListener("toggle", () => { if (history.isConnected) planExpansion.set(historyKey, history.open); });
  text("summary", "計画の変更履歴・撤回した作業", history); section.append(history);
  for (const plan of [...plans].reverse()) {
    const panel = document.createElement("details"); const key = `${task.id}:${plan.round}:${plan.revision}`;
    panel.open = planExpansion.get(key) ?? false; panel.className = "execution-plan-version"; history.append(panel);
    panel.addEventListener("toggle", () => { if (panel.isConnected) planExpansion.set(key, panel.open); });
    text("summary", `第${plan.revision}版 · ラウンド${plan.round} · ${plan === plans.at(-1) && plan.round === (task.roundNumber ?? 1) && plan.goalRevision === task.goal?.revision ? "現在の計画" : "履歴"} · 主担当＋専門担当${plan.tasks.length}件`, panel);
    prose(plan.summary, panel); prose(`変更理由：${plan.reason}`, panel);
    text("p", `残り作業目安：${plan.estimatedMinutes}分（超過可） · 主担当 ${plan.estimatedTokens.toLocaleString()} tokens ＋ 分担 ${plan.tasks.reduce((n, t) => n + t.estimatedTokens, 0).toLocaleString()} tokens（推定、PDF・最終レビューは別枠）`, panel);
    const primary = document.createElement("article"); primary.className = "execution-plan-member"; panel.append(primary);
    text("h4", "主担当の計画内容", primary);
    prose(plan.primaryWork, primary); prose(`検証：${plan.acceptance}`, primary);
    const criteria = (ids: string[]) => ids.map(id => task.goal?.criteria.find(c => c.id === id)?.description ?? id).join(" / ");
    text("p", `達成条件：${criteria(plan.criterionIds)}`, primary);
    for (const member of plan.tasks) {
      const card = document.createElement("article"); card.className = "execution-plan-member"; panel.append(card);
      text("h4", `${member.title}${task.retiredWorkUnits?.some(u => u.id === plan.taskUnitIds[member.key]) ? " · 再計画で撤回" : ""}`, card);
      prose(member.instructions, card); prose(`成果物：${member.deliverable}`, card); prose(`検証：${member.acceptance}`, card);
      text("p", `達成条件：${criteria(member.criterionIds)} · ${member.estimatedTokens.toLocaleString()} tokens（推定）`, card);
      text("p", `前提：${member.dependsOn.map(k => plan.tasks.find(t => t.key === k)?.title ?? k).join(" / ") || "計画確定後に開始"}`, card);
    }
    text("p", `ユーザへの確認条件：${plan.escalation}`, panel);
    text("p", "終了工程：TeX・PDFビルド → 独立した最終レビュー（計画変更でも省略しません）", panel);
  }
  return section;
}

// Goal approval shares this draft with the regular editor, but saves it together
// with the goal actions so there is no second, easily missed Save button.
async function saveGoalExecutionDraft(taskId: string): Promise<void> {
  const task = state.tasks.find(t => t.id === taskId);
  const draft = executionDrafts.get(taskId);
  if (!task || !draft) return;
  if (JSON.stringify(draft) === JSON.stringify(task.pendingExecution?.policy ?? task.execution ?? executionDefaults)) return;
  const saved = await api.configureExecution(taskId, structuredClone(draft), executionDraftRevisions.get(taskId) ?? task.executionRevision ?? 0);
  state.tasks = state.tasks.map(t => t.id === saved.id ? saved : t);
  executionDrafts.delete(taskId); executionDraftRevisions.delete(taskId);
}

function buildExecutionSettings(task?: TaskRecord, inlineApproval = false): HTMLElement {
  const section = document.createElement("section"); section.className = "execution-settings";
  const key = task?.id ?? "defaults";
  const summary = document.createElement("p"); summary.className = "execution-scope-note";
  summary.textContent = task ? `このタスクだけに適用します。実行中の変更は予約し、現在の担当が全員終了した区切りから反映します。端末を止めず、既存計画の依存関係や完了済み作業は変えません。分担数・分担ON/OFFは次の計画に反映します。レビュー方式は実行中・開始済みには変更できません。${task.remote ? "遠隔タスクです。施設の同時実行制限を確認してください。" : ""}` : "今後作成するタスクの初期設定です。既存タスク・やり直しには自動反映しません。遠隔タスクの同時実行数は安全のため初期値1に制限します。";
  if (inlineApproval) summary.textContent = "このタスクの進め方です。下の「下書きを保存」または「ゴールを承認してキューへ」で一緒に保存します。";
  section.append(summary);
  const timing = document.createElement("p"); timing.textContent = (task ? taskReviewAdjustment(task)?.reason : undefined) ?? "作業目安時間がある場合、レビュー開始前に残り時間を確認し、必要に応じて2回または1回の独立レビューへ軽量化します。必須条件の検証・問題の修正は省略せず、開始済みレビューは打ち切りません。"; section.append(timing);
  if (task && !inlineApproval) {
    const status = document.createElement("p"); status.className = "execution-update-status"; status.setAttribute("role", "status"); status.textContent = executionUpdateStatus(task); section.append(status);
    const reload = document.createElement("button"); reload.type = "button"; reload.textContent = "保存済みの設定を読み直す"; reload.className = "secondary-button compact";
    reload.onclick = () => { if (section.querySelector('fieldset[data-saving="true"]')) return; executionDrafts.delete(key); executionDraftRevisions.delete(key); section.replaceWith(buildExecutionSettings(state.tasks.find(t=>t.id===task.id)!)); };
    section.append(reload);
  }
  const note = document.createElement("p"); note.textContent = "品質と完了までの速さを優先します。主担当は継続し、他サービスへ実装・検証・独立案を有益な範囲で委任します。共有ファイルの同時編集は避け、分離実装には専用の作業領域を使います。総トークン数は記録のみで起動を制限しません。各サービスの使用枠と安全条件は確認します。";
  // Settings have one disclosure level. Task-specific controls retain their
  // existing compact disclosure outside the system settings screen.
  const advanced = document.createElement(task ? "details" : "section"); advanced.className = "execution-advanced";
  const advancedTitle = document.createElement(task ? "summary" : "h3"); advancedTitle.textContent = inlineApproval ? "詳細：分担・会話・自動修正" : "詳細：分担・会話の引き継ぎ";
  advanced.append(advancedTitle, note);
  const draft = executionDrafts.get(key) ?? { ...(task ? task.pendingExecution?.policy ?? task.execution ?? executionDefaults : savedExecutionDefaults) };
  if (!executionDraftRevisions.has(key)) executionDraftRevisions.set(key, task?.executionRevision ?? 0);
  const revision = executionDraftRevisions.get(key)!;
  executionDrafts.set(key, draft);
  const fields = document.createElement("fieldset");
  const schedulingLabel = document.createElement("label"); schedulingLabel.textContent = "割り当て方針";
  const scheduling = document.createElement("select"); scheduling.setAttribute("aria-label", "割り当て方針");
  scheduling.add(new Option("通常 · 文脈・使用枠のバランス", "balanced")); scheduling.add(new Option("効率重視 · 複数サービス", "throughput")); scheduling.value = draft.scheduling ?? "balanced";
  const reviewLabel = document.createElement("label"); reviewLabel.textContent = "レビュー方式";
  const review = document.createElement("select"); review.setAttribute("aria-label", "レビュー方式");
  review.add(new Option("並列レビュー＋統括", "parallel")); review.add(new Option("異なるCLIで2回連続レビュー", "pair")); review.add(new Option("全サービスのクロスレビュー", "cross-service")); review.value = draft.reviewMode ?? "pair";
  review.disabled = Boolean(task && (taskIsActive(task) || task.workUnits.some(u => u.role === "reviewer" && task.runs.some(r => r.workUnitId === u.id))));
  scheduling.onchange = () => { draft.scheduling = scheduling.value as ExecutionPolicy["scheduling"]; if (draft.scheduling === "throughput") { draft.decompose = true; if (!review.disabled) { draft.reviewMode = "parallel"; review.value = "parallel"; } const check = fields.querySelector<HTMLInputElement>('[aria-label="必要な場合は成果物単位に分担する"]'); if (check) check.checked = true; } };
  review.onchange = () => { draft.reviewMode = review.value as ExecutionPolicy["reviewMode"]; };
  schedulingLabel.append(scheduling); reviewLabel.append(review); fields.append(schedulingLabel, reviewLabel);
  const help = document.createElement("p"); help.textContent = "並列レビューは別サービスが独立に確認し、1担当が結果を統合します。最大1並列なら順番に実行します。利用可能なサービスが2つ未満なら待機します。実作業の分担は主担当が判断します。";
  for (const [key, text] of [["reuseContext", "主担当の保存済み会話を引き継ぐ（Codex / Claude Code）"], ["decompose", "必要な場合は成果物単位に分担する"]] as const) {
    const label = document.createElement("label"); label.className = "followup-check";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = draft[key]; input.setAttribute("aria-label", text);
    input.addEventListener("change", () => { draft[key] = input.checked; }); label.append(input, text); advanced.append(label);
  }
  for (const [key, text, min, max] of [["maxSubtasks", "最大分担数", 1, 8], ["maxParallel", "最大同時実行数", 1, 8], ["contextTokens", "会話を切り替える文脈量の目安（推定）", 4000, 200000]] as const) {
    const label = document.createElement("label"); label.textContent = text;
    if (key === "maxSubtasks" || key === "maxParallel") {
      label.className = "execution-count-setting";
      const count = document.createElement("select"); count.setAttribute("aria-label", text);
      for (let value = min; value <= max; value++) count.add(new Option(`${value}${key === "maxParallel" ? " 並列" : " 分担"}`, String(value)));
      count.value = String(draft[key]);
      count.addEventListener("change", () => { draft[key] = Number(count.value); });
      label.append(count); (key === "maxSubtasks" ? advanced : fields).append(label);
      continue;
    }
    const input = document.createElement("input"); input.type = "number"; input.min = String(min); input.max = String(max); input.step = "1"; input.value = String(draft[key] ?? ""); input.setAttribute("aria-label", text);
    input.addEventListener("input", () => { draft[key] = input.value ? Number(input.value) : undefined; }); label.append(input); (key === "contextTokens" ? advanced : fields).append(label);
    if (key === "contextTokens") {
      enhanceSettingsSlider(input, { title: text, min, max, unit: "tokens", optional: true, logarithmic: true });
    }
    if (key === "contextTokens") {
      input.placeholder = "未指定";
      const hint = document.createElement("small"); hint.textContent = "未指定の場合、文脈量を理由に会話を切り替えません。レビューの独立性やCLI自体のコンテキスト上限は変わりません。"; label.append(hint);
    }
  }
  advanced.append(help); fields.append(advanced);
  const save = document.createElement("button"); save.type = "button"; save.className = "secondary-button compact"; save.textContent = task ? "保存して次の工程から反映" : "戦略設定を保存";
  const error = document.createElement("p"); error.className = "form-error"; error.setAttribute("role", "alert");
  save.addEventListener("click", async () => {
    save.disabled = true; fields.disabled = true; fields.dataset.saving = "true"; error.textContent = "";
    try {
      if (task) {
        const saved = await api.configureExecution(task.id, structuredClone(draft), revision);
        state.tasks = state.tasks.map(t => t.id === saved.id ? saved : t);
      } else savedExecutionDefaults = await api.updateExecutionDefaults(structuredClone(draft));
      executionDrafts.delete(key);
      executionDraftRevisions.delete(key);
      if (task) section.replaceWith(buildExecutionSettings(state.tasks.find(t => t.id === task.id)!));
      else { renderExecutionSettings(); renderDispatchExecutionNote(); }
      const current = task && state.tasks.find(t=>t.id===task.id);
      showToast(current ? current.pendingExecution ? "変更を予約しました。現在の担当はそのまま続行し、次の工程から反映します。" : "戦略を保存しました。停止中タスクは自動再開しません。" : "新規タスクの既定値を保存しました。既存タスクは変更していません。");
    } catch (caught) { error.textContent = errorMessage(caught); } finally { save.disabled = false; fields.disabled = false; delete fields.dataset.saving; }
  });
  if (!inlineApproval) fields.append(save, error);
  section.append(fields);
  if (task && !inlineApproval) {
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-button compact execution-update-cancel"; cancel.textContent = "変更予約を取り消す"; cancel.hidden = !task.pendingExecution;
    cancel.onclick = async () => {
      if (fields.dataset.saving === "true") return;
      const current = state.tasks.find(t=>t.id===task.id); if (!current?.pendingExecution) return;
      cancel.disabled = true;
      try {
        const saved = await api.configureExecution(task.id, current.execution ?? executionDefaults, current.executionRevision ?? 0);
        state.tasks = state.tasks.map(t=>t.id===saved.id?saved:t); executionDrafts.delete(key); executionDraftRevisions.delete(key);
        section.replaceWith(buildExecutionSettings(saved)); showToast("変更予約を取り消しました。適用中の設定を維持します。");
      } catch (e) { error.textContent = errorMessage(e); } finally { cancel.disabled = false; }
    };
    section.append(cancel);
  }
  return section;
}
function executionDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function buildExecutionMetrics(task: TaskRecord): HTMLElement {
  const bar = document.createElement("div"); bar.className = "execution-metrics";
  bar.setAttribute("aria-label", "今回の作業時間・モデル別トークン使用量");
  const metrics = task.executionMetrics;
  const timer = document.createElement("span"); timer.className = "execution-elapsed";
  timer.dataset.taskId = task.id;
  timer.textContent = `経過時間 ${metrics ? executionDuration(metrics.elapsedMs) : "未取得"}`;
  timer.title = "今回の作業の実行時間。ゴール作成・工程間の承認待ち・一時停止時間は除外し、並列実行は重複計上しません。CLI内部の対話待ちがハーネスへ通知されない場合、その時間は含まれます。";
  bar.append(timer);
  if (task.autonomy?.targetMinutes) {
    const target = document.createElement("span"); target.textContent = `目安 ${task.autonomy.targetMinutes}分`;
    bar.append(target);
  }
  const models = document.createElement("div"); models.className = "execution-models";
  const labels: Record<string,string> = {codex:"Codex",claude:"Claude Code",antigravity:"Antigravity",opencode:"OpenCode"};
  for (const item of metrics?.models ?? []) {
    const tokens = document.createElement("span"); tokens.className = "execution-tokens";
    const label = document.createElement("span"); label.className = "execution-model-name";
    label.textContent = item.model ? /^(?:opus|sonnet|haiku)$/i.test(item.model) ? `${item.model}（版未取得）` : item.model : `${labels[item.agentId] ?? item.agentId} · モデル名未取得`;
    const value = document.createElement("span");
    value.textContent = item.usage.source === "reported"
      ? `${compactTokenCount((item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0))} tokens${item.measuredRuns < item.totalRuns ? "（一部）" : ""}`
      : "トークン未取得";
    tokens.title = `${labels[item.agentId] ?? item.agentId}の起動時モデル別集計。合計 ${((item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0)).toLocaleString()} tokens・入力 ${(item.usage.inputTokens ?? 0).toLocaleString()} / 出力 ${(item.usage.outputTokens ?? 0).toLocaleString()}（${item.measuredRuns}/${item.totalRuns}実行取得）。キャッシュ入力は入力に含めます。契約使用率や課金額ではありません。応答・工程終了時に更新し、未取得分は0とみなしません。CLI内部のモデル切替・子セッションを区別できない場合があります。`;
    tokens.append(label,value); models.append(tokens);
  }
  if (!models.childElementCount) models.textContent = "トークン：実行開始後にモデル別に表示";
  bar.append(models); return bar;
}

function compactTokenCount(tokens: number): string {
  return tokens >= 10000 ? `${(tokens / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}万` : tokens.toLocaleString("ja-JP");
}

/** Classify measured wall-clock segments, not summed agent durations. Unknown
 * legacy timing remains unknown. Concurrent roles never inflate the total. */
function taskEffortBreakdown(task: TaskRecord): Record<string, number> {
  const spans = task.executionMetrics?.intervals ?? [];
  const edges = [...new Set(spans.flatMap(i => [i.start, i.workStart, i.end]))].sort((a, b) => a - b);
  const totals: Record<string, number> = {};
  const units = [...task.workUnits, ...(task.retiredWorkUnits ?? []), ...(task.autonomyHistory ?? []).flatMap(h => h.workUnits)];
  const order = ["実作業", "独立レビュー", "レポート", "計画・統括", "起動・指示待ち", "区分不明"];
  for (let n = 1; n < edges.length; n++) {
    const start = edges[n - 1], end = edges[n];
    const kinds: string[] = spans.filter(i => i.start <= start && i.end >= end).map(i => {
      if (i.uncertain) return "区分不明";
      if (start < i.workStart || i.waiting) return "起動・指示待ち";
      const unit = units.find(u => u.id === i.unitId);
      const role = unit?.role ?? task.runs.find(r => r.id === i.runId)?.role;
      return unit?.planPhase || unit?.orchestrator || role === "planner" ? "計画・統括" : role === "worker" ? "実作業" : role === "reviewer" ? "独立レビュー" : role === "reporter" ? "レポート" : "区分不明";
    });
    const kind = order.find(k => kinds.includes(k));
    if (kind) totals[kind] = (totals[kind] ?? 0) + end - start;
  }
  return totals;
}
function buildTaskEfficiencySummary(task: TaskRecord): HTMLElement {
  const section = document.createElement("section"); section.className = "progress-efficiency";
  const heading = document.createElement("h3"); heading.textContent = "時間・並列の実績"; section.append(heading);
  const m = task.executionMetrics;
  if (!m) { section.append(progressNode("p", "実行開始後に計測します。", "progress-meta")); return section; }
  const target = task.autonomy?.targetMinutes;
  const elapsed = m.elapsedMs / 60000;
  section.append(progressNode("p", `${target ? `目安 ${target}分 ／ ` : ""}実行 ${elapsed.toFixed(1)}分${target && elapsed > target ? `（目安の${(elapsed / target).toFixed(1)}倍）` : ""} · 最大実績 ${m.peakParallel}並列 · 並列稼働 ${executionDuration(m.parallelMs)}`));
  const phases = taskEffortBreakdown(task);
  const list = document.createElement("ul"); list.className = "effort-breakdown";
  for (const [label, ms] of Object.entries(phases)) list.append(progressNode("li", `${label} ${(ms / 60000).toFixed(1)}分`));
  list.title = "停止・工程間の待ち時間を除いた実行時間。実作業は調査・実装・評価を含みます。同時実行は重複計上せず、実作業→レビュー→報告→計画の順で分類。旧記録で時刻を確認できない範囲は区分不明です。";
  section.append(list);
  if (taskIsActive(task) && task.timeOutlook) {
    const o = task.timeOutlook;
    section.append(progressNode("p", `終了見込み：実行時間で少なくとも${o.projectedMinutes.toFixed(1)}分${o.unknownUnits ? ` ＋ 未見積り${o.unknownUnits}工程` : ""}。${target && o.projectedMinutes > target ? "統括役の節目確認で必須作業・分担・残り時間を見直します。" : "見込みは作業の節目で更新します。"}`, "progress-meta"));
  }
  if (target && elapsed > target && taskIsActive(task)) section.append(progressNode("p", "目安を超過しています。統括役は必須作業を優先し、任意の探索・改善を区切ります。強制終了や検証の省略は行いません。", "progress-meta"));
  return section;
}

// Refresh the header clock modestly. Usage is refreshed by native receipt/task
// events; do not poll accounts or rebuild the interactive terminal for a clock.
setInterval(() => {
  for (const timer of document.querySelectorAll<HTMLElement>(".execution-elapsed")) {
    const metrics = state.tasks.find(t => t.id === timer.dataset.taskId)?.executionMetrics;
    if (metrics) timer.textContent = `経過時間 ${executionDuration(metrics.elapsedMs + (metrics.ticking ? Math.max(0, Date.now() - metrics.measuredAt) : 0))}`;
  }
}, 15000);
