// Read-only view: model-authored strings are always text, never HTML.
function buildResearchView(task: TaskRecord): HTMLElement {
  const root=document.createElement("section"); root.className="hpc-view";
  const status=document.createElement("p"), body=document.createElement("div"), refresh=document.createElement("button");
  status.setAttribute("role","status"); refresh.textContent="証拠を再確認"; refresh.className="secondary-button";
  const node=(tag:string,value:string)=>{const e=document.createElement(tag);e.textContent=value;return e;};
  const load=async()=>{
    refresh.disabled=true; status.textContent="研究の記録と証拠ファイルを確認中…";
    try {
      const ledger=await api.researchSnapshot(task.id); body.replaceChildren();
      status.textContent=ledger.blockers.length ? ledger.blockers.join(" / ") : "記録・数値比較・独立批評の条件を確認済み。科学的妥当性は最終レビューでも検証します。";
      body.append(node("p",`評価条件 ${ledger.protocol ? "固定済み" : "未登録"} · 候補 ${ledger.candidates.length}件 · 実験 ${ledger.experiments.length}/${ledger.protocol?.maxExperiments ?? "未設定"}件 · 採用 ${ledger.selected ?? "未選定"}`));
      if(ledger.conclusion) body.append(node("p",`改善を確認できなかった結果の総括: ${ledger.conclusion.reason}`));
      body.append(node("p","小規模評価 → 別CLIの批評 → 全体評価 → 要素比較 → 論文・独立レビュー。実測の改善とAIの評価は、学会採択や科学的正しさの保証ではありません。"));
      if(ledger.protocol){const p=document.createElement("details");p.append(node("summary","固定した評価条件"),node("p",ledger.protocol.question));for(const m of ledger.protocol.metrics)p.append(node("p",`${m.id} · ${m.direction==="min"?"小さいほど良い":"大きいほど良い"} · 許容差 ${m.tolerance} · ${m.subset?"小規模評価にも使用":"全体評価"}`));body.append(p);}
      for(const h of ledger.candidates){const d=document.createElement("details");d.append(node("summary",`${h.id}${h.parent?` ← ${h.parent}`:""} · ${h.hypothesis}`),node("p",`解決対象: ${h.limitation}`),node("p",`新規性の仮説: ${h.novelty}`),node("p",`反証条件: ${h.falsifier}`),node("p",h.sources.join("\n")));body.append(d);}
      const stages:Record<string,string>={"baseline-subset":"小規模基準","baseline-full":"全体基準",subset:"小規模評価",full:"全体評価",ablation:"要素比較",rebuttal:"査読対応実験"};
      const decisions:Record<string,string>={advance:"数値改善あり",refine:"改善未確認",analysis:"分析用",baseline:"基準"};
      const verdicts:Record<string,string>={accept:"批評合格",refine:"批評：再検討",reject:"批評：棄却"};
      for(const e of [...ledger.experiments].reverse()){
        const d=document.createElement("details");
        d.append(node("summary",`${e.id} · ${stages[e.stage]} · ${e.stale?"証拠変更・再確認必要":decisions[e.decision]} · ${e.critique?verdicts[e.critique.verdict]:"未批評"}`),node("p",e.purpose),node("p",Object.entries(e.metrics).map(([k,v])=>`${k}: ${v}`).join(" / ")),node("p",`証拠: ${Object.keys(e.files).join("\n")}`));
        if(e.critique)d.append(node("p",`${e.critique.cli}: ${e.critique.reason}`));body.append(d);
      }
    } catch(e){status.textContent=errorMessage(e);} finally{refresh.disabled=false;}
  };
  const recover=document.createElement("button");recover.textContent="台帳ロックを復旧";recover.className="secondary-button";
  recover.onclick=()=>{void(async()=>{try{await api.researchRecover(task.id);await load();}catch(e){status.textContent=errorMessage(e);}})();};
  const actions=document.createElement("div");actions.className="research-actions";actions.append(refresh,recover);
  refresh.onclick=()=>{void load();};root.append(actions,status,body);void load();return root;
}
