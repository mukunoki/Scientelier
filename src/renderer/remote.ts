interface PreparedTarget { hostname: string; username: string; home: string; cwd: string; nodeExecutable: string; }
interface PreparedConnectionStatus { mode: "direct" | "prepared"; stage: "shell" | "checking" | "ready" | "closed"; target?: PreparedTarget; error?: string; }
interface RemoteSystem {
  terminalBackend?: "auto" | "tmux" | "direct";
  codexPermissions?: "sandbox" | "full-access";
  connectionMode?: "direct" | "prepared"; pythonCommand?: string; preparedTarget?: PreparedTarget;
  id: string; name: string; host: string; cwd: string; nodeCommand: string;
  startup: string; instructions: string; texCommand: string;
  username?: string; port?: number; resolvedCwd?: string;
}
function confirmRemoteFullAccess(local = false): boolean {
  return window.confirm(`${local ? "このMacの" : "遠隔"}CodexをFull accessで起動します。Codexのサンドボックスと承認要求は使いません。ログインユーザがアクセスできる作業フォルダ外のファイル・認証情報・ネットワークにも操作が及ぶ可能性があります。読み取り担当・レビューもOSによる書込禁止ではなく指示のみになります。施設の利用規則と管理ポリシーは引き続き適用されます。この範囲を理解して許可しますか？`);
}
function codexDiagnosticNote(result: { codexPermissions?: string }): string {
  return result.codexPermissions === "full-access" ? "Full access：通常コマンドとCLI起動のみ確認。サンドボックスは使用・検証していません。隔離環境の復旧や本作業の成功を示すものではありません。"
    : result.codexPermissions === "sandbox" ? "サンドボックス設定：Linuxでは読み取り用・作業用の隔離環境も確認します。" : "診断の対象と結果は下記の項目を確認してください。";
}
let remoteSystemsList: RemoteSystem[] = [];
const remoteAgentLists = new Map<string, AgentStatus[]>();
const preparedStatuses = new Map<string, PreparedConnectionStatus>();
function selectedRemoteId(): string { return byId<HTMLSelectElement>("task-remote").value; }
function dispatchAgents(): AgentStatus[] {
  const id = selectedRemoteId();
  return (!id ? state.agents : remoteAgentLists.get(id) ?? state.agents.map(a => ({ ...a, installed: true, version: "遠隔・未確認", executable: undefined }))).filter(a => a.id !== "gemini");
}
function renderRemoteChoices(): void {
  for (const id of ["task-remote", "remote-select"]) {
    const select = byId<HTMLSelectElement>(id); const previous = select.value;
    select.replaceChildren(new Option(id === "task-remote" ? "このMac" : "新しく登録", ""));
    for (const system of remoteSystemsList) select.add(new Option(`${system.name} · ${system.host}`, system.id));
    select.value = remoteSystemsList.some(p => p.id === previous) ? previous : "";
  }
  updateRemoteDispatch();
}
function updateRemoteDispatch(): void {
  invalidateWorkspace();
  const system = remoteSystemsList.find(p => p.id === selectedRemoteId());
  byId("task-local-directory").classList.toggle("hidden", !!system);
  byId<HTMLInputElement>("task-cwd").required = !system;
  byId<HTMLSelectElement>("task-workspace-mode").required = !system;
  const prepared = system && preparedStatuses.get(system.id);
  byId("task-remote-note").textContent = system?.connectionMode === "prepared"
    ? prepared?.stage === "ready" && prepared.target ? `準備済み環境：${prepared.target.username}@${prepared.target.hostname}:${prepared.target.cwd}。CLI・ファイル操作・PDF取得をこの最終マシンで行います。`
      : `手動準備：最初の接続先 ${system.host}。開始時の接続用ターミナルで追加SSH・環境設定・cdを行い、最終マシンを確定してください。`
    : system ? `遠隔CLI：${system.host}:${system.cwd}。作業開始時にSSH認証画面が開きます（接続済みなら不要）。作業フォルダはこの接続先の設定を使います。ローカルのCLI検出・使用枠とは別です。` : "";
  renderTaskAgentPool();
}
function initializeRemote(systems: RemoteSystem[] = []): void {
  initializeTaskRemoteAuthentication();
  remoteSystemsList = systems; renderRemoteChoices();
  const select = byId<HTMLSelectElement>("remote-select");
  const fields = { id: "remote-id", name: "remote-name", host: "remote-host", username: "remote-user", port: "remote-port", cwd: "remote-cwd", nodeCommand: "remote-node", pythonCommand: "remote-python", connectionMode: "remote-mode", terminalBackend:"remote-terminal-backend", codexPermissions: "remote-codex-permissions", texCommand: "remote-tex", startup: "remote-startup", instructions: "remote-instructions" } as const;
  let loadedFields: Record<string, string> = {};
  const formValues = () => Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, byId<HTMLInputElement>(id).value]));
  const updateMode = () => {
    const manual = byId<HTMLSelectElement>("remote-mode").value === "prepared";
    byId("remote-mode-note").classList.toggle("hidden", !manual);
    byId("remote-direct-folder").classList.toggle("hidden", manual);
  };
  const loadSelectedProfile = () => {
    const value = remoteSystemsList.find(p => p.id === select.value);
    for (const [key, id] of Object.entries(fields)) byId<HTMLInputElement | HTMLTextAreaElement>(id).value = String(value?.[key as keyof RemoteSystem] ?? (key === "terminalBackend" ? "auto" : key === "codexPermissions" ? value ? "sandbox" : "full-access" : key === "nodeCommand" ? "node" : key === "pythonCommand" ? "python3" : key === "connectionMode" ? value ? "direct" : "prepared" : key === "texCommand" ? "latexmk" : key === "cwd" ? "agent-harness" : ""));
    loadedFields = formValues(); updateMode();
    byId("remote-update-address-label").hidden = byId("remote-address-note").hidden = !value;
    byId<HTMLInputElement>("remote-update-task-address").checked = !!value;
    byId<HTMLInputElement>("remote-id").readOnly = !!value;
    byId<HTMLButtonElement>("remote-dispatch").disabled = !value;
    byId("remote-status").textContent = "ここでは接続先の設定を保存します。接続・認証・診断はResourcesで行います。";
    try { localStorage.setItem("remote-settings-selection", select.value); } catch { /* Optional preference. */ }
  };
  const action = async (fn: () => Promise<void>) => {
    byId("remote-error").textContent = "";
    try { await fn(); } catch (e) { byId("remote-error").textContent = errorMessage(e); }
  };
  select.addEventListener("change", loadSelectedProfile);
  let previous = "";
  try { previous = localStorage.getItem("remote-settings-selection") ?? ""; } catch { /* Optional preference. */ }
  select.value = remoteSystemsList.some(p => p.id === previous) ? previous : remoteSystemsList[0]?.id ?? "";
  loadSelectedProfile();
  byId("remote-mode").addEventListener("change", updateMode);
  byId("remote-dispatch").onclick = () => void action(async () => {
    if (Object.entries(formValues()).some(([key, value]) => loadedFields[key] !== value)) throw new Error("変更した接続先を保存してからResourcesを開いてください。");
    serviceEnvironment = select.value; showView("usage");
  });
  byId("task-remote").addEventListener("change", updateRemoteDispatch);
  byId<HTMLFormElement>("remote-form").addEventListener("submit", event => {
    event.preventDefault();
    void action(async () => {
      const raw = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, byId<HTMLInputElement | HTMLTextAreaElement>(id).value]));
      const value = { ...raw, id: raw.id.trim() || `remote-${crypto.randomUUID()}`, username: raw.username.trim() || undefined, port: raw.port ? Number(raw.port) : undefined } as unknown as RemoteSystem;
      const fullAccess = value.codexPermissions === "full-access";
      if (fullAccess && !confirmRemoteFullAccess()) return;
      const previous = remoteSystemsList.find(system => system.id === value.id);
      const address = value.host.trim().split("@").at(-1);
      const affected = state.tasks.filter(task => task.remote?.id === value.id && task.remote.host.split("@").at(-1) !== address);
      const applyAddress = !!previous && byId<HTMLInputElement>("remote-update-task-address").checked && (previous.host !== value.host.trim() || affected.length > 0);
      if (applyAddress && !window.confirm(`同じマシンの接続アドレス変更として保存し、既存タスク${affected.length}件にも反映しますか？\nゴール・作業フォルダ・ログインユーザ・権限・成果・履歴は保持します。待機中のSSH接続は閉じ、新しいIPへ再接続します。別マシンへの移動では使用しないでください。タスクは自動再開しません。`)) return;
      remoteSystemsList = await api.remoteSave(value, fullAccess, applyAddress ? { expectedHost: previous!.host, confirmed: true } : undefined);
      renderRemoteChoices(); select.value = value.id;
      remoteAgentLists.delete(value.id);
      preparedStatuses.delete(value.id);
      loadSelectedProfile(); updateRemoteDispatch();
      byId("remote-status").textContent = applyAddress
        ? `保存しました。既存タスク${affected.length}件の接続アドレスだけを更新しました。Resourcesまたはタスクの再開からSSHへ再接続し、同じ最終マシン・作業フォルダを確定してください。タスクは自動再開しません。`
        : "保存しました。接続・認証はResourcesで行います。既存タスクの接続先・作業場所は変更しません。";
    });
  });
  api.onRemoteOutput?.(event => {
    if (event.stream !== "status") return;
    const cached = preparedStatuses.get(event.id);
    if (cached) preparedStatuses.set(event.id, { ...cached, stage: "closed" });
    remoteAgentLists.delete(event.id); updateRemoteDispatch();
  });
}

