// 画面全体の状態と初期化。データ/APIの型は types.d.ts を参照。
const state: {
  agents: AgentStatus[];
  tasks: TaskRecord[];
  queue: QueueStatus;
  resources: ProviderResourceSummary[];
  orchestrationSettings?: OrchestrationSettings;
  reportSettings?: ReportSettings;
  reportEnvironment?: ReportEnvironmentStatus;
  selectedTaskId?: string;
  selectedTaskPanels: Map<string, TaskPanel>;
  currentView: "dispatch" | "tasks" | "usage" | "settings";
  selectedTerminalAgents: Map<string, AgentId>;
} = {
  agents: [],
  tasks: [],
  queue: { running: false, stopping: false },
  resources: [],
  currentView: "tasks",
  selectedTaskPanels: new Map(),
  selectedTerminalAgents: new Map()
};

const api = (window as typeof window & { harness: HarnessApi }).harness;
let resourceDialogProviderKey: string | undefined;
const byId = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element #${id}`);
  return value as T;
};

function showToast(message: string): void {
  const toast = byId<HTMLDivElement>("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentLabel(id: AgentId): string {
  return state.agents.find((agent) => agent.id === id)?.label ?? (id === "gemini" ? "Gemini CLI（廃止・過去の履歴）" : id);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatLimitDuration(minutes?: number): string {
  if (!minutes) return "";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}週間`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}日`;
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}


function showView(view: "dispatch" | "tasks" | "usage" | "settings"): void {
  state.currentView = view;
  document.body.classList.toggle("task-layout", view === "tasks");
  byId("dispatch-view").classList.toggle("hidden", view !== "dispatch");
  byId("tasks-view").classList.toggle("hidden", view !== "tasks");
  byId("usage-view").classList.toggle("hidden", view !== "usage");
  byId("settings-view").classList.toggle("hidden", view !== "settings");
  byId("nav-dispatch").classList.toggle("active", view === "dispatch");
  byId("nav-tasks").classList.toggle("active", view === "tasks");
  byId("nav-usage").classList.toggle("active", view === "usage");
  byId("nav-settings").classList.toggle("active", view === "settings");
  if (view === "usage") byId("settings-models").dispatchEvent(new Event("services-shown"));
  byId("page-title").textContent = view === "dispatch"
    ? "新しいタスク"
    : view === "tasks"
      ? "タスク"
      : view === "settings" ? "システム設定" : "CLIの利用状況";
  if (view === "usage") renderResources();
  if (view === "settings") refreshTaskExecutionDialog();
  renderResourceSummary();
}

function providerForAgent(agentId: AgentId): ProviderResourceSummary | undefined {
  return state.resources.find((resource) => resource.agentIds.includes(agentId));
}

function renderAgents(): void {
  const grid = byId<HTMLDivElement>("agent-grid");
  grid.replaceChildren();
  for (const agent of state.agents.filter(a => a.id !== "gemini")) {
    const resource = providerForAgent(agent.id);
    const card = document.createElement("div");
    card.className = "agent-card";
    const top = document.createElement("div");
    top.className = "agent-top";
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = agent.label;
    const dot = document.createElement("span");
    const readiness = resource ? serviceReadiness(resource) : undefined;
    dot.className = `status-dot${readiness?.tone === "ready" ? " online" : ""}${readiness?.tone === "blocked" ? " limited" : ""}`;
    dot.title = readiness?.label ?? "未確認";
    top.append(name, dot);
    const version = document.createElement("div");
    version.className = "agent-version";
    version.textContent = agent.installed ? (agent.version ?? "Detected") : "Not installed";
    const provider = document.createElement("div");
    provider.className = "agent-provider";
    provider.textContent = resource ? `${resource.providerLabel} · ${readiness?.label}` : "Provider unconfigured";
    card.append(top, version, provider);
    grid.append(card);
  }
  renderTaskAgentPool();
}

function renderTaskAgentPool(): void {
  const pool = byId<HTMLDivElement>("task-agent-pool");
  const prior = new Map<AgentId, { checked: boolean; model: string }>();
  for (const row of Array.from(pool.querySelectorAll<HTMLElement>("[data-agent-id]"))) {
    const id = row.dataset.agentId as AgentId;
    prior.set(id, {
      checked: row.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked ?? false,
      model: row.querySelector<HTMLInputElement>("input[type=text]")?.value ?? ""
    });
  }
  pool.replaceChildren();
  for (const agent of dispatchAgents()) {
    const row = document.createElement("div");
    row.className = "agent-choice";
    row.dataset.agentId = agent.id;
    const toggle = document.createElement("label");
    toggle.className = "agent-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = !agent.installed;
    checkbox.checked = prior.has(agent.id) ? prior.get(agent.id)!.checked : agent.installed && state.orchestrationSettings?.agentPolicies.find(p => p.agentId === agent.id)?.enabled !== false;
    const label = document.createElement("span");
    label.textContent = agent.label;
    toggle.append(checkbox, label);
    const model = document.createElement("input");
    model.type = "text";
    const resource = providerForAgent(agent.id);
    const catalogDefault = resource?.models.find((item) => item.source === "catalog" && item.isDefault);
    const configured = state.orchestrationSettings?.agentPolicies.find((item) => item.agentId === agent.id)?.defaultModel;
    model.placeholder = configured
      ? `default: ${configured}`
      : catalogDefault ? `automatic: ${catalogDefault.label}` : "automatic CLI default";
    model.title = "Leave blank to follow the CLI default as it changes.";
    model.disabled = !agent.installed;
    model.value = prior.get(agent.id)?.model ?? "";
    row.append(toggle, modelPicker(agent.id, model, configured ? `既定 · ${configured}` : "CLIの既定モデル"));
    if (agent.id === "antigravity") {
      const help = document.createElement("small"); help.className = "agent-choice-help";
      help.textContent = "Googleログインを使用。利用枠はResourcesで確認。";
      row.append(help);
    }
    pool.append(row);
  }
}

function renderQueue(): void {
  const queued = state.tasks.filter((task) => task.state === "queued").length;
  const running = new Set([...(state.queue.activeTaskIds ?? []), ...state.tasks.filter(taskIsActive).map(t => t.id)]).size;
  const indicator = byId<HTMLDivElement>("queue-indicator");
  const label = indicator.querySelector("strong");
  indicator.classList.toggle("running", state.queue.running);
  indicator.classList.toggle("stopping", state.queue.stopping);
  if (label) label.textContent = state.queue.stopping
    ? "Stopping after current task"
    : `${running}タスク実行中 · ${queued}件待機${state.queue.running ? "（キュー最大2件並列）" : ""}`;
  byId<HTMLButtonElement>("start-queue").disabled = state.queue.running || queued === 0;
  byId<HTMLButtonElement>("stop-queue").disabled = !state.queue.running || state.queue.stopping;
}

let workspaceChoiceRevision = 0;
function invalidateWorkspace(): void {
  // Only invalidate in-flight folder-picker replies, not the entered goal.
  workspaceChoiceRevision++;
  const isNew = byId<HTMLSelectElement>("task-workspace-mode").value === "new";
  byId("choose-workspace").textContent = isNew ? "新規フォルダの場所を選択…" : "既存フォルダを選択…";
  byId("workspace-choice-status").textContent = "入力順は自由です。作業場所はタスク作成時に確認します。";
}
function initializeWorkspace(): void {
  const path = byId<HTMLInputElement>("task-cwd");
  const mode = byId<HTMLSelectElement>("task-workspace-mode");
  path.value = "";
  path.addEventListener("input", invalidateWorkspace);
  mode.addEventListener("change", invalidateWorkspace);
  byId("choose-workspace").addEventListener("click", async () => {
    const revision = workspaceChoiceRevision;
    try {
      const selected = await api.chooseWorkspace(mode.value);
      if (selected && revision === workspaceChoiceRevision) { path.value = selected; invalidateWorkspace(); }
    } catch (error) { byId("workspace-choice-status").textContent = errorMessage(error); }
  });
}

function resourceUsagePercent(resource: ProviderResourceSummary): number | undefined {
  if (resource.usedPercent !== undefined && Number.isFinite(resource.usedPercent)) {
    return Math.max(0, Math.min(100, resource.usedPercent));
  }
  if (resource.softTokenBudget && resource.softTokenBudget > 0) {
    return Math.max(0, Math.min(100, (resource.totalTokens / resource.softTokenBudget) * 100));
  }
  return undefined;
}

/** Sidebar shortcut shows the same quota observations as Resources, not a
 * catalog of model token totals (which are not subscription rate limits). */
function renderResourceUsageDialog(resource: ProviderResourceSummary): void {
  byId("resource-usage-dialog-title").textContent = `${resource.providerLabel} · 使用枠`;
  const body = byId("resource-usage-dialog-body"); body.replaceChildren();
  body.append(buildServiceAccountCard(accountResourceGroups([resource])[0]));
  const connections = serviceElement("button", "サービスを開く", "secondary-button compact");
  connections.type = "button"; connections.onclick = () => {
    closeResourceUsageDialog(); serviceEnvironment = resource.environmentId ?? "local"; openServiceSettings(resource.agentIds[0]);
  };
  body.append(connections);
}

function openResourceUsageDialog(providerKey: string): void {
  const group = accountResourceGroups(state.resources).find(g => g.key === providerKey || g.members.some(r => r.providerKey === providerKey));
  const resource = group?.quota;
  if (!resource) return;
  resourceDialogProviderKey = group!.key;
  renderResourceUsageDialog(resource);
  const dialog = byId<HTMLDialogElement>("resource-usage-dialog");
  if (!dialog.open) dialog.showModal();
}

function closeResourceUsageDialog(): void {
  const dialog = byId<HTMLDialogElement>("resource-usage-dialog");
  resourceDialogProviderKey = undefined;
  if (dialog.open) dialog.close();
}

function renderResourceSummary(): void {
  renderServiceStatus();
  const summary = byId<HTMLDivElement>("resource-summary");
  summary.replaceChildren();

  const label = document.createElement("span");
  label.className = "resource-summary-label";
  label.textContent = "レートリミット・使用枠";
  summary.append(label);
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "secondary-button compact";
  refresh.textContent = "更新";
  refresh.addEventListener("click", () => byId<HTMLButtonElement>("refresh-capacity").click());
  summary.append(refresh);
  const task = state.currentView === "tasks" ? state.tasks.find(t => t.id === state.selectedTaskId) : undefined;
  const environmentId = task?.remote?.id ?? (state.currentView === "usage" ? serviceEnvironment : "local");
  const scope = serviceElement("span", task ? `このタスクの環境：${task.remote?.name ?? "このMac"}` : `表示環境：${environmentId ? remoteSystemsList.find(s => s.id === environmentId)?.name ?? "このMac" : "すべて"}`, "sidebar-usage-scope");
  summary.append(scope);

  const items = document.createElement("div");
  items.className = "resource-summary-items";
  if (state.resources.length === 0) {
    const empty = document.createElement("span");
    empty.className = "resource-summary-empty";
    empty.textContent = "状態は未取得です。「サービス」で確認できます。";
    items.append(empty);
    summary.append(items);
    return;
  }

  for (const group of accountResourceGroups(state.resources)) {
    const resource = group.quota;
    if (environmentId && (resource.environmentId ?? "local") !== environmentId) continue;
    const item = document.createElement("button");
    item.type = "button";
    const fresh = quotaIsFresh(resource);
    // Quota color must not inherit an SSH-disconnected / CLI-disabled status.
    const availability = serviceAvailability(resource, task);
    item.className = `resource-summary-item ${availability.tone === "ready" ? "available" : availability.tone === "blocked" ? "unavailable" : "warning"}${fresh ? "" : " stale-quota"}`;
    const percent = resourceUsagePercent(resource);
    const percentText = percent === undefined ? "—" : `${percent.toFixed(0)}%`;
    const resetText = resource.resetAt ? ` · リセット ${new Date(resource.resetAt).toLocaleString()}` : "";
    item.title = `${resource.providerLabel}: ${percent === undefined ? "使用枠未取得" : `使用 ${percent.toFixed(1)}%`}${resetText}`;
    item.addEventListener("click", () => openResourceUsageDialog(group.key));

    const dot = document.createElement("span");
    dot.className = "resource-summary-dot";
    const provider = document.createElement("span");
    provider.className = "resource-summary-provider";
    provider.textContent = `${resource.agentIds[0] ? agentLabel(resource.agentIds[0]) : serviceLabelOf(resource)}${!environmentId ? ` · ${resource.environmentLabel ?? "このMac"}` : ""}`;
    const value = document.createElement("span");
    value.className = "resource-summary-value";
    value.textContent = resource.windows.length || resource.usedPercent !== undefined ? fresh ? "観測値" : "前回値" : "未取得";
    item.append(dot, provider, value);
    const status = serviceElement("span", availability.label, "sidebar-cli-status"); status.title = availability.reason; item.append(status);
    const windows = document.createElement("span");
    windows.className = "sidebar-quota-windows";
    // Keep every reported bucket expanded, including old observations. The
    // previous-value warning and timestamps distinguish them from live quota;
    // displaying a value never refreshes it or changes routing eligibility.
    for (const window of [...resource.windows].sort((a, b) => Number(a.scope === "model") - Number(b.scope === "model"))) {
      const row = document.createElement("span");
      row.className = "sidebar-quota-window";
      const name = document.createElement("span");
      const period = resource.agentIds.includes("claude") ? window.label : formatLimitDuration(window.windowMinutes) || window.label;
      const model = window.scope === "model" ? window.model : undefined;
      name.textContent = [model && !period.includes(model) ? model : "", period].filter(Boolean).join(" · ");
      const used = document.createElement("strong");
      used.textContent = `${window.usedPercent.toFixed(1)}%`;
      row.title = `${fresh ? "観測値" : "前回値（最新ではありません）"} · ${name.textContent}: ${used.textContent} 使用${window.resetAt ? ` · リセット ${new Date(window.resetAt).toLocaleString()}` : ""}`;
      const bar = document.createElement("span");
      bar.className = "resource-summary-meter";
      const progress = document.createElement("span");
      progress.style.width = `${Math.max(0, Math.min(100, window.usedPercent))}%`;
      bar.append(progress);
      row.append(name, used, bar);
      const reset = document.createElement("span");
      reset.className = "sidebar-quota-reset";
      reset.textContent = window.resetAt
        ? `${Date.parse(window.resetAt) <= Date.now() ? "前回のリセット予定" : "リセット"}：${new Date(window.resetAt).toLocaleString("ja-JP", {
          month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short"
        })}` : window.resetText ?? "リセット日時未報告";
      row.append(reset);
      if (window.detail) { const detail = document.createElement("span"); detail.className = "sidebar-usage-meta"; detail.textContent = window.detail; row.append(detail); }
      if (window.observedAt && window.observedAt !== resource.capacityUpdatedAt) {
        const age = document.createElement("span"); age.className = "sidebar-usage-meta";
        age.textContent = `前回値 ${new Date(window.observedAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
        row.append(age);
      }
      windows.append(row);
    }
    if (!resource.windows.length) {
      const unknown = document.createElement("span");
      unknown.textContent = percent === undefined ? "使用枠未取得（CLIの利用可否とは別）" : `${fresh ? "報告使用率" : "前回の使用率"}：${percentText}`;
      windows.append(unknown);
    }
    if (!fresh && (resource.windows.length || percent !== undefined)) windows.append(serviceElement("span", "前回値（最新の使用量は未確認）", "sidebar-usage-meta"));
    const updated = document.createElement("span");
    updated.className = "sidebar-usage-meta";
    updated.textContent = `取得：${resource.capacityUpdatedAt ? new Date(resource.capacityUpdatedAt).toLocaleString("ja-JP", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }) : "—"}`;
    updated.title = resource.capacityUpdatedAt ? new Date(resource.capacityUpdatedAt).toLocaleString() : "未取得";
    item.append(windows, updated);
    if (resource.agentIds.includes("antigravity")) {
      if (!resource.windows.length && percent === undefined) windows.textContent = "契約残量: 未取得 · CLIで確認";
    }
    if (resource.providerKey === "ollama-cloud" && resource.creditBalance) { const balance = document.createElement("span"); balance.className = "sidebar-usage-meta"; balance.textContent = resource.creditBalance; item.append(balance); }
    if (resource.capacityError) {
      const error = document.createElement("span");
      error.className = "sidebar-usage-error";
      error.textContent = resource.providerKey === "ollama-cloud" ? `残量取得失敗 · ${resource.capacityUpdatedAt && resource.limitSource !== "unknown" ? "前回値" : "未確認"} · CLI認証とは別` : resource.capacityRetryAt
        ? `取得制限/失敗 · 再試行 ${new Date(resource.capacityRetryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "使用枠の取得失敗 · CLI認証とは別";
      error.title = resource.capacityError;
      item.append(error);
    }
    items.append(item);
  }
  if (!items.childElementCount) items.append(serviceElement("span", "この環境の状態は未取得です。「サービス」で接続・CLIを確認できます。", "resource-summary-empty"));
  summary.append(items);
  const dialog = byId<HTMLDialogElement>("resource-usage-dialog");
  if (dialog.open && resourceDialogProviderKey) {
    const selected = accountResourceGroups(state.resources).find(g => g.key === resourceDialogProviderKey)?.quota;
    if (selected) renderResourceUsageDialog(selected);
    else closeResourceUsageDialog();
  }
}

function taskAgentText(task: TaskRecord): string {
  if (task.legacySingleAgent) return `${agentLabel(task.allowedAgentIds[0])} · legacy`;
  const used = [...new Set(task.runs.map((run) => run.agentId))];
  return used.length ? used.map(agentLabel).join(" → ") : `${task.allowedAgentIds.length} agents · ${task.strategy}`;
}

function ensureSelectedTask(): void {
  if (state.tasks.some((task) => task.id === state.selectedTaskId)) return;
  state.selectedTaskId = state.tasks.find(taskIsActive)?.id ?? state.tasks[0]?.id;
}

function renderTasks(): void {
  const list = byId<HTMLDivElement>("task-list");
  byId<HTMLSpanElement>("task-count").textContent = String(state.tasks.length);
  ensureSelectedTask();
  list.replaceChildren();
  if (state.tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "task-tabs-empty";
    empty.textContent = "No task tabs";
    list.append(empty);
  }
  for (const task of state.tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.setAttribute("aria-selected", String(task.id === state.selectedTaskId));
    button.setAttribute("aria-controls", "task-detail");
    button.className = `task-tab ${task.state}${task.id === state.selectedTaskId ? " selected" : ""}`;
    button.dataset.displayState = taskDisplayStatus(task).tone;
    const dot = document.createElement("span");
    dot.className = "task-tab-dot";
    const title = document.createElement("span");
    title.className = "task-tab-title";
    title.textContent = task.title;
    const badge = document.createElement("span");
    badge.className = "task-tab-state";
    badge.textContent = taskDisplayStatus(task).label;
    button.title = `${task.title}\n${taskAgentText(task)}\n${badge.textContent}`;
    button.append(dot, title, badge);
    button.addEventListener("keydown", event => {
      const index = state.tasks.indexOf(task);
      const target = event.key === "ArrowDown" ? (index + 1) % state.tasks.length : event.key === "ArrowUp" ? (index + state.tasks.length - 1) % state.tasks.length : event.key === "Home" ? 0 : event.key === "End" ? state.tasks.length - 1 : -1;
      if (target < 0) return;
      event.preventDefault();
      (list.querySelectorAll<HTMLButtonElement>(".task-tab")[target]).click();
      list.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
    button.addEventListener("click", () => {
      state.selectedTaskId = task.id;
      showView("tasks");
      renderTasks();
      renderDetail();
    });
    list.append(button);
  }
  renderQueue();
}

function usageText(usage?: UsageRecord): string {
  if (!usage || usage.source === "unknown") return "使用量：未取得";
  const fields = [
    usage.inputTokens !== undefined ? `入力 ${formatTokens(usage.inputTokens)}` : "",
    usage.cachedInputTokens !== undefined ? `キャッシュ ${formatTokens(usage.cachedInputTokens)}` : "",
    usage.outputTokens !== undefined ? `出力 ${formatTokens(usage.outputTokens)}` : "",
    usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : ""
  ].filter(Boolean);
  return `使用量（${usage.source === "estimated" ? "推定" : "報告値"}）：${fields.join(" · ") || "取得済み"}`;
}

const workflowCollapsed = new Set<string>();
function buildWorkflow(task: TaskRecord): HTMLElement {
  const section = document.createElement("details");
  section.open = !workflowCollapsed.has(task.id);
  section.addEventListener("toggle", () => { if (!section.isConnected) return; if (section.open) workflowCollapsed.delete(task.id); else workflowCollapsed.add(task.id); });
  section.className = "workflow-section";
  const heading = document.createElement("summary");
  heading.className = "workflow-heading";
  const title = document.createElement("h3");
  title.textContent = "工程・担当";
  const note = document.createElement("span");
  note.textContent = task.legacySingleAgent ? "旧版から引き継いだタスク" : `${task.workflowMode === "primary" ? "主担当方式 · 独立レビュー" : "工程分離方式"} · ${{balanced:"バランス重視",quality:"品質重視","quota-saver":"使用枠の節約重視"}[task.strategy]}`;
  heading.append(title, note);
  section.append(heading);
  // Coordination details remain in 計画・担当; keep this small pane for the
  // actual dependency graph/timeline instead of duplicating the status panel.
  section.append(buildWorkflowVisualization(task));
  return section;
}


function renderRuns(task: TaskRecord): HTMLElement {
  const container = document.createElement("div");
  container.className = "run-history";
  const title = document.createElement("h3");
  title.textContent = "Agent runs";
  container.append(title);
  if (!task.runs.length) {
    const empty = document.createElement("p");
    empty.textContent = "No agent runs yet.";
    container.append(empty);
    return container;
  }
  for (const run of [...task.runs].reverse()) {
    const row = document.createElement("div");
    row.className = `run-row ${run.state}`;
    const identity = document.createElement("strong");
    identity.textContent = `${agentLabel(run.agentId)} · ${run.role}`;
    const details = document.createElement("span");
    const tokens = (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
    details.textContent = `${run.model ?? "default model"} · ${runStatusLabel(task, run)}${tokens ? ` · ${formatTokens(tokens)} tokens` : ""}${run.subagentCount ? ` · ${run.subagentCount} internal subagent${run.subagentCount === 1 ? "" : "s"}` : ""}`;
    row.append(identity, details);
    if (run.error) row.title = run.error;
    container.append(row);
  }
  return container;
}




function buildTaskOverview(task: TaskRecord): HTMLElement {
  const body = document.createElement("div");
  body.className = "detail-body summary-only";
  const context = document.createElement("div"); context.className = "task-context-summary";
  const mode = document.createElement("span"); mode.textContent = task.workPreset?.manifest.name ?? "カスタムタスク";
  context.append(mode);
  if (task.workflowMode === "primary" && task.goal?.status !== "draft") {
    const strategy = document.createElement("span"); strategy.className = "task-context-strategy";
    const review = taskReviewAdjustment(task);
    strategy.textContent = `${task.execution?.scheduling === "throughput" ? "効率重視" : "通常"} · 最大${task.execution?.maxParallel ?? 2}並列 · ${review ? `独立レビュー${review.mode === "single" ? 1 : 2}回（時間調整）` : task.execution?.reviewMode === "parallel" ? "並列レビュー＋統括" : task.execution?.reviewMode === "cross-service" ? "クロスレビュー" : "2回レビュー"}${task.pendingExecution ? ` · 変更予約あり（次工程から最大${task.pendingExecution.policy.maxParallel}並列）` : ""}`;
    context.append(strategy);
  }
  body.append(context);
  const references = document.createElement("section"); references.className = "task-rule-references";
  const heading = document.createElement("h3"); heading.textContent = "適用ルール（参照）"; references.append(heading);
  if (task.workPreset) references.append(buildTaskPreset(task));
  const finishingStatus = buildFinishingStatus(task);
  if (finishingStatus) references.append(finishingStatus);
  if (task.goal) {
    body.append(buildGoalEditor(task));
    if (references.childElementCount > 1) body.append(references);
    return body;
  }
  const instructions = document.createElement("div");
  instructions.className = "instructions";
  const instructionsTitle = document.createElement("h3");
  instructionsTitle.textContent = "Objective";
  const prompt = document.createElement("p");
  prompt.textContent = task.prompt;
  const facts = document.createElement("div");
  facts.className = "facts";
  const entries = [
    ["Allowed", task.allowedAgentIds.map(agentLabel).join(", ")],
    ["Runs", String(task.runs.length)],
    ["Report", task.report?.state ?? "not generated"]
  ];
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    row.className = "fact";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("span");
    val.textContent = value;
    val.title = value;
    row.append(key, val);
    facts.append(row);
  }
  if (task.error) {
    const error = document.createElement("p");
    error.className = "report-error";
    error.textContent = task.error;
    facts.append(error);
  }
  instructions.append(instructionsTitle, prompt, facts, renderRuns(task));
  const usage = document.createElement("div");
  usage.className = "usage-line summary-usage";
  usage.textContent = usageText(task.usage);
  instructions.append(usage);
  body.append(instructions);
  if (references.childElementCount > 1) body.append(references);
  return body;
}

function buildTaskExecution(task: TaskRecord): HTMLElement {
  const content = document.createElement("div");
  content.className = "task-execution-view";
  const workflow = buildWorkflow(task);
  content.append(workflow, paneSplitter(`workflow:${task.id}`, workflow, "top", 32, () => content.clientHeight * .6), buildAgentTerminals(task));
  return content;
}

function buildTaskPanelTabs(task: TaskRecord): HTMLElement {
  const selected = state.selectedTaskPanels.get(task.id) ?? "overview";
  state.selectedTaskPanels.set(task.id, selected);
  const tabs = document.createElement("div");
  tabs.className = "task-panel-tabs";
  tabs.setAttribute("role", "tablist");
  const labels: Array<[TaskPanel, string]> = [["overview", "概要"], ["execution", "実行"], ["work-report", "作業報告"], ["evidence", "成果・検証"], ["report", "レポート"], ["history", "履歴"]];
  if (task.goal?.status !== "draft") labels.splice(1, 0, ["goal", "目的・条件"], ["plan", "計画・担当"]);
  const selectedGroup = selected === "goal" && task.goal?.status === "draft" ? "overview" : taskPanelGroup(selected);
  for (const [id, label] of labels) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.role = "tab";
    tab.className = `task-panel-tab${selectedGroup === id ? " selected" : ""}`;
    tab.setAttribute("aria-selected", String(selectedGroup === id));
    tab.textContent = label;
    tab.addEventListener("click", () => {
      state.selectedTaskPanels.set(task.id, id);
      renderDetail();
    });
    tabs.append(tab);
  }
  return tabs;
}

function renderDetail(): void {
  pruneTerminalViews();
  const panel = byId<HTMLElement>("task-detail");
  const planScroll = panel.querySelector<HTMLElement>(".task-panel-content.plan")?.scrollTop;
  const priorDecision = panel.querySelector<HTMLElement>(".task-decision-notice");
  const decisionScroll = priorDecision && priorDecision.dataset.taskId === state.selectedTaskId ? priorDecision.scrollTop : undefined;
  const historyScroll = panel.querySelector<HTMLElement>(".task-panel-content.history")?.scrollTop;
  const progressScroll = panel.querySelector<HTMLElement>(".task-panel-content.overview, .task-panel-content.evidence, .task-panel-content.followup")?.scrollTop;
  const focused = document.activeElement;
  const focusedTerminal = [...terminalViews.values()].find((view) => focused && view.host.contains(focused));
  const composing = focused instanceof HTMLElement && focused.closest(".followup-composer, .goal-editor, .execution-settings") ? focused : undefined;
  const focusLabel = composing?.getAttribute("aria-label");
  const caret = composing instanceof HTMLTextAreaElement || composing instanceof HTMLInputElement ? composing.selectionStart : null;
  const task = state.tasks.find((item) => item.id === state.selectedTaskId);
  if (!task) {
    panel.classList.add("empty");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "›_";
    const title = document.createElement("h2");
    title.textContent = "タスクを選んでください";
    const note = document.createElement("p");
    note.textContent = "左の「新しいタスク」から作業を依頼できます。";
    empty.append(icon, title, note);
    panel.replaceChildren(empty);
    return;
  }
  panel.classList.remove("empty");
  panel.replaceChildren();
  const header = document.createElement("div");
  header.className = "detail-header";
  const heading = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `${historyInstructionLabel(task.roundNumber ?? 1)} · ${taskDisplayStatus(task).label}`;
  const title = document.createElement("h2");
  title.textContent = task.title;
  const environment = document.createElement("section");
  environment.className = "task-environment-details";
  environment.setAttribute("aria-label", "作業場所・実行設定");
  // Keep the path and selected settings distinct; long explanations belong in
  // tooltips, while important permission warnings remain visible below.
  const setting = (label: string, value: string, className = "") => {
    const item = document.createElement("span"); item.className = `task-setting ${className}`;
    const key = document.createElement("span"); key.className = "task-setting-label"; key.textContent = label;
    const text = document.createElement("span"); text.textContent = value;
    item.append(key, text); environment.append(item); return item;
  };
  const remote = task.remote;
  const path = remote?.preparedTarget?.cwd ?? remote?.cwd ?? task.cwd;
  const location = setting(remote ? `SSH · ${remote.name}` : "作業場所 · このMac", path, "task-setting-path");
  location.title = remote ? `${remote.preparedTarget ? `${remote.preparedTarget.username}@${remote.preparedTarget.hostname}` : remote.host}:${path}${remote.connectionMode === "prepared" && !remote.preparedTarget ? "（最終マシン未確定）" : ""}` : path;
  if(remote?.connectionMode==="prepared") {
    const change=document.createElement("button");change.type="button";change.className="secondary-button compact";change.textContent="最初のログイン先を変更…";
    change.disabled=taskIsActive(task);change.title="最初のSSH接続先だけを変更します。その先の作業マシン・フォルダ・ゴール・履歴は保持します。";
    change.onclick=()=>showTaskLoginRoute(task);environment.append(change);
  }
  if (remote?.connectionMode === "prepared" && !remote.preparedTarget) setting("接続", "最終マシン未確定");
  if (task.workPreset) setting("モード", task.workPreset.manifest.name);
  setting("方針", {balanced:"バランス",quality:"品質重視","quota-saver":"使用枠を節約"}[task.strategy]);
  setting("Git", "必須").title = "開始・再開時に確認し、未管理なら初期化。各担当が作業単位でコミットします（自動pushなし）。";
  heading.className = "task-heading";
  const titleLine = document.createElement("div"); titleLine.className = "task-title-line";
  titleLine.append(title, buildExecutionMetrics(task));
  heading.append(eyebrow, titleLine);
  if (task.remote) setting("PDF生成", "遠隔側").title = "タスクの作業場所で生成し、このMacでプレビューします。";
  if ((task.remote ? task.remote.codexPermissions : task.localCodexPermissions) === "full-access") {
    setting("Codex権限", "Full access（作業場所外も操作可能）").title = "承認要求なし。読み取り担当もOSによる書き込み制限はありません。変更は「目的・条件」のタスク設定から行えます。";
  }
  if (task.restart) {
    const origin = document.createElement("p");
    origin.className = "task-environment-note";
    origin.textContent = `${task.restart.mode === "carry" ? "前回の作業を引き継ぎ" : "空の作業フォルダから再計画"} · ゴール・設定は保持 · 実行予算はこのタスクで新しく計測`;
    environment.title = origin.textContent;
  }
  const actions = document.createElement("div");
  actions.className = "detail-actions task-actions";
  actions.setAttribute("aria-label", "タスクの操作");
  const taskSettings = document.createElement("section"); taskSettings.className = "task-settings-actions";
  taskSettings.append(progressNode("h3", "このタスクの設定"), progressNode("p", "システム設定は新規タスクの初期値です。ここでの変更はこのタスクだけに適用します。", "progress-meta"));
  const configuration = document.createElement("div"); configuration.className = "detail-actions"; configuration.setAttribute("aria-label", "このタスクの設定"); taskSettings.append(configuration);
  if (taskIsActive(task)) {
    const cancel = document.createElement("button");
    cancel.className = "danger-button";
    cancel.type = "button";
    cancel.textContent = "一時停止";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        const accepted = await api.cancelTask(task.id);
        showToast(accepted ? "一時停止を要求しました。現在の処理の停止を待っています。" : "このタスクは現在実行されていません。表示を更新しました。");
      } catch (error) { showToast(errorMessage(error)); }
      finally { cancel.disabled = false; }
    });
    actions.append(cancel);
  } else if (legacyWorkLimit(task) || task.resumeFromUnitId || ["queued", "blocked", "paused"].includes(task.state) || (task.state === "awaiting-input" && task.awaitingReason === "plan")) {
    const run = document.createElement("button");
    run.className = "primary-button";
    run.type = "button";
    run.disabled = taskIsActive(task);
    run.textContent = task.resumeFromUnitId ? "中断した工程から再開" : task.awaitingReason === "plan" ? "計画を承認して続行" : task.state === "blocked" ? "割り当てを再試行" : task.state === "paused" ? "再開" : "実行";
    if (legacyWorkLimit(task)) run.textContent = "残課題を記録して仕上げへ";
    if (task.resumeFromUnitId) run.title = `再開工程：${task.workUnits.find(u => u.id === task.resumeFromUnitId)?.title ?? "中断工程"}。完了済み工程とファイル・ログは保持します。`;
    if (task.pendingFollowup) {
      run.textContent = "元の作業を再開";
      run.title += " 保存した追加指示は適用せず、次回用に保持します。";
    }
    if (task.reportRecovery?.kind === "prerequisite") {
      run.textContent = "不足する確認を再計画して続行";
      run.disabled = !task.reportRecovery.canReplan;
      run.title = task.reportRecovery.unavailableReason ?? "主担当が不足する確認担当を配置し、確認・統合後にレポーターと最終レビューへ進めます。";
    }
    if (task.reportRecovery?.resumeStage === "paper") {
      run.textContent = "論文執筆から再開";
      run.title = "省略された論文執筆を同じタスク内で復帰します。既存の実験・履歴・未確認事項を保持し、執筆・PDF・独立レビューへ進みます。";
    }
    run.addEventListener("click", async () => {
      run.disabled = true;
      try {
        if (legacyWorkLimit(task) || task.resumeFromUnitId) await api.resumeTask(task.id);
        else await api.runTask(task.id);
      } catch (error) {
        showToast(errorMessage(error));
        run.disabled = false;
      }
    });
    actions.append(run);
    if (task.pendingFollowup) {
      const followup = progressButton("保存した追加指示を確認…", () => {
        const input = panel.querySelector<HTMLTextAreaElement>(".followup-composer textarea");
        input?.scrollIntoView({ block: "center" }); input?.focus();
      });
      followup.title = "内容を確認し、「続ける」で同じタスクの次の作業を開始します。";
      actions.append(followup);
    }
  }
  if (!task.resumeFromUnitId && task.state === "awaiting-input" && task.awaitingReason === "result" && task.reviewPolicy && task.autonomyState === "satisfied" && (taskReviewAdjustment(task)?.mode === "single" ? [1] : [1, 2]).every(pass => task.workUnits.some(u => u.reviewPass === pass && u.state === "completed"))) {
    const complete = document.createElement("button"); complete.type = "button";
    complete.className = "secondary-button"; complete.textContent = "タスクを完了にする";
    complete.addEventListener("click", async () => {
      try { await api.completeTask(task.id); } catch (error) { showToast(errorMessage(error)); }
    });
    actions.append(complete);
  }
  if (task.workflowMode === "primary" && task.goal?.status !== "draft") {
    const strategy = progressButton("実行戦略…", () => showTaskExecutionSettings(task));
    strategy.title = "並列数・分担方針・予算を変更。保存後、次の工程から反映します。";
    configuration.append(strategy);
  }
  if (task.goal?.status !== "draft") {
    const next = progressButton("担当・確認設定…", () => openTaskPanel(task, "followup"));
    next.title = "追加指示の担当CLI・モデル・計画の確認方法を設定します。";
    configuration.append(next);
  }
  if (!task.runs.some(r => !r.goalPreparation) && task.state !== "completed") {
    const initial = task.initialAssignment?.round === (task.roundNumber ?? 1) ? task.initialAssignment : undefined;
    const startCli = progressButton(initial?.agentId ? `開始時のCLI：${agentLabel(initial.agentId)}…` : "開始時のCLI…", () => showInitialCliSettings(task));
    startCli.disabled = taskIsActive(task) || task.workUnits.some(u => u.state === "running");
    startCli.title = startCli.disabled ? "AIのゴール案作成などが終わってから変更できます。起動済みの担当は変更しません。"
      : "本作業の最初のCLI・モデルを変更します。保存だけでは開始しません。";
    configuration.append(startCli);
  }
  const deleteButton = document.createElement("button");
  if (task.remote || task.allowedAgentIds.includes("codex")) {
    // Permission selection must also be available before the goal is approved;
    // recovery/diagnosis itself requires an executable, approved work unit.
    const permissions = document.createElement("button"); permissions.type = "button";
    permissions.className = "secondary-button"; permissions.textContent = task.remote ? "遠隔Codexの権限…" : "ローカルCodexの権限…";
    permissions.disabled = taskIsActive(task);
    permissions.title = "停止中に変更できます。次回のCodex起動から適用します。";
    permissions.addEventListener("click", () => showEnvironmentRecovery(task, true)); configuration.append(permissions);
  }
  if (task.remote && task.goal?.status === "approved" && !task.goalPreparation && !taskIsActive(task)
    && ["paused", "blocked", "failed", "cancelled", "awaiting-input"].includes(task.state)) {
    const recover = document.createElement("button"); recover.type = "button";
    recover.className = "secondary-button"; recover.textContent = "実行環境を復旧…";
    recover.disabled = state.queue.running;
    recover.addEventListener("click", () => showEnvironmentRecovery(task)); actions.append(recover);
  }
  // Approved tasks use the single entry point in the follow-up composer.
  // Draft/legacy tasks still need access because they have no usable composer.
  if ((!task.goal || task.goal.status === "draft") && ["completed", "paused", "blocked", "failed", "cancelled", "awaiting-input"].includes(task.state) && !task.goalPreparation && !taskIsActive(task)) {
    const restart = document.createElement("button"); restart.type = "button";
    restart.className = "secondary-button"; restart.textContent = "別タスクに分ける…";
    restart.disabled = taskIsActive(task);
    restart.addEventListener("click", () => showRestartDialog(task, "carry")); actions.append(restart);
  }
  deleteButton.className = "danger-button compact delete-task-button";
  deleteButton.type = "button";
  const active = taskIsActive(task);
  deleteButton.disabled = active;
  deleteButton.textContent = "タスクを削除";
  deleteButton.title = active ? "一時停止してから削除できます。" : "タスクの管理記録を削除します。生成ファイルは保持します。";
  deleteButton.addEventListener("click", async () => {
    if (!window.confirm(`「${task.title}」を削除しますか？\n\nタスクの履歴は削除します。生成された成果物・レポートのファイルは保持します。`)) return;
    deleteButton.disabled = true;
    try {
      state.tasks = await api.deleteTask(task.id);
      forgetTaskTerminalSelections(task);
      forgetTaskReportSelections(task.id);
      state.selectedTaskPanels.delete(task.id);
      hpcDrafts.delete(task.id); hpcSnapshots.delete(task.id);
      state.selectedTaskId = undefined;
      ensureSelectedTask();
      renderTasks();
      renderDetail();
      showToast("タスクの管理記録を削除しました。成果物ファイルは保持しています。");
    } catch (error) {
      deleteButton.disabled = false;
      showToast(errorMessage(error));
    }
  });
  // Keep deletion discoverable before goal approval and on every task tab.
  // A visible disabled control explains why active work cannot be deleted.
  const headerTop = document.createElement("div"); headerTop.className = "task-header-top";
  headerTop.append(heading, deleteButton);
  for (const button of actions.querySelectorAll("button")) button.classList.add("compact");
  header.append(headerTop, environment, actions);

  const decision = taskUserDecision(task);
  const savedBlocker = task.executionBlocker;
  const environmentBlocker = savedBlocker && savedBlocker.round === (task.roundNumber ?? 1)
    && savedBlocker.cycle === (task.autonomyCycle ?? 1) && savedBlocker.goalRevision === task.goal?.revision
    && task.workUnits.some(u => u.id === savedBlocker.unitId) ? savedBlocker : undefined;
  const stopNotice = document.createElement("details");
  stopNotice.className = "task-stop-notice";
  const finishedClosure = taskHasFinishedWorkReport(task) && !!taskPartialClosure(task)?.finishedAt;
  if (task.error && !finishedClosure && ["awaiting-input", "blocked", "paused", "failed"].includes(task.state)) {
    const summary = document.createElement("summary");
    const userPaused = task.state === "paused" && (task.error === "Paused by the user. Resume the workflow to continue."
      || task.error === "ユーザーの操作で一時停止しています。「中断した工程から再開」で未完了の作業を続けられます。");
    const reason = userPaused ? "ユーザー操作による一時停止です。障害や追加の承認待ちではありません。" : reportStopReason(task);
    const stoppedUnit = legacyWorkLimit(task)
      ? [...task.workUnits].reverse().find(u => (u.primary || u.checkpointFor) && u.state === "completed" && !u.planPhase)
      : task.workUnits.find(u => u.id === task.resumeFromUnitId) ?? task.workUnits.find(u => ["blocked", "failed"].includes(u.state));
    summary.append(document.createTextNode(`${userPaused ? "一時停止中" : "停止中"}${stoppedUnit ? ` · ${stoppedUnit.title}` : ""}（原因・対応）`));
    const guidance = taskStopGuidance(task);
    const shortReason = guidance.reason || conciseTaskFailure(reason);
    const reasonPreview = progressNode("span", `：${shortReason}`, "stop-reason-preview");
    summary.append(reasonPreview);
    const detail = document.createElement("p"); detail.textContent = shortReason;
    const next = document.createElement("p");
    next.textContent = userPaused ? (task.pendingFollowup
      ? "「元の作業を再開」で未完了工程を続けます。保存済みの追加指示はそのまま保持し、適用しません。追加指示を適用する場合は、下の入力欄で内容を確認して「続ける」を押してください。"
      : "上の「中断した工程から再開」で続けられます。完了済みの作業と成果物は保持しています。復旧内容の入力は不要です。")
      : guidance.next;
    stopNotice.open = true;
    stopNotice.append(summary, detail, next);
    if (!decision && guidance.action) {
      const action = progressButton(guidance.action === "answer" ? "追加指示を入力" : guidance.action === "services" ? "対象サービスを確認" : "対象端末を確認", () => {
        if (guidance.action === "execution") openTaskPanel(task, "execution");
        else if (guidance.action === "services") {
          serviceEnvironment = task.remote?.id ?? "local"; showView("usage");
        } else { const input = panel.querySelector<HTMLTextAreaElement>(".followup-composer textarea"); input?.focus(); }
      });
      stopNotice.append(action);
    }
    if (environmentBlocker) {
      stopNotice.open = true;
      summary.textContent = "停止中 — 必須の実行環境を利用できません";
      detail.textContent = environmentBlocker.summary;
      next.textContent = `${environmentBlocker.recovery} 完了済みの成果は保持しています。復旧後は同じ工程で必要な機能を再確認し、後続工程を続けます。`;
      if (environmentBlocker.check) {
        const check = document.createElement("details");
        check.append(progressNode("summary","失敗した確認"),progressNode("p",environmentBlocker.check));
        stopNotice.append(check);
      }
    }
    if (!decision && reason !== shortReason) {
      const raw = document.createElement("details"); raw.className = "decision-original";
      raw.append(progressNode("summary", "詳細な記録"), progressNode("p", reason)); stopNotice.append(raw);
    }
    if (legacyWorkLimit(task)) next.textContent = "上の「残課題を記録して仕上げへ」で、再作業を繰り返さずレポートと独立レビューへ進みます。未達項目は合格に変更しません。";
    if (decision) {
      stopNotice.open = true;
      stopNotice.classList.add("task-decision-notice");
      stopNotice.dataset.taskId = task.id;
      summary.textContent = "回答待ち — 作業方針の確認が必要です";
      const answer = document.createElement("button"); answer.type = "button"; answer.className = "secondary-button compact"; answer.textContent = "回答欄へ";
      answer.onclick = event => { event.preventDefault(); stopNotice.open = true; const input = panel.querySelector<HTMLTextAreaElement>(".followup-composer textarea"); input?.scrollIntoView({block:"nearest"}); input?.focus({preventScroll:true}); };
      summary.append(answer);
      detail.textContent = decision.reason;
      const questionTitle = document.createElement("h3"); questionTitle.textContent = "確認したいこと";
      const question = document.createElement("p"); question.className = "decision-question"; question.textContent = decision.question;
      const raw = document.createElement("details"); raw.className = "decision-original";
      const rawTitle = document.createElement("summary"); rawTitle.textContent = "担当の報告全文（実施済みの作業・根拠）";
      const rawText = document.createElement("p");
      const report = [...task.workUnits].reverse().map(reportedWorkOutcome).find(Boolean);
      rawText.textContent = report ? `${report.summary}\n${report.remainingWork ?? ""}` : reason;
      raw.append(rawTitle, rawText);
      next.textContent = "下の欄に回答して続行してください。合格条件自体を変える場合は「合格条件・制約を変更…」で対象の条件と検証方法を編集し、承認します。回答だけでは合格条件は変わりません。";
      stopNotice.insertBefore(questionTitle, next); stopNotice.insertBefore(question, next); stopNotice.append(raw);
    }
    // A pending reporter is the destination of a closure handoff, not the
    // cause of the worker retry cap. Keep one recovery action for that cap.
    if (!environmentBlocker && !legacyWorkLimit(task) && task.resumeFromUnitId && task.workUnits.some(u => u.id === task.resumeFromUnitId && u.role === "reporter")) {
      const issue = task.reportRecovery;
      const downloadFailure = /遠隔レポートのローカル取得に失敗|取得先が通常ファイルではありません/.test(task.error ?? "");
      next.textContent = downloadFailure
        ? "遠隔レポートをこのMacへ取得する段階で停止しました。TeXビルド失敗を示すエラーではありません。表示されたローカル保存先の競合や権限を確認してください。旧プレビューのファイルリンクは更新後の取得処理で安全に置き換えます。同じレポーター工程から再開できます。SSHが切断されている場合のみ再接続してください。"
        : `${task.remote ? "次のレポーターはタスクの遠隔作業環境でTeX・PDFを生成します。SSHへ再接続し、遠隔側のTeX環境を確認してください。新しいPDFの生成・確認は省略しません。" : ""}同じレポーター工程から再開できます。完了済み作業は保持し、PDF確認後にレビューへ進みます。`;
      const resume = document.createElement("button"); resume.textContent = "レポーターから再開";
      resume.disabled = taskIsActive(task);
      if (issue) {
        stopNotice.classList.add("task-report-recovery");
        summary.textContent = issue.kind === "prerequisite" ? "停止中 · レポートの前提確認が不足" : "停止中 · レポートの未完了事項";
        detail.textContent = issue.summary;
        const artifact = document.createElement("p"); artifact.className = "report-recovery-artifact";
        artifact.textContent = issue.pdfAvailable ? "PDFファイル：生成・更新を確認済み ／ 内容・仕上げの合格：未確定" : "PDFの生成状態と内容の合格は別です。既存PDFと完了済み成果は保持します。";
        const items = document.createElement("ul"); items.className = "report-recovery-concerns";
        for (const concern of issue.concerns) { const item = document.createElement("li"); item.textContent = concern; items.append(item); }
        stopNotice.insertBefore(artifact, next); stopNotice.insertBefore(items, next);
        next.textContent = issue.kind === "prerequisite"
          ? issue.unavailableReason ?? "次の操作：不足する確認を再計画して続行。主担当 → 資料取得・独立照合 → 原稿統合 → PDF・仕上げ確認 → 最終レビューの順に進めます。利用枠・予算・権限の条件は維持します。"
          : issue.kind === "user-input" ? "下の追加指示欄で、必要な資料や作業方針を回答してください。回答だけで合格条件を緩和することはありません。"
          : issue.kind === "environment" ? "接続・認証・必要なツールを復旧してから、レポーターを再開してください。資料不足は環境復旧だけでは解決しません。"
          : "記載された文章・組版・検証の不足をレポーターが修正します。追加資料があれば下の欄へ記入してください。";
        if (issue.kind === "prerequisite") { resume.textContent = "不足する確認を再計画して続行"; resume.disabled ||= !issue.canReplan; }
        if (issue.resumeStage === "paper") {
          resume.textContent = "論文執筆から再開";
          next.textContent = "次の操作：論文執筆から再開。既存の証拠から本文を作成し、指定形式への修正・PDF生成・独立レビューを順に実施します。過去の評価条件の登録不足は未確認として保持します。SSHが切断されている場合は先に再接続してください。";
        }
        if (issue.kind === "user-input") resume.hidden = true;
        const answer = document.createElement("button"); answer.className = "secondary-button"; answer.textContent = "追加資料・取得方法を入力";
        answer.onclick = () => { const input = panel.querySelector<HTMLTextAreaElement>(".followup-composer textarea"); input?.scrollIntoView({block:"center"}); input?.focus(); };
        const recoveryActions = document.createElement("div"); recoveryActions.className = "report-recovery-actions";
        recoveryActions.append(resume, answer); stopNotice.insertBefore(recoveryActions, artifact);
      }
      resume.onclick = async () => { resume.disabled = true; try { await api.resumeTask(task.id); } catch (e) { showToast(errorMessage(e)); resume.disabled = false; } };
      if (!issue) stopNotice.append(resume); stopNotice.open = true;
    }
  } else stopNotice.hidden = true;

  const selected = state.selectedTaskPanels.get(task.id) ?? "overview";
  const content = document.createElement("div");
  content.className = `task-panel-content ${selected}`;
  if (selected === "goal") content.append(taskSettings);
  if (selected === "overview") content.append(buildProgressOverview(task));
  if (selected === "goal") content.append(buildTaskOverview(task));
  if (selected === "evidence") content.append(buildTaskEvidence(task));
  if (selected === "work-report") content.append(buildTaskWorkReport(task));
  if (selected === "plan") content.append(buildExecutionPlanView(task));
  if (selected === "execution") content.append(buildTaskExecution(task));
  if (selected === "report") content.append(buildTaskReport(task));
  if (selected === "history") content.append(buildTaskHistory(task));
  if (selected === "followup") content.append(buildFollowupComposer(task, true));
  if (selected === "hpc") content.append(buildHpcView(task));
  if (selected === "research") content.append(buildResearchView(task));
  if (selected === "quality") content.append(buildQualityView(task));
  if (task.goal?.status === "draft" || selected === "followup") {
    panel.append(header, stopNotice, buildTaskPanelTabs(task), buildTaskDetailNavigation(task, selected), content);
  } else {
    const composer = buildFollowupComposer(task);
    if (decision) {
      stopNotice.append(composer);
      panel.append(header, stopNotice, buildTaskPanelTabs(task), buildTaskDetailNavigation(task, selected), content);
    } else panel.append(header, stopNotice, buildTaskPanelTabs(task), buildTaskDetailNavigation(task, selected), content,
        paneSplitter(`composer:${task.id}`, composer, "bottom", 80, () => panel.clientHeight * .45), composer);
  }
  if (focusedTerminal?.host.isConnected) focusedTerminal.term.focus();
  if (decision && decisionScroll !== undefined) stopNotice.scrollTop = decisionScroll;
  if (selected === "plan" && planScroll !== undefined) content.scrollTop = planScroll;
  if (selected === "history" && historyScroll !== undefined) content.scrollTop = historyScroll;
  if (["overview", "evidence", "followup"].includes(selected) && progressScroll !== undefined) content.scrollTop = progressScroll;
  if (focusLabel) {
    const replacement = [...panel.querySelectorAll<HTMLElement>(".followup-composer [aria-label], .goal-editor [aria-label], .execution-settings [aria-label]")].find((element) => element.getAttribute("aria-label") === focusLabel);
    replacement?.focus({ preventScroll: true });
    if (caret !== null && (replacement instanceof HTMLTextAreaElement || replacement instanceof HTMLInputElement)) replacement.setSelectionRange(caret, caret);
  }
}

const followupDrafts = new Map<string, FollowupInput>();
function showEnvironmentRecovery(task: TaskRecord, permissionsOnly = false): void {
  if (document.querySelector(".environment-recovery-dialog")) return;
  const local = !task.remote;
  if (local) permissionsOnly = true;
  const savedValue = () => (local ? task.localCodexPermissions : task.remote?.codexPermissions) ?? "sandbox";
  const dialog = document.createElement("dialog"); dialog.className = "restart-dialog environment-recovery-dialog";
  const heading = permissionsOnly ? `${local ? "ローカル" : "遠隔"}Codexの権限` : "遠隔実行環境の復旧";
  dialog.setAttribute("aria-label", heading);
  const title = document.createElement("h3"); title.textContent = heading;
  const intro = document.createElement("p");
  intro.textContent = `1. 接続・診断 → 2. 必要な環境修正 → 3. 確認して再開。ゴール・成果物・過去ログは保持します。接続先：${task.remote?.preparedTarget?.hostname ?? task.remote?.host} / ${task.remote?.resolvedCwd ?? task.remote?.cwd}`;
  if (permissionsOnly) intro.textContent = "ゴール承認前でも変更できます。次回の遠隔Codex起動から適用し、保存だけではタスクを開始しません。Full accessはbwrapを使いませんが、読み取り担当も作業フォルダ外へ書き込めるため注意してください。ゴールの作業範囲や施設の利用規則は変更しません。";
  if (local) intro.textContent = "このタスクの次回Codex起動から適用します。Full accessはGPU・MetalやCPU情報へのアクセスを妨げるサンドボックスを解除しますが、作業フォルダ外への操作も可能になります。コンパイラやSDKの不足は別問題で、自動インストールはしません。ゴール・作業範囲は変更せず、保存だけではタスクを開始しません。Claudeなど他CLIの設定は変更しません。";
  const guidance = document.createElement("p");
  guidance.textContent = "未接続なら認証画面が開きます。多段SSHの場合は以前と同じマシン・ユーザ・作業フォルダを確定してください。通常コマンドは成功しCodexだけ失敗する場合、接続先のターミナルまたは管理者にbubblewrap・ユーザ名前空間・AppArmorの確認を依頼してください。この画面はOS設定変更・インストール・ジョブ再投入を行いません。環境を修正した後、もう一度診断できます。";
  const output = document.createElement("pre"); output.className = "recovery-diagnostic-output";
  output.setAttribute("role", "status"); output.textContent = "まず接続・診断を実行してください。診断だけではタスクは開始しません。";
  if (permissionsOnly) output.textContent = "権限を選び「権限をこのタスクに保存」を押してください。SSH接続や診断は実行しません。";
  const note = document.createElement("p");
  note.textContent = "再開時にも診断します。完了済み計画は保持し、未完了工程とその後のレポート・レビューを再実行します。既に投入したバッチジョブや部分成果は、担当が確認してから作業を続けます。診断成功は本作業の成功を保証するものではありません。";
  const actions = document.createElement("div"); actions.className = "detail-actions";
  const inspect = document.createElement("button"); inspect.type = "button"; inspect.className = "secondary-button"; inspect.textContent = "接続・診断";
  const resume = document.createElement("button"); resume.type = "button"; resume.className = "primary-button"; resume.textContent = "復旧を確認して再開"; resume.disabled = true;
  const close = document.createElement("button"); close.type = "button"; close.className = "secondary-button"; close.textContent = "閉じる";
  const permissionsLabel = document.createElement("label"); permissionsLabel.textContent = `このタスクの${local ? "ローカル" : "遠隔"}Codex権限`;
  const permissions = document.createElement("select"); permissions.setAttribute("aria-label", permissionsLabel.textContent);
  permissions.add(new Option("Full access（サンドボックスなし）", "full-access")); permissions.add(new Option(local ? "工程別サンドボックスを使用" : "工程別サンドボックスを使用（Linuxではbwrap）", "sandbox"));
  permissions.value = savedValue(); permissionsLabel.append(permissions);
  const applyPermissions = document.createElement("button"); applyPermissions.type = "button"; applyPermissions.className = "secondary-button"; applyPermissions.textContent = "権限をこのタスクに保存";
  // Local permission recovery uses normal resume (which rechecks the required
  // environment), not the remote-only SSH diagnostic/recovery endpoint.
  const saveAndResume = document.createElement("button"); saveAndResume.type = "button"; saveAndResume.className = "primary-button";
  saveAndResume.textContent = "保存して同じ工程から再開";
  const canResumeHere = () => local && permissionsOnly && task.goal?.status === "approved" && !task.goalPreparation
    && !taskIsActive(state.tasks.find(t => t.id === task.id) ?? task) && Boolean(task.resumeFromUnitId)
    && ["paused", "blocked", "failed", "cancelled"].includes(task.state);
  saveAndResume.hidden = !canResumeHere();
  if (!saveAndResume.hidden) output.textContent = "権限を選び「保存して同じ工程から再開」を押してください。完了済み工程は保持し、中断工程で環境を再確認します。保存だけを行うこともできます。";
  const savedPermissions = document.createElement("p");
  const updateSavedPermissions = () => { savedPermissions.textContent = `保存済み：${savedValue() === "full-access" ? "Full access（隔離・承認要求なし）" : "工程別サンドボックス"}。保存だけでは実行しません。端末が残っている場合は、実行画面で「端末終了」してから変更してください。`; };
  updateSavedPermissions();
  let busy = false;
  const setBusy = (value: boolean) => { busy = value; inspect.disabled = close.disabled = permissions.disabled = applyPermissions.disabled = value; saveAndResume.disabled = value || !canResumeHere(); resume.disabled = true; };
  permissions.onchange = () => { resume.disabled = true; output.textContent = canResumeHere()
    ? "権限の変更は未保存です。「保存して同じ工程から再開」または「権限をこのタスクに保存」を押してください。"
    : "権限の変更は未保存です。「権限をこのタスクに保存」を押してください。"; };
  const savePermissions = async (restart: boolean) => {
    if (busy || (restart && !canResumeHere())) return;
    const value = permissions.value as "sandbox" | "full-access";
    const fullAccess = value === "full-access";
    if (fullAccess && !confirmRemoteFullAccess(local)) return;
    setBusy(true);
    try {
      task = await api.setTaskCodexPermissions(task.id, value, fullAccess);
      state.tasks = state.tasks.map(t => t.id === task.id ? task : t); renderTasks(); renderDetail(); updateSavedPermissions();
      if (savedValue() !== value) throw new Error("選択した権限を保存できませんでした。タスクは再開していません。");
      output.textContent = permissionsOnly ? "権限を保存しました。次回のCodex起動から適用します。タスクは開始していません。" : "権限を保存しました。選択した設定で接続・診断を実行してください。タスクはまだ再開していません。";
      if (restart) {
        output.textContent = "権限を保存しました。同じ工程から再開しています。";
        try { await api.resumeTask(task.id); }
        catch (error) { output.textContent = `権限は保存済みですが、再開できませんでした。\n${errorMessage(error)}`; return; }
        dialog.close(); showToast("保存した権限で中断工程から再開しました");
      }
    } catch (error) { output.textContent = errorMessage(error); }
    finally { setBusy(false); }
  };
  applyPermissions.onclick = () => savePermissions(false);
  saveAndResume.onclick = () => savePermissions(true);
  inspect.onclick = async () => {
    if (permissions.value !== savedValue()) { output.textContent = "権限の変更を保存してから診断してください。"; return; }
    setBusy(true); output.textContent = "接続・診断中です（認証後、最大約1分）。タスクは変更しません。";
    try {
      const result = await api.inspectTaskRecovery(task.id);
      output.textContent = `${result.ready ? "選択した権限での起動前チェックに合格しました" : "環境の修正が必要です（タスクは変更していません）"}\n${codexDiagnosticNote(result.diagnostic)}\n再実行する工程：${result.unitTitle}\n${result.diagnostic.platform} · ${result.diagnostic.cwd}\n\n${result.diagnostic.checks.map(c => `${c.ok ? "OK" : "要確認"} · ${c.name}\n${c.detail}`).join("\n\n")}`;
      setBusy(false); resume.disabled = !result.ready;
    } catch (error) { output.textContent = errorMessage(error); setBusy(false); }
  };
  resume.onclick = async () => {
    if (!window.confirm("環境を再診断して、同じタスクの未完了工程から再開します。既存のCLIやバッチジョブを手動操作中の場合は、先に状態を確認してください。続行しますか？")) return;
    setBusy(true); output.textContent = "復旧を再確認しています。確認できた場合だけ作業を再開します。";
    try { await api.recoverTask(task.id); dialog.close(); showToast("未完了工程から再開しました"); }
    catch (error) { output.textContent = errorMessage(error); }
    finally { setBusy(false); }
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove());
  if (!permissionsOnly) actions.append(inspect, resume);
  else if (!saveAndResume.hidden) actions.append(saveAndResume);
  actions.append(close); dialog.append(title, intro);
  if (!permissionsOnly) dialog.append(guidance);
  dialog.append(permissionsLabel, applyPermissions, savedPermissions, output);
  if (!permissionsOnly) dialog.append(note);
  dialog.append(actions);
  document.body.append(dialog); dialog.showModal();
}

async function showAssignmentRecovery(task: TaskRecord): Promise<void> {
  let options: AssignmentRecoveryOption[];
  try { options=await api.assignmentOptions(task.id); } catch(e){showToast(errorMessage(e));return;}
  if(!options.length){showToast("最新計画に復旧できる失敗した読取担当がありません。完了済み担当や未解決の作業方針は変更しません。");return;}
  const dialog=document.createElement("dialog");dialog.className="restart-dialog assignment-recovery-dialog";dialog.setAttribute("aria-label","担当・スキルの配置を修復");
  const title=document.createElement("h3");title.textContent="担当・スキルの配置を修復";
  const note=document.createElement("p");note.textContent="選んだ失敗担当と、その後の統合・報告・レビューを再開待ちに戻します。成功済み担当・成果物・ゴール・予算は保持します。作業範囲や権限の確認への回答には使わないでください。保存だけでは開始しません。";
  const field=(text:string,control:HTMLElement)=>{const label=document.createElement("label");label.className="field";label.textContent=text;label.append(control);return label;};
  const unit=document.createElement("select");unit.setAttribute("aria-label","復旧する担当");options.forEach(o=>unit.add(new Option(o.title,o.id)));
  const peer=document.createElement("select");peer.setAttribute("aria-label","異なるモデル系統にする比較対象");
  const families=document.createElement("select");families.setAttribute("aria-label","許可するモデル系統");
  for(const [label,value] of [["系統を限定しない",""],["Gemini または DeepSeek","gemini,deepseek"],["Gemini","gemini"],["DeepSeek","deepseek"],["OpenAI","openai"],["Anthropic","anthropic"],["GLM","glm"]])families.add(new Option(label,value));
  const rules=document.createElement("input");rules.type="checkbox";rules.setAttribute("aria-label","執筆・文献検証スキルを必須にする");rules.checked=true;
  const ruleInfo=document.createElement("p");ruleInfo.style.overflowWrap="anywhere";
  const updateRule=()=>{const p=options.find(o=>o.id===unit.value)!.peers.find(p=>p.key===peer.value);ruleInfo.textContent=p?.writingRevision?`比較対象と同じ保存版の執筆ルールを配布します：${p.writingRevision}`:"比較対象に保存版がない場合は現在の執筆ルールを使用します。モデル系統はユーザー設定のモデルIDで確認し、不明なら起動しません。";};
  const update=()=>{const o=options.find(o=>o.id===unit.value)!;peer.replaceChildren(new Option("指定しない",""));o.peers.forEach(p=>peer.add(new Option(`${p.title} · ${p.model??"モデル不明"}`,p.key)));peer.value=o.requirements?.independentFrom?.[0]??o.peers[0]?.key??"";families.value=o.requirements?.modelFamilies?.join(",")??"";updateRule();};
  unit.onchange=update;peer.onchange=updateRule;update();
  const error=document.createElement("p");error.setAttribute("role","status");
  const actions=document.createElement("div");actions.className="detail-actions";
  const save=document.createElement("button");save.className="primary-button";save.textContent="配置を修復して再開待ちにする";
  const close=document.createElement("button");close.className="secondary-button";close.textContent="閉じる";close.onclick=()=>dialog.close();
  save.onclick=async()=>{
    const o=options.find(o=>o.id===unit.value)!, p=o.peers.find(p=>p.key===peer.value);
    const requirements:WorkRequirements={...o.requirements,...(families.value?{modelFamilies:families.value.split(",") as WorkRequirements["modelFamilies"]}:{}),
      ...(peer.value?{independentFrom:[...new Set([...(o.requirements?.independentFrom??[]),peer.value])]}:{})};
    if(rules.checked){const skills=[...(requirements.skills??[])];for(const id of ["writing-rules","document-checks","related-research"])if(!skills.some(s=>s.id===id))skills.push({id,...(id==="writing-rules"&&p?.writingRevision?{revision:p.writingRevision}:{})});requirements.skills=skills;}
    save.disabled=close.disabled=true;
    try{const saved=await api.repairAssignment(task.id,unit.value,requirements,task.updatedAt);state.tasks=state.tasks.map(t=>t.id===saved.id?saved:t);dialog.close();renderTasks();renderDetail();showToast("成功済み作業を保持し、担当の配置を修復しました。中断した工程から再開できます。");}
    catch(e){error.textContent=errorMessage(e);save.disabled=close.disabled=false;}
  };
  actions.append(save,close);dialog.append(title,note,field("復旧する担当",unit),field("異なるモデル系統にする比較対象",peer),field("許可するモデル系統",families),field("執筆・文献検証スキルを必須にする",rules),ruleInfo,error,actions);
  dialog.addEventListener("cancel",event=>{if(save.disabled)event.preventDefault();});
  dialog.addEventListener("close",()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}

function showRestartDialog(task: TaskRecord, mode: "carry" | "fresh"): void {
  const existing = document.querySelector<HTMLDialogElement>(".restart-dialog");
  if (existing?.open) return;
  existing?.remove();
  const dialog = document.createElement("dialog"); dialog.className = "restart-dialog";
  const caption = mode === "fresh" ? "同じゴールで最初から" : "別タスクに分ける";
  dialog.setAttribute("aria-label", caption);
  const title = document.createElement("h3"); title.textContent = caption;
  const description = document.createElement("p");
  description.textContent = "元のタスクは残し、新しいタブに作成します。ゴール（承認状態を含む）・プリセット・担当設定・予算設定を保持し、最初に計画を立て直します。作成だけでは実行しません。";
  const detail = document.createElement("p");
  detail.textContent = mode === "carry"
    ? `作業フォルダを共有します：${task.cwd}。報告書フォルダのTeX・図表をコピーし、引き継ぎ情報を担当へ渡します。古い判定は引き継がず再検証します。同じフォルダのタスクを同時操作しないでください。`
    : "専用の空フォルダを新しく作り、過去の会話・計画・実行履歴・評価・成果物を使わずやり直します。元コードや入力資料も自動コピーしません（論文解説モードの登録PDFは引き継ぎます）。必要な入力は新フォルダへ用意してください。元のファイルは削除しません。";
  const draftNote = document.createElement("p"); draftNote.className = "followup-note";
  draftNote.textContent = "入力中の追加指示は元のタスクに保持します。新しいタスクへの指示は作成後に入力してください。";
  draftNote.hidden = !followupDrafts.get(task.id)?.instruction.trim();
  const error = document.createElement("p"); error.setAttribute("role", "alert");
  const actions = document.createElement("div"); actions.className = "detail-actions";
  const cancel = document.createElement("button"); cancel.textContent = "キャンセル"; cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  const create = document.createElement("button"); create.textContent = "新しいタスクを作成"; create.type = "button"; create.className = "primary-button";
  let busy = false;
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => dialog.remove());
  create.addEventListener("click", async () => {
    if (busy) return; busy = true; create.disabled = cancel.disabled = true; error.textContent = "";
    try {
      const created = await api.restartTask(task.id, mode);
      if (!state.tasks.some(t => t.id === created.id)) state.tasks.unshift(created);
      state.selectedTaskId = created.id; renderTasks(); renderDetail(); showView("tasks");
      dialog.close(); showToast("ゴールを保持した新しいタスクを作成しました。作業フォルダを確認してから開始してください。");
    } catch (e) { error.textContent = errorMessage(e); }
    finally { busy = false; create.disabled = cancel.disabled = false; }
  });
  actions.append(cancel, create); dialog.append(title, description, detail, draftNote, error, actions);
  document.body.append(dialog); dialog.showModal();
}
const roundLabels: Record<RoundKind, string> = { initial: "初回", consult: "相談・計画", continue: "修正・続行", review: "レビューのみ", report: "レポート更新" };

function buildFollowupComposer(task: TaskRecord, settings = false): HTMLElement {
  const form = document.createElement("form"); form.className = "followup-composer";
  if (settings) form.classList.add("followup-settings");
  const decision = taskUserDecision(task);
  const draft = followupDrafts.get(task.id) ?? structuredClone(task.pendingFollowup ?? {
    instruction: "", kind: "continue" as const, assignments: task.assignments ?? {}, pauseAfterPlan: task.pauseAfterPlan ?? false
  });
  followupDrafts.set(task.id, draft);
  const active = taskIsActive(task);
  const row = document.createElement("div"); row.className = "followup-row";
  const options = document.createElement("section"); options.className = "followup-settings-fields";
  if (settings) {
    const help = document.createElement("p"); help.className = "followup-note";
    help.textContent = "通常は変更不要です。追加指示に使う担当や計画確認を変更するときだけ設定します。戻るだけでは保存・実行しません。";
    form.append(help);
  }
  const kind = document.createElement("select"); kind.setAttribute("aria-label", "進め方");
  kind.title = "通常は成果を使って続けます。最初からの作成・別タスクへの分岐もここから選べます。";
  const sameTask = document.createElement("optgroup"); sameTask.label = "同じタスクで続ける";
  for (const id of ["continue", "consult", "review", "report"] as const) sameTask.append(new Option(id === "continue" ? task.continuationUnitId ? "停止した工程の続きを実行" : "成果を使って続ける" : roundLabels[id], id));
  const newTask = document.createElement("optgroup"); newTask.label = "新しいタスクを作る（確認後に作成）";
  const fresh = new Option("同じゴールで最初から…", "fresh"); fresh.disabled = active || !!task.remote;
  const carry = new Option("別タスクに分ける…", "carry"); carry.disabled = active;
  newTask.append(fresh, carry); kind.append(sameTask, newTask);
  kind.value = draft.kind;
  kind.addEventListener("change", () => {
    if (kind.value === "fresh" || kind.value === "carry") {
      const mode = kind.value;
      // Creation is a separate confirmed action, never a follow-up kind sent to
      // the backend. Cancel/failed creation must preserve the original draft.
      kind.value = draft.kind;
      if (!taskIsActive(task) && !(mode === "fresh" && task.remote)) showRestartDialog(task, mode);
      return;
    }
    draft.kind = kind.value as FollowupInput["kind"];
    if (draft.kind !== "continue") { draft.implementation = false; draft.scopeChange = undefined; }
    updateTransitionControl();
  });
  const instruction = document.createElement("textarea"); instruction.rows = 2; instruction.required = true;
  instruction.maxLength = 50_000; instruction.value = draft.instruction; instruction.setAttribute("aria-label", "追加指示");
  instruction.placeholder = decision ? "確認事項への回答を入力（合格条件を変更する場合は、下の変更ボタンで明示的に承認）" : "結果を見て追加指示（例：図2を対数軸に変更し、考察を追加）";
  if (decision) {
    const title = document.createElement("label"); title.textContent = "確認事項への回答";
    instruction.id = `decision-answer-${task.id}`; title.htmlFor = instruction.id; form.append(title);
    if (decision.options.length) {
      const choices = document.createElement("div"); choices.className = "decision-choices";
      for (const option of decision.options) {
        const button = document.createElement("button"); button.type = "button"; button.className = "secondary-button";
        button.textContent = `回答案：${option}`;
        button.onclick = () => { instruction.value = draft.instruction = option; instruction.focus(); };
        choices.append(button);
      }
      form.append(choices);
    }
  }
  instruction.addEventListener("input", () => { draft.instruction = instruction.value; });
  const start = document.createElement("button"); start.type = "submit"; start.className = "primary-button";
  start.textContent = "続ける";
  start.disabled = active || taskIsActive(task);
  const save = document.createElement("button"); save.type = "button"; save.className = "secondary-button"; save.textContent = "次回用に保存";
  const submit = async (run: boolean, scopeConfirmed = false) => {
    if (!form.reportValidity()) return;
    if (run && draft.scopeChange && !scopeConfirmed) {
      const change = await confirmScopeChange(task, draft.instruction, draft.scopeChange);
      if (!change) return;
      draft.scopeChange = change;
    }
    start.disabled = true; save.disabled = true; scopeButton.disabled = true;
    try {
      const result = await api.submitFollowup(task.id, structuredClone(draft), run);
      state.tasks = state.tasks.map(t => t.id === result.id ? result : t);
      if (run) {
        followupDrafts.delete(task.id);
        if (result.goalRevisionPending) goalEdits.delete(task.id);
        state.selectedTaskPanels.set(task.id, result.goalRevisionPending ? "overview" : draft.kind === "consult" || draft.kind === "review" ? "history" : "execution");
      }
      showToast(run ? result.goalRevisionPending ? "実装・実験用のゴールを確認し、承認してください。まだ実行していません。" : (result.roundNumber ?? 1) === (task.roundNumber ?? 1) ? "工程・実行記録を保持して、停止した工程から続行します" : "前回の成果物を引き継いで開始しました" : "追加指示を保存しました。自動では開始しません");
      renderTasks(); renderDetail();
    } catch (error) { showToast(errorMessage(error)); start.disabled = active || taskIsActive(task); save.disabled = false; scopeButton.disabled = start.disabled || draft.kind !== "continue"; }
  };
  save.addEventListener("click", () => { void submit(false); });
  form.addEventListener("submit", (event) => { event.preventDefault(); void submit(true); });
  row.append(kind, instruction, start, save); form.append(row);
  const transitionCheck = document.createElement("input"); transitionCheck.type = "checkbox";
  transitionCheck.setAttribute("aria-label", "実装・実験へ進む");
  const updateTransitionControl = () => {
    transitionCheck.checked = draft.implementation === true;
    transitionCheck.disabled = draft.kind !== "continue";
    start.textContent = draft.scopeChange ? "作業範囲の変更を確認" : draft.implementation ? "実装・実験のゴールを確認" : decision ? "回答して続行" : task.continuationUnitId && draft.kind === "continue" ? "指示を渡して再開" : "続ける";
    instruction.maxLength = draft.implementation ? 8000 : 50_000;
    scopeButton.disabled = start.disabled || draft.kind !== "continue";
  };
  transitionCheck.onchange = () => { draft.implementation = transitionCheck.checked; draft.scopeChange = undefined; updateTransitionControl(); };
  const scopeButton = document.createElement("button"); scopeButton.type = "button"; scopeButton.className = "secondary-button";
  scopeButton.textContent = decision ? "合格条件・制約を変更…" : "作業範囲・制約を変更して実行…";
  scopeButton.onclick = async () => {
    if (!form.reportValidity()) return;
    const change = await confirmScopeChange(task, draft.instruction, draft.scopeChange);
    if (!change) return;
    draft.scopeChange = change; draft.implementation = false;
    await submit(true, true);
  };
  if (task.goal?.status === "approved") {
    (decision ? form : options).append(scopeButton);
    const scopeHint = document.createElement("p"); scopeHint.className = "followup-note";
    scopeHint.textContent = "「実装禁止」「実験は対象外」などを変える場合はこちら。解除する項目を選び、新しいゴールを承認して実行できます。選ばなかった制約は維持します。";
    options.append(scopeHint);
  }
  if (task.workPreset?.manifest.focus === "idea" && task.goal?.status === "approved") {
    const label = document.createElement("label"); label.className = "followup-check";
    label.append(transitionCheck, task.workPreset.manifest.ideaApproach === "experimental" ? "本格実装へ移る（ゴールを見直して承認）" : "実装・実験へ進む（ゴールを見直して承認）"); options.append(label);
    const hint = document.createElement("p"); hint.className = "followup-note";
    hint.textContent = (task.workPreset.manifest.ideaApproach === "experimental" ? "試作と予備評価は現在のアイディアモードで実行できます。本格実装へ移る場合だけ、この項目を使ってください。" : "") + "追加指示に実装対象・実験条件・検証方法を記入してください。成果物を保持して実装モードに切り替えます。次のゴールを承認するまで実行せず、OS権限・SSH接続先・予算は変えません。";
    options.append(hint);
  }
  updateTransitionControl();
  if (task.continuationUnitId) {
    const help = document.createElement("p"); help.className = "followup-note";
    help.textContent = "通常の続行は、停止した工程に回答・指示を渡して再開します。計画・依存関係・これまでの実行記録は保持します。作業範囲を変更する場合は、変更内容を別途承認します。";
    form.append(help);
  }
  const note = document.createElement("span"); note.className = "followup-note";
  note.textContent = active ? "実行中の指示は変わりません。変更する場合は一時停止後に開始してください。"
    : task.awaitingReason === "plan" ? "計画は「作業履歴」で確認できます。承認して続行するか、追加指示で計画を修正できます。"
      : task.pendingFollowup ? "次回用の追加指示を保存済みです。開始するまで実行されません。" : "同じタスクで反復できます。相談・レビューのみの場合、成果物は変更しません。";
  if (active || task.pendingFollowup || task.awaitingReason === "plan") form.append(note);
  else if (settings) options.append(note);
  if (task.pendingFollowup) {
    const discard = document.createElement("button"); discard.type = "button"; discard.className = "secondary-button compact"; discard.textContent = "保存した指示を破棄";
    discard.addEventListener("click", async () => {
      try { await api.discardFollowup(task.id); followupDrafts.delete(task.id); renderDetail(); }
      catch (error) { showToast(errorMessage(error)); }
    }); form.append(discard);
  }
  // Keep the everyday composer small. The same draft backs the dedicated
  // settings screen, so navigation never discards assignments or scope choices.
  if (!settings) {
    if (draft.pauseAfterPlan || draft.implementation || draft.scopeChange || Object.values(draft.assignments).some(a => a?.agentId || a?.allowFallback === false)) {
      form.append(progressButton("担当・確認設定の指定あり — 確認…", () => openTaskPanel(task, "followup")));
    }
    return form;
  }
  const gateLabel = document.createElement("label"); gateLabel.className = "followup-check";
  const gate = document.createElement("input"); gate.type = "checkbox"; gate.checked = draft.pauseAfterPlan;
  gate.addEventListener("change", () => { draft.pauseAfterPlan = gate.checked; });
  gateLabel.append(gate, "修正・続行の前に計画を立て、承認を待つ"); options.append(gateLabel);
  for (const role of ["planner", "worker", "reviewer", "reporter"] as const) {
    const assignment = draft.assignments[role] ?? { allowFallback: true }; draft.assignments[role] = assignment;
    const line = document.createElement("div"); line.className = "assignment-row";
    const name = document.createElement("span"); name.textContent = { planner: task.workflowMode === "primary" ? "追加の計画担当（任意）" : "計画", worker: task.workflowMode === "primary" ? "主担当" : "修正", reviewer: "レビュー", reporter: "レポート" }[role];
    const cli = document.createElement("select"); cli.setAttribute("aria-label", `${name.textContent}担当CLI`); cli.add(new Option("自動割当", ""));
    for (const id of task.allowedAgentIds.filter(id => id !== "gemini")) cli.add(new Option(agentLabel(id), id));
    cli.value = assignment.agentId ?? "";
    const model = document.createElement("input"); model.type = "text"; model.value = assignment.model ?? ""; model.disabled = !assignment.agentId;
    let picker = modelPicker(assignment.agentId ?? "codex", model, "タスク／システム設定に従う");
    cli.addEventListener("change", () => {
      assignment.agentId = (cli.value || undefined) as AgentId | undefined; model.disabled = !cli.value;
      assignment.model = undefined; model.value = "";
      const next = modelPicker(assignment.agentId ?? "codex", model, "タスク／システム設定に従う"); picker.replaceWith(next); picker = next;
    });
    model.addEventListener("input", () => { assignment.model = model.value; });
    const fallbackLabel = document.createElement("label"); fallbackLabel.className = "followup-check";
    const fallback = document.createElement("input"); fallback.type = "checkbox"; fallback.checked = assignment.allowFallback;
    fallback.addEventListener("change", () => { assignment.allowFallback = fallback.checked; }); fallbackLabel.append(fallback, "代替CLIを許可");
    line.append(name, cli, picker, fallbackLabel); options.append(line);
  }
  form.append(options);
  if (["queued", "paused", "blocked"].includes(task.state) || task.awaitingReason === "plan") {
    const apply = document.createElement("button"); apply.type = "button"; apply.className = "secondary-button compact";
    apply.textContent = "現在の工程に担当・確認設定を適用";
    apply.addEventListener("click", async () => {
      try { await api.configureTask(task.id, structuredClone(draft)); showToast("設定を適用しました。開始・再開ボタンで進められます"); }
      catch (error) { showToast(errorMessage(error)); }
    }); options.append(apply);
  }
  return form;
}

function renderResources(): void {
  renderServiceEnvironment();
  // Only refresh observations. The single set of editable forms stays mounted,
  // so background usage updates cannot erase a model, slider or provider draft.
  renderServiceStatus();
  const groups = accountResourceGroups(state.resources);
  const shown = new Set<string>();
  for (const host of document.querySelectorAll<HTMLElement>("[data-service-accounts]")) {
    host.replaceChildren();
    const accounts = groups.filter(g => g.members.some(r => serviceInEnvironment(r) && r.agentIds.includes(host.dataset.serviceAccounts as AgentId)));
    // Quotas now live next to the corresponding connection, not in a second list.
    for (const account of accounts) shown.add(account.key);
  }
  let monitors = document.getElementById("resource-account-monitors");
  if (!monitors) {
    monitors = serviceElement("section"); monitors.id = "resource-account-monitors";
    byId("resource-grid").append(monitors);
  }
  monitors.replaceChildren();
  for (const group of groups.filter(g => !shown.has(g.key) && g.members.some(serviceInEnvironment))) monitors.append(buildServiceAccountCard(group));
  monitors.hidden = !monitors.childElementCount;
}

let routingSettingsDirty = false;
let routingSettingsRevision = 0;
let routingSettingsSaving = false;
function updateRoutingSliderHints(): void {
  for (const row of document.querySelectorAll<HTMLElement>(".policy-row")) {
    const percent = Number(row.querySelector<HTMLInputElement>(".policy-limit")?.value);
    row.querySelector<HTMLElement>(".policy-budget-hint")!.textContent = `残り${100 - percent}%を確保する目安。未取得の使用率は判定対象外です。`;
    const summary = document.querySelector<HTMLElement>(`[data-service-limit="${row.dataset.agentId}"]`);
    if (summary) summary.textContent = `切替目安 ${percent}%`;
  }
}
function mountServiceUsageControls(): void {
  for (const row of document.querySelectorAll<HTMLElement>(".policy-row")) {
    document.querySelector<HTMLElement>(`[data-service-usage="${row.dataset.agentId}"]`)?.append(row);
  }
  updateRoutingSliderHints();
}
function renderOrchestrationSettings(): void {
  if (routingSettingsDirty) { mountServiceUsageControls(); return; }
  const settings = state.orchestrationSettings;
  if (!settings) return;
  byId<HTMLInputElement>("warning-percent").value = String(settings.warningPercent);
  byId<HTMLInputElement>("drain-percent").value = String(settings.drainPercent);
  // Legacy global thresholds remain internal defaults for unsaved old policies.
  byId<HTMLInputElement>("warning-percent").type = "hidden";
  byId<HTMLInputElement>("drain-percent").type = "hidden";
  const list = byId<HTMLDivElement>("agent-policy-list");
  for (const row of document.querySelectorAll(".policy-row")) row.remove();
  for (const policy of settings.agentPolicies) {
    if (policy.agentId === "gemini") continue;
    const row = document.createElement("div");
    row.className = "policy-row";
    row.dataset.agentId = policy.agentId;
    const name = document.createElement("strong");
    name.textContent = `${policy.providerLabel} · ${agentLabel(policy.agentId)}`;
    const labelled = (title: string, control: HTMLElement) => {
      const label = document.createElement("label"); label.append(title, control); return label;
    };
    const field = (className: string, value: string, placeholder: string, type = "text") => {
      const input = document.createElement("input");
      input.className = className;
      input.type = type;
      input.value = value;
      input.placeholder = placeholder;
      return input;
    };
    const budget = field("policy-limit", String(policy.usageLimitPercent ?? settings.drainPercent), "", "number");
    budget.min = "1";
    const basic = document.createElement("div"); basic.className = "policy-basic";
    basic.append(labelled("上限の何％まで使うか", budget));
    enhanceSettingsSlider(budget, { title: `${agentLabel(policy.agentId)}の使用率目安`, min: 1, max: 100, unit: "%" });
    const hint = document.createElement("p"); hint.className = "policy-budget-hint";
    row.append(basic); row.setAttribute("aria-label", name.textContent);
    row.append(hint);
    list.append(row);
  }
  updateRoutingSliderHints();
  mountServiceUsageControls();
}

function renderReportSettings(): void {
  const settings = state.reportSettings;
  if (!settings) return;
  byId<HTMLInputElement>("tex-command").value = settings.texCommand;
  byId<HTMLTextAreaElement>("tex-args").value = settings.texArgs.join("\n");
  byId<HTMLInputElement>("plot-command").value = settings.plotCommand;
  byId<HTMLTextAreaElement>("plot-check-args").value = settings.plotCheckArgs.join("\n");
  byId<HTMLInputElement>("report-output-directory").value = settings.outputDirectory;
}

function renderReportEnvironment(): void {
  const container = byId<HTMLDivElement>("environment-status");
  container.replaceChildren();
  const status = state.reportEnvironment;
  if (!status) return;
  for (const [label, check] of [["TeX", status.tex], ["Plot", status.plot]] as const) {
    const item = document.createElement("div");
    item.className = `tool-check${check.ok ? " ready" : " failed"}`;
    const heading = document.createElement("div");
    heading.className = "tool-check-heading";
    const name = document.createElement("strong");
    name.textContent = label;
    const badge = document.createElement("span");
    badge.textContent = check.ok ? "Ready" : "Unavailable";
    heading.append(name, badge);
    const detail = document.createElement("p");
    detail.textContent = check.detail;
    detail.title = `${check.command}\n${check.detail}`;
    item.append(heading, detail);
    container.append(item);
  }
}


function argumentLines(id: string): string[] {
  return byId<HTMLTextAreaElement>(id).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function collectAgentSelection(): { allowedAgentIds: AgentId[]; modelOverrides: Partial<Record<AgentId, string>> } {
  const allowedAgentIds: AgentId[] = [];
  const modelOverrides: Partial<Record<AgentId, string>> = {};
  for (const row of Array.from(byId("task-agent-pool").querySelectorAll<HTMLElement>("[data-agent-id]"))) {
    const agentId = row.dataset.agentId as AgentId;
    if (row.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked) allowedAgentIds.push(agentId);
    const model = row.querySelector<HTMLInputElement>("input[type=text]")?.value.trim();
    if (model) modelOverrides[agentId] = model;
  }
  return { allowedAgentIds, modelOverrides };
}

function collectPolicies(): AgentPolicy[] {
  const previous = new Map(state.orchestrationSettings?.agentPolicies.map((policy) => [policy.agentId, policy]) ?? []);
  return Array.from(document.querySelectorAll<HTMLElement>(".policy-row")).map((row) => {
    const agentId = row.dataset.agentId as AgentId;
    const value = (selector: string) => row.querySelector<HTMLInputElement>(selector)?.value.trim() ?? "";
    const usageLimitPercent = Number(value(".policy-limit"));
    const toggle = document.querySelector<HTMLInputElement>(`[data-service-enabled="${agentId}"]`);
    const model = document.querySelector<HTMLInputElement>(`.model-default-row[data-agent-id="${agentId}"] input[type="text"]`);
    return {
      agentId,
      codingPlan: previous.get(agentId)?.codingPlan,
      openCodeModels: previous.get(agentId)?.openCodeModels,
      enabled: toggle?.checked ?? previous.get(agentId)!.enabled,
      providerKey: previous.get(agentId)!.providerKey,
      providerLabel: previous.get(agentId)!.providerLabel,
      authMode: previous.get(agentId)!.authMode,
      defaultModel: model ? model.value.trim() || undefined : previous.get(agentId)?.defaultModel,
      usageLimitPercent,
      softTokenBudget: undefined,
      // Removing the manual control must not rewrite existing routing policy.
      priority: previous.get(agentId)?.priority ?? 50
    };
  });
}

async function initialize(): Promise<void> {
  initializeSidebarSplitter();
  const snapshot = await api.getSnapshot();
  state.agents = snapshot.agents;
  state.tasks = snapshot.tasks;
  state.queue = snapshot.queue;
  state.resources = snapshot.resources;
  state.orchestrationSettings = snapshot.orchestrationSettings;
  state.reportSettings = snapshot.reportSettings;
  state.reportEnvironment = snapshot.reportEnvironment;
  initializeWorkspace();
  initializePresets(snapshot.workPresets);
  initializeSkillManager();
  initializeSettingsLayout();
  initializeModelSettings();
  initializeBenchmarkSettings();
  initializeExecutionSettings(snapshot.executionDefaults);
  byId("task-remote").addEventListener("change", renderDispatchExecutionNote);
  initializeFinishing();
  initializeRemote(snapshot.remoteSystems);
  initializeSettingsPages();
  if (state.tasks.length) state.selectedTaskId = state.tasks[0].id;
  renderAgents();
  renderTasks();
  renderResources();
  renderResourceSummary();
  renderOrchestrationSettings();
  renderReportSettings();
  renderReportEnvironment();
  if (state.selectedTaskId) renderDetail();
  showView(state.currentView);

  api.onRunEvent(appendRunEvent);
  api.onTasksChanged((tasks) => {
    followStartedTerminals(state.tasks, tasks);
    for (const task of tasks) {
      const old = state.tasks.find(item => item.id === task.id);
      if (old?.goalPreparation && !task.goalPreparation && task.awaitingReason === "goal") state.selectedTaskPanels.set(task.id, "overview");
    }
    state.tasks = tasks;
    refreshTaskExecutionDialog();
    renderTasks();
    renderDetail();
  });
  api.onAgentsChanged((agents) => {
    state.agents = agents;
    renderAgents();
    renderTasks();
    if (state.selectedTaskId) renderDetail();
  });
  api.onQueueChanged((queue) => {
    state.queue = queue;
    refreshTaskExecutionDialog();
    renderQueue();
    if (state.selectedTaskId) renderDetail();
  });
  api.onResourcesChanged((resources) => {
    state.resources = resources;
    renderResourceSummary();
    renderAgents();
    if (state.currentView === "usage") renderResources();
  });
  api.onOrchestrationSettingsChanged(({ settings, resources }) => {
    state.orchestrationSettings = settings;
    state.resources = resources;
    renderResourceSummary();
    renderOrchestrationSettings();
    renderResources();
    renderAgents();
  });
  api.onReportEnvironmentChanged((environment) => { state.reportEnvironment = environment; renderReportEnvironment(); });
  api.onReportSettingsChanged(({ settings, environment }) => {
    state.reportSettings = settings;
    state.reportEnvironment = environment;
    renderReportSettings();
    renderReportEnvironment();
    if (state.selectedTaskId) renderDetail();
  });

  byId("nav-dispatch").addEventListener("click", () => showView("dispatch"));
  byId("nav-tasks").addEventListener("click", () => showView("tasks"));
  byId("nav-usage").addEventListener("click", () => showView("usage"));
  byId("nav-settings").addEventListener("click", () => showView("settings"));
  const resourceDialog = byId<HTMLDialogElement>("resource-usage-dialog");
  byId<HTMLButtonElement>("close-resource-usage").addEventListener("click", closeResourceUsageDialog);
  resourceDialog.addEventListener("click", (event) => {
    if (event.target === resourceDialog) closeResourceUsageDialog();
  });
  resourceDialog.addEventListener("close", () => { resourceDialogProviderKey = undefined; });
  byId<HTMLButtonElement>("start-queue").addEventListener("click", async () => {
    try { state.queue = await api.startQueue(); renderQueue(); } catch (error) { showToast(errorMessage(error)); }
  });
  byId<HTMLButtonElement>("stop-queue").addEventListener("click", async () => {
    state.queue = await api.stopQueue();
    renderQueue();
  });
  byId<HTMLButtonElement>("refresh-agents").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      state.agents = await api.refreshAgents();
      renderAgents();
      showToast("CLI status refreshed");
    } finally {
      button.disabled = false;
      button.textContent = "Refresh CLIs";
    }
  });
  byId<HTMLButtonElement>("refresh-capacity").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "更新中…";
    try {
      state.agents = await api.refreshAgents();
      // Check existing connections only. Updating never opens SSH or logs in.
      const targets = state.resources.filter(r => r.agentIds.length && r.enabled !== false && r.connected !== false && serviceInEnvironment(r));
      const checks = await Promise.allSettled(targets.map(r => api.checkService(r.providerKey)));
      state.resources = await api.refreshCapacity();
      renderResources();
      renderResourceSummary();
      renderAgents();
      const failed = checks.filter(result => result.status === "rejected").length;
      showToast(failed ? `${failed}件の状態を確認できませんでした。各サービスの表示を確認してください。` : "状態・使用枠を更新しました。取得できない枠は未取得・前回値で表示します。");
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      button.disabled = false;
      button.textContent = "状態・使用枠を更新";
    }
  });
  byId<HTMLButtonElement>("check-report-tools").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      state.reportEnvironment = await api.refreshReportEnvironment();
      renderReportEnvironment();
      showToast("Report tools checked");
    } finally {
      button.disabled = false;
      button.textContent = "Check tools";
    }
  });
  const markRoutingEdited = (event: Event) => {
    routingSettingsDirty = true; routingSettingsRevision++;
    const input = event.target as HTMLInputElement;
    const warning = byId<HTMLInputElement>("warning-percent"), drain = byId<HTMLInputElement>("drain-percent");
    // Moving one threshold keeps the warning <= routing invariant. Refreshing
    // the peer's visual control does not overwrite other unsaved policy fields.
    if ((input === warning || input === drain) && input.value !== "" && Number(input.value) >= 1 && Number(input.value) <= 100 && Number(warning.value) > Number(drain.value)) {
      const peer = input === warning ? drain : warning; peer.value = input.value;
      settingsSliders.get(peer)?.();
    }
    updateRoutingSliderHints();
  };
  byId("orchestration-settings-form").addEventListener("input", markRoutingEdited);
  byId("orchestration-settings-form").addEventListener("change", markRoutingEdited);
  for (const type of ["input", "change"]) byId("settings-models").addEventListener(type, event => {
    if ((event.target as HTMLElement).closest(".policy-row")) markRoutingEdited(event);
  });
  byId("routing-revert").onclick = () => {
    if (routingSettingsSaving) return;
    if ((routingSettingsDirty || serviceModelEdits.dirty) && !window.confirm("サービス設定の未保存の変更を破棄し、保存済みの設定に戻しますか？")) return;
    routingSettingsDirty = false; serviceModelEdits.reset(); renderOrchestrationSettings(); byId("policy-error").textContent = "";
  };
  byId<HTMLFormElement>("orchestration-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (routingSettingsSaving) return;
    routingSettingsSaving = true;
    const submittedRevision = routingSettingsRevision;
    const submittedModels = serviceModelEdits.revision;
    const save = byId<HTMLButtonElement>("save-routing-settings");
    const revert = byId<HTMLButtonElement>("routing-revert");
    save.disabled = true; revert.disabled = true;
    const error = byId<HTMLParagraphElement>("policy-error");
    error.textContent = "";
    try {
      const result = await api.updateOrchestrationSettings({
        warningPercent: Number(byId<HTMLInputElement>("warning-percent").value),
        drainPercent: Number(byId<HTMLInputElement>("drain-percent").value),
        agentPolicies: collectPolicies()
      });
      state.orchestrationSettings = result.settings;
      state.resources = result.resources;
      renderResourceSummary();
      // サービス設定の通知と保存中の追加入力を区別し、下書きを上書きしない。
      routingSettingsDirty = routingSettingsRevision !== submittedRevision;
      serviceModelEdits.saved(submittedModels);
      renderTaskAgentPool();
      renderOrchestrationSettings();
      showToast(routingSettingsDirty || serviceModelEdits.dirty ? "送信分を保存しました。その後の変更は未保存です" : "サービス設定を保存しました。次に起動する工程から適用します。");
    } catch (caught) {
      error.textContent = errorMessage(caught);
    } finally {
      routingSettingsSaving = false; save.disabled = false; revert.disabled = false;
    }
  });
  byId<HTMLFormElement>("report-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = byId<HTMLParagraphElement>("settings-error");
    error.textContent = "";
    try {
      const result = await api.updateReportSettings({
        remoteExecution: "remote",
        texCommand: byId<HTMLInputElement>("tex-command").value,
        texArgs: argumentLines("tex-args"),
        plotCommand: byId<HTMLInputElement>("plot-command").value,
        plotCheckArgs: argumentLines("plot-check-args"),
        outputDirectory: byId<HTMLInputElement>("report-output-directory").value
      });
      state.reportSettings = result.settings;
      state.reportEnvironment = result.environment;
      showToast("レポート環境を保存しました");
    } catch (caught) {
      error.textContent = errorMessage(caught);
    }
  });
  byId<HTMLFormElement>("task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = byId<HTMLParagraphElement>("form-error");
    error.textContent = "";
    const selection = collectAgentSelection();
    const buttons = [...byId("task-form").querySelectorAll<HTMLButtonElement>('button[type="submit"]')];
    if (buttons.some(button => button.disabled)) return;
    buttons.forEach(button => { button.disabled = true; });
    const goalMode = (event as SubmitEvent).submitter?.getAttribute("value") === "manual" ? "manual" : "ai";
    try {
      const remoteId = selectedRemoteId();
      const remote = remoteSystemsList.find(s => s.id === remoteId);
      if (remoteId && !remote) throw new Error("遠隔の接続先を選び直してください。入力内容は保持しています。");
      const workspaceMode = remoteId ? "remote" : byId<HTMLSelectElement>("task-workspace-mode").value;
      const cwd = remote ? remote.cwd : byId<HTMLInputElement>("task-cwd").value.trim();
      if (!remote && !cwd) throw new Error("作業ディレクトリを選択または入力してください。入力内容は保持しています。");
      if (!["new", "existing", "remote"].includes(workspaceMode)) throw new Error("新規作成か既存ディレクトリを選んでください。");
      // createTask validates the current path in the main process. There is no
      // cached confirmation to go stale, and existing contents are preserved.
      const timeValue = byId<HTMLInputElement>("task-target-minutes").value;
      const targetMinutes = timeValue === "" ? undefined : Number(timeValue);
      if (targetMinutes !== undefined && (!Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 10080)) throw new Error("作業時間の目安は1〜10080分、または空欄にしてください。");
      const task = await api.createTask({
        targetMinutes,
        workspaceMode: workspaceMode as "existing" | "new" | "remote",
        remoteSystemId: remoteId || undefined,
        ...selectedPresetInput(),
        ...lessonDispatchInput(),
        goalMode,
        workflowMode: "primary",
        title: byId<HTMLInputElement>("task-title").value,
        prompt: byId<HTMLTextAreaElement>("task-prompt").value,
        cwd,
        strategy: byId<HTMLSelectElement>("task-strategy").value as TaskStrategy,
        ...selection
      });
      state.selectedTaskId = task.id;
      if (!state.tasks.some((item) => item.id === task.id)) state.tasks.unshift(task);
      renderTasks();
      renderDetail();
      byId<HTMLInputElement>("task-title").value = "";
      byId<HTMLInputElement>("task-target-minutes").value = "";
      resetLessonDispatch();
      byId<HTMLTextAreaElement>("task-prompt").value = "";
      byId<HTMLInputElement>("task-cwd").value = "";
      byId<HTMLSelectElement>("task-workspace-mode").value = "existing";
      invalidateWorkspace();
      showView("tasks");
      showToast("ゴール下書きを作成しました。承認後に本作業を開始できます。");
      if (goalMode === "ai") {
        try { await api.runTask(task.id); state.selectedTaskPanels.set(task.id, "execution"); renderDetail(); }
        catch (caught) { showToast(`ゴール案は保存しました。「Run workflow」で整理を開始できます。${errorMessage(caught)}`); }
      }
    } catch (caught) {
      error.textContent = errorMessage(caught);
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  });
}

void initialize().catch((error) => { showToast(errorMessage(error)); });
