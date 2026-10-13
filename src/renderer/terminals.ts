// xterm's browser bundles expose these constructors without renderer Node access.
declare const Terminal: new (options: Record<string, unknown>) => {
  cols: number; rows: number; options: { disableStdin: boolean };
  loadAddon(addon: unknown): void; open(host: HTMLElement): void;
  write(data: string): void; reset(): void; clear(): void; focus(): void; dispose(): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
};
declare const FitAddon: { FitAddon: new () => { fit(): void } };
interface TerminalSnapshot { data: string; offset: number; cols: number; rows: number; alive: boolean; awaitingHandoff: boolean; inputAllowed?: boolean; notificationIssue?: string; startupIssue?: string; }
interface TerminalView {
  taskId: string; runId: string; host: HTMLDivElement; notice: HTMLParagraphElement;
  term: InstanceType<typeof Terminal>; fit: InstanceType<typeof FitAddon.FitAddon>;
  observer: ResizeObserver; offset: number; alive: boolean; inputAllowed: boolean; syncing: boolean;
  pending: Array<{ data: string; offset: number }>;
}
const terminalViews = new Map<string, TerminalView>();
const terminalRunSelections = new Map<string, string>();
const terminalTiledTasks = new Set<string>();

function terminalKey(taskId: string, agentId: AgentId): string {
  return `${taskId}:${agentId}`;
}

function terminalAgentIds(task: TaskRecord): AgentId[] {
  const available = task.remote ? remoteAgentLists.get(task.remote.id) ?? [] : state.agents;
  return [...new Set([...task.runs.map(run => run.agentId), ...task.allowedAgentIds,
    ...available.filter(agent => agent.installed).map(agent => agent.id)])].filter(id => id !== "gemini" || task.runs.some(run => run.agentId === "gemini"));
}

function terminalRuns(task: TaskRecord, agentId: AgentId): AgentRun[] {
  return task.runs.filter((run) => run.agentId === agentId);
}

function appendRunEvent(event: RunEvent): void {
  if (!event.runId) return;
  const terminal = terminalViews.get(event.runId);
  if (event.terminalOffset !== undefined) {
    if (terminal) receiveTerminalData(terminal, event.text, event.terminalOffset);
    return;
  }
  if (terminal && event.type === "status" && /^Terminal (notification|startup): /.test(event.text)) {
    terminal.notice.dataset.kind = event.text.startsWith("Terminal startup: ") ? "startup" : "notification";
    terminal.notice.textContent = event.text.replace(/^Terminal (notification|startup): /, "");
    terminal.notice.hidden = !terminal.notice.textContent;
    return;
  }
  if (terminal && event.type === "status" && /^Terminal (exited|retiring)/.test(event.text)) {
    if (event.text.startsWith("Terminal retiring")) terminal.notice.hidden = true;
    if (event.text.startsWith("Terminal exited")) { terminal.alive = false; terminal.host.dataset.alive = "false"; }
    terminal.inputAllowed = false;
    terminal.term.options.disableStdin = true;
    terminal.term.write(`\r\n\x1b[0m[${event.text}]\r\n`);
    return;
  }
  // Status messages for unopened PTYs must not accumulate in legacy buffers.
  const task = state.tasks.find(candidate => candidate.id === event.taskId);
  if (task?.runs.some(run => run.id === event.runId && run.terminal)) return;
  appendLegacyRunEvent(event);
}

function forgetTaskTerminalSelections(task: TaskRecord): void {
  forgetLegacyTerminalLogs(task);
  state.selectedTerminalAgents.delete(task.id);
  terminalTiledTasks.delete(task.id);
  for (const key of terminalRunSelections.keys()) {
    if (key.startsWith(`${task.id}:`)) terminalRunSelections.delete(key);
  }
  // renderDetail prunes/disposes xterm views after the task list is replaced.
}

