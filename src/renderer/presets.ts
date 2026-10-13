interface WorkPresetSnapshot {
  manifest: { id: string; name: string; description: string; version: number; rules: string; focus?: "research" | "idea" | "literature" | "implementation" | "paper" | "poster" | "paper-explainer"; primaryDocument?: "beamer" | "paper"; integratedWorkflow?: boolean; ideaApproach?: "experimental"; goal: { deliverables: string[]; criteria: GoalCriterion[]; questions: string[] } };
  rules: string; commonRules: string; revision: string; source: "builtin" | "user"; capturedAt: string;
  stages?: WorkPresetSnapshot[];
  documentTemplate?: { id: "paper" | "poster"; source: string; latexmkrc: string };
}
interface WorkPresetCatalog { presets: WorkPresetSnapshot[]; errors: string[]; userDirectory: string; editingVersion?: number; defaultPresetId?: string; }
let presetCatalog: WorkPresetCatalog = { presets: [], errors: [], userDirectory: "" };
const presetDrafts = new Map<string, { rules: string; revision: string; goal: WorkPresetSnapshot["manifest"]["goal"] }>();
const presetTaskOpen = new Set<string>();
let presetManagerId: string | undefined;
let presetsBusy = false;
let dispatchPresetInitialized = false;
const presetEditorsOpen = new Set<string>();

function renderPresetEditState(): void {
  const open = Boolean(presetManagerId && presetEditorsOpen.has(presetManagerId));
  byId("preset-raw-editor").hidden = !open;
  byId("preset-edit").setAttribute("aria-expanded", String(open));
  byId("preset-edit").textContent = open ? "全文を閉じる" : "ルール全文を確認・編集";
  byId("preset-status").textContent = presetManagerId && presetDrafts.has(presetManagerId)
    ? "未保存の編集があります。全文を開いて保存、または編集を破棄してください。"
    : "保存済みのルールを自動適用します。ここでの操作は不要です。";
}
function presetDraft(p: WorkPresetSnapshot) {
  let draft = presetDrafts.get(p.manifest.id);
  if (!draft) { draft = { rules: p.rules, revision: p.revision, goal: structuredClone(p.manifest.goal) }; presetDrafts.set(p.manifest.id, draft); }
  byId<HTMLButtonElement>("preset-revert").disabled = false;
  byId<HTMLButtonElement>("preset-save").disabled = presetsBusy || presetCatalog.editingVersion !== 1;
  return draft;
}

