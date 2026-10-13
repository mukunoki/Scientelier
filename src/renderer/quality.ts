interface QualityViewCheck {
  id:string;stage:string;title:string;guidance:string;required:boolean;stale?:boolean;
  plan?:{method:string;procedure:string;targets:string[];dependsOn:string[]};
  result?:{status:string;detail:string;at:string;files:Record<string,string>;repairOwner?:string};
}
interface QualityViewSnapshot {
  domains:Array<{domain:"work"|"report";error?:string;snapshot?:{checks:QualityViewCheck[];blockers:Array<{id:string;reason:string;owner:string}>}}>;
  external:Array<{title:string;blockers:string[]}>;reviewState:string;
}

// Evidence is untrusted text. No agent-authored HTML or file path is executed.
function buildQualityView(task:TaskRecord):HTMLElement {
  const root=document.createElement("section");root.className="hpc-view";
  const node=(tag:string,text:string)=>{const e=document.createElement(tag);e.textContent=text;return e;};
  const controls=document.createElement("div");controls.className="research-actions";
  const refresh=document.createElement("button");refresh.className="secondary-button";refresh.textContent="証拠を再確認";
  const all=document.createElement("input");all.type="checkbox";
  const label=document.createElement("label");label.append(all,document.createTextNode("合格済みも表示"));controls.append(refresh,label);
  const status=node("p","");status.setAttribute("role","status");const body=document.createElement("div");
  let value:QualityViewSnapshot|undefined;
  const render=()=>{
    body.replaceChildren();if(!value)return;
    const count=value.domains.reduce((n,d)=>n+(d.snapshot?.blockers.length??0),0);
    const unavailable=value.domains.filter(d=>d.error).length;
    status.textContent=`必須検査の未確認・不合格 ${count}件${unavailable?` / 未取得 ${unavailable}領域`:""}。台帳の合格と、独立レビューによるゴール達成は別判定です。`;
    for(const domain of value.domains){
      const section=document.createElement("section");section.append(node("h3",domain.domain==="work"?"実作業の検証":"文書・PDFの検証"));
      const recover=document.createElement("button");recover.className="secondary-button";recover.textContent="停止後のロック復旧";
      recover.onclick=()=>{void(async()=>{try{await api.qualityRecover(task.id,domain.domain);await load();}catch(e){status.textContent=errorMessage(e);}})();};
      if(domain.error)section.append(node("p",domain.error),recover);
      else {
        const checks=domain.snapshot!.checks.filter(c=>all.checked||c.stale||!c.result||!["pass","not-applicable"].includes(c.result.status));
        if(!checks.length)section.append(node("p","未確認・不合格の検査はありません。合格済みの内容は上のチェックで表示できます。"));
        const states:Record<string,string>={pass:"合格",fail:"不合格",unverified:"未確認","not-applicable":"条件付き対象外"};
        for(const c of checks){const d=document.createElement("details");d.className="quality-check";
          const blocker=domain.snapshot!.blockers.find(b=>b.id===c.id);
          d.append(node("summary",`${c.required?"必須":"任意"} · ${c.title} · ${c.stale?"変更あり・再検証":c.result?states[c.result.status]:"未確認"}`));
          d.append(node("p",`担当: ${(blocker?.owner??(domain.domain==="work"?"worker":"reporter"))==="worker"?"実作業担当":"レポーター"} / 工程: ${c.stage}`),node("p",c.guidance));
          if(c.plan)d.append(node("p",`検査方法: ${c.plan.method==="script"?"スクリプト":"意味・内容の確認"} / ${c.plan.procedure}`),node("p",`対象: ${c.plan.targets.join(" / ")}`),node("p",`前提: ${c.plan.dependsOn.join(" / ")||"なし"}`));
          if(c.result)d.append(node("p",c.result.detail),node("p",`記録: ${c.result.at}`),node("p",`証拠: ${Object.keys(c.result.files).join(" / ")}`));section.append(d);
        }
      }body.append(section);
    }
    for(const external of value.external)body.append(node("h3",`${external.title}（既存台帳を参照）`),node("p",external.blockers.length?external.blockers.join(" / "):"既存台帳の条件を確認済み。二重登録は不要です。"));
  };
  const load=async()=>{refresh.disabled=true;status.textContent="証拠と変更の影響を確認中…";try{value=await api.qualitySnapshot(task.id);render();}catch(e){status.textContent=errorMessage(e);}finally{refresh.disabled=false;}};
  refresh.onclick=()=>{void load();};all.onchange=render;root.append(controls,status,body);void load();return root;
}
