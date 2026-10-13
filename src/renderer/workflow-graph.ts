// Rendering only. Edges come from saved dependencies, bars from observed runs;
// neither a planned branch nor a completed CLI implies scientific acceptance.
const workflowViews = new Map<string,"graph"|"timeline">();
const workflowScopes = new Map<string,"task"|"round">();
const workflowScroll = new Map<string,[number,number]>();
function workflowUnitDetail(task:TaskRecord,unit:WorkUnit,historical=false):void {
  const dialog=document.createElement("dialog");dialog.className="restart-dialog workflow-unit-dialog";
  dialog.setAttribute("aria-label",workUnitTitle(unit));
  const title=document.createElement("h3");title.textContent=workUnitTitle(unit);
  const status=document.createElement("p");status.textContent=historical?historyUnitLabel(unit,true):unitStatusLabel(task,unit);
  const detail=historyReportBody((historical?historicalRemainingWork(unit):unfinishedWorkExplanation(task,unit))||unit.error||unit.instructions||"指示はありません。");
  const close=progressButton("閉じる",()=>dialog.close());
  dialog.append(title,status,detail);
  if (unit.subtask?.comparison) {
    const contract=document.createElement("p");
    const c=unit.subtask.comparison;
    contract.textContent=`独立比較案：${unit.subtask.requirements?.independenceGroup} · ${c.approach}\n共通入力：${c.input}\n評価・採否基準：${c.evaluation}`;
    contract.style.whiteSpace="pre-wrap";dialog.append(contract);
  }
  const run=[...task.runs].reverse().find(r=>r.workUnitId===unit.id);
  if(run)dialog.append(progressButton("担当の端末を開く",()=>{
    state.selectedTerminalAgents.set(task.id,run.agentId);terminalRunSelections.set(`${task.id}:${run.agentId}`,run.id);
    dialog.close();openTaskPanel(task,"execution");
  }));
  dialog.append(close);dialog.addEventListener("close",()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}
/** Latest snapshot per earlier round; never manufacture edges across plans.
 * Current units win over interrupted snapshots of the SAME resumed round. */
function workflowRounds(task:TaskRecord):Array<{number:number;units:WorkUnit[];historical:boolean}> {
  const rounds=new Map<number,TaskRound>();
  for(const r of [...(task.interruptedHistory??[]),...(task.history??[])].sort((a,b)=>a.finishedAt.localeCompare(b.finishedAt)))
    if(r.number<(task.roundNumber??1))rounds.set(r.number,r);
  return [...rounds.values()].sort((a,b)=>a.number-b.number).map(r=>({number:r.number,units:r.workUnits,historical:true}))
    .concat([{number:task.roundNumber??1,units:task.workUnits,historical:false}]);
}
function buildWorkflowVisualization(task:TaskRecord):HTMLElement {
  const section=document.createElement("div");section.className="workflow-visualization";
  const rounds=workflowRounds(task),hasHistory=rounds.length>1;
  const scope=hasHistory?(workflowScopes.get(task.id)??"task"):"round";
  const m=scope==="task"?task.workflowMetrics??task.executionMetrics:task.executionMetrics;
  const stats=document.createElement("p");stats.className="workflow-statistics";
  stats.textContent=m?`実作業 ${m.currentParallel??0} / 上限${task.execution?.maxParallel??1}並列 · 最大実績 ${m.peakParallel??0} · 並列稼働 ${executionDuration(m.parallelMs??0)} · 起動・指示待ち ${executionDuration(m.startupMs??0)}${m.waitingRuns?`（現在${m.waitingRuns}担当）`:""}${m.unknownMs?` · 時間区分不明 ${executionDuration(m.unknownMs)}`:""}`:"並列実績は未取得";
  stats.title="並列稼働＝2担当以上が同時に作業した時間。起動・指示待ちは他担当が実作業中の時間を除いた値です。指示取得後のCLI内部の承認待ちは、検出できない場合があります。";
  const outlook=task.timeOutlook;
  if(outlook?.targetMinutes){
    const time=document.createElement("p");time.className="workflow-time-outlook";
    time.textContent=`目安 ${outlook.targetMinutes}分 · 実作業 ${outlook.elapsedMinutes.toFixed(1)}分 · ${task.workUnits.some(u=>["pending","running"].includes(u.state))?`終了見込み ${outlook.unknownUnits?"少なくとも ":"約"}${outlook.projectedMinutes.toFixed(1)}分${outlook.unknownUnits?`（未見積り・超過 ${outlook.unknownUnits}工程）`:""}`:"今回の作業は終了"}`;
    time.title="PDF・レビューを含む、依存関係と同時実行上限からの概算。未見積りや未知の後続作業を0分とはみなしません。";
    section.append(time);
  }
  section.append(stats);
  const controls=document.createElement("div");controls.className="workflow-view-switch";controls.setAttribute("aria-label","工程の表示形式");
  const mode=workflowViews.get(task.id)??"graph";
  if(hasHistory){
    const select=document.createElement("select");select.setAttribute("aria-label","表示する作業範囲");
    select.append(new Option("タスク全体（過去の工程を含む）","task"),new Option("今回の作業のみ","round"));select.value=scope;
    select.onchange=()=>{workflowScopes.set(task.id,select.value as "task"|"round");renderDetail();};controls.append(select);
  }
  for(const [id,label] of [["graph","依存グラフ"],["timeline","実績タイムライン"]] as const){
    const button=progressButton(label,()=>{workflowViews.set(task.id,id);renderDetail();});button.setAttribute("aria-pressed",String(id===mode));controls.append(button);
  }
  const legend=document.createElement("span");legend.textContent=mode==="graph"?"矢印＝前提作業（分岐は同時実行の実績ではありません）":"横軸＝実時刻 · 色付き＝実作業 · 斜線＝起動待ち · 灰色＝区分不明";
  controls.append(legend);section.append(controls);
  const viewport=document.createElement("div");viewport.className="workflow-viewport";viewport.tabIndex=0;viewport.setAttribute("aria-label",mode==="graph"?"工程の依存関係":"実行時刻と並列稼働");
  const key=`${task.id}:${mode}:${scope}`;
  viewport.addEventListener("scroll",()=>workflowScroll.set(key,[viewport.scrollLeft,viewport.scrollTop]));
  if(mode==="graph") {
    if(scope==="task")for(const round of rounds){
      const group=document.createElement("section");group.className="workflow-round";
      const heading=document.createElement("h4");heading.textContent=`${historyInstructionLabel(round.number)} · ${round.historical?"保存済みの計画（現在の待機列ではありません）":"現在の計画"}`;
      group.append(heading);buildDependencyGraph(task,group,round.units,round.historical);viewport.append(group);
    } else buildDependencyGraph(task,viewport);
  } else buildRunTimeline(task,viewport,m?.intervals,rounds,scope==="task");
  section.append(viewport);
  requestAnimationFrame(()=>{const p=workflowScroll.get(key);if(viewport.isConnected&&p){viewport.scrollLeft=p[0];viewport.scrollTop=p[1];}});
  return section;
}
function buildDependencyGraph(task:TaskRecord,viewport:HTMLElement,units=task.workUnits,historical=false):void {
  if(!units.length){viewport.textContent="計画はまだありません。";return;}
  const levels=new Map<string,number>();
  for(let pass=0;pass<units.length;pass++)for(const u of units){
    if(levels.has(u.id))continue;
    const peers=u.dependsOn.filter(id=>units.some(p=>p.id===id));
    if(peers.every(id=>levels.has(id)))levels.set(u.id,peers.length?1+Math.max(...peers.map(id=>levels.get(id)!)):0);
  }
  const rows=new Map<number,number>(),positions=new Map<string,{x:number;y:number}>();
  units.forEach(u=>{const level=levels.get(u.id)??0;const row=rows.get(level)??0;rows.set(level,row+1);positions.set(u.id,{x:level*252+8,y:row*124+8});});
  const width=(Math.max(...levels.values(),0)+1)*252,height=Math.max(...rows.values(),1)*124;
  const canvas=document.createElement("div");canvas.className="workflow-graph-canvas";canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
  const ns="http://www.w3.org/2000/svg",svg=document.createElementNS(ns,"svg");svg.setAttribute("width",String(width));svg.setAttribute("height",String(height));svg.setAttribute("aria-hidden","true");
  for(const u of units)for(const dep of u.dependsOn){
    const from=positions.get(dep),to=positions.get(u.id);if(!from||!to)continue;
    const x=from.x+212,y=from.y+50,endX=to.x-4,endY=to.y+50;
    const path=document.createElementNS(ns,"path");path.setAttribute("d",`M${x},${y} C${x+20},${y} ${endX-20},${endY} ${endX},${endY} M${endX-5},${endY-4} L${endX},${endY} L${endX-5},${endY+4}`);svg.append(path);
  }
  canvas.append(svg);
  for(const u of units){
    const pos=positions.get(u.id)!;const node=progressButton("",()=>workflowUnitDetail(task,u,historical));
    const outcome=reportedWorkOutcome(u);node.className=`workflow-node ${historical?"archived":u.state}${!historical&&outcome&&outcome.status!=="ready"?" needs-work":""}`;
    node.style.left=`${pos.x}px`;node.style.top=`${pos.y}px`;
    const title=document.createElement("strong");title.textContent=workUnitTitle(u);
    const who=document.createElement("span");who.textContent=(u.assignedAgentId?agentLabel(u.assignedAgentId):"担当未定")+(u.subtask?.comparison?` · 比較案 ${u.subtask.key}`:"")+(u.subtask?.inputScope==="assignment"?" · 入力から独立検討":u.subtask?.allowTaskOnlyPeers?" · 独立検討と並行可能":"");
    const status=document.createElement("span");status.textContent=historical?historyUnitLabel(u,true):unitStatusLabel(task,u);
    node.title=`${title.textContent}\n${who.textContent} · ${status.textContent}\n前提：${u.dependsOn.map(id=>units.find(p=>p.id===id)?.title??"過去の工程").join("、")||"なし"}`;
    node.append(title,who,status);canvas.append(node);
  }
  viewport.append(canvas);
}
function buildRunTimeline(task:TaskRecord,viewport:HTMLElement,intervals=task.executionMetrics?.intervals??[],rounds=workflowRounds(task),allRounds=false):void {
  if(!intervals.length){viewport.textContent="実行記録はまだありません。";return;}
  const start=Math.min(...intervals.map(i=>i.start)),end=Math.max(...intervals.map(i=>i.end)),duration=Math.max(1,end-start);
  const canvas=document.createElement("div");canvas.className="workflow-timeline";
  const axis=document.createElement("div");axis.className="timeline-axis";
  for(let i=0;i<=4;i++){const tick=document.createElement("span");tick.textContent=new Date(start+duration*i/4).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});tick.style.left=`${i*25}%`;axis.append(tick);}canvas.append(axis);
  for(const interval of intervals){
    const run=task.runs.find(r=>r.id===interval.runId);if(!run)continue;
    const round=rounds.find(r=>r.units.some(u=>u.id===run.workUnitId));
    const unit=round?.units.find(u=>u.id===run.workUnitId)??task.retiredWorkUnits?.find(u=>u.id===run.workUnitId)??task.autonomyHistory?.flatMap(h=>h.workUnits).find(u=>u.id===run.workUnitId);
    const row=document.createElement("div");row.className="timeline-row";
    const label=progressButton(`${allRounds&&round?`${historyInstructionLabel(round.number)} · `:""}${agentLabel(run.agentId)} · ${unit?workUnitTitle(unit):historyRoleLabels[run.role]}`,()=>{if(unit)workflowUnitDetail(task,unit,round?.historical);});label.className="timeline-label";label.title=label.textContent!;
    const track=document.createElement("div");track.className="timeline-track";
    const segment=(a:number,b:number,kind:string,label:string)=>{if(b<=a)return;const bar=document.createElement("span");bar.className=`timeline-segment ${kind}`;bar.style.left=`${100*(a-start)/duration}%`;bar.style.width=`${100*(b-a)/duration}%`;bar.title=`${label} ${executionDuration(b-a)} · ${new Date(a).toLocaleTimeString("ja-JP")}–${new Date(b).toLocaleTimeString("ja-JP")}`;bar.setAttribute("aria-label",bar.title);track.append(bar);};
    segment(interval.start,interval.workStart,"waiting","起動・指示待ち");
    segment(interval.workStart,interval.end,interval.uncertain?"unknown":run.state==="running"?"running":"work",interval.uncertain?"時間区分不明":"実作業");
    row.append(label,track);canvas.append(row);
  }
  viewport.append(canvas);
}