function showTaskLoginRoute(task: TaskRecord): void {
  if(document.querySelector(".login-route-dialog"))return;
  const dialog=document.createElement("dialog");dialog.className="login-route-dialog restart-dialog";
  dialog.setAttribute("aria-label","最初のログイン先を変更");
  const title=document.createElement("h3");title.textContent="最初のSSHログイン先だけを変更";
  const target=task.remote?.preparedTarget;
  const note=document.createElement("p");note.textContent="その先の作業マシン・作業フォルダ・ゴール・成果・履歴は変更しません。保存後は新しいログイン先から手動で追加SSHし、以前と同じ最終環境で接続を確定してください。タスクは自動再開しません。";
  const final=document.createElement("p");final.textContent=target ? `保持する最終環境：${target.username}@${target.hostname}:${target.cwd}` : "最終環境は初回の手動接続で確定します。";
  const select=document.createElement("select");select.setAttribute("aria-label","タスクの最初のログイン先");
  select.add(new Option("ログイン先を選択", ""));
  for(const system of remoteSystemsList.filter(s=>s.id!==task.remote?.id&&s.connectionMode==="prepared"))select.add(new Option(`${system.name} · ${system.host}`,system.id));
  const error=document.createElement("p");error.className="form-error";error.role="alert";
  const actions=document.createElement("div");actions.className="detail-actions";
  const apply=document.createElement("button");apply.textContent="ログイン先だけを変更";apply.className="primary-button";apply.disabled=true;
  const close=document.createElement("button");close.textContent="閉じる";close.onclick=()=>dialog.close();
  let busy=false;select.onchange=()=>{apply.disabled=!select.value;};
  apply.onclick=async()=>{
    if(busy||!select.value)return;
    busy=true;apply.disabled=close.disabled=select.disabled=true;error.textContent="";
    try{const saved=await api.setTaskLoginRoute(task.id,select.value,{updatedAt:task.updatedAt,confirmed:true});state.tasks=state.tasks.map(t=>t.id===saved.id?saved:t);renderTasks();renderDetail();renderResourceSummary();dialog.close();showToast(`最初のログイン先を${saved.remote?.name}へ変更しました。手動で追加SSHし、以前と同じ最終環境で確定してください。`);}
    catch(e){error.textContent=errorMessage(e);}
    finally{busy=false;close.disabled=select.disabled=false;apply.disabled=!select.value;}
  };
  dialog.oncancel=e=>{if(busy)e.preventDefault();};dialog.onclose=()=>dialog.remove();
  actions.append(apply,close);dialog.append(title,note,final,select,error,actions);document.body.append(dialog);dialog.showModal();
}

