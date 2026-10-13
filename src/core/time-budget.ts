import type { TaskRecord, WorkUnit, SubtaskSpec } from "./types";
import { executionTime, runInterval } from "./execution-time";
import { effectiveReviewMode } from "./review-timing";
import { concurrentAccessAllowed, packageAccess, workAccess, type WorkAccess } from "./work-concurrency";

/** Coalesced soft-target events, never a timeout or implicit completion. */
export function timeCheckpoint(task:TaskRecord,now=Date.now()):1|2|undefined {
  const target=task.autonomy?.targetMinutes;
  if(!target || target<=0)return;
  const ratio=executionTime(task,now).elapsedMs/60000/target;
  return ratio>=2/3 ? 2 : ratio>=1/3 ? 1 : undefined;
}

type TimedNode = WorkAccess & { key:string; dependsOn:string[]; minutes?:number };
function estimateKind(unit: WorkUnit): string {
  return unit.subtask?.kind ?? (unit.primary ? "integration" : unit.role);
}
/** Calibrate comparable work from observed CLI-active time, not an agent's
 * claimed duration, startup/trust waits or cumulative round wall time. Older
 * estimates remain valid inputs; calibration can raise, never shrink them. */
export function observedEstimates(task:TaskRecord) {
  const units = new Map([...((task.history??[]).flatMap(h=>h.workUnits)),
    ...((task.autonomyHistory??[]).flatMap(h=>h.workUnits)),...(task.retiredWorkUnits??[]),...task.workUnits].map(u=>[u.id,u]));
  const samples = new Map<string,number[]>();
  for (const u of [...units.values()].sort((a,b)=>(Date.parse(a.completedAt??"")||0)-(Date.parse(b.completedAt??"")||0))) {
    if (u.state!=="completed" || u.planPhase || u.orchestrator) continue;
    const planned=u.subtask?.estimatedMinutes ?? task.executionPlans?.find(p=>p.primaryUnitId===u.id)?.estimatedMinutes;
    if (!planned || planned<=0) continue;
    const intervals=task.runs.filter(r=>r.workUnitId===u.id && !r.goalPreparation && r.state==="completed").map(r=>runInterval(task,r));
    if (!intervals.length || intervals.some(i=>!i || i.uncertain)) continue;
    const actual=intervals.reduce((sum,i)=>sum+Math.max(0,i!.end-i!.workStart)/60000,0);
    if (actual<=0) continue;
    const kind=estimateKind(u), values=samples.get(kind)??[];
    values.push(actual/planned); samples.set(kind,values.slice(-8));
  }
  const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  // Recent heavier work must not be diluted by many old, quick setup steps.
  return [...samples].map(([kind,values])=>({kind,samples:values.length,
    factor:Math.max(1,Math.min(8,Math.max(median(values),median(values.slice(-3)))))}));
}
export function calibratedMinutes(task:TaskRecord,minutes:number|undefined,kind:string,estimates=observedEstimates(task)):number|undefined {
  return minutes===undefined ? undefined : minutes*(estimates.find(s=>s.kind===kind)?.factor??1);
}
/** Conservative list schedule: honor dependencies, reader limit and exclusive shared writes. */
export function scheduleMinutes(nodes: TimedNode[], parallel: number): {minutes:number; unknown:number} {
  const done=new Set<string>(), active:Array<TimedNode & {end:number}>=[];
  const pending=[...nodes]; let now=0;
  const unknown=nodes.filter(n=>n.minutes===undefined || n.minutes<=0).length;
  while(pending.length || active.length) {
    let launched=false;
    const ready=pending.filter(n=>n.dependsOn.every(k=>done.has(k)||!nodes.some(x=>x.key===k)));
    const writer=ready.find(n=>n.exclusive), runningWriter=active.find(n=>n.exclusive);
    // Match the runtime's drain barrier: a ready writer prevents admission of
    // more workspace readers, even while an earlier reader is still running.
    const candidates=runningWriter ? ready.filter(n=>n.taskOnly) : writer ? [writer,...ready.filter(n=>n.taskOnly)] : ready;
    for(const n of candidates) {
      if(active.length>=Math.max(1,parallel))break;
      if(active.some(a=>!concurrentAccessAllowed(a,n)) || writer&&n!==writer&&!active.some(a=>a.key===writer.key))continue;
      pending.splice(pending.indexOf(n),1);active.push({...n,end:now+Math.max(0,n.minutes??0)});launched=true;
      if(n.exclusive && !n.allowTaskOnlyPeers)break;
    }
    if(!active.length) { if(pending.length)return {minutes:now,unknown:unknown+pending.length};break; }
    now=Math.min(...active.map(a=>a.end));
    for(let i=active.length-1;i>=0;i--)if(active[i].end<=now){done.add(active[i].key);active.splice(i,1);}
    if(!launched && !pending.length && !active.length)break;
  }
  return {minutes:now,unknown};
}
function finishingEstimate(task:TaskRecord,role:"reporter"|"reviewer") {
  const values=task.runs.filter(r=>r.role===role&&r.state==="completed"&&!r.goalPreparation).flatMap(r=>{
    const i=runInterval(task,r);return i && !i.uncertain && i.end>i.workStart ? [(i.end-i.workStart)/60000]:[];
  }).sort((a,b)=>a-b);
  return values.length ? values[Math.floor(values.length/2)] : role==="reporter"?5:3;
}
/** Before actual services are frozen, reserve a conservative parallel review
 * graph for the planner/outlook. These virtual nodes never launch work. */
