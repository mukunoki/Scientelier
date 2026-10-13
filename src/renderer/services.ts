/** Presentation only. Environment readiness and account quota are different
 * facts; neither grouping nor a successful status command changes routing. */
interface ServiceAccountGroup {
  key: string; serviceKey: string; label: string; members: ProviderResourceSummary[];
  quota: ProviderResourceSummary;
}
let serviceEnvironment = "local";
function serviceInEnvironment(r: ProviderResourceSummary): boolean {
  return !serviceEnvironment || (r.environmentId ?? "local") === serviceEnvironment;
}
function renderServiceEnvironment(): void {
  const select = byId<HTMLSelectElement>("service-environment");
  select.replaceChildren(new Option("すべての環境", ""), new Option("このMac", "local"));
  for (const system of remoteSystemsList) select.add(new Option(system.name, system.id));
  if (![...select.options].some(o => o.value === serviceEnvironment)) serviceEnvironment = "";
  select.value = serviceEnvironment;
  select.onchange = () => { serviceEnvironment = select.value; renderResources(); renderResourceSummary(); };
  byId("service-environment-settings").onclick = () => {
    openServiceSettings(undefined, true);
    if (serviceEnvironment && serviceEnvironment !== "local") {
      const profile = byId<HTMLSelectElement>("remote-select"); profile.value = serviceEnvironment; profile.dispatchEvent(new Event("change"));
    }
  };
}
function serviceKeyOf(r: ProviderResourceSummary): string { return r.serviceKey ?? r.providerKey.split("@")[0]; }
function serviceLabelOf(r: ProviderResourceSummary): string { return r.serviceLabel ?? r.providerLabel.split(" · ")[0]; }
function usageAuthenticationFailed(r: ProviderResourceSummary): boolean {
  return /\b401\b|\b403\b|認証.*(?:拒否|期限切れ|ありません)|authorization failed|usage unavailable\. Sign in/i.test(r.capacityError ?? "");
}
function serviceCapacityError(r: ProviderResourceSummary): string {
  // Quota API credentials can fail while the CLI still works. This also scopes
  // legacy persisted relogin instructions without changing the observation.
  const raw = r.capacityError ?? "";
  if (usageAuthenticationFailed(r)) {
    const http = raw.match(/\b(401|403)\b/)?.[1];
    const environment = raw.match(/環境変数CLAUDE_CODE_OAUTH_TOKEN[^。]*。/)?.[0];
    return `残量取得の認証を確認できません${http ? `（HTTP ${http}）` : ""}。CLIが使えている場合は再ログイン不要です。「更新」で再確認できます。${environment ?? ""}`;
  }
  if (serviceKeyOf(r) === "ollama-cloud" && /Webログイン|未連携|Web連携を解除/.test(raw))
    return "残量表示のWeb連携は未確認です。モデル実行には不要です。必要な場合だけ「残量表示を連携（任意）」を利用してください。";
  return raw.replace(/Resourcesの「Claudeログイン管理」で確認・再ログインしてください。/g,
    "CLIが使えている場合は再ログイン不要です。残量取得は「更新」で再確認できます。");
}
function cliAuthenticationFailed(r: ProviderResourceSummary): boolean {
  return r.login?.loggedIn === false || !!r.login?.blocked;
}
function quotaObservedTime(r: ProviderResourceSummary): number {
  const times = r.windows.map(w => Date.parse(w.observedAt ?? r.capacityUpdatedAt ?? "")).filter(Number.isFinite);
  return times.length ? Math.max(...times) : Date.parse(r.capacityUpdatedAt ?? "") || 0;
}
function accountResourceGroups(resources: ProviderResourceSummary[]): ServiceAccountGroup[] {
  const groups = new Map<string, ProviderResourceSummary[]>();
  for (const r of resources) {
    // Unknown identities never merge, including across local and SSH sessions.
    // Account labels are a retired display feature, not proof of identity.
    // Keep observations separate; never apply one host's quota to another.
    const key = JSON.stringify([serviceKeyOf(r), ["unassigned", r.providerKey]]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, members]) => {
    const measured = members.filter(r => r.limitSource !== "configured" && r.limitSource !== "unknown"
      && (r.windows.length || r.usedPercent !== undefined));
    const latest = [...(measured.length ? measured : members)].sort((a, b) => quotaObservedTime(b) - quotaObservedTime(a))[0];
    const label = members[0].environmentLabel ?? "このMac";
    // Choose a whole observation; never add percentages or silently combine
    // different model buckets observed at different times into a fresh snapshot.
    const quota = { ...latest, providerLabel: `${serviceLabelOf(latest)} · ${label}`,
      softTokenBudget: undefined,
      usedPercent: latest.limitSource === "configured" || latest.limitSource === "unknown" ? undefined : latest.usedPercent,
      totalTokens: members.reduce((n, r) => n + r.totalTokens, 0),
      inputTokens: members.reduce((n, r) => n + r.inputTokens, 0),
      outputTokens: members.reduce((n, r) => n + r.outputTokens, 0),
      runs: members.reduce((n, r) => n + r.runs, 0) };
    return { key, serviceKey: serviceKeyOf(latest), label, members, quota };
  });
}
function serviceReadiness(r: ProviderResourceSummary, quota = r, now = Date.now()): { tone: string; label: string; reason: string } {
  const result = (tone: string, label: string, reason: string) => ({ tone, label, reason });
  if (r.enabled === false) return result("muted", "利用OFF", "Resourcesで利用対象から外れています。");
  if (r.connected === false) return result("blocked", "SSH未接続", "先に作業環境へ接続してください。ログイン・CLI検出は未確認です。");
  if (r.cliInstalled === false) return result("blocked", "CLI未検出", "対象環境でCLIを導入・検出してください。");
  if (cliAuthenticationFailed(r)) return result("blocked", "認証・設定の確認が必要", r.login!.detail);
  if (r.login?.runtimeReady === false) return result("blocked", "Ollama未接続", r.login.detail);
  if (r.cooldownUntil && Date.parse(r.cooldownUntil) > now || quota.cooldownUntil && Date.parse(quota.cooldownUntil) > now)
    return result("blocked", "使用制限中", "CLIの制限通知を記録しています。リセット時刻と対象モデルを確認してください。");
  if (quota.ordinaryUsageAllowed === false || quota.usedPercent !== undefined && quota.usedPercent >= 100)
    return result("blocked", "使用枠不足", "最後の取得値で使用枠が不足しています。更新して残量を確認してください。");
  if (r.state === "draining" || quota.state === "draining") return result("warning", "切替目安に到達", "保存済みの使用率目安を超えています。別サービスへの割り当てを優先します。");
  if (r.login?.runtimeReady === true && Number.isFinite(Date.parse(r.login.checkedAt)) && now - Date.parse(r.login.checkedAt) <= 5 * 60_000)
    return result("observed", "Ollama接続済み", "この環境のOllamaに接続できます。既存のCLI認証を使います。クラウド認証は実行時に確認し、残量表示のWeb連携は任意です。");
  // A usage observation is not a login-status response. In particular, another
  // host's shared account quota must never certify this CLI's authentication.
  if (r.login?.checkSupported === false || (!r.login && r.agentIds?.includes("antigravity"))) {
    if (quotaIsFresh(r, now)) return result("observed", "使用枠取得済み", "この環境のCLIから使用枠を取得しました。認証単独の自動判定は未対応ですが、認証エラーではありません。モデル実行の成功を保証する表示ではありません。");
    if (r.capacityError) return result("warning", "使用枠の取得を確認", `${serviceCapacityError(r)} CLIの認証失敗とは判定しません。`);
    return result("muted", r.windows.length ? "使用枠は前回値" : "使用枠未取得", "認証単独の自動判定は未対応です。CLIが操作できる場合、再ログインは不要です。/usage を実行して使用枠を更新してください。");
  }
  if (!r.login || r.login.loggedIn !== true || !Number.isFinite(Date.parse(r.login.checkedAt)) || now - Date.parse(r.login.checkedAt) > 5 * 60_000)
    return result("warning", "状態未確認", "「更新」で認証と使用枠を確認できます。CLIを利用できていれば再ログインは不要です。");
  return result("ready", "認証確認済み", "CLIのログインを確認済みです。実際のモデル通信と契約残量は別に確認します。");
}

