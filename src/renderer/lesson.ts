type LessonDepth = "known" | "recap" | "foundation" | "deep";
interface LessonPlan {
  audience: string; interests: string; language: "ja" | "en"; references: string[];
  topics: Array<{id: string; title: string; reason: string; dependsOn: string[]; recommended: LessonDepth; depth: LessonDepth}>;
}
const lessonDepthLabels: Record<LessonDepth, string> = { known: "既知（説明省略）", recap: "簡単に復習", foundation: "基礎から説明", deep: "詳しく説明" };
let lessonFiles: Array<{id: string; name: string}> = [];
function renderLessonDispatch(enabled: boolean): void {
  byId("lesson-dispatch").classList.toggle("hidden", !enabled);
  const button = byId<HTMLButtonElement>("lesson-choose-pdfs");
  button.onclick = async () => {
    button.disabled = true;
    try {
      const added = await api.chooseLessonPdfs();
      if (lessonFiles.length + added.length > 10) throw new Error("PDFは合計10件までです。不要なものを外してください。");
      lessonFiles.push(...added); renderLessonFiles();
    } catch (e) { showToast(errorMessage(e)); }
    finally { button.disabled = false; }
  };
}
function renderLessonFiles(): void {
  const host = byId("lesson-pdf-list"); host.replaceChildren();
  lessonFiles.forEach((file, index) => {
    const row = document.createElement("li"), title = document.createElement("span"); title.textContent = `${index === 0 ? "主論文" : "補足"}：${file.name}`;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary-button compact"; remove.textContent = "外す";
    remove.onclick = () => { lessonFiles = lessonFiles.filter(f => f.id !== file.id); renderLessonFiles(); };
    row.append(title, remove);
    if (index > 0) { const primary = document.createElement("button"); primary.type = "button"; primary.className = "secondary-button compact"; primary.textContent = "主論文にする"; primary.onclick = () => { lessonFiles = [file, ...lessonFiles.filter(f => f.id !== file.id)]; renderLessonFiles(); }; row.append(primary); }
    host.append(row);
  });
}
function lessonDispatchInput(): {lesson?: {attachmentIds: string[]; references: string[]; audience: string; interests: string; language: "ja" | "en"}} {
  if (byId<HTMLSelectElement>("task-preset").value !== "paper-explainer") return {};
  if (!lessonFiles.length) throw new Error("主論文PDFを選択してください。");
  return { lesson: { attachmentIds: lessonFiles.map(f => f.id), references: byId<HTMLTextAreaElement>("lesson-references").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    audience: byId<HTMLInputElement>("lesson-audience").value, interests: byId<HTMLInputElement>("lesson-interests").value, language: byId<HTMLSelectElement>("lesson-language").value as "ja" | "en" } };
}
function resetLessonDispatch(): void { lessonFiles = []; renderLessonFiles(); }

/** Same draft/save/approve transaction as the goal: choices cannot silently
 * alter a running lesson, and AI recommendations are distinct from selections. */
function buildLessonEditor(task: TaskRecord, plan: LessonPlan, changed: () => void): HTMLElement {
  const section = document.createElement("section"); section.className = "lesson-panel";
  const heading = document.createElement("h3"); heading.textContent = "どこから説明するか";
  const note = document.createElement("p"); note.textContent = "AIの推奨を参考に、項目ごとの説明レベルを選んでください。ゴールの承認で確定します。枚数・発表時間の上限はありません。";
  const sources = document.createElement("p"); sources.textContent = (task.lessonSources ?? []).map((s, i) => `${i ? "補足" : "主論文"}：${s.name}`).join(" ／ ");
  section.append(heading, note, sources);
  for (const [key, labelText] of [["audience", "想定読者・既知の知識"], ["interests", "重点的に理解したいこと"]] as const) {
    const label = document.createElement("label"); label.textContent = labelText;
    const input = document.createElement("input"); input.value = plan[key]; input.maxLength = 2000; input.setAttribute("aria-label", labelText); input.oninput = () => { plan[key] = input.value; changed(); }; label.append(input); section.append(label);
  }
  const lang = document.createElement("label"); lang.textContent = "教材の言語";
  const language = document.createElement("select"); language.add(new Option("日本語", "ja")); language.add(new Option("English", "en")); language.value = plan.language; language.onchange = () => { plan.language = language.value as "ja"|"en"; changed(); }; lang.append(language); section.append(lang);
  const references = document.createElement("label"); references.textContent = "参考URL（1行1件）";
  const urls = document.createElement("textarea"); urls.rows = 2; urls.value = plan.references.join("\n"); urls.oninput = () => { plan.references = urls.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); changed(); }; references.append(urls); section.append(references);
  const accept = document.createElement("button"); accept.type = "button"; accept.className = "secondary-button compact"; accept.textContent = "すべて推奨設定にする";
  const rows = document.createElement("div"); rows.className = "lesson-topics";
  const render = () => {
    rows.replaceChildren();
    if (!plan.topics.length) { const p = document.createElement("p"); p.textContent = "まだ提案はありません。下の「AIで前提知識・説明レベルを提案」から整理できます。手動追加も可能です。"; rows.append(p); }
    for (const topic of plan.topics) {
      const card = document.createElement("div"); card.className = "lesson-topic";
      const heading = document.createElement("strong"); heading.textContent = topic.title;
      const reason = document.createElement("p"); reason.textContent = topic.reason;
      const dependencies = document.createElement("small"); dependencies.textContent = `AI推奨：${lessonDepthLabels[topic.recommended]}${topic.dependsOn.length ? ` ／ 前提：${topic.dependsOn.map(id => plan.topics.find(t => t.id === id)?.title ?? id).join("、")}` : ""}`;
      const select = document.createElement("select"); select.setAttribute("aria-label", `${topic.title}の説明レベル`);
      for (const [value, label] of Object.entries(lessonDepthLabels)) select.add(new Option(label, value));
      select.value = topic.depth; select.onchange = () => { topic.depth = select.value as LessonDepth; changed(); };
      const body = document.createElement("div"); body.append(heading, reason, dependencies); card.append(body, select); rows.append(card);
    }
    accept.disabled = !plan.topics.length;
  };
  accept.onclick = () => { plan.topics.forEach(t => { t.depth = t.recommended; }); changed(); render(); };
  section.append(accept, rows); render();
  const addition = document.createElement("div"); addition.className = "goal-add-line";
  const title = document.createElement("input"); title.placeholder = "説明してほしい項目を追加"; title.maxLength = 200; title.setAttribute("aria-label", "説明項目を追加");
  const button = document.createElement("button"); button.type = "button"; button.textContent = "＋ 追加"; button.className = "secondary-button compact";
  button.onclick = () => { if (!title.value.trim()) return; if (plan.topics.length >= 40) { showToast("説明項目は40件以内にしてください。"); return; } plan.topics.push({id:crypto.randomUUID(),title:title.value.trim(),reason:"ユーザーが説明を指定した項目",dependsOn:[],recommended:"foundation",depth:"foundation"}); title.value = ""; changed(); render(); };
  addition.append(title, button); section.append(addition); return section;
}
