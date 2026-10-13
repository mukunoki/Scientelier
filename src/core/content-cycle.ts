import { randomUUID } from "node:crypto";
import type { TaskRecord, WorkUnit } from "./types";
import type { WorkCheck } from "./work-guidance";
import { usesContentRefinement } from "./content-refinement";
import { currentExecutionBlocker } from "./execution-blocker";
import { currentWorkClosure } from "./work-closure";

function current(task:TaskRecord,unit:WorkUnit) {
  return unit.contentCheck?.round===(task.roundNumber??1) && unit.contentCheck.goalRevision===task.goal?.revision;
}
/** Capture policy only when accepting a NEW plan. Never migrate old plans or
 * add phases on application load, pure report/review requests or paused jobs. */
export function contentCycleForPlan(task:TaskRecord,owner:WorkUnit):WorkUnit["contentCheck"] {
  if (!task.autonomy?.enabled || task.goal?.status!=="approved" || !owner.primary || owner.mode!=="write"
    || task.workflowMode!=="primary" || !usesContentRefinement(task,owner)
    || owner.researchStage && owner.researchStage!=="paper") return;
  if (current(task,owner) && owner.contentCheck?.stage==="response") return owner.contentCheck;
  const response=[...task.workUnits,...(task.retiredWorkUnits??[])].find(u=>current(task,u) && u.contentCheck?.stage==="response");
  return response?.contentCheck ?? {stage:"initial",round:task.roundNumber??1,goalRevision:task.goal!.revision};
}

/** One late content check and lead response, inside the SAME goal/round.
 * It is a planned finishing phase, not an extra repair allowance. */
export function contentCheckPatch(task:TaskRecord,owner:WorkUnit,check:WorkCheck):Partial<TaskRecord>|undefined {
  if (!current(task,owner) || owner.contentCheck?.stage!=="initial" || !owner.primary || owner.mode!=="write" || owner.planPhase
    || owner.state!=="completed" || !["ready","report-ready","needs-work"].includes(check.status)
    || check.status==="needs-work" && (!check.evidence.length || (owner.workAttempt??1)>=(task.autonomy?.maxCycles??1))
    || task.goal?.status!=="approved" || !task.autonomy?.enabled || task.goalRevisionPending || task.pendingExecution || task.pendingFollowup
    || currentExecutionBlocker(task) || currentWorkClosure(task) || ["paused","blocked"].includes(task.state)
    || task.runs.some(r=>r.state==="running" || r.terminationUnconfirmed)
    || task.workUnits.some(u=>u.launchBlocked || current(task,u) && ["peer","response"].includes(u.contentCheck?.stage??""))
    || !task.workUnits.some(u=>u.id===owner.id) || !task.workUnits.some(u=>u.role==="reporter" && u.state==="pending")) return;
  const peerId=randomUUID(),responseId=randomUUID();
  const slots=task.execution?.decompose && task.workUnits.filter(u=>u.subtask).length<(task.execution.maxSubtasks??0);
  const peer = slots && task.allowedAgentIds.length>1 ? {
    id:peerId,role:"worker",mode:"read",state:"pending",attemptedAgentIds:[],dependsOn:[owner.id],planRevision:owner.planRevision,allocatedBy:owner.id,
    contentCheck:{...owner.contentCheck,stage:"peer",sourceUnitId:owner.id},
    title:"内容点検 · 説明不足と改善余地",
    subtask:{key:`content-check-${peerId}`,kind:"investigation",title:"説明不足と改善余地",instructions:"Inspect the stable draft and evidence, not the owner's success claims.",
      deliverable:"Concrete reader questions and high-value in-scope improvements",acceptance:"Evidence locations, minimum test and cost; no invented defects or execution",criterionIds:task.goal.criteria.map(c=>c.id),
      dependsOn:[],estimatedTokens:1500,estimatedMinutes:3,purpose:"verify"},
    instructions:"Read the current source/draft and relevant evidence. Find undefined representations, assumptions, steps or missing reasoning a competent reader needs; identify high-value design/optimization/idea alternatives supported by bottleneck or counterexample evidence. Prioritize a small number of actionable findings, with exact locations, why they matter, a minimal test and cost/risk. Answer in Japanese bullets. Distinguish observed facts, hypotheses and unperformed tests. Do not edit, run experiments, spawn agents, repeat full bibliography/layout audits, add requirements or give final acceptance. Return no concerns when there is genuinely no actionable issue; do not manufacture busywork."
  } as WorkUnit : undefined;
  const response:WorkUnit={...owner,id:responseId,title:"主担当 · 内容の仕上げと終了判断",state:"pending",planPhase:false,
    contentCheck:{...owner.contentCheck,stage:"response",sourceUnitId:owner.id,
      estimatedMinutes:check.status==="needs-work" ? Math.max(1,check.estimatedRemainingMinutes) : 5},
    workAttempt:check.status==="needs-work" ? (owner.workAttempt??1)+1 : owner.workAttempt,
    assignedAgentId:undefined,retryAgentId:undefined,attemptedAgentIds:[],startedAt:undefined,completedAt:undefined,output:undefined,error:undefined,
    checkpointHandled:undefined,delegationHandled:undefined,workCheckRetries:undefined,workCheckFeedback:undefined,
    dependsOn:[owner.id,...(peer?[peer.id]:[])],
    instructions:`Finish the SAME approved work from the existing artifacts, not another project or survey. ${peer ? "Inspect the content peer's concrete findings against actual evidence." : "No separate peer is scheduled within available services/package slots; perform the focused reader and improvement check yourself without claiming independent inspection."} Repair missing explanations from verified sources/code. Compare and test the best worthwhile in-scope improvement when justified, then adopt/reject/defer it with evidence. Negative findings and no further useful changes are valid. Do not redo unchanged measurements, invent explanations, polish the PDF repeatedly or replace final independent review. Prefer finishing useful work in this turn. Preserve permissions, goal, tolerance and remaining retry limits. Use the existing work-check, with contentDecision={decision:'finish'|'continue',explanation:'reader gaps checked/repaired, evidence or limitations',improvement:'suggestions tried/rejected/deferred and why'}. For continue, use needs-work with concrete remainingWork; for genuine authority/environment failures use the existing blocker/ask-user path. A finish decision is NOT goal acceptance. Do not put this control decision or agent history in the manuscript.`};
  response.instructions=`${owner.instructions}\n${response.instructions}`;
  if(check.status==="needs-work")response.instructions+=`\nRequired remaining work from the owner (preserve, not waive): ${check.remainingWork}`;
  const units=task.workUnits.map(u=>u.id===owner.id ? {...u,checkpointHandled:true} : u.state==="completed" ? u :
    {...u,dependsOn:u.dependsOn.map(id=>id===owner.id?response.id:id)});
  units.splice(units.findIndex(u=>u.id===owner.id)+1,0,...(peer?[peer]:[]),response);
  return {workUnits:units,error:undefined};
}

