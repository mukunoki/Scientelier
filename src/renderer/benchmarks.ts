let benchmarkSnapshot: BenchmarkSnapshot | undefined;
const benchmarkLabelRequests = new WeakMap<HTMLElement,number>();
const benchmarkNumber = (value?:number) => value === undefined ? "—" : value.toLocaleString(undefined,{maximumFractionDigits:1});

/** Resolve in the main process: UI and routing must never disagree on a match. */
async function updateBenchmarkLabel(label:HTMLElement, model:string):Promise<void> {
  label.dataset.benchmarkModel=model;
  label.removeAttribute("title");
  const revision=(benchmarkLabelRequests.get(label)??0)+1;
  benchmarkLabelRequests.set(label,revision);
  if(!benchmarkSnapshot?.models.length) { label.textContent=""; return; }
  label.textContent="能力データを照合中…";
  try {
    const match=await api.inspectBenchmark(model);
    if(benchmarkLabelRequests.get(label)!==revision)return;
    const messages={missing:"能力データ未取得",stale:"データ期限切れ · 再取得が必要",default:"CLI既定・別名のため未照合",unmatched:"版・評価設定が一致するデータなし",matched:"照合済み"};
    const record=match.record, reference=record?.reference;
    const value=(metric:"intelligence"|"coding"|"agentic"|"tokensPerSecond")=>{
      const range=reference?.ranges[metric];
      return range && range[0]!==range[1] ? `${benchmarkNumber(range[0])}–${benchmarkNumber(range[1])}` : benchmarkNumber(record?.[metric]);
    };
    label.textContent=record ? `${reference ? `参考 · ${reference.model}${reference.kind==="alias"?"（別名・最新掲載版）":"（評価条件別）"}：` : ""}総合 ${value("intelligence")} · 実装 ${value("coding")} · 自律実行 ${value("agentic")} · ${value("tokensPerSecond")} tokens/s${match.enabled?"":"（割り当てへの反映はOFF）"}` : messages[match.status];
    label.title=record ? `${record.name} · Artificial Analysis · ${benchmarkSnapshot?.fetchedAt?.slice(0,10)??"取得日不明"}${reference ? `\n${reference.note}\n${reference.evaluationIds.length}評価の範囲を表示。自動割り当ては測定値の中央値を低い重みで参考にします。\n評価ID：${reference.evaluationIds.join(", ")}` : ""}` : "CLIで使えるモデルIDはそのままにしてください。ベンチマークの評価名をCLIモデルIDとして入力しないでください。";
  } catch { if(benchmarkLabelRequests.get(label)===revision)label.textContent="能力データの照合に失敗（作業は継続できます）"; }
}
function updateBenchmarkLabels():void {
  for(const label of document.querySelectorAll<HTMLElement>("[data-benchmark-model]")) void updateBenchmarkLabel(label,label.dataset.benchmarkModel!);
}