/** Compact, environment-specific candidate status. Authentication/connection
 * evidence and quota observations remain separate; this does not route work. */
function serviceAvailability(r: ProviderResourceSummary, task?: TaskRecord, now = Date.now()) {
  if (task && !task.allowedAgentIds.some(id => r.agentIds.includes(id))) return { tone: "muted", label: "タスク対象外", reason: "このタスクで許可されていないCLIです。" };
  const s = serviceReadiness(r, r, now);
  if (s.tone === "ready") return { ...s, label: "利用可能（認証確認）" };
  if (s.label === "Ollama接続済み") return { ...s, label: "接続済み・実行時確認" };
  if (s.label === "使用枠取得済み") return { ...s, label: "使用枠取得済み・実行時確認" };
  if (s.label === "切替目安に到達") return { ...s, label: "切替目安に到達" };
  if (cliAuthenticationFailed(r)) return { ...s, label: "ログイン確認が必要" };
  if (["使用制限中", "使用枠不足"].includes(s.label)) return { ...s, label: "使用枠の制限あり" };
  if (["SSH未接続", "CLI未検出", "Ollama未接続", "利用OFF"].includes(s.label)) return s;
  return { ...s, tone: "warning", label: "実行状態は未確認" };
}
function quotaObservationNote(r: ProviderResourceSummary): string {
  return `取得元：${r.environmentLabel ?? "このMac"} · ${r.capacityUpdatedAt && r.limitSource !== "unknown" ? new Date(r.capacityUpdatedAt).toLocaleString() : "未取得"}${r.capacityError ? " · 取得失敗／前回値" : ""}`;
}