function followStartedTerminals(previous: TaskRecord[], tasks: TaskRecord[]): void {
  for (const task of tasks) {
    const oldRuns = new Map(previous.find(old => old.id === task.id)?.runs.map(run => [run.id, run]));
    for (const run of task.runs) {
      if (!run.terminal || run.state !== "running") continue;
      const old = oldRuns.get(run.id);
      if (old?.terminal && old.state === "running") continue;
      // Follow a start once, not every output/status update. Users can then
      // inspect history until the next start, without the view snapping back.
      terminalRunSelections.set(`${task.id}:${run.agentId}`, run.id);
      state.selectedTerminalAgents.set(task.id, run.agentId);
    }
  }
  // Only terminal selections change: retain tiled layout, current task/panel
  // and drafts. Never explicitly focus the newly selected CLI's input.
}

function receiveTerminalData(view: TerminalView, data: string, offset: number): void {
  if (view.syncing) { view.pending.push({ data, offset }); return; }
  // The run is published before its PTY exists (especially over SSH). A first
  // snapshot can therefore look ended; re-check when the actual process speaks.
  if (!view.alive) { void syncTerminal(view); return; }
  if (offset <= view.offset) return;
  const start = offset - data.length;
  if (start > view.offset) { void syncTerminal(view); return; }
  view.term.write(data.slice(Math.max(0, view.offset - start)));
  view.offset = offset;
}

async function syncTerminal(view: TerminalView): Promise<void> {
  if (view.syncing) return;
  view.syncing = true;
  try {
    const snapshot = await api.terminalSnapshot(view.taskId, view.runId);
    const start = snapshot.offset - snapshot.data.length;
    if (view.offset > 0 && start <= view.offset && snapshot.offset >= view.offset) {
      // Catch up without destroying scrollback or the user's current screen.
      view.term.write(snapshot.data.slice(view.offset - start));
    } else {
      view.term.reset();
      if (start > 0) view.term.write("[古い出力は外部ログを参照]\r\n");
      view.term.write(snapshot.data);
    }
    view.offset = snapshot.offset;
    view.alive = snapshot.alive;
    view.host.dataset.alive = String(snapshot.alive);
    view.inputAllowed = snapshot.alive && snapshot.inputAllowed !== false;
    view.term.options.disableStdin = !view.inputAllowed;
    view.notice.textContent = snapshot.startupIssue ?? snapshot.notificationIssue ?? "";
    view.notice.dataset.kind = snapshot.startupIssue ? "startup" : "notification";
    view.notice.hidden = !view.notice.textContent;
    if (!snapshot.alive) view.term.write("\r\n[終了したセッション・保存画面]\r\n");
  } catch (error) { showToast(errorMessage(error)); }
  finally {
    view.syncing = false;
    for (const item of view.pending.splice(0)) receiveTerminalData(view, item.data, item.offset);
  }
}