function initializeTaskRemoteAuthentication(): void {
  if (!api.onRemoteAuthRequired) return;
  const dialog = byId<HTMLDialogElement>("remote-task-auth-dialog");
  const host = byId("remote-task-auth-terminal");
  const term = new Terminal({ cols: 85, rows: 14, fontSize: 13, cursorBlink: true, theme: { background: "#0b0d12", foreground: "#e0e4ed" } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host);
  let pending: { taskId: string; system: RemoteSystem; recovery?: "inspect" | "resume" } | undefined;
  let busyRequest: typeof pending;
  const error = byId("remote-task-auth-error");
  const status = byId("remote-task-auth-status");
  const action = async (body: (request: NonNullable<typeof pending>) => Promise<void>) => {
    if (!pending || busyRequest === pending) return;
    const request = pending;
    busyRequest = request; error.textContent = "";
    byId<HTMLButtonElement>("remote-task-auth-continue").disabled = true;
    byId<HTMLButtonElement>("remote-task-auth-retry").disabled = true;
    try { await body(request); } catch (e) { if (pending === request) error.textContent = errorMessage(e); }
    finally {
      if (busyRequest === request) {
        busyRequest = undefined;
        byId<HTMLButtonElement>("remote-task-auth-continue").disabled = false;
        byId<HTMLButtonElement>("remote-task-auth-retry").disabled = false;
      }
    }
  };
  term.onData(data => {
    if (pending) void api.remoteInput(pending.system.id, data).catch(e => { error.textContent = errorMessage(e); });
  });
  new ResizeObserver(() => {
    if (!host.clientWidth || !host.clientHeight) return;
    fit.fit();
    if (pending) void api.remoteResize(pending.system.id, Math.min(500, term.cols), Math.min(300, term.rows)).catch(() => {});
  }).observe(host);
  api.onRemoteOutput(event => {
    if (event.id !== pending?.system.id) return;
    if (event.stream === "status") status.textContent = event.text;
    else term.write(event.text);
  });
  api.onRemoteAuthRequired(event => {
    pending = event; term.reset(); error.textContent = "";
    byId("remote-task-auth-target").textContent = `${event.title} · ${event.system.name} · ${event.system.username ? event.system.username + "@" : ""}${event.system.host} · ${event.system.cwd}`;
    const manual = event.system.connectionMode === "prepared";
    byId("remote-task-auth-instructions").textContent = manual ? "下の端末で最終マシンまで追加SSH・認証を済ませ、必要な環境設定とcdを行ってください。最終マシンにNode.js・Python 3・CLIが必要です。" : "下の端末でSSHのパスワード・多要素認証・初回ホスト鍵確認を行ってください。パスワードは設定に保存しません。";
    if(manual && event.system.preparedTarget){const t=event.system.preparedTarget;byId("remote-task-auth-instructions").textContent+=` 保持している最終環境：${t.username}@${t.hostname}:${t.cwd}。最初のログイン先を変更しても、この最終環境は変更しません。`;}
    byId("remote-task-auth-next").textContent = manual ? "最終マシンのシェルのプロンプトが出た状態で確定してください。パスワード入力中には押さないでください。確定後、この接続は連携専用になります。" : "認証後に「環境確認して続行」を押してください。フォルダがなければ作成し、その後にCLIを起動します。";
    if (event.recovery) byId("remote-task-auth-next").textContent = `以前と同じマシン・ユーザ・作業フォルダで確定してください。${event.recovery === "inspect" ? "確定後は診断だけを行い、タスクは開始しません。" : "確定後に再診断し、確認できた場合だけ未完了工程から再開します。"}`;
    byId("remote-task-auth-continue").textContent = manual ? "ここを作業環境として確定して続行" : "環境確認して続行";
    status.textContent = manual ? "接続用ターミナルを開いています。最終マシンへの接続を準備してください。" : "SSH接続を開始しています。認証後に「環境確認して続行」を押してください。";
    dialog.showModal();
    void action(async request => {
      const snapshot = await api.remoteSnapshot(request.system.id);
      if (pending !== request) return;
      if (snapshot?.alive) term.write(snapshot.data);
      await api.remoteTaskConnect(request.taskId);
      if (pending === request) { fit.fit(); term.focus(); }
    });
  });
  byId("remote-task-auth-retry").addEventListener("click", () => void action(async request => {
    await api.remoteTaskConnect(request.taskId); term.focus();
    status.textContent = "端末で認証し、「環境確認して続行」を押してください。";
  }));
  byId("remote-task-auth-continue").addEventListener("click", () => void action(async request => {
    status.textContent = "接続先の環境と作業フォルダを確認しています…";
    const result = await api.remoteTaskReady(request.taskId);
    if (pending !== request) return;
    remoteAgentLists.set(request.system.id, result.agents);
    if (result.target) preparedStatuses.set(request.system.id, { mode: "prepared", stage: "ready", target: result.target });
    pending = undefined; dialog.close(); updateRemoteDispatch();
    showToast(`SSH認証完了 · ${result.cwd} ${request.recovery ? "の復旧診断を行います。" : "で作業を開始します。"}`);
  }));
  const cancel = async () => {
    const request = pending; if (!request) return;
    try {
      await api.remoteTaskCancel(request.taskId);
      if (pending === request) { pending = undefined; dialog.close(); }
    } catch (e) { error.textContent = errorMessage(e); }
  };
  byId("remote-task-auth-cancel").addEventListener("click", () => void cancel());
  dialog.addEventListener("cancel", event => { event.preventDefault(); void cancel(); });
}
