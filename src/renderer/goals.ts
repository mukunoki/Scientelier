interface GoalCriterion { id: string; description: string; verification: string; required: boolean; }
interface GoalDraftInput { lesson?: LessonPlan; objective: string; deliverables: string[]; criteria: GoalCriterion[]; constraints: string[]; outOfScope: string[]; questions: string[]; questionAnswers?: { question: string; answer: string }[]; unselected?: { deliverables: string[]; criteria: GoalCriterion[]; constraints: string[]; outOfScope: string[] }; }
interface GoalContract extends GoalDraftInput { revision: number; status: "draft" | "approved"; updatedAt: string; approvedAt?: string; }
const goalEdits = new Map<string, { revision: number; value: GoalDraftInput; notes: string; dirty: boolean; additions?: Record<string, string>; listOrder?: Record<string, string[]>; resolvedQuestions?: string[]; autonomy: { enabled: boolean; maxCycles: number; targetMinutes?: number } }>();
const goalBusy = new Set<string>();
const goalErrors = new Map<string, string>();
const goalDisclosures = new Map<string, boolean>();

function buildGoalEditor(task: TaskRecord): HTMLElement {
  const goal = task.goal!;
  let edit = goalEdits.get(task.id);
  if (!edit || (!edit.dirty && edit.revision !== goal.revision)) {
    edit = { revision: goal.revision, value: structuredClone(goal), notes: "", dirty: false, autonomy: task.autonomy ?? { enabled: true, maxCycles: 3 } };
    goalEdits.set(task.id, edit);
  }
  const draft = edit;
  draft.value.unselected ??= { deliverables: [], criteria: [], constraints: [], outOfScope: [] };
  const unselected = draft.value.unselected;
  const additions = draft.additions ??= {};
  const listOrder = draft.listOrder ??= {};
  const resolvedQuestions = draft.resolvedQuestions ??= (draft.value.questionAnswers ?? []).map(item => item.question).filter(question => !draft.value.questions.includes(question));
  const disclosure = (key: string, title: string, open = false) => {
    const detail = document.createElement("details"); detail.className = "goal-disclosure";
    const summary = document.createElement("summary"); summary.textContent = title;
    const id = `${task.id}:${draft.revision}:${key}`;
    detail.open = goalDisclosures.get(id) ?? open;
    detail.addEventListener("toggle", () => { if (detail.isConnected) goalDisclosures.set(id, detail.open); });
    detail.append(summary); return detail;
  };
  const active = taskIsActive(task);
  const revisionDraft = task.goalRevisionPending && task.goal?.status === "draft" && task.scopeTransition?.round === (task.roundNumber ?? 1);
  const workStarted = task.runs.some(run => !run.goalPreparation && (!revisionDraft || task.workUnits.some(u => u.id === run.workUnitId)));
  const editable = !active && !workStarted;
  const section = document.createElement("section"); section.className = "goal-editor";
  const isDraft = goal.status === "draft";
  section.classList.toggle("goal-approval-form", isDraft);
  const heading = document.createElement("h3"); heading.textContent = isDraft ? "ゴールを確認して承認" : `ゴール · 第${goal.revision}版 · 承認済み`;
  const note = document.createElement("p");
  note.textContent = goal.status === "approved"
    ? `必須条件 ${goal.criteria.filter(item => item.required).length}件。${task.autonomy?.enabled ? `修正サイクル ${task.autonomyCycle ?? 1}/${task.autonomy.maxCycles}。` : "自律反復は無効です。"}承認は要件の確定であり、達成済みの判定ではありません。`
    : "AIの提案を確認し、必要なところだけ修正してください。チェックは作業対象の選択で、達成済みの印ではありません。承認しても作業は自動開始しません。";
  section.append(heading, note);
  if (task.goalRevisionPending) {
    const change = document.createElement("p"); change.className = "goal-notice";
    change.textContent = "アイディア検討から実装・実験への移行準備です。以前の成果物・条件は保持しています。「制約・変更禁止事項」「対象外」に残る実装禁止・実験禁止を必要に応じて修正し、実験条件・検証方法を具体化して承認してください。承認するまで実行しません。";
    section.append(change);
  }
  const reviewNote = document.createElement("p"); reviewNote.className = "goal-notice";
  reviewNote.textContent = "敵対的レビューは直前とは別CLI・別会話で続け、同じ成果物で2回連続合格し、追加検討事項がない場合のみ完了候補です。不合格・検討事項が出た時点でワーカーへ戻し、修正後は連続合格数をリセットして直前のレビューと別CLIで再検証します。作業担当と別CLIを優先しますが、候補不足ならワーカーのCLIも新しい読取専用会話で利用します。利用可能なCLIは最低2種類必要です。担当固定は最初のレビューのみで、以後は直前と別CLIを自動選択します。";
  const policyDetails = disclosure("policy", "実行・レビューのルール"); policyDetails.append(reviewNote);
  if (task.execution?.reviewMode === "cross-service") reviewNote.textContent = "利用可能な全サービスが別会話で独立レビューし、全員の提出後、他サービスの結果を新しい会話でクロス検証します。最大同時実行数の範囲で並列化します。全員分の判定と根拠を確認し、未達条件・未解決事項があればワーカーへ戻します。少数の指摘を多数決で消すことはありません。";
  if (task.execution?.reviewMode === "parallel") reviewNote.textContent = "利用可能な別サービスが新規会話で独立レビューを並列実行し、全員の提出後に1担当が指摘・食い違いと根拠を統合します。最大同時実行数の範囲で実行します。未達条件・未確認事項・少数意見を多数決で消さず、修正が必要なら主担当へ戻します。";
  const reviewAdjustment = taskReviewAdjustment(task);
  reviewNote.textContent = reviewAdjustment ? reviewAdjustment.reason : `通常のレビュー方式：${reviewNote.textContent}\n作業目安時間がある場合は開始前に必要時間を見積もり、独立レビュー2回または1回に軽量化できます。未達条件や未解決の指摘を合格扱いにはせず、時間超過時も必要な確認を続けます。`;
  if (goal.status === "approved" && !task.reviewPolicy) {
    const migration = document.createElement("p"); migration.className = "goal-notice";
    migration.textContent = "この旧タスクの判定は2回レビュー未対応です。中断工程の再開、または追加作業の「レビューのみ」で再検証してください。以前の合格判定だけでは完了にできません。";
    section.append(migration);
  }
  const cliSettings = document.createElement("details");
  const cliTitle = document.createElement("summary"); cliTitle.textContent = `利用CLIを変更（作業・レビュー共通） · ${task.allowedAgentIds.length}種類を許可`; cliSettings.append(cliTitle);
  const cliOptions = document.createElement("select"); cliOptions.multiple = true; cliOptions.size = 4; cliOptions.setAttribute("aria-label", "作業とレビューに利用するCLI");
  for (const agent of state.agents.filter(a => a.id !== "gemini")) { const option = new Option(`${agent.label}${agent.installed ? "" : "（未インストール）"}`, agent.id); option.selected = task.allowedAgentIds.includes(agent.id); cliOptions.add(option); }
  const saveClis = document.createElement("button"); saveClis.type = "button"; saveClis.textContent = "利用CLIを保存"; saveClis.disabled = active || taskIsActive(task);
  saveClis.onclick = async () => {
    saveClis.disabled = true;
    try { const saved = await api.configureAllowedAgents(task.id, [...cliOptions.selectedOptions].map(o => o.value)); state.tasks = state.tasks.map(t => t.id === saved.id ? saved : t); renderDetail(); showToast("利用CLIを保存しました。インストール・認証と使用枠を確認して再開してください。"); }
    catch (e) { showToast(errorMessage(e)); saveClis.disabled = false; }
  };
  cliSettings.append(cliOptions, saveClis); policyDetails.append(cliSettings);
  const readiness = document.createElement("p"); readiness.className = "goal-readiness"; readiness.setAttribute("role", "status"); section.append(readiness);
  const formError = document.createElement("p"); formError.className = "form-error"; formError.setAttribute("role", "alert");
  formError.textContent = goalErrors.get(task.id) ?? ""; formError.hidden = !formError.textContent; section.append(formError);
  const limitation = document.createElement("p"); limitation.className = "goal-notice";
  limitation.textContent = `作業目安時間は超過できます。時間による強制終了はしません。${task.workflowMode === "primary" ? "主担当が最初に実行計画と体制を設計し、保存済みの会話を引き継いで実作業を進めます。結果に応じて計画を更新し、最終レビューは独立して実施します。「計画・担当」タブで方針・担当・変更理由を確認できます。「実行戦略」で分担・並列数・予算目安を設定できます。" : "プランナーが作業計画とワーカー後の進捗確認で残作業を見直します。トークン予算の着手制御は主担当方式で利用できます。"}`;
  policyDetails.append(limitation);
  let evaluationDetails: HTMLElement | undefined;
  const evaluation = task.evaluations?.filter(e => e.goalRevision === goal.revision && e.round === (task.roundNumber ?? 1)).at(-1);
  if ((task.autonomy?.enabled || task.reviewPolicy) && goal.status === "approved") {
    const ledger = document.createElement("div"); ledger.className = "goal-ledger";
    const title = document.createElement("h4");
    const labels = { working: "修正・レビュー継続中", satisfied: task.reviewPolicy ? "敵対的レビュー2回連続合格" : "必須条件の検証合格", "needs-input": "ユーザ確認待ち", "cycle-limit": "修正サイクル上限", stalled: "進展なし・方針確認待ち", "invalid-review": "レビュー不正・未達成" };
    if (task.execution?.reviewMode === "cross-service") labels.satisfied = "全サービスの独立レビュー・クロスレビュー合格";
    if (task.execution?.reviewMode === "parallel") labels.satisfied = "並列独立レビュー・統括確認で合格";
    if (reviewAdjustment) labels.satisfied = `独立レビュー${reviewAdjustment.mode === "single" ? 1 : 2}回で合格（時間調整・クロス検証なし）`;
    title.textContent = !task.reviewPolicy ? "旧方式の評価（2回レビューが必要）" : task.autonomyState ? labels[task.autonomyState] : "ゴール検証待ち"; ledger.append(title);
    const verified = document.createElement("p"); verified.textContent = evaluation ? `評価時点: ${new Date(evaluation.reviewedAt).toLocaleString()} · 第${evaluation.cycle}回。修正後は再検証が必要です。` : "まだ検証結果はありません。"; ledger.append(verified);
    if (task.reviewPolicy) for (const unit of task.workUnits.filter(u => u.role === "reviewer")) {
      const review = task.evaluations?.filter(e => e.reviewUnitId === unit.id && e.reviewPass === unit.reviewPass).at(-1);
      const row = document.createElement("p"); row.textContent = `${unit.title} · ${review?.reviewerAgentId ?? "未割当"} · ${review ? review.summary : unit.state}`; ledger.append(row);
    }
    for (const concern of evaluation?.concerns ?? []) { const item = document.createElement("p"); item.textContent = `追加検討事項：${concern}`; ledger.append(item); }
    for (const condition of goal.criteria) {
      const finding = evaluation?.criteria.find(c => c.criterionId === condition.id);
      const row = document.createElement("details");
      const summary = document.createElement("summary"); summary.textContent = `${condition.required ? "必須" : "追加"} · ${finding?.status === "pass" ? "合格" : finding?.status === "fail" ? "不合格" : "未検証"} · ${condition.description}`;
      const detail = document.createElement("p"); detail.textContent = finding?.detail ?? condition.verification;
      row.append(summary, detail);
      for (const evidence of finding?.evidence ?? []) { const e = document.createElement("p"); e.textContent = `${evidence.path}\n${evidence.detail}${evidence.hash ? `\nSHA-256: ${evidence.hash}` : ""}`; row.append(e); }
      ledger.append(row);
    }
    if (task.evaluations?.length) {
      const history = document.createElement("details"); const label = document.createElement("summary"); label.textContent = "自律レビューの履歴"; history.append(label);
      for (const e of task.evaluations) { const p = document.createElement("p"); p.textContent = `作業第${e.round}回・サイクル${e.cycle}・${e.reviewPass ? `レビュー #${e.reviewNumber ?? e.reviewPass} (${e.reviewerAgentId})` : "総合判定"}: ${e.summary}`; history.append(p); }
      ledger.append(history);
    }
    evaluationDetails = disclosure("evaluation", `検証結果 · ${title.textContent}`); evaluationDetails.append(ledger);
  }
  if (task.error) { const error = document.createElement("p"); error.className = "form-error"; error.textContent = task.error; section.append(error); }
  if (draft.revision !== goal.revision) {
    const warning = document.createElement("p"); warning.className = "form-error";
    warning.textContent = "別の更新があります。編集中の内容は保持していますが、このままでは保存できません。";
    const reload = document.createElement("button"); reload.className = "secondary-button"; reload.textContent = "編集中の内容を破棄し最新版を開く";
    reload.onclick = () => { if (confirm("未保存のゴール編集を破棄しますか？")) { goalEdits.delete(task.id); renderDetail(); } };
    section.append(warning, reload);
  }
  const controls = document.createElement("fieldset"); controls.className = "goal-fields";
  controls.disabled = !editable || goalBusy.has(task.id) || taskIsActive(task);
  const executionOptions = isDraft ? document.createElement("section") : disclosure("execution", "進め方・作業目安時間");
  if (isDraft) {
    executionOptions.className = "goal-section goal-execution-section";
    const title = document.createElement("h4"); title.textContent = "進め方・実行戦略"; executionOptions.append(title);
  }
  const modeLabel = document.createElement("label"); modeLabel.textContent = "自律反復";
  const mode = document.createElement("select"); mode.setAttribute("aria-label", "自律反復"); mode.add(new Option("不合格・追加検討事項を自動修正する", "on")); mode.add(new Option("反復せず結果を確認する", "off")); mode.value = draft.autonomy.enabled ? "on" : "off";
  mode.onchange = () => { draft.autonomy = { ...draft.autonomy, enabled: mode.value === "on" }; draft.dirty = true; }; modeLabel.append(mode);
  const limitLabel = document.createElement("label"); limitLabel.textContent = "最大修正サイクル（初回を含む）";
  const limit = document.createElement("select"); limit.setAttribute("aria-label", "最大修正サイクル"); for (let n = 1; n <= 5; n++) limit.add(new Option(`${n}回`, String(n))); limit.value = String(draft.autonomy.maxCycles);
  limit.onchange = () => { draft.autonomy = { ...draft.autonomy, maxCycles: Number(limit.value) }; draft.dirty = true; }; limitLabel.append(limit); executionOptions.append(modeLabel, limitLabel);
  const timeLabel = document.createElement("label"); timeLabel.textContent = "作業目安時間（全工程の合計・分、空欄は未指定）";
  const timeInput = document.createElement("input"); timeInput.type = "number"; timeInput.min = "1"; timeInput.max = "10080"; timeInput.step = "1"; timeInput.setAttribute("aria-label", "作業目安時間（分）"); timeInput.placeholder = "例：60（超過しても継続）"; timeInput.value = draft.autonomy.targetMinutes === undefined ? "" : String(draft.autonomy.targetMinutes);
  timeInput.oninput = () => { draft.autonomy = { ...draft.autonomy, targetMinutes: timeInput.value === "" ? undefined : Number(timeInput.value) }; draft.dirty = true; updateReadiness(); }; timeLabel.append(timeInput); executionOptions.append(timeLabel);
  const elapsed = document.createElement("p"); elapsed.className = "goal-time-status";
  const cutoff = Math.max(0, ...(task.history ?? []).filter(r => r.number < (task.roundNumber ?? 1)).map(r => Date.parse(r.finishedAt)));
  const minutes = task.runs.filter(r => !r.goalPreparation && Date.parse(r.startedAt) >= cutoff).reduce((sum, r) => sum + Math.max(0, (r.completedAt ? Date.parse(r.completedAt) : r.state === "running" ? Date.now() : Date.parse(r.startedAt)) - Date.parse(r.startedAt)) / 60000, 0);
  elapsed.textContent = `本作業の実行時間：約${minutes.toFixed(1)}分 ／ 目安：${task.autonomy?.targetMinutes === undefined ? "未指定" : `${task.autonomy.targetMinutes}分`}${task.autonomy?.targetMinutes && minutes > task.autonomy.targetMinutes ? "（目安超過・継続可）" : ""}`; policyDetails.append(elapsed);
  const textarea = (labelText: string, value: string, changed: (value: string) => void, rows = 2) => {
    const label = document.createElement("label"); label.textContent = labelText;
    const input = document.createElement("textarea"); input.value = value; input.rows = rows;
    input.setAttribute("aria-label", labelText); input.maxLength = 8000;
    input.addEventListener("input", () => { changed(input.value); draft.dirty = true; goalErrors.delete(task.id); formError.hidden = true; updateReadiness(); });
    label.append(input); return label;
  };
  const objective = textarea("ゴール・目的", draft.value.objective, value => { draft.value.objective = value; }, 4);
  objective.className = "goal-objective-field";
  objective.firstChild!.textContent = "最終目的";
  controls.append(objective);
  const changed = () => { draft.dirty = true; goalErrors.delete(task.id); formError.hidden = true; updateReadiness(); };
  if (draft.value.lesson) controls.append(buildLessonEditor(task, draft.value.lesson, changed));
  const addLine = (title: string, action: (value: string) => void) => {
    const line = document.createElement("div"); line.className = "goal-add-line";
    const input = document.createElement("input"); input.type = "text"; input.maxLength = 8000; input.placeholder = `${title}を追加…`; input.setAttribute("aria-label", `${title}を追加`); input.value = additions[title] ?? "";
    input.oninput = () => { additions[title] = input.value; changed(); };
    const button = document.createElement("button"); button.type = "button"; button.className = "secondary-button compact"; button.textContent = "＋ 追加";
    const add = () => { if (!input.value.trim() || button.disabled) { input.focus(); return; } const value = input.value.trim(); additions[title] = ""; input.value = ""; action(value); };
    button.onclick = add; input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); add(); } };
    line.append(input, button); return { line, input, button };
  };
  const checklist = (title: string, key: "deliverables" | "constraints" | "outOfScope") => {
    const block = document.createElement("div"); block.className = "goal-checklist"; block.dataset.goalList = key;
    const heading = document.createElement("h4"), rows = document.createElement("div"); rows.className = "goal-choice-list";
    const candidates = [...draft.value[key].map(text => ({ text, selected: true })), ...unselected[key].map(text => ({ text, selected: false }))];
    const order = listOrder[key] ??= candidates.map(c => c.text);
    candidates.sort((a, b) => order.indexOf(a.text) - order.indexOf(b.text));
    const count = () => {
      heading.textContent = `${title} · ${candidates.filter(c => c.selected).length}件を選択`; addition.button.disabled = candidates.length >= 40;
      const summary = block.parentElement?.tagName === "DETAILS" ? block.parentElement.querySelector("summary") : null;
      if (summary) summary.textContent = `${key === "constraints" ? "制約・変更禁止事項" : title} · ${candidates.filter(c => c.selected).length}件`;
    };
    const sync = () => { draft.value[key] = candidates.filter(c => c.selected).map(c => c.text); unselected[key] = candidates.filter(c => !c.selected).map(c => c.text); listOrder[key] = candidates.map(c => c.text); count(); changed(); };
    const draw = () => {
      rows.replaceChildren();
      candidates.forEach((item, index) => {
        const row = document.createElement("div"); row.className = "goal-choice"; row.classList.toggle("is-unselected", !item.selected);
        const label = document.createElement("label"); label.className = "goal-choice-label";
        const check = document.createElement("input"); check.type = "checkbox"; check.checked = item.selected; check.setAttribute("aria-label", `${title}に含める ${index + 1}`);
        const text = document.createElement("span"); text.textContent = item.text;
        check.onchange = () => { item.selected = check.checked; row.classList.toggle("is-unselected", !item.selected); sync(); };
        label.append(check, text);
        const details = disclosure(`${key}:${index}`, "編集"); details.classList.add("goal-choice-detail");
        details.append(textarea(`${title} ${index + 1}`, item.text, value => { item.text = value; text.textContent = value; sync(); }));
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary-button compact"; remove.textContent = "候補から削除";
        remove.onclick = () => { candidates.splice(index, 1); sync(); draw(); }; details.append(remove);
        row.append(label, details); rows.append(row);
      });
      count();
    };
    const addition = addLine(title, value => { if (candidates.length >= 40) return; const existing = candidates.find(c => c.text === value); if (existing) existing.selected = true; else candidates.push({ text: value, selected: true }); sync(); draw(); });
    block.append(heading, rows, addition.line); draw(); return block;
  };
  controls.append(checklist("成果物", "deliverables"));
  const criteriaBlock = document.createElement("div"); criteriaBlock.className = "goal-checklist"; criteriaBlock.dataset.goalList = "criteria";
  const criteriaHeading = document.createElement("h4"), criteriaRows = document.createElement("div"); criteriaRows.className = "goal-choice-list";
  const candidates = [...draft.value.criteria.map(value => ({ value, selected: true })), ...unselected.criteria.map(value => ({ value, selected: false }))];
  const criteriaCount = () => { criteriaHeading.textContent = `達成条件 · ${candidates.filter(c => c.selected).length}件を選択`; criteriaAdd.button.disabled = candidates.length >= 40; };
  const syncCriteria = () => { draft.value.criteria = candidates.filter(c => c.selected).map(c => c.value); unselected.criteria = candidates.filter(c => !c.selected).map(c => c.value); criteriaCount(); changed(); };
  const drawCriteria = () => {
    criteriaRows.replaceChildren();
    for (const candidate of candidates) {
      const criterion = candidate.value;
      const row = document.createElement("div"); row.className = "goal-choice goal-criterion"; row.classList.toggle("is-unselected", !candidate.selected);
      const label = document.createElement("label"); label.className = "goal-choice-label";
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = candidate.selected; check.setAttribute("aria-label", `条件に含める ${criterion.id}`);
      const text = document.createElement("span"); text.textContent = criterion.description || "新しい達成条件";
      check.onchange = () => { candidate.selected = check.checked; row.classList.toggle("is-unselected", !candidate.selected); if (candidate.selected && !criterion.verification.trim()) details.open = true; syncCriteria(); };
      label.append(check, text);
      const priority = document.createElement("select"); priority.className = "goal-priority"; priority.setAttribute("aria-label", `重要度 ${criterion.id}`);
      priority.add(new Option("必須", "required")); priority.add(new Option("追加改善", "optional")); priority.value = criterion.required ? "required" : "optional";
      priority.onchange = () => { criterion.required = priority.value === "required"; changed(); };
      const details = disclosure(`criterion:${criterion.id}`, criterion.verification.trim() ? "検証方法・編集" : "検証方法を入力", candidate.selected && !criterion.verification.trim()); details.classList.add("goal-choice-detail");
      details.append(textarea(`達成条件 ${criterion.id}`, criterion.description, value => { criterion.description = value; text.textContent = value || "新しい達成条件"; }),
        textarea(`検証方法 ${criterion.id}`, criterion.verification, value => { criterion.verification = value; details.querySelector("summary")!.textContent = value.trim() ? "検証方法・編集" : "検証方法を入力"; }));
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary-button compact"; remove.textContent = "候補から削除";
      remove.onclick = () => { candidates.splice(candidates.indexOf(candidate), 1); syncCriteria(); drawCriteria(); }; details.append(remove);
      row.append(label, priority, details); criteriaRows.append(row);
    }
    criteriaCount();
  };
  const criteriaAdd = addLine("達成条件", value => {
    if (candidates.length >= 40) return;
    const criterion = { id: crypto.randomUUID(), description: value, verification: "", required: true };
    candidates.push({ value: criterion, selected: true }); syncCriteria(); drawCriteria();
    criteriaRows.querySelector<HTMLTextAreaElement>(`textarea[aria-label="検証方法 ${criterion.id}"]`)?.focus();
  });
  criteriaBlock.append(criteriaHeading, criteriaRows, criteriaAdd.line); drawCriteria(); controls.append(criteriaBlock);
  const constraints = disclosure("constraints", `制約・変更禁止事項 · ${draft.value.constraints.length}件`, isDraft && draft.value.constraints.length > 0); constraints.append(checklist("制約", "constraints"));
  const excluded = disclosure("outOfScope", `対象外 · ${draft.value.outOfScope.length}件`, isDraft && draft.value.outOfScope.length > 0); excluded.append(checklist("対象外", "outOfScope"));
  controls.append(constraints, excluded);
  const questions = disclosure("questions", `確認事項 · 未解決${draft.value.questions.length}件`, draft.value.questions.length > 0);
  const questionOrder = listOrder.questions ??= [...new Set([...draft.value.questions, ...resolvedQuestions])];
  for (const question of [...draft.value.questions, ...resolvedQuestions]) if (!questionOrder.includes(question)) questionOrder.push(question);
  const questionNote = document.createElement("p"); questionNote.textContent = "各項目の下に回答を書き、「回答を使ってAIでゴールを更新」を押してください。回答は下書きにも保存できます。手動で上のゴールへ反映した場合だけ「反映済み」をチェックしてください。";
  questions.append(questionNote);
  for (const [index, question] of questionOrder.filter(q => draft.value.questions.includes(q) || resolvedQuestions.includes(q)).entries()) {
    const row = document.createElement("div"); row.className = "goal-question-card";
    const title = document.createElement("p"); title.className = "goal-question-title"; title.textContent = `${index + 1}. ${question}`;
    const label = document.createElement("label"); label.className = "goal-question-row";
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = resolvedQuestions.includes(question); check.setAttribute("aria-label", `確認事項 ${index + 1} をゴールに反映済み`);
    const text = document.createElement("span"); text.textContent = "回答をゴールの項目へ手動で反映済み";
    check.onchange = () => {
      if (check.checked) { draft.value.questions = draft.value.questions.filter(q => q !== question); if (!resolvedQuestions.includes(question)) resolvedQuestions.push(question); }
      else { if (!draft.value.questions.includes(question)) draft.value.questions.push(question); resolvedQuestions.splice(resolvedQuestions.indexOf(question), 1); }
      draft.value.questions.sort((a, b) => questionOrder.indexOf(a) - questionOrder.indexOf(b));
      questions.querySelector("summary")!.textContent = `確認事項 · 未解決${draft.value.questions.length}件`; changed();
    };
    const answer = textarea(`確認事項 ${index + 1} への回答`, draft.value.questionAnswers?.find(item => item.question === question)?.answer ?? "", value => {
      const answers = draft.value.questionAnswers ??= [];
      const existing = answers.find(item => item.question === question);
      if (existing) existing.answer = value; else answers.push({ question, answer: value });
      // Editing an already reflected answer requires a fresh reflection/confirmation.
      if (check.checked) { check.checked = false; check.onchange!(new Event("change")); }
    }, 3);
    answer.querySelector("textarea")!.placeholder = "この確認事項への回答・希望・条件を入力…";
    label.append(check, text); row.append(title, answer, label); questions.append(row);
  }
  const questionAdd = addLine("確認事項", value => { if (questionOrder.length >= 40 || questionOrder.includes(value)) return; draft.value.questions.push(value); draft.dirty = true; goalDisclosures.set(`${task.id}:${draft.revision}:questions`, true); renderDetail(); });
  questionAdd.button.disabled = questionOrder.length >= 40; questions.append(questionAdd.line); controls.append(questions);
  if (!workStarted) {
    const answerRefine = document.createElement("button"); answerRefine.type = "button"; answerRefine.className = "secondary-button";
    answerRefine.textContent = "回答を使ってAIでゴールを更新";
    answerRefine.onclick = () => { void refineDraft(); }; questions.append(answerRefine);
  }
  const actions = document.createElement("div"); actions.className = "goal-actions";
  const apply = async (approve: boolean) => {
    if (goalBusy.has(task.id)) return;
    if (Object.values(additions).some(value => value.trim())) { updateReadiness(); return; }
    if (approve && approvalIssues().length) { updateReadiness(); return; }
    goalErrors.delete(task.id);
    goalBusy.add(task.id); controls.disabled = true;
    try {
      if (isDraft && task.workflowMode === "primary") await saveGoalExecutionDraft(task.id);
      const saved = await api.saveGoal(task.id, draft.value, draft.revision, approve, draft.autonomy);
      goalEdits.delete(task.id);
      state.tasks = state.tasks.map(item => item.id === saved.id ? saved : item);
      showToast(approve ? "ゴールを承認しました。本作業はキューまたはRun workflowから開始できます。" : "下書きを保存しました。");
    } catch (error) { goalErrors.set(task.id, errorMessage(error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
    finally { goalBusy.delete(task.id); renderTasks(); renderDetail(); }
  };
  const save = document.createElement("button"); save.type = "button"; save.className = "secondary-button"; save.textContent = "下書きを保存"; save.onclick = () => { void apply(false); };
  const approve = document.createElement("button"); approve.type = "button"; approve.className = "primary-button"; approve.textContent = "ゴールを承認してキューへ"; approve.onclick = () => { void apply(true); };
  const actionReadiness = document.createElement("p"); actionReadiness.className = "goal-readiness"; actionReadiness.hidden = true;
  function approvalIssues(): string[] {
    const issues: string[] = [];
    if (draft.value.lesson && (!draft.value.lesson.topics.length || draft.value.lesson.topics.every(t => t.depth === "known"))) issues.push("説明範囲を設定してください。AIで前提知識を提案するか、説明項目を追加できます。");
    if (draft.autonomy.targetMinutes !== undefined && (!Number.isInteger(draft.autonomy.targetMinutes) || draft.autonomy.targetMinutes < 1 || draft.autonomy.targetMinutes > 10080)) issues.push("作業目安時間は1〜10080分、または空欄にしてください。");
    if (draft.revision !== goal.revision) issues.push("最新版を開き直してください（編集中の内容は保持しています）。");
    if (!draft.value.objective.trim()) issues.push("ゴール・目的を入力してください。");
    if (Object.values(additions).some(value => value.trim())) issues.push("入力中の候補があります。「＋ 追加」で一覧に加えるか、追加欄を空にしてください。");
    if ([...draft.value.deliverables, ...draft.value.constraints, ...draft.value.outOfScope, ...unselected.deliverables, ...unselected.constraints, ...unselected.outOfScope].some(value => !value.trim())) issues.push("空の項目があります。内容を入力するか候補から削除してください。");
    if (draft.value.constraints.some(c => /(?:準備|目標契約).*(?:限定|のみ)/.test(c) && /(?:調査|作成|変更|編集).*(?:行わない|禁止)/.test(c))) issues.push("準備段階だけの作業禁止が制約に残っています。本作業を許可する範囲を確認し、制約を修正してください。");
    if (!draft.value.deliverables.length) issues.push("成果物を1件以上入力してください。");
    if (!draft.value.criteria.some(c => c.required)) issues.push("必須の達成条件を1件以上設定してください。");
    if (draft.value.criteria.some(c => !c.description.trim() || !c.verification.trim())) issues.push("すべての達成条件に説明と検証方法を入力してください。");
    if (draft.value.questions.length) issues.push(`未解決の確認事項が${draft.value.questions.length}件あります。各項目の回答欄に記入し、「回答を使ってAIでゴールを更新」を押してください。`);
    if (draft.notes.trim()) issues.push("AIへの回答がまだゴールに反映されていません。「編集内容・回答からAIで再提案」を押してください。手動で反映済みなら回答欄を空にしてください。");
    return issues;
  }
  function updateReadiness(): void {
    const issues = approvalIssues();
    const lockReason = active ? task.goalPreparation ? "AIがゴールを再提案中です。終了すると編集・承認できるようになります。中断する場合は「Pause workflow」を押してください。" : "本作業の実行中はゴールを編集できません。"
      : workStarted ? "本作業開始後のゴール変更にはまだ対応していません。"
      : goalBusy.has(task.id) ? "ゴールを保存しています。"
      : taskIsActive(task) ? "このタスクを停止してからゴールを編集・承認してください。" : "";
    const message = lockReason || (issues.length ? `承認前に確認：${issues.join("\n")}` : goal.status === "approved" && !draft.dirty ? "承認済みです。上の実行ボタン、または「待機タスクを実行」で開始します。" : "承認できます。実行待ちに登録するだけで、本作業は自動開始しません。");
    readiness.textContent = message; actionReadiness.textContent = message;
    approve.disabled = Boolean(lockReason || issues.length);
    approve.title = issues.join("\n");
  }
  actions.append(save, approve); actions.classList.add("goal-approval-actions");
  if (!workStarted) {
    const aiDetails = disclosure("ai", draft.value.lesson ? "AIで前提知識・説明レベルを提案" : "AIで整理・質問に回答", !!draft.notes.trim() || !!draft.value.lesson && !draft.value.lesson.topics.length);
    if (goal.status === "approved") {
      const reopening = document.createElement("p"); reopening.className = "goal-notice";
      reopening.textContent = "本作業はまだ始まっていないため、承認後もAIで見直せます。再提案すると下書きに戻り、改めて承認するまで本作業は開始しません。";
      aiDetails.append(reopening);
    }
    aiDetails.append(textarea("AIへの補足・質問への回答", draft.notes, value => { draft.notes = value; }, 3));
    const refine = document.createElement("button"); refine.type = "button"; refine.className = "secondary-button"; refine.textContent = "編集内容・回答からAIで再提案";
    refine.onclick = () => { void refineDraft(); };
    aiDetails.append(refine); controls.append(aiDetails);
  }
  async function refineDraft(): Promise<void> {
    if (goalBusy.has(task.id)) return;
    if (Object.values(additions).some(value => value.trim())) { updateReadiness(); return; }
    goalErrors.delete(task.id);
    goalBusy.add(task.id); controls.disabled = true;
    try {
      if (isDraft && task.workflowMode === "primary") await saveGoalExecutionDraft(task.id);
      const saved = await api.saveGoal(task.id, draft.value, draft.revision, false, draft.autonomy);
      state.tasks = state.tasks.map(item => item.id === saved.id ? saved : item);
      goalEdits.set(task.id, { revision: saved.goal!.revision, value: structuredClone(saved.goal!), notes: draft.notes, dirty: false, autonomy: draft.autonomy });
      const started = await api.refineGoal(task.id, draft.notes, saved.goal!.revision);
      goalEdits.delete(task.id);
      state.tasks = state.tasks.map(item => item.id === started.id ? started : item);
      state.selectedTaskPanels.set(task.id, "execution");
    } catch (error) { goalErrors.set(task.id, errorMessage(error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
    finally { goalBusy.delete(task.id); renderTasks(); renderDetail(); }
  }
  if (isDraft && task.workflowMode === "primary") {
    const strategy = buildExecutionSettings(task, true);
    // Keep the common decisions visible; rarely changed iteration controls sit
    // with the other advanced controls, not above the main strategy choices.
    strategy.querySelector(".execution-advanced")!.append(modeLabel, limitLabel);
    executionOptions.append(strategy);
  }
  controls.append(executionOptions, actionReadiness, actions);
  section.append(controls);
  if (evaluationDetails) section.append(evaluationDetails);
  section.append(policyDetails);
  updateReadiness();
  if (task.goalHistory?.length) {
    const history = document.createElement("details"); const title = document.createElement("summary"); title.textContent = "ゴールの変更履歴"; history.append(title);
    for (const previous of [...task.goalHistory].reverse()) {
      const entry = document.createElement("div"); entry.className = "goal-history-entry";
      const label = document.createElement("h4"); label.textContent = `第${previous.revision}版 · ${previous.status === "approved" ? "承認済み" : "下書き"}`;
      const text = document.createElement("p"); text.textContent = [previous.objective, ...previous.deliverables.map(s => `成果物：${s}`), ...previous.criteria.map(c => `${c.required ? "必須" : "追加"}：${c.description}\n検証：${c.verification}`), ...previous.constraints.map(s => `制約：${s}`), ...previous.outOfScope.map(s => `対象外：${s}`), ...previous.questions.map(s => `確認：${s}`)].join("\n");
      entry.append(label, text); history.append(entry);
      for (const answer of previous.questionAnswers ?? []) {
        const clarification = document.createElement("p"); clarification.textContent = `確認：${answer.question}\n回答：${answer.answer || "（未入力）"}`; entry.append(clarification);
      }
    }
    section.append(history);
  }
  return section;
}
