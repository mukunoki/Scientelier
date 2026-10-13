// Read-only compatibility for saved runs from before interactive PTYs.
// Keep these buffers separate from live xterm sessions and never accept a
// legacy log as a new run's completion notification.
const legacyTerminalState = {
  liveRuns: new Map<string, { readable: string; raw: string }>(),
  viewModes: new Map<string, "readable" | "raw">(),
  clearOffsets: new Map<string, { readable: number; raw: number }>()
};

function terminalTextForAgent(task: TaskRecord, agentId: AgentId, mode: "readable" | "raw"): string {
  const runs = terminalRuns(task, agentId);
  if (!runs.length) return "Waiting for the first event…";
  return runs.map((run, index) => {
    const live = legacyTerminalState.liveRuns.get(run.id);
    const value = mode === "raw"
      ? live?.raw || run.output
      : live?.readable || run.displayOutput || run.output;
    const prefix = runs.length > 1
      ? `${index ? "\n\n" : ""}===== ${run.role} · ${run.model ?? "CLI default"} · ${run.state} =====\n`
      : "";
    return `${prefix}${(mode === "raw" ? value : humanOutput(value)) || "Waiting for output…"}`;
  }).join("");
}

function visibleTerminalText(task: TaskRecord, agentId: AgentId, mode: "readable" | "raw"): string {
  const full = terminalTextForAgent(task, agentId, mode);
  const key = terminalKey(task.id, agentId);
  const offset = Math.min(legacyTerminalState.clearOffsets.get(key)?.[mode] ?? 0, full.length);
  return full.slice(offset) || "Display cleared. New events will appear here…";
}

function updateTerminalPane(taskId: string, agentId?: AgentId): void {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  const selectedAgent = agentId ?? (task ? state.selectedTerminalAgents.get(task.id) : undefined);
  if (!task || !selectedAgent) return;
  const terminal = document.getElementById(`agent-terminal-${task.id}-${selectedAgent}`);
  if (!terminal) return;
  const key = terminalKey(task.id, selectedAgent);
  const mode = legacyTerminalState.viewModes.get(key) ?? "readable";
  terminal.textContent = visibleTerminalText(task, selectedAgent, mode);
  terminal.scrollTop = terminal.scrollHeight;
}

