// This screen uses the same ledger as the agents; it never infers a pass from a
// completed terminal. Keep form drafts outside the periodically rebuilt detail.
const hpcDrafts = new Map<string, { budget?: Record<string, string>; unit?: any }>();
const hpcSnapshots = new Map<string, any>();
function buildHpcView(task: TaskRecord): HTMLElement {
  const root = document.createElement("section"); root.className = "hpc-view";
  const controls = document.createElement("div"); controls.className = "goal-actions";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const body = document.createElement("div");
  const drafts = hpcDrafts.get(task.id) ?? {}; hpcDrafts.set(task.id, drafts);
  let ledger = hpcSnapshots.get(task.id), busy = false;
  const node = (tag: string, text: string) => { const e = document.createElement(tag); e.textContent = text; return e; };
  const button = (label: string, run: () => void) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.onclick = run; return b; };
  const table = (headers: string[], rows: Array<Array<string | HTMLElement>>) => {
    const t = document.createElement("table"), head = document.createElement("thead"), tr = document.createElement("tr"), tbody = document.createElement("tbody");
    headers.forEach(h => tr.append(node("th", h))); head.append(tr);
    rows.forEach(row => { const r = document.createElement("tr"); row.forEach(v => { const d = document.createElement("td"); typeof v === "string" ? d.textContent = v : d.append(v); r.append(d); }); tbody.append(r); });
    t.append(head, tbody); const scroll = document.createElement("div"); scroll.className = "hpc-table-scroll"; scroll.append(t); return scroll;
  };
  const field = (label: string, value: string, change: (value: string) => void, multiline = false) => {
    const l = document.createElement("label"), e = multiline ? document.createElement("textarea") : document.createElement("input");
    l.append(node("span", label), e); e.value = value; e.setAttribute("aria-label", label); e.oninput = () => change(e.value); return l;
  };
  const execute = async (request: unknown) => {
    if (busy) return; busy = true; status.textContent = "確認中…";
    try { await api.hpcAction(task.id, request); ledger = await api.hpcAction(task.id, { action: "snapshot" }); hpcSnapshots.set(task.id, ledger); render(); status.textContent = "更新しました。"; }
    catch (e) { status.textContent = errorMessage(e); }
    finally { busy = false; }
  };
  const stageNames: Record<string, string> = { reference: "CPU基準", replay: "CPU再現", unit: "移行版単体", integration: "統合", mpi: "MPI構成", performance: "性能条件" };
  const inactive = !taskStateIsActive(task.state);
  const render = () => {
    if (!ledger) return;
    body.replaceChildren();
    const units: any[] = ledger.units, jobs: any[] = ledger.jobs, workspaces: any[] = ledger.workspaces;
    body.append(node("h3", `移行単位 ${units.filter(u => u.state === "統合検証済").length}/${units.length} 検証済`));
    body.append(node("p", "コード変更・入力・環境・検証器の変更で合格は無効になります。数値比較の合格と、実機での計算・科学的妥当性は別に確認します。"));
    if (!units.length) body.append(node("p", "主担当が計画時に移行単位と検証ケースを登録します。下の「移行単位を設定」から手動設定もできます。"));
    for (const u of units) {
      const card = document.createElement("details"); card.className = "hpc-unit";
      card.append(node("summary", `${u.id} · ${u.title} — ${u.state}`));
      card.append(node("p", `対象: ${u.files.join(", ")} / 依存: ${u.dependsOn.join(", ") || "なし"}`), node("p", `数値条件の根拠: ${u.policyNote}`));
      card.append(table(["段階・ケース", "許容差（絶対 / 相対）", "状態", "比較結果"], u.cases.map((t: any) => {
        const check = [...u.checks].reverse().find((c: any) => c.caseId === t.id);
        const summary = check?.metrics?.map((m: any) => `${m.variable}: ${m.failures}/${m.count} 不一致、最大絶対差 ${m.maxAbsolute}`).join(" / ") || check?.reason || "未実施";
        return [`${stageNames[t.stage]} · ${t.id}`, `${t.absolute} / ${t.relative}`, check ? check.stale ? "再検証待ち" : check.passed ? "合格" : "不合格" : "未検証", summary];
      })));
      const evidence = document.createElement("details"); evidence.append(node("summary", `証拠と履歴（${u.checks.length}件）`));
      for (const c of [...u.checks].reverse()) evidence.append(node("p", `${c.at} · ${c.caseId}: ${c.stale ? "無効" : c.passed ? "合格" : "不合格"} / 基準 ${c.reference} / 結果 ${c.actual} / 環境 ${c.environment} / 検証器 ${c.verifier}${c.reason ? ` / ${c.reason}` : ""}`));
      card.append(evidence);
      const edit = button("定義を編集…", () => { drafts.unit = structuredClone({ ...u, checks: undefined, state: undefined }); render(); }); edit.disabled = !inactive; card.append(edit); body.append(card);
    }
    body.append(node("h3", "計算ジョブと資源"));
    const used = (key: string) => jobs.reduce((sum, j) => sum + (j.actual ?? j.reserved)[key], 0);
    body.append(node("p", `ジョブ ${jobs.length} / ${ledger.budget.jobs ?? "無指定"}件 · GPU ${used("gpuHours").toFixed(2)} / ${ledger.budget.gpuHours ?? "無指定"}時間 · ノード ${used("nodeHours").toFixed(2)} / ${ledger.budget.nodeHours ?? "無指定"}時間 · 保存量 ${used("storageGB").toFixed(2)} / ${ledger.budget.storageGB ?? "無指定"}GB`));
    body.append(node("p", "未確定のジョブは予約見積もりを計上します。これは投入時の予算管理で、実機の強制停止や物理的な容量制限ではありません。"));
    body.append(table(["ジョブ", "状態", "投入 / 更新", "記録と復旧"], jobs.map(j => {
      const details = document.createElement("details"); details.append(node("summary", "コマンド・観測記録"), node("pre", `投入: ${j.submit}\n照合: ${j.probe}\n出力先: ${j.outputDirectory}\n${j.observations.map((o: any) => `${o.at}\n${o.output}\n${o.error ?? ""}`).join("\n")}`));
      const actions = document.createElement("div"); actions.append(button("状態を照合", () => { void execute({ action: "probe-job", jobId: j.id }); }), details);
      return [`${j.label} · ${j.schedulerId ?? "ID未確定"}`, ({ unknown: "不明・要照合", queued: "待機", running: "実行中", succeeded: "終了（計算成功）", failed: "計算失敗" } as Record<string,string>)[j.state], `${j.createdAt}\n${j.updatedAt}`, actions];
    })));
    const budgetPanel = document.createElement("details"); budgetPanel.append(node("summary", "計算資源の予算を設定"));
    const budgetForm = document.createElement("div"); budgetForm.className = "hpc-form";
    const labels: Record<string, string> = { jobs: "最大投入ジョブ数", gpuHours: "GPU時間の上限", nodeHours: "ノード時間の上限", storageGB: "保存量の上限（GB）" };
    for (const [key, label] of Object.entries(labels)) budgetForm.append(field(label, drafts.budget?.[key] ?? String(ledger.budget[key] ?? ""), v => { drafts.budget ??= Object.fromEntries(Object.keys(labels).map(k => [k, String(ledger.budget[k] ?? "")])); drafts.budget[key] = v; }));
    budgetForm.append(node("p", "空欄は無指定。上限を下げても、投入済みのジョブを強制終了しません。"), button("資源予算を保存", () => {
      const budget = Object.fromEntries(Object.keys(labels).map(k => [k, (drafts.budget?.[k] ?? String(ledger.budget[k] ?? "")).trim()]).filter(([,v]) => v !== "").map(([k,v]) => [k, Number(v)]));
      void execute({ action: "budget", revision: ledger.revision, budget });
    })); budgetPanel.append(budgetForm); body.append(budgetPanel);
    body.append(node("h3", "分離作業場所"));
    body.append(table(["担当工程", "状態・対象", "場所・操作"], workspaces.map(w => {
      const actions = document.createElement("div"); actions.append(node("p", w.path));
      const unit = task.workUnits.find(u => u.id === w.id);
      if (unit) actions.append(button("担当ターミナルへ", () => {
        const run = [...task.runs].reverse().find(r=>r.workUnitId === unit.id);
        if (run) { state.selectedTerminalAgents.set(task.id,run.agentId); terminalRunSelections.set(terminalKey(task.id,run.agentId),run.id); terminalTiledTasks.delete(task.id); }
        state.selectedTaskPanels.set(task.id, "execution"); renderDetail();
      }));
      actions.append(button("差分を表示", () => { void (async () => { try { const result = await api.hpcAction(task.id,{action:"workspace-diff",id:w.id}); const details = document.createElement("details"); details.open=true; details.append(node("summary", result.truncated ? "差分（先頭のみ）" : "差分"),node("pre",result.diff || "変更なし")); actions.append(details); } catch(e) {status.textContent=errorMessage(e);} })(); }));
      if (["active", "preparing"].includes(w.state)) { const release = button("成果を保持して割当解除…", () => { if (confirm("作業場所のファイルは削除せず、統合対象とファイル割当てから外します。よろしいですか？")) void execute({ action: "workspace-release", id: w.id }); }); release.disabled = !inactive; actions.append(release); }
      return [unit?.title ?? w.id, `${w.state} · ${w.files.join(", ")} · 単体検証 ${w.checks?.filter((c: any) => c.stage === "unit" && c.passed).length ?? 0}件`, actions];
    })));
    const editor = document.createElement("details"); editor.open = !!drafts.unit; editor.append(node("summary", "移行単位を設定（詳細）"));
    const blank = { id: "", title: "", files: [], dependsOn: [], policyNote: "", cases: ["reference", "replay", "unit", "integration"].map(s => ({ id: s, stage: s, absolute: 0, relative: 0 })) };
    const v = drafts.unit ?? blank;
    const form = document.createElement("div"); form.className = "hpc-form";
    const set = (k: string, value: unknown) => { drafts.unit ??= structuredClone(v); drafts.unit[k] = value; };
    for (const [key, label] of [["id", "単位ID"], ["title", "単位名"], ["policyNote", "許容差の根拠（承認ゴールとの対応）"]]) form.append(field(label, v[key], value => set(key, value)));
    form.append(field("対象ファイル（相対パス、1行1件）", v.files.join("\n"), value => set("files", value.split("\n").map(s => s.trim()).filter(Boolean)), true));
    form.append(field("依存単位ID（カンマ区切り）", v.dependsOn.join(","), value => set("dependsOn", value.split(",").map(s => s.trim()).filter(Boolean))));
    v.cases.forEach((c: any, i: number) => {
      const row = document.createElement("div"); row.className = "hpc-case-form";
      const setCase = (key: string, value: unknown) => { drafts.unit ??= structuredClone(v); drafts.unit.cases[i][key] = value; };
      row.append(field(`ケースID ${i+1}`, c.id, value => setCase("id", value)));
      const select = document.createElement("select"); select.setAttribute("aria-label", `検証段階 ${i+1}`);
      for (const [key,label] of Object.entries(stageNames)) { const option = document.createElement("option"); option.value=key; option.textContent=label; select.append(option); }
      select.value=c.stage; select.onchange=()=>setCase("stage",select.value);
      row.append(select, field(`絶対許容差 ${i+1}`, String(c.absolute), value => setCase("absolute", Number(value))), field(`相対許容差 ${i+1}`, String(c.relative), value => setCase("relative", Number(value))), button("ケースを削除",()=>{drafts.unit ??= structuredClone(v);drafts.unit.cases.splice(i,1);render();})); form.append(row);
    });
    form.append(button("検証ケースを追加", () => { drafts.unit ??= structuredClone(v); drafts.unit.cases.push({ id: `case_${v.cases.length+1}`, stage: "mpi", absolute: 0, relative: 0 }); render(); }));
    const save = button("単位定義を保存", () => { void execute({ action: "define", revision: ledger.revision, unit: drafts.unit ?? v }); }); save.disabled=!inactive;
    form.append(node("p", "既存単位の変更は過去の合格を無効化します。許容差を通過目的で緩めず、承認済みの科学的条件に合わせてください。0は完全一致です。"), save, button("編集を閉じる", () => { delete drafts.unit; render(); }));
    editor.append(form); body.append(editor);
  };
  controls.append(button("最新の検証状態を確認", () => { void execute({ action: "snapshot" }); }));
  const recovery = button("台帳ロックを復旧…", () => { if (confirm("終了したプロセスの台帳ロックだけを解除します。ジョブや作業ファイルは削除しません。よろしいですか？")) void execute({action:"recover-lock"}); }); recovery.disabled = !inactive; controls.append(recovery);
  root.append(controls, status, body); if (ledger) render();
  // A refreshed task reopens this view with preserved form drafts. Manual refresh
  // avoids repeatedly hashing large HPC evidence while the user is typing.
  void execute({ action: "snapshot" });
  return root;
}