function terminalView(task: TaskRecord, run: AgentRun): TerminalView {
  const cached = terminalViews.get(run.id);
  if (cached) {
    if (run.state !== "running") { cached.inputAllowed = false; cached.term.options.disableStdin = true; }
    return cached;
  }
  const host = document.createElement("div");
  const notice = document.createElement("p"); notice.className = "terminal-notification-issue";
  notice.role = "status"; notice.hidden = true;
  host.className = "interactive-terminal";
  host.dataset.runId = run.id;
  host.setAttribute("aria-label", `${agentLabel(run.agentId)} 対話ターミナル`);
  const term = new Terminal({ cols: 100, rows: 30, fontSize: 13, fontFamily: 'Menlo, Monaco, monospace',
    cursorBlink: true, scrollback: 5000, allowProposedApi: false, allowTransparency: false,
    disableStdin: true, theme: { background: "#0b0d12", foreground: "#e0e4ed" } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
  let lastSize = "";
  const observer = new ResizeObserver(() => {
    if (!host.isConnected || host.clientWidth < 20 || host.clientHeight < 20) return;
    fit.fit();
    const size = `${term.cols}:${term.rows}`;
    if (size === lastSize) return;
    lastSize = size;
    void api.terminalResize(task.id, run.id, Math.max(2, Math.min(500, term.cols)), Math.max(2, Math.min(300, term.rows))).catch((error) => showToast(errorMessage(error)));
  });
  observer.observe(host);
  const view: TerminalView = { taskId: task.id, runId: run.id, host, notice, term, fit, observer,
    offset: 0, alive: false, inputAllowed:false, syncing: false, pending: [] };
  terminalViews.set(run.id, view);
  term.onData((data) => {
    if (!view.alive || !view.inputAllowed) return;
    // Recognition and notice clearing belong to TerminalRunner. xterm also
    // emits automatic color/device replies here; they are not human consent.
    // Split large pastes to bound each IPC message while preserving byte order.
    for (let i = 0; i < data.length; i += 16000) {
      void api.terminalInput(task.id, run.id, data.slice(i, i + 16000)).catch((error) => showToast(errorMessage(error)));
    }
  });
  void syncTerminal(view);
  return view;
}

function handoffDialog(task: TaskRecord, run: AgentRun): void {
  const dialog = document.createElement("dialog"); dialog.className = "handoff-dialog";
  const form = document.createElement("form");
  const heading = document.createElement("h3"); heading.textContent = "工程完了・引継ぎ";
  const note = document.createElement("p");
  note.textContent = "CLIの作業が止まっていることを確認してください。要約を次の担当へ渡します。画面の文字列から完了を推測することはありません。";
  const status = document.createElement("select"); status.setAttribute("aria-label", "引継ぎ結果");
  status.add(new Option("工程完了・次へ", "completed")); status.add(new Option("使用枠不足・別の担当へ", "rate-limited"));
  const summary = document.createElement("textarea"); summary.rows = 8; summary.required = true;
  summary.maxLength = 64000; summary.placeholder = "結果、変更したファイル、確認内容、未解決点を貼り付けてください";
  summary.setAttribute("aria-label", "引継ぎ要約");
  const submit = document.createElement("button"); submit.textContent = "引き継ぐ"; submit.type = "submit";
  const cancel = document.createElement("button"); cancel.textContent = "戻る"; cancel.type = "button";
  cancel.addEventListener("click", () => dialog.close());
  form.append(heading, note, status, summary, submit, cancel); dialog.append(form); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); submit.disabled = true;
    try { await api.terminalComplete(task.id, run.id, { status: status.value, summary: summary.value }); dialog.close(); }
    catch (error) { showToast(errorMessage(error)); submit.disabled = false; }
  });
  dialog.showModal(); summary.focus();
}

