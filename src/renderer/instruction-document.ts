function showTaskInstructions(taskId: string): void {
  if (document.querySelector(".instruction-document-dialog")) return;
  const dialog = document.createElement("dialog"); dialog.className = "instruction-document-dialog";
  dialog.setAttribute("aria-label", "タスクの指示書全文");
  const title = document.createElement("h3"); title.textContent = "現在の指示書・全文";
  const note = document.createElement("p"); note.textContent = "保存済みの指示をまとめて表示します。未保存の編集は含みません。TXTには表示中と同じ内容を書き出します。";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const content = document.createElement("textarea"); content.readOnly = true;
  content.setAttribute("aria-label", "指示書全文（読み取り専用）"); content.spellcheck = false;
  const error = document.createElement("p"); error.className = "form-error"; error.setAttribute("role", "alert");
  const actions = document.createElement("div"); actions.className = "detail-actions";
  const refresh = document.createElement("button"); refresh.textContent = "表示を更新";
  const save = document.createElement("button"); save.textContent = "TXTで書き出し"; save.disabled = true;
  const close = document.createElement("button"); close.textContent = "閉じる"; close.onclick = () => dialog.close();
  actions.append(refresh, save, close); dialog.append(title, note, status, content, error, actions);
  document.body.append(dialog); dialog.showModal();
  let snapshotId: string | undefined;
  const load = async () => {
    refresh.disabled = true; save.disabled = true; error.textContent = ""; status.textContent = "指示書を読み込んでいます…";
    try {
      const result = await api.getTaskInstructions(taskId);
      if (!dialog.isConnected) return;
      snapshotId = result.id; content.value = result.text;
      status.textContent = `取得日時：${new Date(result.createdAt).toLocaleString()} · ${result.filename}`;
    } catch (e) { error.textContent = errorMessage(e); status.textContent = snapshotId ? "前回取得した指示書を表示しています。" : "取得できませんでした。"; }
    finally { refresh.disabled = false; save.disabled = !snapshotId; }
  };
  refresh.onclick = () => { void load(); };
  save.onclick = async () => {
    if (!snapshotId) return;
    save.disabled = true; refresh.disabled = true; error.textContent = "";
    try {
      const result = await api.exportTaskInstructions(snapshotId);
      status.textContent = result.canceled ? "書き出しをキャンセルしました。" : `保存しました：${result.path}`;
    } catch (e) { error.textContent = errorMessage(e); }
    finally { save.disabled = false; refresh.disabled = false; }
  };
  dialog.addEventListener("close", () => dialog.remove());
  void load();
}