/** One persistent CLI terminal per environment/service. Closing this view never
 * sends a signal, disconnects SSH, or passes login conversation to a task. */
function showRemoteServiceTerminal(resource: ProviderResourceSummary): void {
  const previous = document.querySelector<HTMLDialogElement>(".remote-service-dialog");
  if (!resource.environmentId || previous?.open) return;
  previous?.remove(); // close events can be delivered after an immediate reopen.
  const environmentId = resource.environmentId, agentId = resource.agentIds[0];
  const system = remoteSystemsList.find(s => s.id === environmentId);
  const dialog = serviceElement("dialog", "", "claude-login-dialog cli-terminal-dialog remote-service-dialog terminal-active");
  dialog.setAttribute("aria-label", `${agentLabel(agentId)} · ${resource.environmentLabel}`);
  const title = serviceElement("h3", `${resource.environmentLabel} · ${agentLabel(agentId)}`);
  const status = serviceElement("p", "接続状態を確認しています…"); status.setAttribute("role", "status");
  const error = serviceElement("p", "", "form-error"); error.setAttribute("role", "alert");
  const note = serviceElement("p", "「画面を閉じる」だけでは、端末・接続は終了しません。");
  const guidance = serviceElement("p", "", "remote-next-step");
  const diagnostic = serviceElement("pre", "", "remote-diagnostics"); diagnostic.hidden = true;
  const header = serviceElement("div", "", "login-header"); header.append(title, guidance, status, error, note);
  const output = serviceElement("div", "", "login-terminal"); output.setAttribute("aria-label", "遠隔CLI・SSHターミナル");
  const actions = serviceElement("div", "", "detail-actions");
  const button = (text: string) => { const b = serviceElement("button", text, "secondary-button compact"); b.type = "button"; actions.append(b); return b; };
  const connect = button("接続する"), attach = button("接続を確認してCLIを開く"), open = button("CLIを開く"), login = button("ログインをやり直す…");
  const check = button("状態・使用枠を更新"), diagnose = button("接続・CLIを診断"), stop = button("CLI端末を終了"), disconnect = button("SSHを切断"), close = button("画面を閉じる");
  const recovery = serviceElement("section", "", "remote-service-recovery"); recovery.hidden = true;
  const recoveryActions = serviceElement("div", "", "detail-actions"); recoveryActions.append(login, diagnose);
  recovery.append(serviceElement("h4", "問題が解決しないとき"), recoveryActions, diagnostic);
  actions.append(stop, disconnect, close);
  dialog.append(header, output, recovery, actions); document.body.append(dialog); dialog.showModal();
  const term = new Terminal({ cols: 100, rows: 28, fontSize: 14, cursorBlink: true, scrollback: 2000, theme: { background: "#0b0d12", foreground: "#e0e4ed" } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(output);
  let terminalId = resource.serviceTerminalId, offset = 0, alive = false, ready = false, busy = false;
  let streamRevision = 0;
  let initialized = false, sshStarted = false, usagePrepared = false;
  let observation = resource;
  let timer: ReturnType<typeof setTimeout> | undefined, lastCheck = 0, checking = false;
  const paint = () => {
    // One primary action at a time. Do not infer successful SSH authentication
    // from terminal output: the user confirms the final host with remoteCheck.
    const connecting = !ready && (sshStarted || (!terminalId && alive));
    const active = ready ? terminalId && alive ? check : open : connecting ? attach : connect;
    for (const item of [connect, attach, open, check]) {
      item.hidden = item !== active; item.className = "primary-button compact";
    }
    guidance.textContent = !initialized ? "接続状態を確認中…" : !ready
      ? connecting ? system?.connectionMode === "prepared"
        ? "端末で最終マシンへ接続し、作業フォルダへ移動したら、下の確認ボタンを押してください。"
        : "端末でSSH認証を済ませたら、下の確認ボタンを押してください。"
        : "「接続する」から始めてください。"
      : terminalId && alive ? "CLIを操作できます。使用枠を確認するときは下の更新ボタンを押してください。"
        : "接続済みです。「CLIを開く」から操作を始められます。";
    connect.disabled = busy || !initialized || ready; attach.disabled = busy || !initialized || ready;
    open.disabled = login.disabled = busy || !ready || (!!terminalId && alive);
    check.disabled = busy || checking || !ready; diagnose.disabled = busy || !ready;
    close.disabled = busy;
    // Recovery is contextual, not a second management screen. An unknown
    // quota is not evidence of expired credentials; never force a new login.
    const authFailed = cliAuthenticationFailed(observation);
    login.hidden = !ready || !authFailed;
    diagnose.hidden = !ready || !(authFailed || observation.capacityError || error.textContent);
    recovery.hidden = login.hidden && diagnose.hidden && diagnostic.hidden;
    stop.hidden = !terminalId || !alive;
    disconnect.hidden = !(ready || sshStarted) || (!!terminalId && alive);
    stop.disabled = busy || !terminalId || !alive; disconnect.disabled = busy || (!!terminalId && alive);
    term.options.disableStdin = busy || !alive || (!terminalId && ready);
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return; busy = true; error.textContent = ""; paint();
    try { await fn(); } catch (e) { error.textContent = errorMessage(e); }
    finally { busy = false; if (dialog.isConnected) { paint(); term.focus(); } }
  };
  const refresh = async (retryAuthorization = false) => {
    if (checking || !ready) return;
    checking = true; lastCheck = Date.now();
    const revision = streamRevision;
    try {
      const updated = await api.checkService(resource.providerKey, retryAuthorization);
      if (!dialog.isConnected || revision !== streamRevision) return;
      state.resources = updated; renderResources(); renderResourceSummary();
      const row = state.resources.find(r => r.providerKey === resource.providerKey);
      if (row) { ready = row.connected === true; observation = row; }
      if (dialog.isConnected && row) status.textContent = `${row.login?.detail ?? "認証未確認"} 使用枠：${row.capacityError ? serviceCapacityError(row) : (row.quotaSupported === false ? "自動取得未対応" : row.capacityUpdatedAt && row.limitSource !== "unknown" ? `取得 ${new Date(row.capacityUpdatedAt).toLocaleTimeString()}` : "未取得")}`;
    } catch (e) { if (dialog.isConnected) error.textContent = errorMessage(e); }
    finally { checking = false; if (dialog.isConnected) paint(); }
  };
  const poll = async () => {
    const id = terminalId, revision = streamRevision;
    try {
      const snapshot = id ? await api.serviceTerminalSnapshot(id) : await api.remoteSnapshot(environmentId);
      if (!dialog.isConnected || id !== terminalId || revision !== streamRevision) return;
      if (snapshot) {
        const start = snapshot.offset - snapshot.data.length;
        term.write(snapshot.data.slice(Math.max(0, offset - start))); offset = snapshot.offset;
        const ended = alive && !snapshot.alive; alive = snapshot.alive;
        if (!id && !alive) sshStarted = false;
        if (ended && id) { status.textContent = "CLI端末は終了しました。認証状態を確認しています。"; void refresh(true); }
      } else alive = false;
      if (!terminalId && alive) sshStarted = true;
      paint();
      if (ready && terminalId && Date.now() - lastCheck > 30_000) void refresh();
    } catch (e) { if (dialog.isConnected && revision === streamRevision) error.textContent = errorMessage(e); }
    finally {
      // A stream switch can invalidate an in-flight snapshot. Keep polling the
      // new stream even when that old reply was discarded above.
      if (dialog.isConnected) timer = setTimeout(() => void poll(), 700);
    }
  };
  const resize = () => {
    if (output.clientWidth < 20 || output.clientHeight < 20) return;
    fit.fit(); const cols = Math.max(2, Math.min(500, term.cols)), rows = Math.max(2, Math.min(300, term.rows));
    void (terminalId ? api.serviceTerminalResize(terminalId, cols, rows) : api.remoteResize(environmentId, cols, rows)).catch(() => {});
  };
  const observer = new ResizeObserver(resize); observer.observe(output);
  term.onData(data => {
    if (!alive || busy || (!terminalId && ready)) return;
    for (let i = 0; i < data.length; i += 16000) void (terminalId ? api.serviceTerminalInput(terminalId, data.slice(i, i + 16000)) : api.remoteInput(environmentId, data.slice(i, i + 16000)))
      .catch(e => { error.textContent = errorMessage(e); });
  });
  connect.onclick = () => void run(async () => {
    await api.remoteConnect(environmentId); streamRevision++; terminalId = undefined; offset = 0; term.reset(); alive = true; sshStarted = true;
    status.textContent = "接続先の案内に従って端末に入力してください。認証後に空欄でも、下の確認ボタンから進めます。";
  });
  attach.onclick = () => void run(async () => {
    const result = await api.remoteCheck(environmentId); ready = true;
    remoteAgentLists.set(environmentId, result.agents);
    if (result.target) preparedStatuses.set(environmentId, { mode: "prepared", stage: "ready", target: result.target });
    updateRemoteDispatch();
    status.textContent = `${result.target ? `${result.target.username}@${result.target.hostname}` : system?.host} : ${result.cwd}。接続を確認しました。`;
    await launch("cli"); void refresh();
  });
  const launch = async (mode: "cli" | "login") => {
    // Antigravity's usage integration is part of opening its terminal, not a
    // separate setup step. Failure must not prevent authentication itself.
    if (agentId === "antigravity" && !usagePrepared) {
      try { await api.antigravityUsageInstall(environmentId); usagePrepared = true; }
      catch (e) { error.textContent = `使用枠の連携を準備できませんでした。CLIは引き続き操作できます。${errorMessage(e)}`; }
    }
    terminalId = await api.serviceTerminalStart(resource.providerKey, mode); streamRevision++; offset = 0; term.reset(); alive = true; resize();
    status.textContent = "端末を開きました。CLIの案内に従って操作してください。ログイン情報は次の担当も利用します。";
  };
  open.onclick = () => void run(() => launch("cli")); login.onclick = () => void run(() => launch("login"));
  check.onclick = () => { void refresh(true); paint(); };
  diagnose.onclick = () => void run(async () => {
    diagnostic.hidden = false; diagnostic.textContent = "診断中…";
    const result = await api.remoteDiagnose(environmentId, agentId);
    diagnostic.textContent = `${result.platform} · ${result.cwd}\n${codexDiagnosticNote(result)}\n${result.checks.map(c => `${c.ok ? "OK" : "要確認"} · ${c.name}\n${c.detail}`).join("\n")}`;
  });
  stop.onclick = () => {
    if (!terminalId || !window.confirm("このCLI端末を終了しますか？端末内の操作は終了します。保存済みの認証とSSH接続は保持します。")) return;
    void run(async () => { await api.serviceTerminalStop(terminalId!); status.textContent = "終了確認中…"; });
  };
  disconnect.onclick = () => {
    if (!window.confirm("この環境の共有SSH接続を切断しますか？この環境で実行中のタスクにも影響します。")) return;
    void run(async () => { await api.remoteDisconnect(environmentId); streamRevision++; ready = alive = sshStarted = false; terminalId = undefined; offset = 0; term.reset();
      remoteAgentLists.delete(environmentId); preparedStatuses.delete(environmentId); updateRemoteDispatch(); status.textContent = "SSHを切断しました。"; });
  };
  close.onclick = () => dialog.close();
  dialog.oncancel = event => { if (busy) event.preventDefault(); };
  dialog.onclose = () => { if (timer) clearTimeout(timer); observer.disconnect(); term.dispose(); dialog.remove(); };
  void run(async () => {
    const connection = await api.remoteStatus(environmentId).finally(() => { initialized = true; }); ready = connection.stage === "ready";
    status.textContent = ready ? `接続済み：${connection.target ? `${connection.target.username}@${connection.target.hostname}:${connection.target.cwd}` : system?.host}。CLIを開けます。`
      : connection.error ?? "SSH接続を開始してください。追加SSHもこの端末で行えます。";
  });
  void poll();
}
function quotaIsFresh(r: ProviderResourceSummary, now = Date.now()): boolean {
  return r.limitSource !== "unknown" && r.limitSource !== "configured" && !!(r.windows.length || r.usedPercent !== undefined)
    && !r.capacityError && Number.isFinite(Date.parse(r.capacityUpdatedAt ?? ""))
    && now - Date.parse(r.capacityUpdatedAt!) <= 15 * 60_000
    && !r.windows.some(w => (w.resetAt && Date.parse(w.resetAt) <= now)
      || (w.observedAt && (!Number.isFinite(Date.parse(w.observedAt)) || now - Date.parse(w.observedAt) > 15 * 60_000)));
}
function serviceElement<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function openServiceSettings(id?: AgentId, remote = false): void {
  showView(remote ? "settings" : "usage");
  if (remote) selectSettingsPage("settings-remote");
  const section = byId(remote ? "settings-remote" : "settings-models");
  if (section instanceof HTMLDetailsElement) section.open = true;
  if (id && !remote) {
    const card = id === "opencode" ? document.getElementById("service-opencode") : document.querySelector<HTMLDetailsElement>(`.model-default-row[data-agent-id="${id}"]`);
    if (card instanceof HTMLDetailsElement) card.open = true;
  }
  const target = !remote && id ? id === "opencode" ? document.getElementById("service-opencode") : document.querySelector<HTMLElement>(`.model-default-row[data-agent-id="${id}"]`) : section;
  (target ?? section).scrollIntoView({ block: "start" });
}
async function confirmChangedServiceAccount(resource: ProviderResourceSummary): Promise<boolean> {
  if (!window.confirm(`${resource.environmentLabel ?? "このMac"} のAntigravityで別アカウントへのログインを完了しましたか？\n旧アカウントの端末を終了したうえで確定してください。以前の使用枠・制限・アカウント表示名を切り離し、新アカウントを「未確認」にします。提供元の制限を解除する操作ではありません。タスクは自動再開しません。`)) return false;
  state.resources = await api.confirmServiceAccountChange(resource.providerKey);
  renderResources(); renderResourceSummary(); return true;
}
function buildServiceConnections(id: AgentId): HTMLElement {
  const host = serviceElement("div", "", "service-connections");
  const rows = state.resources.filter(r => r.agentIds.includes(id) && serviceInEnvironment(r));
  // Login recovery remains reachable even before the first usage snapshot.
  if ((!serviceEnvironment || serviceEnvironment === "local") && !rows.some(r => !r.environmentId && !r.providerKey.includes("@"))) {
    const policy = state.orchestrationSettings?.agentPolicies.find(p => p.agentId === id);
    const agent = state.agents.find(a => a.id === id);
    rows.unshift({ providerKey: policy?.providerKey ?? id, providerLabel: policy?.providerLabel ?? agentLabel(id), agentIds: [id], authModes: [],
      state: "unavailable", enabled: policy?.enabled, connected: true, cliInstalled: !!agent?.installed, environmentLabel: "このMac",
      totalTokens: 0, inputTokens: 0, outputTokens: 0, runs: 0, failures: 0, windows: [], models: [], limitSource: "unknown" });
  }
  const groups = accountResourceGroups(state.resources);
  for (const r of rows) {
    const group = groups.find(g => g.members.includes(r)) ?? accountResourceGroups([r])[0];
    const quota = group.quota;
    const readiness = serviceReadiness(r, quota);
    const row = serviceElement("article", "", `service-connection ${readiness.tone}`);
    const top = serviceElement("div", "", "service-connection-heading");
    top.append(serviceElement("strong", r.environmentLabel ?? "このMac"), serviceElement("span", readiness.label, "service-readiness"));
    const reason = serviceElement("p", readiness.reason); reason.title = r.login?.detail ?? "";
    const actions = serviceElement("div", "", "detail-actions");
    const check = serviceElement("button", "更新", "secondary-button compact"); check.type = "button"; check.disabled = r.connected === false;
    check.onclick = async () => {
      check.disabled = true; check.textContent = "確認中…";
      try {
        state.resources = await api.checkService(r.providerKey, true);
        if (!r.environmentId) state.resources = await api.refreshCapacity();
        renderResourceSummary(); renderResources();
      }
      catch (e) { showToast(errorMessage(e)); }
      finally { check.disabled = false; check.textContent = "更新"; }
    };
    actions.append(check);
    if (id === "antigravity" && (r.cooldownUntil || r.login?.blocked || r.login?.loggedIn === false)) {
      const changed = serviceElement("button", "別アカウントへの切替を反映…", "secondary-button compact"); changed.type = "button";
      changed.onclick = async () => {
        changed.disabled = true;
        try { if (await confirmChangedServiceAccount(r)) showToast("新アカウントの残量は未確認です。Usage連携を有効にし、CLIを開き直して /usage を実行してください。"); }
        catch (e) { showToast(errorMessage(e)); }
        finally { changed.disabled = false; }
      };
      actions.append(changed);
    }
    if (r.environmentId) {
      const remote = serviceElement("button", cliAuthenticationFailed(r) ? "認証を確認…" : r.serviceTerminalId ? "端末に戻る" : "接続・CLI端末", "secondary-button compact"); remote.type = "button"; remote.onclick = () => showRemoteServiceTerminal(r); actions.append(remote);
    } else if (id !== "gemini") {
      const login = cliLoginButton(id, id === "opencode" ? openCodePlanForResource(serviceKeyOf(r)) : undefined);
      const needsLogin = cliAuthenticationFailed(r);
      login.textContent = needsLogin ? "ログインして復旧…" : "CLIを開く…";
      if (needsLogin) login.className = "primary-button compact";
      actions.append(login);
    }
    row.append(top);
    // Healthy rows need no repeated connection/authentication checklist.
    if (!["ready", "observed"].includes(readiness.tone)) row.append(reason);
    row.append(buildServiceAccountCard(group, false), actions);
    host.append(row);
  }
  return host;
}
function renderUnifiedServiceStatus(): void {
  for (const host of document.querySelectorAll<HTMLElement>("[data-service-status]")) {
    host.replaceChildren(buildServiceConnections(host.dataset.serviceStatus as AgentId));
  }
  for (const label of document.querySelectorAll<HTMLElement>("[data-service-readiness]")) {
    const rows = state.resources.filter(r => r.agentIds.includes(label.dataset.serviceReadiness as AgentId) && serviceInEnvironment(r));
    const groups = accountResourceGroups(state.resources);
    const statuses = rows.map(r => serviceReadiness(r, groups.find(g => g.members.includes(r))!.quota));
    if (rows.length === 1) {
      const status = serviceAvailability(rows[0]); label.textContent = status.label; label.title = status.reason;
    } else {
      const count = statuses.filter((s, i) => s.tone === "ready" || s.tone === "observed" && rows[i].login?.runtimeReady === true).length;
      label.textContent = rows.length ? `確認済み ${count} / ${rows.length}環境` : "実行状態は未確認";
      label.title = "環境を選ぶと、そこでのCLI利用可否を確認できます。使用枠の取得可否とは別です。";
    }
  }
}
function buildServiceAccountCard(group: ServiceAccountGroup, heading = true): HTMLElement {
  const section = serviceElement("section", "", "service-account-card");
  if (heading) section.append(serviceElement("h4", group.label));
  section.append(serviceElement("p", quotaIsFresh(group.quota) ? "残量：取得済み" : group.quota.windows.length ? "残量：前回値（最新の残量ではありません）" : "残量：未確認", "service-connection-meta"));
  for (const w of group.quota.windows) {
    const row = serviceElement("div", "", "service-quota-line");
    const label = w.scope === "model" && w.model && !w.label.includes(w.model) ? `${w.model} · ${w.label}` : w.label;
    row.append(serviceElement("span", label), serviceElement("strong", `使用 ${w.usedPercent.toFixed(1)}% · 残り ${Math.max(0, 100 - w.usedPercent).toFixed(1)}%`));
    const meter = serviceElement("meter"); meter.min = 0; meter.max = 100; meter.value = w.usedPercent; meter.setAttribute("aria-label", `${w.label} 使用率`);
    row.append(meter, serviceElement("small", `リセット：${w.resetAt ? new Date(w.resetAt).toLocaleString() : w.resetText ?? "未報告"}`)); section.append(row);
    if (w.observedAt && w.observedAt !== group.quota.capacityUpdatedAt) row.append(serviceElement("small", `この枠の観測：${new Date(w.observedAt).toLocaleString()}`));
  }
  if (!group.quota.windows.length) section.append(serviceElement("p", group.quota.usedPercent !== undefined && group.quota.limitSource !== "configured" ? `報告使用率 ${group.quota.usedPercent.toFixed(1)}%` : "契約残量は未取得（0%・利用可能とは扱いません）"));
  section.append(serviceElement("p", quotaObservationNote(group.quota), "service-connection-meta"));
  if (group.quota.cooldownUntil && Date.parse(group.quota.cooldownUntil) > Date.now()) section.append(serviceElement("p", `使用制限中 · 再試行目安：${new Date(group.quota.cooldownUntil).toLocaleString()}`, "capacity-error"));
  if (group.quota.capacityError) {
    const error = serviceElement("p", serviceCapacityError(group.quota), "capacity-error");
    error.title = group.quota.capacityError; section.append(error);
  }
  if (group.serviceKey === "ollama-cloud" && (!quotaIsFresh(group.quota) || !group.quota.windows.length)) section.append(ollamaUsageButton());
  return section;
}