async function cliHandoffDialog(task:TaskRecord,run:AgentRun):Promise<void> {
  const dialog=document.createElement("dialog");dialog.className="restart-dialog";
  const title=document.createElement("h3");title.textContent="別CLIへ引き継いで再開";
  const note=document.createElement("p");
  note.textContent="失敗・中断した同じ工程を、指定したCLIで再実行します。成果物・ログ・完了済み工程を保持します。旧CLIの終了を確認してから起動し、その後は通常のワークフローを続けます。";
  const unit=document.createElement("p");unit.textContent=`対象：${task.workUnits.find(u=>u.id===run.workUnitId)?.title??run.role}（${agentLabel(run.agentId)}）`;
  const select=document.createElement("select");select.setAttribute("aria-label","引き継ぎ先CLI");
  const reasons=document.createElement("ul"),status=document.createElement("p");status.role="alert";
  const submit=document.createElement("button");submit.className="primary-button";submit.textContent="選択したCLIで再開";submit.disabled=true;
  const refresh=document.createElement("button");refresh.textContent="候補を再確認";refresh.className="secondary-button";
  const close=document.createElement("button");close.textContent="戻る";close.className="secondary-button";
  const canReduce=task.workUnits.some(u=>u.id===run.workUnitId&&u.crossReview?.wave===1);
  const reductionNote=document.createElement("p");
  const reduce=document.createElement("button");reduce.textContent="残るサービスで相互レビューを続行";reduce.className="primary-button";reduce.disabled=true;
  reductionNote.hidden=reduce.hidden=!canReduce;
  const actions=document.createElement("div");actions.className="detail-actions";actions.append(submit,refresh,close);
  dialog.append(title,unit,note,select,reasons,status,reductionNote,reduce,actions);document.body.append(dialog);dialog.showModal();
  let busy=false;
  const load=async()=>{
    submit.disabled=true;reduce.disabled=true;refresh.disabled=true;status.textContent="利用条件を確認しています…";
    try{
      const options=await api.terminalHandoffOptions(task.id,run.id);select.replaceChildren();reasons.replaceChildren();
      for(const option of options){const item=new Option(agentLabel(option.agentId),option.agentId);item.disabled=!option.enabled;select.add(item);
        if(!option.enabled){const reason=document.createElement("li");reason.textContent=`${agentLabel(option.agentId)}：${option.reason}`;reasons.append(reason);}}
      select.value=options.find(o=>o.enabled)?.agentId??"";submit.disabled=!select.value;
      status.textContent=select.value?"モデルはこのタスク／システムの設定を使用します。":"選択可能なCLIがありません。接続・ログイン・使用枠、またはレビュー条件を確認してください。";
      if(canReduce){
        const plan=await api.terminalReviewReduction(task.id,run.id,false);reduce.disabled=!plan.enabled;
        reductionNote.textContent=plan.enabled?`${plan.providers.map(id=>agentLabel(id as AgentId)).join("・")} の独立判定を保持します。失敗した ${agentLabel(run.agentId)} の担当枠は履歴へ移し、残る各サービスに他社の判定を検証させます。失敗を合格とは数えません。`:`レビュー再編：${plan.reason}`;
        if(plan.enabled&&!select.value)status.textContent="別CLIへの置換候補はありませんが、下のボタンで残るサービスによる相互レビューへ進めます。";
      }
    }catch(e){status.textContent=errorMessage(e);}finally{refresh.disabled=false;}
  };
  refresh.onclick=()=>void load();close.onclick=()=>dialog.close();
  dialog.oncancel=e=>{if(busy)e.preventDefault();};dialog.onclose=()=>dialog.remove();
  submit.onclick=async()=>{
    busy=true;reduce.disabled=true;submit.disabled=true;close.disabled=true;refresh.disabled=true;select.disabled=true;status.textContent="旧CLIの終了を確認し、引き継ぎを開始しています…";
    try{await api.terminalHandoff(task.id,run.id,select.value as AgentId);state.selectedTerminalAgents.set(task.id,select.value as AgentId);dialog.close();renderDetail();showToast("指定したCLIへ引き継ぎ、同じ工程から再開しました。");}
    catch(e){status.textContent=errorMessage(e);submit.disabled=false;}
    finally{busy=false;close.disabled=false;refresh.disabled=false;select.disabled=false;}
  };
  reduce.onclick=async()=>{
    busy=true;reduce.disabled=true;submit.disabled=true;refresh.disabled=true;close.disabled=true;select.disabled=true;
    status.textContent="旧CLIの終了とレビューの証拠を確認し、残りの計画を再編しています…";
    try{const result=await api.terminalReviewReduction(task.id,run.id,true);dialog.close();renderDetail();showToast(result.reason);}
    catch(e){status.textContent=errorMessage(e);reduce.disabled=false;submit.disabled=!select.value;}
    finally{busy=false;refresh.disabled=false;close.disabled=false;select.disabled=false;}
  };
  await load();
}