function renderDispatchPresets(): void {
  const select = byId<HTMLSelectElement>("task-preset"), previous = select.value;
  select.replaceChildren();
  const none = document.createElement("option"); none.value = ""; none.textContent = "指定なし（標準ルール）"; select.append(none);
  for (const p of presetCatalog.presets) { const option = document.createElement("option"); option.value = p.manifest.id; option.textContent = p.manifest.name; select.append(option); }
  if (previous && !presetCatalog.presets.some(p => p.manifest.id === previous)) {
    // Keep a removed/broken selection visible rather than silently changing a
    // user's requested work mode to the standard mode.
    const missing = document.createElement("option"); missing.value = previous; missing.textContent = "選択したプリセットは使用不可（選び直してください）"; select.append(missing);
  }
  select.value = !dispatchPresetInitialized && !previous ? presetCatalog.defaultPresetId ?? "" : previous;
  if (presetCatalog.presets.length || previous) dispatchPresetInitialized = true;
  renderDispatchPresetNote();
}
function renderDispatchPresetNote(): void {
  const id = byId<HTMLSelectElement>("task-preset").value;
  renderLessonDispatch(id === "paper-explainer");
  const p = presetCatalog.presets.find(p => p.manifest.id === id);
  byId("task-preset-description").textContent = p ? `${p.manifest.description} ゴールの初期値と作業ルールに適用し、担当構成は主担当が設計します。` : id ? "選択したプリセットを利用できません。システム設定で再読み込みするか、別のモードを選んでください。" : "用途を指定せず、標準のゴール設定から始めます。";
  if (p?.documentTemplate) byId("task-preset-description").textContent += ` 専用TeXひな型：${p.documentTemplate.id === "paper" ? "論文 A4" : "ポスター A0縦（841×1189mm）"}。公式投稿様式ではありません。希望のサイズ・向き・様式はゴールで指定してください。標準IPSJ報告書も別に作成します。`;
  if (p?.stages?.length) byId("task-preset-description").textContent += presetCompositionNote(p);
}
function renderPresetManager(): void {
  const select = byId<HTMLSelectElement>("preset-manager-select");
  presetManagerId ??= presetCatalog.presets[0]?.manifest.id;
  select.replaceChildren();
  for (const p of presetCatalog.presets) { const o = document.createElement("option"); o.value = p.manifest.id; o.textContent = p.manifest.name; select.append(o); }
  select.value = presetManagerId ?? "";
  const preset = presetCatalog.presets.find(p => p.manifest.id === presetManagerId);
  byId("preset-directory").textContent = `保存先：${presetCatalog.userDirectory || "未取得"}/${preset?.manifest.id ?? "用途"}/settings.json`;
  byId("preset-error").textContent = presetCatalog.errors.join("\n");
  const rules = byId<HTMLTextAreaElement>("preset-rules");
  const draft = preset && presetDrafts.get(preset.manifest.id);
  rules.value = draft?.rules ?? preset?.rules ?? "";
  rules.readOnly = !preset;
  byId("preset-manager-description").textContent = preset ? `${preset.manifest.description} · 版 ${preset.revision.slice(0, 12)}${draft && draft.revision !== preset.revision ? " · 保存済みファイルが変わっています。編集内容は保持していますが、そのまま上書きはできません。" : ""}` : "プリセットを読み込めません。再読み込みを試してください。";
  if (preset?.stages?.length) byId("preset-manager-description").textContent += presetCompositionNote(preset);
  renderPresetEditState();
  const incompatible = presetCatalog.editingVersion !== 1;
  if (incompatible) byId("preset-error").textContent = "プリセットの統合編集を使うにはアプリを再起動してください。";
  for (const element of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>(".preset-panel input, .preset-panel select, .preset-panel button, .preset-panel textarea")) element.disabled = presetsBusy || incompatible;
  byId<HTMLButtonElement>("presets-refresh").disabled = presetsBusy;
  byId<HTMLButtonElement>("preset-edit").disabled = presetsBusy || !preset;
  byId<HTMLButtonElement>("preset-save").disabled = presetsBusy || incompatible || !preset || !draft;
  byId<HTMLButtonElement>("preset-revert").disabled = presetsBusy || !draft;
}
async function presetAction(work: () => Promise<void>): Promise<void> {
  if (presetsBusy) return;
  presetsBusy = true;
  for (const e of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>(".preset-panel input, .preset-panel select, .preset-panel button, .preset-panel textarea")) e.disabled = true;
  byId("preset-error").textContent = "";
  try { await work(); presetCatalog = await api.listWorkPresets(); renderDispatchPresets(); }
  catch (e) { byId("preset-error").textContent = errorMessage(e); showToast(errorMessage(e)); }
  finally {
    const error = byId("preset-error").textContent;
    presetsBusy = false; renderPresetManager();
    if (error) byId("preset-error").textContent = error;
  }
}
function initializePresets(catalog?: WorkPresetCatalog): void {
  if (catalog) presetCatalog = catalog;
  renderDispatchPresets(); renderPresetManager();
  byId("task-preset").addEventListener("change", () => { dispatchPresetInitialized = true; renderDispatchPresetNote(); });
  byId("preset-manager-select").addEventListener("change", () => { presetManagerId = byId<HTMLSelectElement>("preset-manager-select").value; renderPresetManager(); });
  byId("preset-rules").addEventListener("input", () => {
    const p = presetCatalog.presets.find(p => p.manifest.id === presetManagerId);
    if (p) { presetDraft(p).rules = byId<HTMLTextAreaElement>("preset-rules").value; renderPresetEditState(); }
  });
  byId("preset-edit").addEventListener("click", () => {
    if (!presetManagerId) return;
    if (presetEditorsOpen.has(presetManagerId)) presetEditorsOpen.delete(presetManagerId);
    else presetEditorsOpen.add(presetManagerId);
    renderPresetEditState();
  });
  byId("presets-refresh").addEventListener("click", () => void presetAction(async () => {}));
  byId("preset-save").addEventListener("click", () => {
    const p = presetCatalog.presets.find(p => p.manifest.id === presetManagerId); if (!p) return;
    if (presetCatalog.editingVersion !== 1) return;
    const draft = presetDrafts.get(p.manifest.id) ?? { revision: p.revision, rules: p.rules, goal: p.manifest.goal };
    // Checklist defaults are no longer editable here, but preserve legacy
    // custom defaults exactly rather than silently replacing them on save.
    void presetAction(async () => { await api.saveWorkPresetRules(p.manifest.id, draft.revision, draft.rules, draft.goal); presetDrafts.delete(p.manifest.id); showToast("作業ルールを保存しました。既存タスクは変わりません。"); });
  });
  byId("preset-revert").addEventListener("click", () => { if (presetManagerId) presetDrafts.delete(presetManagerId); renderPresetManager(); });
  initializePresetCommon();
}