function anticipatedReviews(task:TaskRecord): TimedNode[] | undefined {
  const reviews=task.workUnits.filter(u=>u.role==="reviewer");
  if(effectiveReviewMode(task)!=="parallel" || !reviews.length || reviews.some(u=>u.crossReview || u.state!=="pending" || u.startedAt || task.runs.some(r=>r.workUnitId===u.id)))return;
  const minutes=finishingEstimate(task,"reviewer");
  const dependsOn=task.workUnits.filter(u=>u.role!=="reviewer").map(u=>u.id);
  const first=Array.from({length:Math.max(2,task.allowedAgentIds.length)},(_,i)=>({key:`anticipated-review-${i}`,dependsOn,minutes}));
  return [...first,{key:"anticipated-consolidation",dependsOn:first.map(n=>n.key),minutes}];
}
export function planTimeAssessment(task:TaskRecord,plan:{tasks:SubtaskSpec[];estimatedMinutes:number},now=Date.now()) {
  const observed=observedEstimates(task);
  const schedule=scheduleMinutes(plan.tasks.map(p=>({key:p.key,dependsOn:p.dependsOn,minutes:calibratedMinutes(task,p.estimatedMinutes,p.kind??"worker",observed),...packageAccess(p)})),task.execution?.maxParallel??1);
  const virtual=anticipatedReviews(task);
  const unfinished=task.workUnits.filter(u=>u.state==="pending"&&(u.role==="reporter"||u.role==="reviewer"));
  const finishing=virtual ? scheduleMinutes([...unfinished.filter(u=>u.role==="reporter").map(u=>({key:u.id,dependsOn:u.dependsOn,minutes:finishingEstimate(task,"reporter"),exclusive:true})),...virtual],task.execution?.maxParallel??1).minutes
    : unfinished.reduce((s,u)=>s+finishingEstimate(task,u.role as "reporter"|"reviewer"),0);
  const elapsed=executionTime(task,now).elapsedMs/60000;
  const primary=calibratedMinutes(task,plan.estimatedMinutes,"integration",observed)??0;
  return {elapsed,remaining:schedule.minutes+primary+finishing,finishing,unknown:schedule.unknown,
    target:task.autonomy?.targetMinutes,projected:elapsed+schedule.minutes+primary+finishing};
}
export function timePlanRetry(task:TaskRecord,unit:WorkUnit,plan:{tasks:SubtaskSpec[];estimatedMinutes:number;coordination?:import("./types").ExecutionPlan["coordination"]}): Partial<WorkUnit>|undefined {
  if(!task.autonomy?.targetMinutes || !unit.planPhase || task.workUnits.some(u=>u.timePlanReviewed))return;
  const a=planTimeAssessment(task,plan);
  if(a.projected<=a.target! && !a.unknown)return;
  // A fully estimated coordinated plan already considered the soft target.
  // Don't spend another full CLI turn merely because required work overruns.
  // The live outlook still displays the overrun; missing estimates get a pass.
  if (!a.unknown && plan.estimatedMinutes > 0 && plan.coordination
    && ["criticalPath", "parallelBenefit", "contextPlan", "resourcePlan"].every(k => {
      const v = plan.coordination![k as keyof NonNullable<typeof plan.coordination>];
      return typeof v === "string" && !!v.trim();
    })) return;
  // A soft target gets ONE optimization pass, never a validation failure loop.
  return {state:"pending",completedAt:undefined,assignedAgentId:undefined,timePlanReviewed:true,
    attemptedAgentIds:unit.attemptedAgentIds.filter(id=>id!==unit.assignedAgentId),
    planFormatFeedback:`時間配分を一度見直してください。目安${a.target}分、実作業${a.elapsed.toFixed(1)}分、提出計画と仕上げ予約で終了見込みは少なくとも${a.projected.toFixed(1)}分（仕上げ予約${a.finishing.toFixed(1)}分、未見積り${a.unknown}件）。後続モードがあれば別途加算が必要です。依存しない調査・独立照合の並列化、既存証拠再利用、重複管理と任意探索の削減を検討。必須基準・権限を変更せず、時間を過少申告しないこと。各作業のestimatedMinutesを入れ、収まらないなら理由と実現可能な見込みをcoordinationに明示して提出してください。超過だけを理由にユーザー確認や停止にしません。`};
}
export function taskTimeOutlook(task:TaskRecord,now=Date.now()) {
  const observed=observedEstimates(task);
  const active=task.workUnits.filter(u=>!u.orchestrator && ["pending","running"].includes(u.state));
  const nodes=active.map(u=>{
    const plan=task.executionPlans?.find(p=>p.primaryUnitId===u.id);
    let minutes=calibratedMinutes(task,u.subtask?.estimatedMinutes ?? u.contentCheck?.estimatedMinutes ?? plan?.estimatedMinutes,estimateKind(u),observed);
    if(u.role==="reporter"||u.role==="reviewer")minutes=finishingEstimate(task,u.role);
    if(u.state==="running" && minutes!==undefined) {
      const spent=task.runs.filter(r=>r.workUnitId===u.id).reduce((s,r)=>{const i=runInterval(task,r,now);return s+(i?(i.end-i.workStart)/60000:0);},0);
      // An overrun is not zero remaining work; flag it as unestimated.
      minutes=spent>=minutes ? undefined : minutes-spent;
    }
    return {key:u.id,dependsOn:u.dependsOn??[],minutes,...workAccess(u)};
  });
  const virtual=anticipatedReviews(task), reviewIds=new Set(task.workUnits.filter(u=>u.role==="reviewer").map(u=>u.id));
  const scheduled=scheduleMinutes(virtual ? [...nodes.filter(n=>!reviewIds.has(n.key)),...virtual] : nodes,task.execution?.maxParallel??1);
  const timing=executionTime(task,now), elapsed=timing.elapsedMs/60000;
  return {targetMinutes:task.autonomy?.targetMinutes,elapsedMinutes:elapsed,remainingMinutes:scheduled.minutes,
    projectedMinutes:elapsed+scheduled.minutes,unknownUnits:scheduled.unknown,
    startupWaitMinutes:timing.startupMs/60000,observedEstimates:observed};
}
export function timeBudgetGuidance(task:TaskRecord,unit:WorkUnit):string {
  if(!task.autonomy?.targetMinutes)return "";
  const o=taskTimeOutlook(task);
  const checkpoint=timeCheckpoint(task);
  return `\n# Live time strategy (soft target, no forced termination)\n${JSON.stringify(o)}\n${checkpoint ? `Time checkpoint ${checkpoint}/2: reassess now at a safe milestone. Compare CORE deliverable progress with approved success criteria; paperwork/check counts are not improvement. ${checkpoint===2 ? "Protect finishing capacity; try only a high-value bounded improvement and defer optional expansion." : "Expose the first useful result and consider a bounded alternative/counterexample before committing all remaining time to one approach."}` : "Plan a useful first-result checkpoint before one third of the target."}\nThis snapshot excludes observed startup waits; unknown durations are NOT zero. Reserve PDF/report and independent checks before allocating exploration. Use finishing estimates from this task's observed history when available. Reuse verified evidence and avoid duplicate surveys. At each milestone or about every 3–5 active minutes call agent_harness.get_progress when available, reassess remaining scope and estimate, and hand off bounded results using the normal completion protocol if a different role must continue. Return a realistic remaining estimate and concrete next action in the existing handoff, not a new management artifact. Do not spend a long uninterrupted turn repeating failed access attempts. A delay never authorizes skipping mandatory evidence, changing the goal, killing jobs, or claiming success. When over target, prioritize required integration/finishing, defer optional exploration and disclose unresolved criteria. Do not ask the user solely because time is exceeded. Current role: ${unit.role}.`;
}
