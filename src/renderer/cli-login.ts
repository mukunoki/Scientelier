// 認証はCLIが管理する。対話CLIの画面を閉じても、その端末は維持する。
type LoginProvider = "claude" | "codex" | "opencode" | "antigravity";
const loginProviderNames: Record<LoginProvider, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity" };

function openCodePlanForResource(key: string): OpenCodePlan {
  if (key !== "ollama-cloud") return "zai";
  return state.orchestrationSettings?.agentPolicies.find(p => p.agentId === "opencode")?.codingPlan === "ollama-app" ? "ollama-app" : "ollama";
}
function selectedOpenCodeLoginPlan(): OpenCodePlan {
  // General login actions always refer to saved configuration, never a draft
  // provider selection elsewhere in Settings.
  return state.orchestrationSettings?.agentPolicies.find(p => p.agentId === "opencode")?.codingPlan ?? "zai";
}
function showCliLogin(provider: LoginProvider, plan: OpenCodePlan = selectedOpenCodeLoginPlan()): void {
  if (document.querySelector(".claude-login-dialog")) return;
  const name = loginProviderNames[provider];
  const interactiveOpenCode = provider === "opencode" && plan === "ollama-app";
  const persistentTerminal = provider === "antigravity" || interactiveOpenCode;
  const client = provider === "claude" ? {
    status: api.claudeLoginStatus, start: api.claudeLoginStart, snapshot: api.claudeLoginSnapshot,
    input: api.claudeLoginInput, resize: api.claudeLoginResize, close: api.claudeLoginClose, refresh: api.claudeLoginRefresh
  } : provider === "codex" ? {
    status: api.codexLoginStatus, start: api.codexLoginStart, snapshot: api.codexLoginSnapshot,
    input: api.codexLoginInput, resize: api.codexLoginResize, close: api.codexLoginClose, refresh: api.codexLoginRefresh
  } : provider === "antigravity" ? {
    status: api.antigravityLoginStatus, start: api.antigravityLoginStart, snapshot: api.antigravityLoginSnapshot,
    input: api.antigravityLoginInput, resize: api.antigravityLoginResize, close: api.antigravityLoginClose, refresh: api.antigravityUsageRefresh
  } : {
    status: () => api.opencodeLoginStatus(plan), start: () => api.opencodeLoginStart(plan), snapshot: api.opencodeLoginSnapshot,
    input: api.opencodeLoginInput, resize: api.opencodeLoginResize, close: api.opencodeLoginClose, refresh: async () => state.resources
  };
  const dialog = document.createElement("dialog"); dialog.className = "claude-login-dialog cli-terminal-dialog";
  dialog.setAttribute("aria-label", interactiveOpenCode ? "OpenCode端末" : `${name}ログイン管理`);
  const title = document.createElement("h3"); title.textContent = `${name}ログイン管理 · このMac`;
  const planLabel = plan === "ollama-app" ? "Ollama経由のCloud" : plan === "ollama" ? "Ollama Cloud" : "Z.AI Coding Plan";
  if (provider === "opencode") title.textContent += ` · ${planLabel}`;
  if (interactiveOpenCode) title.textContent = "OpenCode端末 · このMac · Ollama経由のCloud";
  const note = document.createElement("p");
  note.textContent = `${name}公式のログイン操作を開きます。ブラウザでの認証やコード入力はご自身で行ってください。認証情報はCLIが管理し、このアプリはログイン端末の内容をログファイルに保存しません（CLI自身の診断ログは別です）。同じMacのCLIにも反映されます。SSH接続先のログインは別です。`;
  if (provider === "antigravity") note.textContent += " Googleアカウントでログインしてください。ブラウザでコードが表示された場合はこの端末へ貼り付けます。残量はCLI内の /usage で確認できます。APIキーへの切替や追加クレジットの購入・利用有効化は行いません。";
  if (provider === "opencode") note.textContent = `${planLabel}のAPIキーを下のOpenCode公式認証画面に入力してください。${plan === "ollama" ? "Pro契約のアカウントで ollama.com/settings/keys から発行したキーを使います。" : "通常のZ.AIとは別の登録です。"}キーはOpenCodeが管理し、このアプリは設定や端末ログに保存しません。SSH接続先の認証は別です。`;
  if (provider === "opencode" && plan === "ollama-app") note.textContent = "インストール済みOllamaのクラウド認証を利用します。Ollamaアプリでログイン済みなら、OpenCodeへのAPIキー登録は不要です。接続確認はこのMacのOllamaサーバーだけを調べ、モデル実行やクラウド認証テストはしません。SSH先では最終マシンのOllama起動・ログインが必要です。";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const usage = document.createElement("p");
  const output = document.createElement("div"); output.className = "login-terminal"; output.hidden = true;
  output.setAttribute("aria-label", `${name}${interactiveOpenCode ? "対話" : "ログイン用"}ターミナル`);
  const error = document.createElement("p"); error.className = "form-error"; error.setAttribute("role", "alert");
  const actions = document.createElement("div"); actions.className = "detail-actions";
  const check = document.createElement("button"); check.textContent = "状態を更新"; check.className = "secondary-button";
  const login = document.createElement("button"); login.textContent = "CLIを開く"; login.className = "primary-button";
  const close = document.createElement("button"); close.textContent = "閉じる"; close.className = "secondary-button";
  const stop = document.createElement("button"); stop.textContent = "端末を終了"; stop.className = "secondary-button"; stop.hidden = true;
  // First-use setup is separate from everyday terminal actions. A prior quota
  // observation is not proof that the current CLI still has a working hook.
  const usageSetup = document.createElement("div"); usageSetup.className = "login-usage-setup"; usageSetup.hidden = true;
  const usageSetupNote = document.createElement("p");
  const connectUsage = document.createElement("button"); connectUsage.textContent = "使用量表示を設定"; connectUsage.className = "secondary-button compact"; connectUsage.hidden = true;
  usageSetup.append(usageSetupNote, connectUsage);
  const help = document.createElement("details"); help.className = "login-help";
  const helpTitle = document.createElement("summary"); helpTitle.textContent = "認証・使用量について";
  help.append(helpTitle, note, usage);
  const header = document.createElement("div"); header.className = "login-header";
  header.append(title);
  header.append(status, error, usageSetup, help);
  actions.append(login, check, stop, close); dialog.append(header, output, actions);
  document.body.append(dialog); dialog.showModal();
  let id: string | undefined, term: InstanceType<typeof Terminal> | undefined, observer: ResizeObserver | undefined;
  let offset = 0, timer: ReturnType<typeof setTimeout> | undefined, alive = false, starting = false;
  let checking = false, linking = false, stopping = false, usageRefreshing = false, canLaunch = !persistentTerminal;
  const updateControls = () => {
    login.disabled = alive || starting || checking || linking || stopping || !canLaunch;
    check.disabled = checking || starting || linking || stopping;
    stop.hidden = !alive; stop.disabled = !alive || starting || linking || stopping;
    connectUsage.disabled = alive || starting || checking || linking || stopping;
    connectUsage.title = alive ? "端末を終了してから設定してください。保存済みログインは保持されます。" : "";
    close.disabled = starting || linking || stopping;
  };
  const renderUsageSetup = (link: Awaited<ReturnType<HarnessApi["antigravityLoginStatus"]>>["usageLink"]) => {
    usageSetup.hidden = provider !== "antigravity" || link?.state === "enabled";
    usageSetupNote.textContent = link?.detail ?? "使用量の表示設定を確認できません。「状態を更新」で再確認してください。";
    connectUsage.hidden = link?.state !== "not-configured";
    if (link?.state === "enabled") usageSetupNote.textContent = "";
  };
  const renderUsage = () => {
    if (provider === "antigravity") { usage.textContent = "「閉じる」は画面を閉じるだけで、認証や端末は継続します。「端末を終了」でも保存済みログインは削除しません。使用量表示を設定すると、CLIが報告した残量・リセット時刻を自動で取り込みます（認証情報・会話本文は保存しません）。最新の残量はCLIの /usage で取得してください。「状態を更新」は記録済みの値を読み直します。別アカウントに変更したら端末を終了し、Resourcesの「別アカウントへの切替を反映…」を押してから開き直してください。既存のカスタム表示設定は上書きしません。SSH先はResourcesの対象環境から設定します。"; return; }
    if (provider === "opencode") { usage.textContent = plan === "zai" ? `${planLabel}の残量・リセット日時は現在未取得です。認証情報の登録は契約プラン・有効性を保証するものではありません。` : "残量表示のWeb連携は任意です。モデル実行は既存のCLI／Ollamaログインを使い、残量が未確認でも再ログインは不要です。必要な場合だけResourcesの「残量表示を連携（任意）」を利用してください。"; return; }
    const policy = state.orchestrationSettings?.agentPolicies.find(p => p.agentId === provider);
    const resource = state.resources.find(r => r.providerKey === policy?.providerKey);
    const problem = resource ? serviceCapacityError(resource) : "";
    const category = !problem ? "" : resource && usageAuthenticationFailed(resource) ? "残量未確認（CLIのログイン状態とは別）"
      : /429|要求を制限|too many requests/i.test(problem) ? "取得APIの一時制限（再ログインでは解消しません）"
      : /timed out|タイムアウト/i.test(problem) ? "応答待ちの時間超過（ログイン切れとは限りません）" : "取得失敗";
    usage.textContent = problem ? `${category}\n${problem}${resource?.capacityRetryAt ? `\n自動再試行予定 ${new Date(resource.capacityRetryAt).toLocaleString()}` : ""}${resource?.capacityUpdatedAt ? `\n表示中の値は前回取得分です：${new Date(resource.capacityUpdatedAt).toLocaleString()}` : ""}`
      : resource?.capacityUpdatedAt ? `使用量の最終取得：${new Date(resource.capacityUpdatedAt).toLocaleString()}` : "使用量APIの認証状態は未確認です。";
    if (problem) help.open = true;
  };
  const checkStatus = async (withUsage = false) => {
    if (checking || starting || linking || stopping) return;
    checking = true; updateControls();
    error.textContent = "";
    try {
      // Detect automatically on open/update, never start login as a side effect.
      state.agents = await api.refreshAgents();
      if (!dialog.isConnected) return;
      renderAgents();
      const result = await client.status();
      if (!dialog.isConnected) return;
      status.textContent = [result.detail, result.authMethod, result.subscriptionType].filter(Boolean).join(" · ");
      if (persistentTerminal) {
        canLaunch = interactiveOpenCode ? state.agents.some(a => a.id === "opencode" && a.installed)
          : "installed" in result && result.installed === true && !("launchBlocked" in result && result.launchBlocked === true);
        if (!interactiveOpenCode) renderUsageSetup("usageLink" in result ? result.usageLink : undefined);
        if ("sessionId" in result && typeof result.sessionId === "string" && !id && !starting) void openTerminal(result.sessionId);
      }
      if (withUsage && provider !== "opencode") await refreshUsage();
    } catch (e) { error.textContent = errorMessage(e); }
    finally { checking = false; updateControls(); }
  };
  const poll = async () => {
    if (!id || !dialog.isConnected) return;
    const requestedId = id;
    try {
      const result = await client.snapshot(requestedId);
      // 終了・再接続後に古い端末の応答が戻っても、新しい画面状態を上書きしない。
      if (!dialog.isConnected || id !== requestedId) return;
      const start = result.offset - result.data.length;
      term?.write(result.data.slice(Math.max(0, offset - start))); offset = result.offset;
      alive = result.alive; if (term) term.options.disableStdin = !alive;
      updateControls();
      if (result.issue) {
        status.textContent = "直近の認証エラー · 端末の案内を確認してください";
        error.textContent = result.issue.message;
      }
      if (!alive) {
        if (!result.issue) status.textContent = interactiveOpenCode ? `OpenCode端末が終了しました（終了コード ${result.exitCode}）。必要なら「CLIを開く」で開き直してください。`
          : result.exitCode === 0 ? "ログイン操作が終了しました。ログイン状態を確認してください。" : `ログイン操作が終了しました（終了コード ${result.exitCode}）。必要なら再試行してください。`;
        if ((provider === "claude" || provider === "codex") && result.exitCode === 0 && !result.issue) await checkStatus(true);
        return;
      }
      timer = setTimeout(() => { void poll(); }, 500);
    } catch (e) {
      if (dialog.isConnected && id === requestedId) { error.textContent = errorMessage(e); updateControls(); }
    }
  };
  check.onclick = () => { void checkStatus(true); };
  const openTerminal = async (existingId?: string) => {
    if (starting || alive || (!existingId && (checking || linking || stopping || !canLaunch))) return;
    starting = true; updateControls(); error.textContent = "";
    try {
      id = existingId ?? await client.start(); offset = 0; alive = true; output.hidden = false; updateControls();
      dialog.classList.add("terminal-active"); help.open = false;
      observer?.disconnect(); term?.dispose(); output.replaceChildren();
      term = new Terminal({ cols: 100, rows: 24, fontSize: 13, cursorBlink: true, scrollback: 1000,
        theme: { background: "#0b0d12", foreground: "#e0e4ed" } });
      const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(output);
      observer = new ResizeObserver(() => {
        if (!id || !alive || output.clientWidth < 20 || output.clientHeight < 20) return;
        fit.fit(); void client.resize(id, Math.max(2, Math.min(500, term!.cols)), Math.max(2, Math.min(300, term!.rows))).catch(e => { error.textContent = errorMessage(e); });
      }); observer.observe(output);
      term.onData(data => { if (id && alive) for (let i = 0; i < data.length; i += 16000) void client.input(id, data.slice(i, i + 16000)).catch(e => { error.textContent = errorMessage(e); }); });
      term.focus(); status.textContent = `${name}の対話端末です。認証・入力待ちの状態は端末内で確認してください。`; void poll();
    } catch (e) { error.textContent = errorMessage(e); }
    finally { starting = false; updateControls(); }
  };
  login.onclick = () => { void openTerminal(); };
  connectUsage.onclick = async () => {
    if (alive || starting || checking || linking || stopping) return;
    linking = true; updateControls(); error.textContent = "";
    try {
      const message = await api.antigravityUsageInstall();
      const result = await api.antigravityLoginStatus();
      if (!dialog.isConnected) return;
      renderUsageSetup(result.usageLink); status.textContent = message;
    }
    catch(e) { error.textContent = errorMessage(e); }
    finally { linking = false; updateControls(); }
  };
  stop.onclick = async () => {
    if (!id || !alive || !window.confirm("この対話端末を終了しますか？端末内で実行中の作業・入力は終了します。保存済みログインは削除しません。")) return;
    if (stopping) return;
    stopping = true; updateControls();
    try {
      await client.close(id); if(timer) clearTimeout(timer); id=undefined; alive=false;
      if(term) term.options.disableStdin=true;
      status.textContent="端末を終了しました。保存済みログインは保持されています。";
    } catch(e) { error.textContent=errorMessage(e); }
    finally { stopping=false; updateControls(); }
  };
  const refreshUsage = async () => {
    if (usageRefreshing) return;
    usageRefreshing = true;
    try { const resources = await client.refresh(); if (!dialog.isConnected) return; state.resources = resources; renderResources(); renderResourceSummary(); renderUsage(); }
    catch (e) { error.textContent = errorMessage(e); }
    finally { usageRefreshing = false; }
  };
  const requestClose = () => {
    if (starting || linking || stopping || (!persistentTerminal && alive && !window.confirm("ログイン用端末を終了して閉じますか？完了済みのログインは削除しません。"))) return;
    dialog.close();
  };
  close.onclick = requestClose;
  dialog.addEventListener("cancel", event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener("close", () => {
    if (timer) clearTimeout(timer); observer?.disconnect(); term?.dispose();
    if (id && (!persistentTerminal || !alive)) void client.close(id).catch(() => {}); dialog.remove();
  });
  renderUsage(); updateControls(); void checkStatus();
}

function cliLoginButton(provider: LoginProvider, plan?: OpenCodePlan): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button";
  button.className = "secondary-button compact";
  button.textContent = `${loginProviderNames[provider]}ログイン管理`;
  button.onclick = () => showCliLogin(provider, plan); return button;
}


