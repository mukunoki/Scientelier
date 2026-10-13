/** One editor for the actual SKILL.md source, never copies of mode/writing rules. */
function initializeSkillManager(): void {
  const host = document.createElement("details"); host.id="settings-skills"; host.className="settings-section";
  host.innerHTML = `<summary>スキル一覧・編集<span>採用状態・保存版・取得履歴</span></summary>
    <section class="panel skill-manager">
    <p>採用済みのスキルを次の工程から必要時に取得します。試験中・廃止は自動配布しません。取得履歴は適用完了や課金量の証明ではありません。</p>
    <div class="skill-manager-toolbar"><label>保存先<select id="skill-scope" aria-label="スキルの保存先"></select></label><button id="skill-refresh" type="button" class="secondary-button">再読み込み</button><button id="skill-new" type="button" class="secondary-button">新規</button></div>
    <p id="skill-location"></p><p id="skill-message" role="status"></p><p id="skill-error" class="form-error" role="alert"></p>
    <div class="skill-manager-grid"><label>スキル一覧<select id="skill-list" size="9" aria-label="管理するスキル"></select></label>
    <div id="skill-editor"><label>ID<input id="skill-id" maxlength="48" aria-label="スキルID"></label>
    <label>本文・適用条件（nameとdescriptionを含むSKILL.md）<textarea id="skill-content" rows="13" maxlength="12000" spellcheck="false" aria-label="スキル本文"></textarea></label>
    <div class="skill-manager-toolbar"><label>状態<select id="skill-status"><option value="experimental">試験中</option><option value="validated">採用済み</option><option value="retired">廃止</option></select></label><button id="skill-save" class="primary-button" type="button">保存</button><button id="skill-promote" class="secondary-button" type="button">共通へ登録…</button></div>
    <label>検証証拠・試験結果<textarea id="skill-evidence" rows="3" maxlength="8000" aria-label="スキルの検証証拠"></textarea></label>
    <p>本文変更後は試験中へ戻ります。試験後、保存した本文を変えずに証拠を記入して採用済みにしてください。採用は自動認定ではありません。追加スキルは保存先ごとに6件まで採用できます。補助スクリプトの自動実行・コピーは行いません。</p>
    <div class="skill-manager-toolbar"><button id="skill-history" type="button" class="secondary-button">保存版を表示</button><select id="skill-version" aria-label="過去のスキル版"></select><button id="skill-restore" type="button" class="secondary-button">選択版を編集欄へ</button></div>
    </div></div><h3>取得履歴</h3><pre id="skill-usage">保存先を選択してください。</pre>
    <p>執筆ルール・モード別ルール・共通の作業原則は、それぞれの設定項目で直接編集できます。重複保存しません。script-reuse / document-checks / related-researchは実装側の共通ガイダンスで、この画面で無効化する対象ではありません。</p>
    </section>`;
  byId("settings-view").append(host);
  const el = <T extends HTMLElement=HTMLElement>(id:string)=>byId<T>(`skill-${id}`);
  const scope=el<HTMLSelectElement>("scope"), list=el<HTMLSelectElement>("list"), id=el<HTMLInputElement>("id"), body=el<HTMLTextAreaElement>("content"), evidence=el<HTMLTextAreaElement>("evidence"), status=el<HTMLSelectElement>("status"), versions=el<HTMLSelectElement>("version");
  let selectedScope="", selected:ManagedSkill|undefined, catalog:SkillCatalog|undefined, past:ManagedSkill[]=[], busy=false, initialized=false, baseline="", serial=0;
  const draft=()=>JSON.stringify([id.value,body.value,status.value,evidence.value]);
  const dirty=()=>initialized && draft()!==baseline;
  const discard=()=>!dirty() || window.confirm("スキルの未保存の編集を破棄しますか？");
  const controls=()=>{
    for(const name of ["scope","list","refresh","new","history","promote","restore","save"]) (el(name) as HTMLButtonElement).disabled=busy;
    el<HTMLButtonElement>("save").disabled=busy || !initialized;
    el<HTMLButtonElement>("history").disabled=busy || !selected;
    el<HTMLButtonElement>("restore").disabled=busy || !past.length;
    el<HTMLButtonElement>("promote").disabled=busy || !selectedScope || selected?.status!=="validated" || dirty();
    id.disabled=Boolean(selected) || busy;
  };
  const action=async(work:()=>Promise<void>)=>{
    if(busy)return; busy=true; controls(); el("error").textContent="";
    try{await work();}catch(e){el("error").textContent=errorMessage(e);}finally{busy=false;controls();}
  };
  const show=(value?:ManagedSkill)=>{
    selected=value; id.value=value?.id??""; body.value=value?.content??"---\nname: new-skill\ndescription: このスキルを使う作業・条件\n---\n\n# 作業手順\n\n";
    if(!value)id.value="new-skill";
    evidence.value=value?.evidence??""; status.value=value?.status??"experimental";
    initialized=true; baseline=draft(); serial++; past=[]; versions.replaceChildren();
    el("message").textContent=value?`保存版 ${value.revision.slice(0,12)} · ${value.path}`:"新規スキル。IDとnameを一致させてください。";
    controls();
  };
  const options=()=>{
    scope.replaceChildren(new Option("共通スキル（このアプリ内）",""));
    for(const task of state.tasks) scope.add(new Option(`${task.remote?"SSH":"ローカル"} · ${task.title}`,task.id));
    scope.value=selectedScope;
  };
  const renderList=()=>{
    list.replaceChildren(...(catalog?.skills??[]).map(s=>new Option(`${s.id} · ${{experimental:"試験中",validated:"採用済み",retired:"廃止"}[s.status]}${s.builtin?" · 同梱":""}`,s.id)));
    el("location").textContent=catalog?.root??"";
    el("error").textContent=catalog?.errors.join("\n")??"";
    el("usage").textContent=catalog?.history.length?catalog.history.map(s=>`${s.at} · ${s.task}\n${s.id}@${s.revision.slice(0,12)} ×${s.calls} · ${s.bytes} bytes/回`).reverse().join("\n\n"):"取得の記録はありません。未取得を未使用とは断定しません。Antigravityのファイル読み取りは未観測です。";
  };
  const reload=async()=>{const version=serial;catalog=await api.listSkills(selectedScope||undefined);renderList();if(serial===version)show(catalog.skills.find(s=>s.id===selected?.id)??catalog.skills[0]);else el("message").textContent="取得中に入力した編集を保持しています。保存時に版の競合を確認します。";if(selected)list.value=selected.id;};
  scope.onchange=()=>{if(!discard()){scope.value=selectedScope;return;}selectedScope=scope.value;selected=undefined;initialized=false;list.replaceChildren();id.value="";body.value="";evidence.value="";el("location").textContent="";void action(reload);};
  list.onchange=()=>{if(!discard()){list.value=selected?.id??"";return;}show(catalog?.skills.find(s=>s.id===list.value));};
  el("refresh").onclick=()=>{if(discard()){options();void action(reload);}};
  el("new").onclick=()=>{if(discard()){list.value="";show();}};
  for(const input of [id,body,evidence,status]) input.addEventListener("input",()=>{serial++;el("message").textContent="未保存の編集があります。";controls();});
  el("save").onclick=()=>void action(async()=>{
    const version=serial;
    const saved=await api.saveSkill(selectedScope||undefined,{id:id.value,revision:selected?.revision??"",content:body.value,status:status.value as ManagedSkill["status"],evidence:evidence.value});
    catalog=await api.listSkills(selectedScope||undefined); renderList(); selected=saved; list.value=saved.id;
    if(serial===version)show(saved);else{baseline=JSON.stringify([saved.id,saved.content,saved.status,saved.evidence]);el("message").textContent="保存しました。保存中に追加した編集は未保存のまま保持しています。";}
  });
  el("history").onclick=()=>void action(async()=>{if(!selected)return;past=await api.skillHistory(selectedScope||undefined,selected.id);versions.replaceChildren(...past.map((s,i)=>new Option(`${s.updatedAt||"同梱・初期版"} · ${s.revision.slice(0,12)} · ${s.status}`,String(i))));if(!past.length)el("message").textContent="過去の保存版はありません。";});
  el("restore").onclick=()=>{const value=past[Number(versions.value)];if(value && discard()){body.value=value.content;evidence.value=value.evidence;status.value="experimental";serial++;el("message").textContent="過去版を編集欄へ戻しました。保存すると新しい版になります。";controls();}};
  el("promote").onclick=()=>void action(async()=>{if(!selected || dirty())return;const value=await api.promoteSkill(selectedScope,selected.id,selected.revision);if(value)el("message").textContent="共通へ試験中として登録しました。元のスキルは保持しています。共通環境での再試験後に採用してください。";});
  host.addEventListener("toggle",()=>{if(host.open){options();if(!initialized && typeof api.listSkills==="function")void action(reload);}});
  // Retain a recovery draft even if the OS closes the window. No silent restore
  // into a different scope or revision: the user explicitly chooses to recover.
  const recoveryKey="harness-skill-editor-draft";
  let recoveryPending=Boolean(localStorage.getItem(recoveryKey));
  window.addEventListener("beforeunload",()=>{if(dirty())localStorage.setItem(recoveryKey,JSON.stringify({scope:selectedScope,selected,draft:[id.value,body.value,status.value,evidence.value]}));else if(!recoveryPending)localStorage.removeItem(recoveryKey);});
  options();controls();
  const recovery=localStorage.getItem(recoveryKey);
  if(recovery){const restore=document.createElement("button");restore.className="secondary-button";restore.textContent="前回の未保存編集を復元";restore.onclick=()=>{if(!discard())return;try{const v=JSON.parse(recovery);selectedScope=v.scope;options();show(v.selected);[id.value,body.value,status.value,evidence.value]=v.draft;serial++;el("message").textContent="前回の未保存編集です。保存前に保存先・版を確認してください。";controls();recoveryPending=false;restore.remove();}catch(e){el("error").textContent=errorMessage(e);}};el("message").after(restore);}
}
