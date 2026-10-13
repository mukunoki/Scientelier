const modelCatalogs = new Map<string, CliModelCatalog>();
const modelCatalogRequests = new Map<string, Promise<CliModelCatalog>>();
// The single service save commits model/toggle and usage drafts together.
// Revision fencing preserves edits made while that request is in flight.
const serviceModelEdits = { revision: 0, dirty: false, saved: (_revision: number) => {}, reset: () => {} };
function modelCatalogKey(id: AgentId): string {
  return `${id}:${id === "opencode" ? state.orchestrationSettings?.agentPolicies.find(p => p.agentId === id)?.codingPlan ?? "" : ""}`;
}

/** The input remains the value source for existing form collectors. */
function modelPicker(id: AgentId, input: HTMLInputElement, defaultLabel = "自動（CLIの既定設定）", allowManual = true): HTMLElement {
  const host = document.createElement("div"); host.className = "model-picker";
  const select = document.createElement("select"); select.setAttribute("aria-label", `${agentLabel(id)}モデル選択`);
  const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "secondary-button compact"; refresh.textContent = "候補を取得";
  const note = document.createElement("small"); note.className = "model-picker-note"; note.setAttribute("role", "status");
  const ability = document.createElement("small"); ability.className = "model-picker-note";
  const showAbility = () => { void updateBenchmarkLabel(ability,input.value); };
  input.addEventListener("input",showAbility);input.addEventListener("change",showAbility);
  const key = modelCatalogKey(id);
  input.setAttribute("aria-label", `${agentLabel(id)}モデルID${allowManual ? "（直接指定）" : ""}`); input.placeholder = "モデルIDを入力";
  const draw = () => {
    const catalog = modelCatalogs.get(key);
    select.replaceChildren(new Option(defaultLabel, ""));
    for (const item of catalog?.models ?? []) select.add(new Option(item.label === item.id ? item.id : `${item.label} · ${item.id}`, item.id));
    if (input.value && ![...select.options].some(o => o.value === input.value)) select.add(new Option(`現在の指定 · ${input.value}`, input.value));
    if (allowManual) select.add(new Option("モデルIDを直接指定…", "__manual__"));
    select.value = input.value;
    input.hidden = true; select.disabled = input.disabled; refresh.disabled = input.disabled;
    note.textContent = catalog?.note ?? (allowManual
      ? "候補はこのMacのCLIから取得します。未取得でも既定設定・直接指定を使えます。"
      : "「候補を取得」からモデルを選べます。未取得の場合はCLIの既定設定を利用できます。");
  };
  select.onchange = () => {
    input.hidden = !allowManual || select.value !== "__manual__";
    if (allowManual && select.value === "__manual__") { input.focus(); return; }
    input.value = select.value; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  refresh.onclick = async () => {
    refresh.disabled = true; note.classList.add("model-picker-error"); note.textContent = "モデル候補を取得しています…";
    try {
      if (!modelCatalogRequests.has(key)) modelCatalogRequests.set(key, api.listModels(id).finally(() => { modelCatalogRequests.delete(key); }));
      modelCatalogs.set(key, await modelCatalogRequests.get(key)!);
      draw(); // Retain the selected ID, even when it is absent from the catalog.
      note.classList.remove("model-picker-error");
    } catch (error) { note.textContent = errorMessage(error); }
    finally { refresh.disabled = input.disabled; }
  };
  host.append(select, refresh, input, note, ability); draw(); showAbility(); return host;
}

function initializeModelSettings(): void {
  const section = byId("settings-models");
  let dirty = false;
  let editRevision = 0;
  const markEdited = () => { dirty = true; serviceModelEdits.dirty = true; serviceModelEdits.revision = ++editRevision; byId("model-default-status").textContent = "未保存の変更があります。"; };
  const serviceToggle = (policy: AgentPolicy) => {
    const label = document.createElement("label"); label.className = "service-toggle";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = policy.enabled;
    input.dataset.serviceEnabled = policy.agentId; input.setAttribute("aria-label", `${agentLabel(policy.agentId)}を利用する`);
    input.onchange = markEdited;
    // Toggling availability must not also collapse the service's settings.
    label.onclick = event => event.stopPropagation();
    label.append(input, "利用する"); return label;
  };
  const expanded = new Set<string>();
  const render = () => {
    // Detach live usage controls before rebuilding model cards: their unsaved
    // percentages and event handlers must survive catalog/model refreshes.
    for (const row of document.querySelectorAll<HTMLElement>(".policy-row")) byId("agent-policy-list").append(row);
    const list = byId("model-default-list"); list.replaceChildren();
    for (const policy of state.orchestrationSettings?.agentPolicies ?? []) {
      // OpenCode has one authoritative provider+model form, below this list.
      if (policy.agentId === "gemini" || policy.agentId === "opencode") continue;
      const row = document.createElement("details"); row.className = "model-default-row"; row.dataset.agentId = policy.agentId;
      row.open = expanded.has(policy.agentId);
      row.ontoggle = () => { if (row.isConnected) { if (row.open) expanded.add(policy.agentId); else expanded.delete(policy.agentId); } };
      const title = document.createElement("strong"); title.textContent = agentLabel(policy.agentId);
      const input = document.createElement("input"); input.type = "text"; input.value = policy.defaultModel ?? "";
      input.oninput = markEdited;
      const header = document.createElement("summary"); header.className = "service-heading";
      const readiness = document.createElement("span"); readiness.dataset.serviceReadiness = policy.agentId; readiness.className = "service-limit-summary";
      const limit = document.createElement("span"); limit.className = "service-limit-summary"; limit.dataset.serviceLimit = policy.agentId;
      header.append(title, readiness, limit, serviceToggle(policy));
      const status = document.createElement("div"); status.dataset.serviceStatus = policy.agentId;
      const usage = document.createElement("div"); usage.dataset.serviceUsage = policy.agentId;
      const accounts = document.createElement("div"); accounts.dataset.serviceAccounts = policy.agentId;
      const body = document.createElement("div"); body.className = "service-settings-body";
      const model = document.createElement("div"); model.className = "service-model-settings";
      const modelLabel = document.createElement("span"); modelLabel.textContent = "既定モデル";
      // Settings use catalog selection only; saved IDs absent from a refreshed
      // catalog remain selectable so an unrelated save cannot erase them.
      model.append(modelLabel, modelPicker(policy.agentId, input, undefined, false));
      body.append(status, usage, model, accounts);
      row.append(header, body); list.append(row);
    }
    const openCode = state.orchestrationSettings?.agentPolicies.find(p => p.agentId === "opencode");
    byId("opencode-enabled").replaceChildren(...(openCode ? [serviceToggle(openCode)] : []));
    renderOrchestrationSettings();
    renderResources();
  };
  serviceModelEdits.saved = revision => {
    dirty = editRevision !== revision; serviceModelEdits.dirty = dirty;
    if (!dirty) render();
    byId("model-default-status").textContent = dirty ? "送信分を保存しました。その後の変更は未保存です。" : "保存済み。次に起動する工程から適用します。タスク・担当の個別指定が優先されます。";
  };
  serviceModelEdits.reset = () => { dirty = serviceModelEdits.dirty = false; render(); byId("model-default-status").textContent = "保存済み設定に戻しました。"; };
  section.addEventListener("services-shown", () => { if (!dirty && !routingSettingsSaving) render(); });
  byId<HTMLFormElement>("model-default-form").onsubmit = event => {
    event.preventDefault();
    byId<HTMLFormElement>("orchestration-settings-form").requestSubmit();
  };
  render();
}

function renderServiceStatus(): void {
  renderUnifiedServiceStatus();
}