async function cliRecoveryDialog(task:TaskRecord,run:AgentRun):Promise<void> {
  const dialog=document.createElement("dialog");dialog.className="restart-dialog cli-recovery-dialog";
  const title=document.createElement("h3");title.textContent=`${agentLabel(run.agentId)} · CLIの手動復旧`;
  const guidance=document.createElement("p");guidance.textContent="作業指示を渡さない専用シェルです。CLIを起動して認証・正常応答を確認し、CLIとシェルを exit で終了してからReadyにしてください。以前の作業は再開・完了扱いにしません。認証出力は外部ログに保存しません。";
  const command=document.createElement("p"),status=document.createElement("p");status.role="status";
  const host=document.createElement("div");host.className="cli-recovery-terminal";
  const term=new Terminal({cols:100,rows:24,fontSize:13,disableStdin:true,scrollback:2000,theme:{background:"#0b0d12",foreground:"#e0e4ed"}});
  const fit=new FitAddon.FitAddon();term.loadAddon(fit);
  const verified=document.createElement("input");verified.type="checkbox";
  const verifiedLabel=document.createElement("label");verifiedLabel.append(verified," CLIで認証と正常応答を確認した（画面が開くだけでは不可）");
  const oldStopped=document.createElement("input");oldStopped.type="checkbox";
  const oldLabel=document.createElement("label");oldLabel.append(oldStopped," 終了記録がない旧CLIとその子処理が残っていないことを手動確認した");oldLabel.hidden=true;
  const inspect=document.createElement("button");inspect.textContent="旧CLIの停止を再確認";inspect.className="secondary-button";
  const ready=document.createElement("button");ready.textContent="確認してReadyにする";ready.className="primary-button";ready.disabled=true;
  const close=document.createElement("button");close.textContent="閉じる";close.className="secondary-button";close.disabled=true;
  const actions=document.createElement("div");actions.className="detail-actions";actions.append(inspect,ready,close);
  dialog.append(title,guidance,command,status,host,verifiedLabel,oldLabel,actions);document.body.append(dialog);dialog.showModal();term.open(host);
  let alive=false,offset=0,polling=false,opened=false,starting=true,confirming=false,confirmed=false,timer:ReturnType<typeof setInterval>|undefined;
  const call=(action:string,value?:unknown)=>api.terminalRecovery(task.id,run.id,action,value);
  const controls=()=>{ready.disabled=confirmed||confirming||!opened||alive||!verified.checked;term.options.disableStdin=!alive;};
  const inspectStatus=async()=>{const result=await call("inspect");status.textContent=result.detail;oldLabel.hidden=!result.needsManualConfirmation;};
  const poll=async()=>{
    if(polling||!opened)return;polling=true;
    try {const s=await call("snapshot");if(s){const start=s.offset-s.data.length;if(offset<start){term.reset();offset=start;}term.write(s.data.slice(Math.max(0,offset-start)));offset=s.offset;alive=s.alive;controls();}}
    catch(e){status.textContent=errorMessage(e);alive=false;controls();}finally{polling=false;}
  };
  const resize=new ResizeObserver(()=>{if(host.clientWidth<20)return;fit.fit();if(opened)void call("resize",{cols:Math.max(2,Math.min(500,term.cols)),rows:Math.max(2,Math.min(300,term.rows))}).catch(()=>{});});resize.observe(host);
  term.onData(data=>{if(alive)void call("input",data).catch(e=>{status.textContent=errorMessage(e);});});
  verified.onchange=controls;inspect.onclick=()=>{void inspectStatus().catch(e=>{status.textContent=errorMessage(e);});};
  ready.onclick=async()=>{confirming=true;controls();try{const r=await call("ready",{verified:verified.checked,oldStopped:oldStopped.checked});confirmed=true;status.textContent=r.detail;showToast(r.detail);}catch(e){status.textContent=errorMessage(e);}finally{confirming=false;controls();}};
  const dismiss=async()=>{if(starting||confirming)return;if(alive&&!confirm("復旧端末を終了しますか？Readyには変更しません。未保存の端末操作は失われることがあります。"))return;if(alive)await call("close");dialog.close();};
  close.onclick=()=>{void dismiss().catch(e=>{status.textContent=errorMessage(e);});};
  dialog.oncancel=e=>{e.preventDefault();void dismiss().catch(e=>{status.textContent=errorMessage(e);});};
  dialog.onclose=()=>{clearInterval(timer);resize.disconnect();term.dispose();dialog.remove();};
  try {const result=await call("start");opened=true;command.textContent=`${result.location??"復旧端末"} · 起動コマンド: ${result.command??run.agentId}（作業用MCP接続はありません）`;await poll();timer=setInterval(()=>void poll(),400);await inspectStatus();term.focus();}
  catch(e){status.textContent=errorMessage(e);}
  finally{starting=false;close.disabled=false;}
}

