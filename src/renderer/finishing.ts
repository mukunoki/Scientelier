interface FinishingSkillSettings {
  section: string;
  current: { rules: string; revision: string; capturedAt: string };
  defaultRules: string;
  userPath: string;
}
const finishingEditors: Record<string, { settings?: FinishingSkillSettings; busy: boolean }> = {};

function initializeWritingEditor(section: string): void {
  const suffix = section === "common" ? "" : `-${section}`;
  const element = <T extends HTMLElement = HTMLElement>(name: string) => byId<T>(`finishing-${name}${suffix}`);
  const state = finishingEditors[section] = { busy: false } as { settings?: FinishingSkillSettings; busy: boolean };
  const editor = element<HTMLTextAreaElement>("rules");
  const controls = () => {
    editor.disabled = state.busy || !state.settings;
    for (const name of ["save", "default"]) element<HTMLButtonElement>(name).disabled = state.busy || !state.settings;
    element<HTMLButtonElement>("reload").disabled = state.busy;
  };
  const action = async (work: () => Promise<void>) => {
    if (state.busy) return;
    state.busy = true; controls(); element("error").textContent = "";
    try { await work(); }
    catch (error) { element("error").textContent = errorMessage(error); }
    finally { state.busy = false; controls(); }
  };
  const reload = () => action(async () => {
    const settings = await api.getFinishingSkill(section);
    if (settings.section !== section) {
      state.settings = undefined;
      throw new Error("執筆ルールの分割を反映するため、アプリを再起動してください。保存は行っていません。");
    }
    state.settings = settings;
    editor.value = state.settings.current.rules;
    element("status").textContent = `保存済み · 版 ${state.settings.current.revision.slice(0, 12)}`;
    element("path").textContent = `保存先：${state.settings.userPath}（初回保存時に作成）。通常のテキストとしても編集できます。冒頭のname・descriptionと本文を保持してください。`;
  });
  editor.addEventListener("input", () => { element("status").textContent = "このルールに未保存の編集があります。"; });
  element("reload").addEventListener("click", () => {
    if (state.settings && editor.value !== state.settings.current.rules && !window.confirm("このルールの未保存の編集を破棄して再読み込みしますか？")) return;
    void reload();
  });
  element("default").addEventListener("click", () => {
    if (!state.settings || !window.confirm("この編集欄を同梱ルールに戻しますか？ 保存するまでは適用されません。")) return;
    editor.value = state.settings.defaultRules;
    element("status").textContent = "同梱ルールを編集欄に戻しました。適用するには保存してください。";
  });
  element("save").addEventListener("click", () => void action(async () => {
    if (!state.settings) return;
    state.settings.current = await api.saveFinishingSkill(state.settings.current.revision, editor.value, section);
    element("status").textContent = `保存済み · 版 ${state.settings.current.revision.slice(0, 12)} · 次に開始する執筆担当・レポーターから適用します。`;
  }));
  void reload();
}

function initializeFinishing(): void {
  const common = byId("writing-editor-common");
  for (const [section, label] of [["style", "表現・文体（AIらしい表現を避ける）"], ["verification", "数値・文献の検証"], ["paper", "論文・レポート"], ["poster", "ポスター"], ["slides", "スライド"]]) {
    const disclosure = document.createElement("details"); disclosure.className = "writing-rule-section";
    const summary = document.createElement("summary"); summary.textContent = label;
    const panel = common.cloneNode(true) as HTMLElement; panel.id = `writing-editor-${section}`;
    for (const node of panel.querySelectorAll<HTMLElement>("[id]")) node.id += `-${section}`;
    panel.querySelector("label")!.firstChild!.textContent = `${label}のルール（SKILL.md）`;
    panel.querySelector("textarea")!.setAttribute("aria-label", `${label}の執筆ルール`);
    disclosure.append(summary, panel); byId("writing-rule-sections").append(disclosure);
  }
  for (const section of ["common", "style", "verification", "paper", "poster", "slides"]) {
    const suffix = section === "common" ? "" : `-${section}`;
    const details = document.createElement("section"); details.className = "settings-inline";
    const title = document.createElement("h3"); title.textContent = "復元・再読み込み・保存先";
    details.append(title, byId(`finishing-default${suffix}`), byId(`finishing-reload${suffix}`), byId(`finishing-path${suffix}`));
    byId(`writing-editor-${section}`).append(details);
    initializeWritingEditor(section);
  }
}

function buildFinishingStatus(task: TaskRecord): HTMLElement | undefined {
  const run = [...task.runs].reverse().find(r => r.role === "reporter" && r.finishingSkill);
  if (!run?.finishingSkill) return;
  const details = document.createElement("details"), summary = document.createElement("summary");
  details.className = "task-finishing-status goal-disclosure";
  const unit = task.workUnits.find(u => u.id === run.workUnitId);
  summary.textContent = `レポート執筆ルール · ${run.finishingCheck ? "適用確認済み" : run.state === "running" ? "実施中" : "完了確認待ち"}`;
  const note = document.createElement("p"); note.textContent = `保存版 ${run.finishingSkill.revision.slice(0, 12)}。PDF・独立レビューは別途確認します。\n${run.finishingCheck?.summary ?? unit?.error ?? "執筆後の仕上げ・再生成が必要です。"}`;
  const sources = document.createElement("pre"); sources.textContent = run.finishingCheck?.sources.join("\n") ?? "";
  const rules = document.createElement("pre"); rules.textContent = run.finishingSkill.rules;
  details.append(summary, note, sources, rules); return details;
}
