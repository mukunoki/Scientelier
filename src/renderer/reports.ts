// PDF targets, historical versions and preview controls. No task execution or
// source rewriting takes place here; report generation remains an API action.
const reportVersionSelections = new Map<string, number>();
const reportDocumentSelections = new Map<string, string>();
function reportButton(task: TaskRecord): HTMLButtonElement | undefined {
  // This legacy build action belongs to the report view, not the task toolbar.
  // Keep its former availability; moving the button must not start a new kind of run.
  if (taskIsActive(task) || task.state === "queued" || task.state === "paused") return undefined;
  const available = task.resumeFromUnitId || task.state === "blocked"
    || (task.state === "awaiting-input" && task.awaitingReason === "plan");
  if (!available) return undefined;
  const button = document.createElement("button");
  button.className = "secondary-button";
  button.type = "button";
  button.disabled = task.report?.state === "building";
  button.textContent = task.report?.state === "building" ? "Report agent is building…" : task.report?.state === "ready" ? "Ask report agent to rebuild" : "Ask report agent to build";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const updated = await api.generateReport(task.id);
      showToast(updated.report?.state === "ready" ? "Report agent produced the PDF" : updated.report?.error ?? "Report agent could not produce a PDF");
    } catch (error) {
      showToast(errorMessage(error));
    }
  });
  return button;
}

function forgetTaskReportSelections(taskId: string): void {
  reportVersionSelections.delete(taskId);
  for (const key of reportDocumentSelections.keys()) {
    if (key.startsWith(`${taskId}:`)) reportDocumentSelections.delete(key);
  }
}

function buildTaskReport(currentTask: TaskRecord): HTMLElement {
  const selectedVersion = reportVersionSelections.get(currentTask.id);
  const historical = currentTask.history?.find((round) => round.number === selectedVersion);
  const bundle = historical ? historical.report : currentTask.report;
  const documentKey = `${currentTask.id}:${historical?.number ?? "current"}`;
  const labels = { report: currentTask.workPreset?.manifest.primaryDocument === "beamer" ? "論文解説スライド（Beamer）" : "標準報告書（IPSJ研究報告）", paper: "論文", poster: "ポスター" };
  const selected = reportDocumentSelections.get(documentKey) ?? "report";
  const documentId = selected !== "report" && !bundle?.documents?.[selected as "paper" | "poster"] ? "report" : selected;
  const task = { ...currentTask, report: documentId === "report" ? bundle : bundle?.documents?.[documentId as "paper" | "poster"] };
  const section = document.createElement("section");
  section.className = "task-report-section";
  const heading = document.createElement("div");
  heading.className = "task-report-heading";
  const title = document.createElement("h3");
  title.textContent = `レポート · ${labels[documentId as keyof typeof labels]}`;
  const state = document.createElement("span");
  state.className = `report-state ${task.report?.state ?? "draft"}`;
  state.textContent = task.report?.state ?? "draft";
  heading.append(title, state);
  if (!historical) {
    const rebuild = reportButton(currentTask);
    if (rebuild) heading.append(rebuild);
  }
  const note = document.createElement("p");
  note.textContent = historical
    ? "選択した回の保存済みPDFを表示しています。"
    : currentTask.remote
      ? "遠隔側のレポート工程完了後に取得したPDFを、このMacで表示します。遠隔ファイルのライブ表示ではありません。"
      : "レポート工程で生成・確認したPDFを表示します。作業中のTeXの変更は、PDFの再生成後に反映されます。";
  section.append(heading, note);
  if (currentTask.goal?.lesson && !historical) {
    const actions = document.createElement("div"); actions.className = "report-recovery-actions";
    for (const label of ["ここがわからない", "具体例を追加", "式を順に説明", "図解して"]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "secondary-button compact"; button.textContent = label;
      button.onclick = () => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="追加指示"]');
        if (input) { input.value += `${input.value ? "\n" : ""}教材のページ［番号・見出しを入力］：${label}。前後の説明との接続も確認してください。`; input.dispatchEvent(new Event("input", {bubbles:true})); input.scrollIntoView({block:"nearest"}); input.focus(); }
      };
      actions.append(button);
    }
    section.append(actions);
  }
  const versions = document.createElement("select");
  versions.setAttribute("aria-label", "レポートの版");
  versions.add(new Option("最新版（作業中のTeX）", ""));
  for (const round of [...(currentTask.history ?? [])].reverse()) {
    if (round.report?.texPath) versions.add(new Option(`第${round.number}回 · ${round.instruction.slice(0, 45)}`, String(round.number)));
  }
  versions.value = selectedVersion === undefined ? "" : String(selectedVersion);
  versions.addEventListener("change", () => {
    if (versions.value) reportVersionSelections.set(task.id, Number(versions.value)); else reportVersionSelections.delete(task.id);
    renderDetail();
  });
  section.append(versions);
  if (Object.keys(bundle?.documents ?? {}).length) {
    const documents = document.createElement("select");
    documents.setAttribute("aria-label", "PDF成果物");
    documents.add(new Option(labels.report, "report"));
    for (const id of ["paper", "poster"] as const) if (bundle?.documents?.[id]) documents.add(new Option(`${labels[id]} · ${bundle.documents[id]!.state}`, id));
    documents.value = documentId;
    documents.addEventListener("change", () => { reportDocumentSelections.set(documentKey, documents.value); renderDetail(); });
    section.append(documents);
  }
  const files = document.createElement("div");
  files.className = "report-file-info";
  if (task.report?.texPath) {
    const tex = document.createElement("span");
    tex.textContent = `TeX memo: ${task.report.texPath}`;
    tex.title = task.report.texPath;
    files.append(tex);
  }
  if (task.report?.pdfPath) {
    const pdf = document.createElement("span");
    pdf.textContent = `PDF: ${task.report.pdfPath}`;
    pdf.title = task.report.pdfPath;
    files.append(pdf);
  }
  if (files.childElementCount) section.append(files);
  if (task.report?.state === "ready" && task.report.previewUrl) {
    const preview = document.createElement("iframe");
    preview.className = "task-report-preview";
    preview.title = `PDF preview for ${task.title}`;
    const viewerUrl = new URL("pdf-viewer.html", location.href);
    viewerUrl.searchParams.set("task", task.id);
    viewerUrl.searchParams.set("document", documentId);
    if (historical) viewerUrl.searchParams.set("round", String(historical.number));
    preview.src = viewerUrl.href;
    section.append(preview);
  } else {
    const status = document.createElement("div");
    status.className = "report-preview-status";
    status.textContent = task.report?.state === "failed"
      ? task.report.error ?? "PDFの生成に失敗しました。"
      : "レポート工程でPDFの生成・取得・確認が完了すると、ここに表示されます。";
    section.append(status);
  }
  return section;
}