function interactivePane(task: TaskRecord, agentId: AgentId, forcedRun?: AgentRun): HTMLElement {
  const runs = terminalRuns(task, agentId);
  const key = `${task.id}:${agentId}`;
  const selected = forcedRun ?? runs.find((run) => run.id === terminalRunSelections.get(key)) ?? runs.at(-1);
  const pane = document.createElement("article"); pane.className = "agent-terminal-pane";
  if (!selected) {
    const empty = document.createElement("div"); empty.className = "terminal-empty";
    const heading = document.createElement("strong"); heading.textContent = `${agentLabel(agentId)} · 未実行`;
    const message = document.createElement("p");
    const allowed = task.allowedAgentIds.includes(agentId);
    message.textContent = allowed
      ? "このCLIは利用候補です。工程が割り当てられて起動すると、ここにCLI原画面が表示されます。ログイン管理の端末とは別です。"
      : "このタスクの利用CLIに含まれていません。利用CLIへ追加すると、次の割り当てから候補になります。ログインしただけではタスクの担当に追加されません。";
    empty.append(heading, message);
    if (!allowed) {
      const add = document.createElement("button"); add.textContent = "このタスクの利用CLIに追加";
      const busy = taskIsActive(task);
      add.disabled = busy;
      add.addEventListener("click", async () => {
        add.disabled = true;
        try {
          const saved = await api.configureAllowedAgents(task.id, [...task.allowedAgentIds, agentId]);
          state.tasks = state.tasks.map(t => t.id === saved.id ? saved : t); renderDetail();
          showToast("利用CLIへ追加しました。作業の開始・再開は自動では行いません。");
        } catch (error) { showToast(errorMessage(error)); add.disabled = false; }
      });
      empty.append(add);
      if (busy) { const note = document.createElement("p"); note.textContent = "利用CLIの変更は作業を一時停止してから行ってください。"; empty.append(note); }
    }
    pane.append(empty); return pane;
  }
  const header = document.createElement("header");
  const selector = document.createElement("select"); selector.className = "terminal-session-selector";
  selector.setAttribute("aria-label", `${agentLabel(agentId)} セッション`);
  for (const [index, run] of runs.entries()) {
    selector.add(new Option(`${agentLabel(agentId)} #${index + 1} · ${historyRoleLabels[run.role]} · ${run.executionLocation === "local" ? "このMac" : task.remote ? "遠隔" : "このMac"} · ${runStatusLabel(task, run)}${run.terminal ? "" : " · 旧ログ"}`, run.id));
  }
  selector.value = selected.id;
  selector.disabled = Boolean(forcedRun);
  selector.addEventListener("change", () => { terminalRunSelections.set(key, selector.value); renderDetail(); });
  header.append(selector);
  pane.append(header);
  if (!selected.terminal) {
    const log = document.createElement("pre"); log.className = "agent-terminal";
    log.textContent = humanOutput(selected.displayOutput || selected.output); pane.append(log); return pane;
  }
  const view = terminalView(task, selected);
  const finish = document.createElement("button"); finish.textContent = "工程完了・引継ぎ";
  finish.disabled = selected.state !== "running" || task.state === "paused";
  finish.addEventListener("click", () => handoffDialog(task, selected));
  const close = document.createElement("button"); close.textContent = "端末終了";
  close.disabled = selected.state === "running";
  close.addEventListener("click", async () => {
    if (!window.confirm("このCLIセッションを終了しますか？保存済みログは残ります。")) return;
    try { await api.terminalClose(task.id, selected.id); } catch (error) { showToast(errorMessage(error)); }
  });
  const recover=document.createElement("button");recover.textContent="CLIを復旧…";
  recover.disabled=taskIsActive(task)||selected.state==="running";
  recover.onclick=()=>{void cliRecoveryDialog(task,selected);};
  const health=document.createElement("span");health.className="cli-readiness";
  health.textContent=selected.terminationUnconfirmed?"停止未確認":selected.recoveredAt?"Ready · 手動確認済み":"";
  health.title=selected.recoveredAt?`${selected.recoveredAt} · 使用枠やモデル条件は別途適用` : "";
  header.append(health,finish,close,recover);
  if (["failed","cancelled","rate-limited"].includes(selected.state)
    && task.runs.filter(r=>r.workUnitId===selected.workUnitId).at(-1)?.id===selected.id
    && task.workUnits.some(u=>u.id===selected.workUnitId&&u.state!=="completed")) {
    const transfer=document.createElement("button");transfer.textContent="別CLIへ引き継いで再開…";
    transfer.disabled=taskIsActive(task);transfer.title=transfer.disabled?"タスクを一時停止してから引き継いでください":"成果物と履歴を保持し、同じ工程を別CLIで再開します";
    transfer.onclick=()=>void cliHandoffDialog(task,selected);header.append(transfer);
  }
  selector.selectedOptions[0].textContent += " · 対話端末";
  pane.dataset.inputMode = "対話端末";
  pane.append(view.notice, view.host);
  return pane;
}

