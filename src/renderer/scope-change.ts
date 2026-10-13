function confirmScopeChange(task: TaskRecord, instruction: string, prior?: FollowupInput["scopeChange"]): Promise<FollowupInput["scopeChange"] | undefined> {
  if (!task.goal || task.goal.status !== "approved" || document.querySelector(".scope-change-dialog")) return Promise.resolve(undefined);
  return new Promise(resolve => {
    const goal = task.goal!;
    const dialog = document.createElement("dialog"); dialog.className = "restart-dialog scope-change-dialog";
    dialog.setAttribute("aria-label", "作業範囲・制約の変更を承認");
    const text = (tag: string, value: string) => { const el = document.createElement(tag); el.textContent = value; dialog.append(el); return el; };
    text("h2", "合格条件・作業範囲の変更を確認");
    text("p", `承認済みゴール第${goal.revision}版を更新します。選択した合格条件のみ編集し、チェックした禁止・対象外だけを解除します。FP64禁止など、選ばなかった条件と成果物は保持します。OS権限・接続先・予算は変更しません。`);
    text("h3", "新しい作業目的・追加指示"); text("p", instruction);
    text("h3", "変更する合格条件");
    text("p", "条件を変更する場合だけ選択し、変更後の全文と検証方法を入力してください。未選択の項目は変更されません。過去のゴールは履歴に保持し、新しい条件で再検証します。条件編集時は最終目的を維持し、上の文章を追加指示として扱います。");
    const criterionFields: { id: string; check: HTMLInputElement; description: HTMLTextAreaElement; verification: HTMLTextAreaElement }[] = [];
    for (const criterion of goal.criteria) {
      const row = document.createElement("section"); row.className = "criterion-edit";
      const check = document.createElement("input"); check.type = "checkbox"; check.setAttribute("aria-label", `合格条件を変更：${criterion.id}`);
      const edit = prior?.goalRevision === goal.revision ? prior.criterionEdits?.find(e => e.id === criterion.id) : undefined;
      check.checked = !!edit;
      const label = document.createElement("label"); label.className = "followup-check";
      label.append(check, `${criterion.id}：${criterion.description}`);
      const fields = document.createElement("div"); fields.className = "criterion-edit-fields"; fields.hidden = !check.checked;
      const before = document.createElement("p"); before.textContent = `変更前の検証方法：${criterion.verification}`; fields.append(before);
      const inputs = ["description", "verification"].map(key => {
        const name = key === "description" ? "変更後の合格条件" : "変更後の検証方法";
        const label = document.createElement("label"); label.textContent = name;
        const input = document.createElement("textarea"); input.maxLength = 2000; input.rows = 3;
        input.setAttribute("aria-label", `${name}：${criterion.id}`); input.value = (edit ?? criterion)[key as "description" | "verification"];
        label.append(input); fields.append(label); return input;
      });
      check.onchange = () => { fields.hidden = !check.checked; };
      criterionFields.push({ id: criterion.id, check, description: inputs[0], verification: inputs[1] });
      row.append(label, fields); dialog.append(row);
    }
    text("p", "実装へ進む場合は、「着想検討に専念」の制約と「実装・実験は対象外」の両方を確認してください。混在した項目を選ぶと、その項目の全文が解除されます。");
    const selected = { removeConstraints: new Set<string>(), removeOutOfScope: new Set<string>() };
    for (const [key, title, values] of [["removeConstraints", "解除する制約・禁止事項", goal.constraints], ["removeOutOfScope", "対象外から外す項目（作業を許可）", goal.outOfScope]] as const) {
      text("h3", title);
      if (!values.length) text("p", "登録なし");
      for (const value of values) {
        const label = document.createElement("label"); label.className = "followup-check";
        const check = document.createElement("input"); check.type = "checkbox"; check.setAttribute("aria-label", `解除：${value}`);
        check.checked = prior?.goalRevision === goal.revision && prior[key].includes(value);
        if (check.checked) selected[key].add(value);
        check.onchange = () => { if (check.checked) selected[key].add(value); else selected[key].delete(value); };
        label.append(check, value); dialog.append(label);
      }
    }
    const implementation = document.createElement("input"); implementation.type = "checkbox"; implementation.setAttribute("aria-label", "実装・精度検証・性能実験を含める");
    implementation.checked = prior?.implementation ?? (task.workPreset?.manifest.focus === "idea" && task.workPreset.manifest.ideaApproach !== "experimental");
    const label = document.createElement("label"); label.className = "followup-check";
    label.append(implementation, task.workPreset?.manifest.ideaApproach === "experimental" ? "本格実装へモード変更する（試作・予備評価だけなら変更不要）" : "追加指示の実装・精度検証・性能実験を含める（必要なら実装モードへ変更）"); dialog.append(label);
    text("p", "合格条件を編集した場合は最終目的を保持します。それ以外の範囲変更では追加指示を新しい目的として保存します。実装・実験を含める場合は成果物と検証条件も追加します。既存の成果物から計画を立て直し、新しい条件でも独立レビューを省略しません。条件変更だけで合格にはなりません。");
    const actions = document.createElement("div"); actions.className = "goal-actions";
    const approve = document.createElement("button"); approve.type = "button"; approve.className = "primary-button"; approve.textContent = "変更を承認して実行";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary-button"; cancel.textContent = "キャンセル";
    let result: FollowupInput["scopeChange"];
    const error = document.createElement("p"); error.setAttribute("role", "alert"); dialog.append(error);
    approve.onclick = () => {
      const edits = criterionFields.filter(c => c.check.checked);
      const invalid = edits.find(c => [c.description.value, c.verification.value].some(v => !v.trim() || v.length > 2000));
      if (invalid) { error.textContent = "変更後の条件と検証方法を空欄にせず、各2,000文字以内で入力してください。"; invalid.description.focus(); return; }
      result = { goalRevision: goal.revision, removeConstraints: [...selected.removeConstraints], removeOutOfScope: [...selected.removeOutOfScope],
        ...(edits.length ? { criterionEdits: edits.map(c => ({ id: c.id, description: c.description.value.trim(), verification: c.verification.value.trim() })) } : {}),
        implementation: implementation.checked, confirmed: true }; dialog.close();
    };
    cancel.onclick = () => dialog.close(); actions.append(approve, cancel); dialog.append(actions);
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