function buildAgentTerminals(task: TaskRecord): HTMLElement {
  // PTY導入前の保存済みタスクだけが旧ログ表示を使う。未使用コードではなく履歴互換。
  if (!task.runs.length || task.runs.some((run) => run.terminal)) return buildInteractiveTerminals(task);
  const section = document.createElement("section");
  section.className = "agent-monitors";
  const heading = document.createElement("div");
  heading.className = "monitor-heading";
  const headingText = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = "Agent terminals";
  const description = document.createElement("p");
  description.textContent = "以前の実行の保存ログ（操作不可）。新しい実行は対話ターミナルで起動します。";
  headingText.append(title, description);
  const agentIds = terminalAgentIds(task);
  const count = document.createElement("span");
  count.textContent = `${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}`;
  heading.append(headingText, count);
  section.append(heading);

  if (!agentIds.length) {
    const empty = document.createElement("div");
    empty.className = "terminal-empty";
    empty.textContent = "An agent monitor will appear when the workflow starts.";
    section.append(empty);
    return section;
  }

  const selected = state.selectedTerminalAgents.get(task.id);
  const selectedAgent = selected && agentIds.includes(selected) ? selected : agentIds[0];
  state.selectedTerminalAgents.set(task.id, selectedAgent);
  const tabs = document.createElement("div");
  tabs.className = "agent-terminal-tabs";
  tabs.setAttribute("role", "tablist");
  for (const agentId of agentIds) {
    const runs = terminalRuns(task, agentId);
    const latest = runs[runs.length - 1];
    const tab = document.createElement("button");
    tab.type = "button";
    tab.role = "tab";
    tab.className = `agent-terminal-tab${agentId === selectedAgent ? " selected" : ""}`;
    tab.setAttribute("aria-selected", String(agentId === selectedAgent));
    tab.textContent = `${agentLabel(agentId)} · ${latest ? runStatusLabel(task, latest) : "未実行"}`;
    tab.title = `${agentLabel(agentId)} · ${runs.length} run${runs.length === 1 ? "" : "s"}`;
    tab.addEventListener("click", () => {
      state.selectedTerminalAgents.set(task.id, agentId);
      renderDetail();
    });
    tabs.append(tab);
  }
  section.append(tabs);

  const runs = terminalRuns(task, selectedAgent);
  const latest = runs[runs.length - 1];
  if (!latest) { section.append(interactivePane(task, selectedAgent)); return section; }
  const key = terminalKey(task.id, selectedAgent);
  const pane = document.createElement("article");
  pane.className = `agent-terminal-pane ${runStatusLabel(task, latest) !== latest.state ? "blocked" : latest.state}`;
  const header = document.createElement("header");
  const identity = document.createElement("div");
  identity.className = "terminal-identity";
  const dot = document.createElement("span");
  dot.className = "terminal-status-dot";
  const labels = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = agentLabel(selectedAgent);
  const meta = document.createElement("span");
  meta.textContent = `${runs.length} run${runs.length === 1 ? "" : "s"} · ${latest.model ?? "CLI default"} · ${runStatusLabel(task, latest)}`;
  labels.append(name, meta);
  identity.append(dot, labels);

  const controls = document.createElement("div");
  controls.className = "terminal-view-controls";
  const mode = legacyTerminalState.viewModes.get(key) ?? "readable";
  for (const viewMode of ["readable", "raw"] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = viewMode === "readable" ? "Readable" : "Raw";
    button.className = mode === viewMode ? "active" : "";
    button.addEventListener("click", () => {
      legacyTerminalState.viewModes.set(key, viewMode);
      for (const sibling of Array.from(controls.querySelectorAll("button"))) sibling.classList.remove("active");
      button.classList.add("active");
      updateTerminalPane(task.id, selectedAgent);
    });
    controls.append(button);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "terminal-clear-button";
  clear.textContent = "Clear display";
  clear.title = "Clear the visible output. External log files are not changed.";
  clear.addEventListener("click", () => {
    const offsets = legacyTerminalState.clearOffsets.get(key) ?? { readable: 0, raw: 0 };
    offsets.readable = terminalTextForAgent(task, selectedAgent, "readable").length;
    offsets.raw = terminalTextForAgent(task, selectedAgent, "raw").length;
    legacyTerminalState.clearOffsets.set(key, offsets);
    updateTerminalPane(task.id, selectedAgent);
    showToast("Display cleared; log files were kept");
  });
  header.append(identity, controls, clear);
  const terminal = document.createElement("pre");
  terminal.className = "agent-terminal";
  terminal.id = `agent-terminal-${task.id}-${selectedAgent}`;
  terminal.textContent = visibleTerminalText(task, selectedAgent, mode);
  pane.append(header, terminal);
  section.append(pane);
  return section;
}


function appendLegacyRunEvent(event: RunEvent): void {
  if (!event.runId) return;
  const current = legacyTerminalState.liveRuns.get(event.runId) ?? { readable: "", raw: "" };
  const raw = event.type === "status"
    ? `${current.raw ? "\n" : ""}[status] ${event.text}\n`
    : event.type === "stderr" ? `[stderr] ${event.text}` : event.text;
  const readable = event.displayText ?? (event.type === "stderr" ? `⚠ ${event.text}` : event.text);
  legacyTerminalState.liveRuns.set(event.runId, {
    readable: current.readable + readable,
    raw: current.raw + raw
  });
  if (state.selectedTaskId === event.taskId) updateTerminalPane(event.taskId, event.agentId);
}


function forgetLegacyTerminalLogs(task: TaskRecord): void {
  for (const run of task.runs) legacyTerminalState.liveRuns.delete(run.id);
  for (const key of legacyTerminalState.viewModes.keys()) {
    if (key.startsWith(`${task.id}:`)) legacyTerminalState.viewModes.delete(key);
  }
  for (const key of legacyTerminalState.clearOffsets.keys()) {
    if (key.startsWith(`${task.id}:`)) legacyTerminalState.clearOffsets.delete(key);
  }
}