interface PresetCommonSettings { rules: string; revision: string; userPath: string; }
let presetCommon: PresetCommonSettings | undefined;
let presetCommonBusy = false;
function initializePresetCommon(): void {
  const editor = byId<HTMLTextAreaElement>("work-common-rules");
  const action = async (save: boolean) => {
    if (presetCommonBusy) return;
    if (!save && presetCommon && editor.value !== presetCommon.rules && !confirm("共通の原則の未保存の編集を破棄しますか？")) return;
    presetCommonBusy = true; editor.disabled = true; byId<HTMLButtonElement>("work-common-save").disabled = true; byId<HTMLButtonElement>("work-common-reload").disabled = true;
    byId("work-common-error").textContent = "";
    try {
      presetCommon = save && presetCommon ? await api.saveWorkPresetCommon(presetCommon.revision, editor.value) : await api.getWorkPresetCommon();
      editor.value = presetCommon.rules; byId("work-common-status").textContent = `保存済み · 版 ${presetCommon.revision.slice(0, 12)}`;
      byId("work-common-path").textContent = `保存先：${presetCommon.userPath}`;
      if (save) { presetCatalog = await api.listWorkPresets(); renderPresetManager(); renderDispatchPresets(); }
    } catch (e) { byId("work-common-error").textContent = typeof api.getWorkPresetCommon !== "function" ? "アプリを再起動してください。" : errorMessage(e); }
    finally { presetCommonBusy = false; editor.disabled = !presetCommon; byId<HTMLButtonElement>("work-common-save").disabled = !presetCommon; byId<HTMLButtonElement>("work-common-reload").disabled = false; }
  };
  editor.oninput = () => { byId("work-common-status").textContent = "未保存の編集があります。"; };
  byId("work-common-save").onclick = () => { void action(true); };
  byId("work-common-reload").onclick = () => { void action(false); };
  void action(false);
}
function selectedPresetInput(): { presetId?: string; presetRevision?: string } {
  const id = byId<HTMLSelectElement>("task-preset").value;
  if (!id) return {};
  const p = presetCatalog.presets.find(p => p.manifest.id === id);
  if (!p) throw new Error("作業プリセットを再読み込みして選び直してください。");
  return { presetId: id, presetRevision: p.revision };
}
function buildTaskPreset(task: TaskRecord): HTMLElement {
  const detail = document.createElement("details"); detail.className = "task-preset-rules goal-disclosure"; detail.open = presetTaskOpen.has(task.id);
  detail.addEventListener("toggle", () => { if (!detail.isConnected) return; if (detail.open) presetTaskOpen.add(task.id); else presetTaskOpen.delete(task.id); });
  const p = task.workPreset!;
  const summary = document.createElement("summary"); summary.textContent = `作業ルール · ${p.manifest.name}`;
  const note = document.createElement("p"); note.textContent = `保存版 ${p.revision.slice(0, 12)}。タスク作成時のルールです。ゴール・権限・予算の承認に優先しません。プリセットを編集してもこのタスクには反映しません。`;
  const content = document.createElement("pre"); content.textContent = `${p.commonRules}\n\n${p.rules}${(p.stages ?? []).map((s,i)=>`\n\n===== ${p.manifest.integratedWorkflow ? "方法" : "工程"}${i+1}: ${s.manifest.name} · ${s.revision.slice(0,12)} =====\n${s.rules}`).join("")}`;
  detail.append(summary, note, content); return detail;
}
function presetCompositionNote(p: WorkPresetSnapshot): string {
  return p.manifest.integratedWorkflow
    ? ` 利用する方法：${p.stages!.map(s=>s.manifest.name).join("、")}。各モードの保存済みルールを取り込み、同じ主担当が必要に応じて行き来します。固定の直列工程ではありません。`
    : ` 使用順：${p.stages!.map(s=>s.manifest.name).join(" → ")}。各モードの保存済みルールをタスク作成時に取り込みます。`;
}