function buildInteractiveTerminals(task: TaskRecord): HTMLElement {
  const section = document.createElement("section"); section.className = "agent-monitors interactive-monitors";
  const agents = terminalAgentIds(task);
  if (!agents.length) {
    const empty = document.createElement("p"); empty.className = "terminal-empty";
    empty.textContent = "利用CLIが設定されていません。Goalから利用CLIを設定してください。";
    section.append(empty); return section;
  }
  const selected = state.selectedTerminalAgents.get(task.id);
  const active = [...task.runs].reverse().find((run) => run.state === "running")?.agentId;
  const chosen = selected && agents.includes(selected) ? selected : active ?? agents[0];
  const tabs = document.createElement("div"); tabs.className = "agent-terminal-tabs"; tabs.role = "tablist";
  for (const agentId of agents) {
    const tab = document.createElement("button"); tab.className = `agent-terminal-tab${chosen === agentId ? " selected" : ""}`;
    tab.textContent = agentLabel(agentId); tab.role = "tab"; tab.setAttribute("aria-selected", String(chosen === agentId));
    tab.title = terminalRuns(task, agentId).length ? `${agentLabel(agentId)} の実行端末` : task.allowedAgentIds.includes(agentId) ? "利用候補・未実行" : "利用CLIへの追加が必要";
    tab.addEventListener("click", () => { state.selectedTerminalAgents.set(task.id, agentId); terminalTiledTasks.delete(task.id); renderDetail(); });
    tabs.append(tab);
  }
  const tile = document.createElement("button"); tile.textContent = terminalTiledTasks.has(task.id) ? "タブ表示" : "並べて表示";
  tile.addEventListener("click", () => {
    if (!terminalTiledTasks.delete(task.id)) terminalTiledTasks.add(task.id);
    renderDetail();
  }); tabs.append(tile); section.append(tabs);
  const body = document.createElement("div"); body.className = terminalTiledTasks.has(task.id) ? "terminal-tiles" : "terminal-single";
  const live = task.runs.filter(r => r.state === "running" && r.terminal);
  const targets = terminalTiledTasks.has(task.id) ? live.length > 1 ? live.map(run => ({ agentId: run.agentId, run })) : agents.map(agentId => ({ agentId, run: undefined })) : [{ agentId: chosen, run: undefined }];
  const tiled = terminalTiledTasks.has(task.id) && targets.length > 1;
  for (const [index, target] of targets.entries()) {
    const pane = interactivePane(task, target.agentId, target.run);
    if (tiled) { pane.style.gridColumn = String(index % 2 === 0 ? 1 : 3); pane.style.gridRow = String(Math.floor(index / 2) + 1); }
    body.append(pane);
  }
  if (tiled) {
    const splitter = columnSplitter(`terminals:${task.id}`, body, .5, .2, .8, (ratio) => {
      body.style.gridTemplateColumns = `minmax(0, ${ratio}fr) 6px minmax(0, ${1 - ratio}fr)`;
    });
    splitter.style.gridColumn = "2"; splitter.style.gridRow = `1 / ${Math.ceil(targets.length / 2) + 1}`;
    body.append(splitter);
  }
  section.append(body);
  return section;
}

// DOM nodes are moved, not recreated, when tasks/tabs rerender. Dispose only deleted tasks.
function pruneTerminalViews(): void {
  const tasks = new Set(state.tasks.map((task) => task.id));
  for (const [id, view] of terminalViews) {
    if (tasks.has(view.taskId)) continue;
    view.observer.disconnect(); view.term.dispose(); terminalViews.delete(id);
  }
}