/** Optional advice may fail, but an unconfirmed old CLI, pause, environment
 * blocker or mandatory reviewer is NEVER bypassed. Keep failure history. */
export function skipContentPeerPatch(task:TaskRecord,unit:WorkUnit,reason:string):Partial<TaskRecord>|undefined {
  if (!current(task,unit) || unit.contentCheck?.stage!=="peer" || ["paused","cancelled"].includes(task.state)
    || task.pendingExecution || task.goalRevisionPending || task.pendingFollowup || currentExecutionBlocker(task)
    || task.runs.some(r=>r.terminationUnconfirmed || r.workUnitId===unit.id && r.state==="running")) return;
  const source=unit.contentCheck.sourceUnitId;
  if (!source || !task.workUnits.some(u=>u.id===source && u.state==="completed")) return;
  return {state:"running",error:undefined,resumeFromUnitId:undefined,
    retiredWorkUnits:[...(task.retiredWorkUnits??[]),{...unit,state:"cancelled",error:`内容点検は未実施：${reason}。主担当が自己点検します。独立確認済みとは扱いません。`}],
    workUnits:task.workUnits.filter(u=>u.id!==unit.id).map(u=>({...u,dependsOn:[...new Set(u.dependsOn.map(id=>id===unit.id?source:id))]}))};
}

export function contentCycleGuidance(task:TaskRecord,unit:WorkUnit):string {
  if (!current(task,unit) || unit.contentCheck?.stage!=="response") return "";
  return "# 主担当の内容点検・終了判断\n追加指示を待たず、元のゴール内の説明不足と有望な改善をこの初回ラウンドで処理します。既存の成果を引き継ぎ、他担当の主張は現物で確認してください。work-checkにcontentDecisionを含めます：{\"decision\":\"finish\"または\"continue\",\"explanation\":\"読者の疑問を確認・修正した箇所と根拠／未確認\",\"improvement\":\"有望案の試行・比較・採否と根拠／追加試行が不適切な理由\"}。continueにはneeds-workと具体的なremainingWorkが必要です。時間超過だけではユーザーへ判断を戻さず、権限・条件の変更が本当に必要な場合だけask-userとします。提案数・検査件数ではなく内容の改善を説明し、finishでも未達・未確認を合格にしません。上限内で完了できなければ残課題を保持して仕上げへ渡します。";
}