function ollamaUsageButton(): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button";
  button.className = "secondary-button compact"; button.textContent = "残量表示を連携（任意）";
  button.onclick = () => {
    if (document.querySelector(".ollama-usage-dialog")) return;
    const dialog = document.createElement("dialog"); dialog.className = "claude-login-dialog ollama-usage-dialog";
    const heading = document.createElement("h3"); heading.textContent = "Ollama Cloud · 残量表示（任意）";
    const note = document.createElement("p"); note.textContent = "残量を表示するためだけの任意機能です。CLIの認証・モデル実行には不要で、連携の成否によってCLIのログイン状態を変更しません。連携する場合は専用ウインドウでCLI／Ollama本体と同じアカウントにログインしてください（アカウント一致は自動検証しません）。他のブラウザのCookieやCLIの認証情報は読み取りません。連携後は通常5分間隔で取得します。";
    const source = document.createElement("p"); source.textContent = "公式APIではなくWeb画面の読み取りです。画面変更・ログイン切れの際は未取得／前回値と表示します。購入・チャージ・プラン変更は自動実行しません。";
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.style.whiteSpace = "pre-wrap";
    const update = () => {
      const r = state.resources.find(r => r.providerKey === "ollama-cloud");
      status.textContent = [r && serviceCapacityError(r), ...(r?.windows ?? []).map(w => `${w.label}: 使用 ${w.usedPercent.toFixed(1)}%${w.detail ? ` · ${w.detail}` : ""}\n${w.resetAt ? `リセット: ${new Date(w.resetAt).toLocaleString()}` : w.resetText ?? "リセット日時未取得"}`), r?.creditBalance,
        r?.capacityUpdatedAt && r.limitSource !== "unknown" ? `最終取得: ${new Date(r.capacityUpdatedAt).toLocaleString()}` : "残量未確認です。この連携はモデル実行の前提条件ではありません。連携する場合だけWeb画面でログインし、「Usageを取得」を押してください。"].filter(Boolean).join("\n");
    };
    const actions = document.createElement("div"); actions.className = "detail-actions";
    const open = document.createElement("button"); open.textContent = "ログイン・Usage画面を開く";
    const refresh = document.createElement("button"); refresh.textContent = "Usageを取得";
    const disconnect = document.createElement("button"); disconnect.textContent = "Web連携を解除";
    const close = document.createElement("button"); close.textContent = "閉じる";
    const buttons = [open, refresh, disconnect];
    for (const b of [...buttons, close]) b.className = "secondary-button compact";
    refresh.className = "primary-button compact";
    const run = async (work: () => Promise<void>) => {
      buttons.forEach(b => b.disabled = true);
      try { await work(); } catch (e) { status.textContent = errorMessage(e); }
      finally { buttons.forEach(b => b.disabled = false); }
    };
    open.onclick = () => { void run(async () => { await api.ollamaUsageOpen(); status.textContent = "専用ウインドウでログインしてください。Usageが表示されたら、ここで「Usageを取得」を押してください。"; }); };
    refresh.onclick = () => { void run(async () => { state.resources = await api.ollamaUsageRefresh(); renderResources(); renderResourceSummary(); update(); }); };
    disconnect.onclick = () => {
      if (!window.confirm("このアプリ専用のOllama Webログインを解除しますか？CLI／Ollama本体のログインやアカウントは変更しません。")) return;
      void run(async () => { state.resources = await api.ollamaUsageDisconnect(); renderResources(); renderResourceSummary(); status.textContent = "Web連携を解除しました。再連携時はログインしてください。"; });
    };
    close.onclick = () => dialog.close(); dialog.addEventListener("close", () => dialog.remove());
    actions.append(open, refresh, disconnect, close); dialog.append(heading, note, source, status, actions);
    document.body.append(dialog); update(); dialog.showModal();
  };
  return button;
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelector("#opencode-login-actions")?.append(ollamaUsageButton());
  const form = document.querySelector<HTMLFormElement>("#glm-form")!;
  const model = document.querySelector<HTMLInputElement>("#glm-model")!;
  const status = document.querySelector<HTMLElement>("#glm-status")!;
  const load = document.querySelector<HTMLButtonElement>("#glm-load-models")!;
  const select = document.querySelector<HTMLSelectElement>("#opencode-provider")!;
  const note = document.querySelector<HTMLElement>("#opencode-plan-note")!;
  const drafts: Partial<Record<OpenCodePlan, string>> = {};
  let current: OpenCodePlan = "zai", initialized = false, generation = 0;
  const updateNote = () => {
    model.placeholder = current === "ollama-app" ? "ollama/deepseek-v4.1-flash:cloud" : current === "ollama" ? "ollama-cloud/…" : "zai-coding-plan/glm-…";
    note.textContent = current === "ollama-app"
      ? "インストール済みOllamaのログインを使います。OpenCodeから実行マシンのOllama（127.0.0.1:11434）を通してCloudモデルを実行します。APIキーの再登録は不要です。Ollamaを起動したままにしてください。一覧はOllamaで選択済みのCloudモデルと、このMacのOpenCode履歴から読み取ります。遠隔では最終マシンにもOllamaが必要です。"
      : current === "ollama"
      ? "Ollama Cloudへ直接接続します（Ollama本体・モデルのダウンロードは不要）。Pro契約のアカウントで発行したAPIキーをOpenCodeログイン管理で登録してください。契約残量は「残量表示を連携（任意）」で表示できます。追加課金設定は ollama.com/settings で確認してください。このアプリは購入・追加チャージを行わず、契約枠だけでの停止も保証しません。"
      : "Z.AI Coding PlanのAPIキーをOpenCodeログイン管理で登録してください。通常のZ.AI従量課金APIへは切り替えません。選択だけでは保存されません。「OpenCodeに適用」で切り替えます。";
  };
  // Initialize once on first Resources visit; navigation must not erase drafts.
  document.querySelector("#settings-models")?.addEventListener("services-shown", () => {
    if (initialized) return;
    const policy = state.orchestrationSettings?.agentPolicies.find(p => p.agentId === "opencode");
    Object.assign(drafts, policy?.openCodeModels);
    current = policy?.codingPlan ?? "zai"; select.value = current;
    if (!model.value) model.value = policy?.codingPlan ? policy.defaultModel ?? "" : drafts[current] ?? "";
    initialized = true; updateNote();
  });
  byId<HTMLButtonElement>("opencode-selected-login").onclick = () => showCliLogin("opencode", current);
  select.addEventListener("change", () => {
    initialized = true; drafts[current] = model.value;
    current = select.value === "ollama-app" ? "ollama-app" : select.value === "ollama" ? "ollama" : "zai";
    model.value = drafts[current] ?? ""; generation++; load.disabled = false;
    document.querySelector("#glm-models")!.replaceChildren(); updateNote();
    status.textContent = current === "ollama-app" ? "未適用です。Ollamaで動作確認済みのモデルを選び「OpenCodeに適用」を押してください。" : "未適用です。認証を登録し、モデルを選んで「OpenCodeに適用」を押してください。";
  });
  document.querySelector<HTMLButtonElement>("#opencode-deepseek")!.onclick = () => {
    if (select.disabled) return;
    select.value = "ollama-app"; select.dispatchEvent(new Event("change"));
    model.value = "ollama/deepseek-v4.1-flash:cloud";
    status.textContent = "DeepSeek V4.1 Flash（Ollama経由）を選択しました。「OpenCodeに適用」で保存してください。";
  };
  load.onclick = async () => {
    load.disabled = true;
    const request = ++generation, plan = current;
    try {
      const models = await api.openCodeModels(plan);
      if (request !== generation) return;
      document.querySelector("#glm-models")!.replaceChildren(...models.map(value => { const option = document.createElement("option"); option.value = value; return option; }));
      status.textContent = models.length ? `${models.length}件のモデルを取得しました。入力欄でモデルを選び、適用してください。契約での利用可否は実行時に確認されます。` : plan === "ollama-app" ? "保存済みのCloudモデルが見つかりません。DeepSeekの選択ボタンを使うか、Ollama経由で動作確認したモデルIDを直接入力してください。" : `一覧を取得できませんでした。OpenCodeの認証を確認してください。CLIの /models に表示される ${model.placeholder} を直接入力することもできます。`;
    } catch (e) { if (request === generation) status.textContent = errorMessage(e); }
    finally { if (request === generation) load.disabled = false; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    save.disabled = true; select.disabled = true; model.disabled = true; load.disabled = true; generation++;
    try {
      const result = await api.configureOpenCode(current, model.value.trim());
      state.orchestrationSettings = result.settings; state.resources = result.resources;
      drafts[current] = model.value.trim();
      renderOrchestrationSettings(); renderResources(); renderResourceSummary(); renderAgents();
      status.textContent = `OpenCodeを ${model.value.trim()} に設定しました。タスクの利用CLIにOpenCodeを含めてください。${current === "zai" ? "契約残量は未取得です。" : "契約残量の表示は「残量表示を連携（任意）」で設定できます。モデル実行には不要です。"}`;
    } catch (e) { status.textContent = errorMessage(e); }
    finally { save.disabled = false; select.disabled = false; model.disabled = false; load.disabled = false; }
  };
});