function paneSplitter(key: string, target: HTMLElement, edge: "top" | "bottom", minimum: number, maximum: () => number): HTMLElement {
  const handle = document.createElement("div"); handle.className = "pane-splitter";
  handle.role = "separator"; handle.tabIndex = 0; handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", "ペインの高さを調整（ダブルクリックで戻す）");
  const stored = Number(localStorage.getItem(`pane:${key}`));
  if (stored >= minimum && Number.isFinite(stored)) target.style.height = `${stored}px`;
  const set = (height: number) => {
    if (target instanceof HTMLDetailsElement) target.open = true;
    const value = Math.round(Math.max(minimum, Math.min(maximum(), height)));
    target.style.height = `${value}px`; target.style.flexShrink = "0";
    localStorage.setItem(`pane:${key}`, String(value)); handle.setAttribute("aria-valuenow", String(value));
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const origin = event.clientY; const height = target.getBoundingClientRect().height;
    document.body.classList.add("resizing-panes");
    const move = (moveEvent: PointerEvent) => set(height + (moveEvent.clientY - origin) * (edge === "top" ? 1 : -1));
    const end = () => { document.body.classList.remove("resizing-panes"); handle.removeEventListener("pointermove", move); handle.removeEventListener("lostpointercapture", end); };
    handle.addEventListener("pointermove", move); handle.addEventListener("lostpointercapture", end);
  });
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); set(target.getBoundingClientRect().height + (event.key === "ArrowDown" ? 16 : -16) * (edge === "top" ? 1 : -1));
  });
  handle.addEventListener("dblclick", () => { target.style.height = ""; localStorage.removeItem(`pane:${key}`); });
  return handle;
}

function columnSplitter(key: string, container: HTMLElement, initial: number, minimum: number, maximum: number,
  apply: (fraction: number) => void): HTMLElement {
  const handle = document.createElement("div"); handle.className = "column-splitter";
  handle.role = "separator"; handle.tabIndex = 0; handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "ペインの幅を調整（ダブルクリックで戻す）");
  const saved = Number(localStorage.getItem(`columns:${key}`));
  let ratio = saved >= minimum && saved <= maximum ? saved : initial;
  const set = (value: number) => {
    ratio = Math.max(minimum, Math.min(maximum, value)); apply(ratio);
    localStorage.setItem(`columns:${key}`, String(ratio));
    handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  };
  apply(ratio);
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const origin = event.clientX; const start = ratio; const width = container.clientWidth;
    document.body.classList.add("resizing-columns");
    const move = (e: PointerEvent) => set(start + (e.clientX - origin) / width);
    const end = () => { document.body.classList.remove("resizing-columns"); handle.removeEventListener("pointermove", move); handle.removeEventListener("lostpointercapture", end); };
    handle.addEventListener("pointermove", move); handle.addEventListener("lostpointercapture", end);
  });
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); set(ratio + (event.key === "ArrowRight" ? .02 : -.02));
  });
  handle.addEventListener("dblclick", () => set(initial));
  return handle;
}

function initializeSidebarSplitter(): void {
  const shell = document.querySelector<HTMLElement>(".app-shell")!;
  const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
  const handle = columnSplitter("sidebar", shell, .195, .15, .27, (fraction) => {
    shell.style.setProperty("--task-sidebar-width", `clamp(170px, ${fraction * 100}%, 300px)`);
  });
  handle.setAttribute("aria-label", "タスクサイドバーの幅を調整");
  sidebar.after(handle);
  const resources = document.querySelector<HTMLElement>(".resource-sidebar")!;
  const rightHandle = columnSplitter("resource-sidebar", shell, .78, .73, .84, (fraction) => {
    shell.style.setProperty("--resource-sidebar-width", `clamp(190px, ${(1 - fraction) * 100}%, 300px)`);
  });
  rightHandle.setAttribute("aria-label", "利用量サイドバーの幅を調整");
  resources.before(rightHandle);
}