function initializeBenchmarkSettings():void {
  const panel=document.createElement("details"); panel.id="settings-benchmarks";panel.className="settings-section";
  const summary=document.createElement("summary");summary.textContent="モデル能力 · ベンチマーク";
  const body=document.createElement("div");body.className="benchmark-settings";
  const intro=document.createElement("p");intro.textContent="モデルの得意分野と速度を比較し、計画・担当割り当ての参考にします。使用枠や固定担当、独立レビューの条件が優先されます。";
  const form=document.createElement("form"); form.className="benchmark-controls";
  const enabled=document.createElement("input");enabled.type="checkbox";enabled.id="benchmark-enabled";
  const toggle=document.createElement("label");toggle.className="checkbox-label";toggle.append(enabled,"能力情報を自動割り当てに使う");
  const key=document.createElement("input");key.type="password";key.autocomplete="off";key.id="benchmark-key";key.placeholder="未登録";key.setAttribute("aria-label","Artificial Analysis APIキー");
  const keyLabel=document.createElement("label");keyLabel.className="benchmark-key-field";keyLabel.append("Artificial Analysis APIキー",key);
  const source=document.createElement("a");source.href="https://artificialanalysis.ai/data-api";source.target="_blank";source.rel="noreferrer";source.textContent="APIキーを取得 · Artificial Analysis";
  const save=document.createElement("button");save.type="submit";save.className="primary-button compact";save.textContent="保存して取得";
  const refresh=document.createElement("button");refresh.type="button";refresh.className="secondary-button compact";refresh.textContent="データを更新";
  const remove=document.createElement("button");remove.type="button";remove.className="secondary-button compact";remove.textContent="キーを削除…";
  const cancel=document.createElement("button");cancel.type="button";cancel.className="secondary-button compact";cancel.textContent="編集を取り消す";
  const actions=document.createElement("div");actions.className="benchmark-actions";actions.append(save,refresh,remove,cancel);
  const status=document.createElement("p");status.setAttribute("role","status");status.id="benchmark-status";
  const error=document.createElement("p");error.className="form-error";error.setAttribute("role","alert");
  const guidance=document.createElement("p");guidance.className="benchmark-guidance";
  const chosen=document.createElement("div");chosen.className="benchmark-list";
  const heading=document.createElement("h3");heading.textContent="取得済みモデルの比較";
  const search=document.createElement("input");search.type="search";search.placeholder="モデル名で検索";search.setAttribute("aria-label","ベンチマークのモデルを検索");
  const sort=document.createElement("select");sort.setAttribute("aria-label","モデル能力の並べ替え");
  for(const [value,label] of [["name","モデル名順"],["intelligence","総合が高い順"],["coding","実装が高い順"],["agentic","自律実行が高い順"],["tokensPerSecond","速度が速い順"]])sort.add(new Option(label,value));
  const filters=document.createElement("div");filters.className="benchmark-filters";filters.append(search,sort);
  const count=document.createElement("p");
  const table=document.createElement("table");table.className="benchmark-table";
  const thead=table.createTHead(), header=thead.insertRow();
  for(const title of ["評価されたモデル","総合","実装","自律実行","速度 tokens/s"]){const th=document.createElement("th");th.scope="col";th.textContent=title;header.append(th);}
  const tbody=table.createTBody();
  const scroll=document.createElement("div");scroll.className="benchmark-table-scroll";scroll.tabIndex=0;scroll.setAttribute("aria-label","モデル能力比較表");scroll.append(table);
  const comparison=document.createElement("section");comparison.append(heading,filters,count,scroll);
  const limits=document.createElement("p");limits.className="benchmark-footnote";limits.textContent="出典：Artificial Analysis · — は未測定。異なる指標同士の点数は比較できません。";
  const help=document.createElement("button");help.type="button";help.className="secondary-button compact";help.textContent="指標の読み方";
  const helpSection=document.createElement("section"),helpTitle=document.createElement("h3"),helpText=document.createElement("p");
  helpTitle.textContent="モデル能力の参考指標";
  helpText.textContent="総合は推論の参考、実装はコーディング、自律実行はエージェント評価の指標です。速度はAPIの測定値で、CLI実測や契約残量ではありません。同一モデルに推論設定などが異なる評価がある場合は範囲を表示し、割り当ては各指標の測定値の中央値を半分の重みで参考にします。Claudeのfable・opus・sonnet・haikuは取得データ内のシリーズ最新掲載版を参考表示します。実際のCLIの版は未確認なので、割り当ての重みは4分の1です。未測定値は補いません。専門分野・日本語執筆・レビュー精度の保証ではありません。1日ごとに更新し、7日を超えたデータは割り当てに使用しません。未照合・未測定は能力ゼロではなく加点なしです。固定担当・使用枠・独立レビューの条件を優先し、わずかな点差では担当を大きく変えません。";
  helpSection.append(helpTitle,helpText);byId("service-settings-help").append(helpSection);
  help.onclick=()=>{byId<HTMLDialogElement>("service-settings-help").showModal();helpSection.scrollIntoView({block:"start"});};
  let dirty=false,busy=false,confirmation=false,editRevision=0,actionError="";
  const drawTable=()=>{
    const all=benchmarkSnapshot?.models??[], query=search.value.trim().toLowerCase();
    const filtered=all.filter(m=>`${m.name} ${m.id}`.toLowerCase().includes(query));
    const field=sort.value as "name"|"intelligence"|"coding"|"agentic"|"tokensPerSecond";
    filtered.sort((a,b)=>field==="name"?a.name.localeCompare(b.name):(b[field]??-Infinity)-(a[field]??-Infinity)||a.name.localeCompare(b.name));
    count.textContent=`${filtered.length}モデル${filtered.length>50?" · 先頭50件を表示（検索で絞り込み）":""}`;
    tbody.replaceChildren();
    for(const model of filtered.slice(0,50)){
      const row=tbody.insertRow();
      for(const value of [model.name,...[model.intelligence,model.coding,model.agentic,model.tokensPerSecond].map(benchmarkNumber)]) row.insertCell().textContent=value;
    }
    comparison.hidden=!all.length;
  };
  const draw=()=>{
    const data=benchmarkSnapshot;
    save.disabled=busy||(!dirty&&!!data?.hasKey)||(!data?.hasKey&&!key.value.trim()&&!data?.models.length);
    refresh.disabled=busy||dirty||!data?.hasKey||!!data?.retryBlocked&&Date.parse(data.retryAt??"")>Date.now();remove.disabled=busy||!data?.hasKey;
    cancel.disabled=busy;cancel.hidden=!dirty&&!confirmation;
    save.textContent=busy?"処理中…":key.value.trim()||!data?.hasKey?"保存して取得":"設定を保存";
    remove.textContent=confirmation?"削除を確定":"キーを削除…";
    cancel.textContent=confirmation?"削除をやめる":"編集を取り消す";
    if(!data) {status.textContent="設定を読み込んでいます…";return;}
    if(!dirty)enabled.checked=data.enabled;
    key.placeholder=data.hasKey?"登録済み · 変更する場合だけ入力":"ここにAPIキーを入力";
    status.textContent=`割り当てへの反映 ${data.enabled?"ON":"OFF"} · キー${data.hasKey?"登録済み":"未登録"} · ${data.models.length}モデル${data.fetchedAt?` · 更新 ${new Date(data.fetchedAt).toLocaleString()} · 指標版 ${data.indexVersion??"不明"}`:" · 未取得"}${dirty?" · 未保存の変更あり":""}`;
    error.textContent=actionError||data.error||"";
    guidance.textContent=confirmation?"キーを削除し、自動更新と割り当てへの反映を停止します。未保存の編集も取り消します。保存済みの比較データは残ります。削除を確定しますか？"
      :!data.hasKey?"1. 上のリンクで無料APIキーを取得 → 2. 入力して「保存して取得」。キーはMac上で暗号化保存し、エージェントには渡しません。"
      :Date.parse(data.retryAt??"")>Date.now()?`${data.retryBlocked?"再試行可能":"自動再試行"}：${new Date(data.retryAt!).toLocaleString()}。${data.retryBlocked?"取得先の待機時間を守ります。":"接続の復旧後は手動でも更新できます。"}既存タスクは止めません。`
      :dirty?"変更はまだ適用されていません。保存するか、編集を取り消してください。"
      :"同一モデルの条件別評価は範囲で表示します。Claudeの別名は最新掲載版の参考値です（実際の版・条件は未確認）。CLIモデルIDの変更は不要です。反映OFFでも比較できます。";
    drawTable();
  };
  const drawChosen=()=>{
    chosen.replaceChildren();
    if(!benchmarkSnapshot?.models.length)return;
    const title=document.createElement("h3");title.textContent="利用するサービスとの照合";chosen.append(title);
    for(const policy of state.orchestrationSettings?.agentPolicies??[]){
      if(policy.agentId==="gemini"||!policy.enabled)continue;
      const row=document.createElement("p"),name=document.createElement("strong"),detail=document.createElement("span");
      name.textContent=`${agentLabel(policy.agentId)} · ${policy.defaultModel||"CLI既定"}`;row.append(name,detail);chosen.append(row);
      void updateBenchmarkLabel(detail,policy.defaultModel??"");
    }
  };
  const receive=(data:BenchmarkSnapshot)=>{benchmarkSnapshot=data;draw();drawChosen();updateBenchmarkLabels();};
  const edit=()=>{dirty=true;editRevision++;confirmation=false;actionError="";draw();};enabled.onchange=edit;key.oninput=edit;
  search.oninput=drawTable;
  sort.onchange=drawTable;
  const action=async(fn:()=>Promise<BenchmarkSnapshot>)=>{
    if(busy)return;
    const focus=document.activeElement;busy=true;actionError="";draw();
    try {receive(await fn());}catch(e){actionError=errorMessage(e);}finally{busy=false;draw();if(document.activeElement===document.body&&focus instanceof HTMLElement&&focus.isConnected)focus.focus();}
  };
  form.onsubmit=event=>{event.preventDefault();void action(async()=>{
    if(enabled.checked&&!key.value.trim()&&!benchmarkSnapshot?.hasKey&&!benchmarkSnapshot?.models.length)throw new Error("先にAPIキーを入力して「保存して取得」を押してください。");
    const revision=editRevision,changedKey=!!key.value.trim(),result=await api.configureBenchmarks({enabled:enabled.checked,apiKey:key.value.trim()||undefined});
    if(revision===editRevision){key.value="";dirty=false;confirmation=false;}
    return changedKey?api.refreshBenchmarks():result;
  });};
  refresh.onclick=()=>void action(()=>api.refreshBenchmarks());
  remove.onclick=()=>{
    if(!confirmation){confirmation=true;draw();return;}
    void action(async()=>{const revision=editRevision,result=await api.configureBenchmarks({enabled:false,clearKey:true});if(revision===editRevision){key.value="";dirty=false;confirmation=false;}return result;});
  };
  cancel.onclick=()=>{if(confirmation){confirmation=false;draw();return;}key.value="";dirty=false;actionError="";draw();};
  form.append(toggle,keyLabel,source,actions);body.append(intro,form,status,error,guidance,chosen,comparison,limits,help);panel.append(summary,body);byId("settings-models").append(panel);
  draw();
  api.onBenchmarksChanged(receive);
  api.onOrchestrationSettingsChanged(value=>{state.orchestrationSettings=value.settings;drawChosen();});
  void api.getBenchmarks().then(receive).catch(e=>{status.textContent=errorMessage(e);});
  window.setInterval(()=>{if(panel.open)draw();},60000);
}