function reportStopReason(task: TaskRecord): string {
  const error = (task.error ?? "").replaceAll("脱AI臭化", "レポート執筆ルール");
  // Explain already-saved generic failures without changing historical task data.
  if (!error.includes("レポート執筆ルールが未完了、未解決事項あり")) return error;
  const reporter = task.workUnits.find(u => u.role === "reporter" && u.state !== "completed");
  const blocks = [...(reporter?.output ?? "").matchAll(/<editorial-check>([\s\S]*?)<\/editorial-check>/g)];
  if (blocks.length !== 1) return error;
  try {
    const check = JSON.parse(blocks[0][1]);
    if (check.status === "blocked" && Array.isArray(check.concerns) && check.concerns.length && check.concerns.every((c: unknown) => typeof c === "string")) {
      return `レポーターの仕上げ・PDF確認が未完了です。\n${check.concerns.join("\n").slice(0, 2400)}`;
    }
  } catch { /* Retain the original failure for malformed output. */ }
  return error;
}

function legacyWorkLimit(task: TaskRecord): boolean {
  return task.state === "awaiting-input" && /^残作業の差戻し回数上限です。/.test(task.error ?? "")
    && task.workUnits.some(u => u.role === "reporter" && u.state === "pending");
}
function conciseTaskFailure(reason: string): string {
  if (/^残作業の差戻し回数上限です。/.test(reason)) return "同じ担当への再作業が上限に達し、レポート・レビューに進めず停止しました。";
  if (/^最終検証に未完了/.test(reason)) return "最終検証に未達・未確認項目があります。成果物は保存されています。";
  const first = reason.trim().split(/\n/)[0];
  const sentence = first.match(/^.{1,180}?[。]/)?.[0] ?? first;
  return sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence;
}
