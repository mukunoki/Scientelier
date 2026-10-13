/**
 * 設定の分類だけを担当する。保存・認証・実行の処理は各画面のモジュールに任せる。
 * DOMは複製せず移動するため、既存の入力値・イベントハンドラを維持できる。
 */
const settingsPages = [
  ["settings-execution", "実行の基本設定"],
  ["settings-work-common", "共通の作業ルール"],
  ["settings-presets", "モード別ルール"],
  ["settings-writing", "レポート執筆ルール"],
  ["settings-skills", "スキル管理"],
  ["settings-remote", "遠隔システム"],
  ["settings-report", "TeX・PDF・作図"],
  ["settings-benchmarks", "モデル能力"]
] as const;

function selectSettingsPage(id: string, focus = false): void {
  if (!settingsPages.some(([key]) => key === id)) return;
  for (const [key] of settingsPages) {
    const active = key === id;
    const panel = byId(key);
    panel.hidden = !active;
    const tab = byId<HTMLButtonElement>(`${key}-tab`);
    tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  byId("settings-view").scrollTop = 0;
}

// Run after all editors are mounted. Moving nodes preserves unsaved values,
// listeners and each editor's independent save operation.
function initializeSettingsPages(): void {
  const host = byId("settings-view");
  const layout = document.createElement("div"); layout.className = "settings-pages";
  const nav = document.createElement("nav"); nav.className = "settings-page-nav";
  nav.setAttribute("role", "tablist"); nav.setAttribute("aria-label", "設定カテゴリ"); nav.setAttribute("aria-orientation", "vertical");
  const content = document.createElement("div"); content.className = "settings-page-content";
  for (const [index, [id, label]] of settingsPages.entries()) {
    const panel = byId(id);
    // Keep the container as well: asynchronous editors may retain its reference.
    const page = panel; page.classList.add("settings-page");
    if (page instanceof HTMLDetailsElement) page.open = true;
    page.setAttribute("role", "tabpanel"); page.setAttribute("aria-labelledby", `${id}-tab`);
    const heading = document.createElement("h2"); heading.textContent = label;
    page.prepend(heading); content.append(page);
    const tab = document.createElement("button"); tab.type = "button"; tab.id = `${id}-tab`; tab.textContent = label;
    tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", id);
    tab.onclick = () => selectSettingsPage(id);
    tab.onkeydown = event => {
      const next = event.key === "ArrowDown" ? (index + 1) % settingsPages.length : event.key === "ArrowUp" ? (index + settingsPages.length - 1) % settingsPages.length : event.key === "Home" ? 0 : event.key === "End" ? settingsPages.length - 1 : undefined;
      if (next !== undefined) { event.preventDefault(); selectSettingsPage(settingsPages[next][0], true); }
    };
    nav.append(tab);
  }
  layout.append(nav, content); host.replaceChildren(layout);
  selectSettingsPage("settings-execution");
}

function organizeOpenCodeSettings(): void {
  const form = byId("glm-form");
  const parent = form.parentElement!;
  const notes = [...form.querySelectorAll<HTMLElement>(":scope > p")].filter(p => !p.id);
  // Explanatory text belongs in help, not another accordion inside the service.
  byId("service-settings-help").append(...notes);

  // OpenCodeはプロバイダー切替の確認が必要なので、共通のモデル保存とフォームを分ける。
  const card = document.createElement("details"); card.id = "service-opencode";
  card.className = "model-default-row";
  parent.insertBefore(card, form);
  const heading = form.querySelector<HTMLElement>(".service-heading")!;
  const summary = document.createElement("summary"); card.append(summary);
  summary.className = "service-heading";
  summary.append(...heading.childNodes);
  const readiness = document.createElement("span"); readiness.dataset.serviceReadiness = "opencode"; readiness.className = "service-limit-summary";
  summary.append(readiness);
  const limit = document.createElement("span"); limit.className = "service-limit-summary"; limit.dataset.serviceLimit = "opencode";
  summary.insertBefore(limit, byId("opencode-enabled"));
  heading.remove();
  const usage = document.createElement("div"); usage.dataset.serviceUsage = "opencode";
  const accounts = document.createElement("div"); accounts.dataset.serviceAccounts = "opencode";
  const status = form.querySelector<HTMLElement>("[data-service-status]")!;
  const body = document.createElement("div"); body.className = "service-settings-body";
  body.append(status, usage, form, accounts); card.append(body);
}

function organizeServiceHelp(): void {
  const dialog = document.createElement("dialog"); dialog.id = "service-settings-help";
  dialog.className = "service-settings-help";
  dialog.setAttribute("aria-labelledby", "service-help-title");
  const title = document.createElement("h2"); title.id = "service-help-title"; title.textContent = "サービス設定の説明・操作権限";
  const close = document.createElement("button"); close.type = "button"; close.textContent = "閉じる";
  close.className = "secondary-button compact"; close.onclick = () => dialog.close();
  const heading = document.createElement("div"); heading.className = "service-heading"; heading.append(title, close);
  dialog.append(heading, byId("settings-login"), byId("settings-permissions"));
  // These sections contain explanations only. Keep all text accessible without
  // stacking more disclosure triangles inside the help dialog.
  for (const details of [...dialog.querySelectorAll("details")].reverse()) {
    const section = document.createElement("section"); section.id = details.id;
    const summary = details.querySelector(":scope > summary");
    if (summary) { const h = document.createElement("h3"); h.textContent = summary.textContent; summary.replaceWith(h); }
    section.append(...details.childNodes); details.replaceWith(section);
  }
  document.body.append(dialog);
  const button = document.createElement("button"); button.type = "button"; button.id = "open-service-settings-help";
  button.className = "secondary-button compact"; button.textContent = "認証・使用量・権限の説明";
  button.onclick = () => dialog.showModal();
  // Keep interactive help outside the disclosure heading: opening help should
  // not toggle the category, and all category headings use the same layout.
  byId("settings-models").querySelector(".panel")!.prepend(button);
}

function initializeSettingsLayout(): void {
  const host = byId("settings-view");
  if (host.dataset.layoutReady === "true") return;

  organizeServiceHelp();
  byId("settings-routing").append(document.querySelector(".policy-panel")!);
  byId("settings-models").querySelector(".panel")!.append(byId("settings-routing"));
  const usageForm = byId("orchestration-settings-form");
  // One user-facing save for service selection, models and usage thresholds.
  // OpenCode provider changes still require their own explicit apply action.
  byId("save-model-defaults").hidden = true;
  usageForm.querySelector(".detail-actions")!.append(byId("model-default-status"));
  for (const note of usageForm.querySelectorAll<HTMLElement>(":scope > p:not([id])")) byId("service-settings-help").append(note);
  const note = document.createElement("p");
  note.textContent = "使用率は切替の目安です。上限の保証や実行中の作業の強制停止は行いません。";
  usageForm.prepend(note);
  byId("save-routing-settings").textContent = "サービス設定を保存";
  byId("routing-revert").textContent = "保存済み設定に戻す";
  // Move the existing forms, never clone them: Resources is the sole editor
  // for CLI configuration and preserves all save handlers and unsaved values.
  byId("resource-grid").append(byId("settings-models"));

  organizeOpenCodeSettings();
  host.dataset.layoutReady = "true";
}
