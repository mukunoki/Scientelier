import { randomUUID } from "node:crypto";
import type { GoalEvaluation, TaskRecord, WorkUnit } from "./types";
import { currentWorkClosure } from "./work-closure";
import { currentExecutionBlocker } from "./execution-blocker";
import { currentReviewAdjustment } from "./review-timing";

/** One manuscript-only correction before bounded closure. Keep scientific
 * failures, original reviews and the same review count; never restart workers. */
export function reportCorrectionPatch(task:TaskRecord,reviews:GoalEvaluation[],now=Date.now()):Partial<TaskRecord>|undefined {
  const closure=currentWorkClosure(task);
  const reporter=task.workUnits.find(u=>u.role==="reporter"), reviewers=task.workUnits.filter(u=>u.role==="reviewer");
  if (!closure || closure.finishedAt || closure.reportCorrectionAttemptedAt || !task.autonomy?.enabled
    || task.goal?.status!=="approved" || task.goalRevisionPending || task.pendingExecution || task.pendingFollowup || currentExecutionBlocker(task)
    || task.state==="paused" || task.state==="blocked" || task.state==="awaiting-input"
    || !reporter || reporter.mode!=="write" || reporter.state!=="completed" || !task.report?.texPath || !reviewers.length
    || task.workUnits.some(u=>u.state!=="completed" || u.launchBlocked) || task.runs.some(r=>r.state==="running" || r.terminationUnconfirmed)
    || reviews.some(e=>e.nextAction==="ask-user")
    || reviewers.some(u=>!reviews.some(e=>e.reviewUnitId===u.id && e.goalRevision===task.goal!.revision
      && e.round===(task.roundNumber??1) && e.cycle===(task.autonomyCycle??1)))) return;
  const corrections=[...new Set(reviews.flatMap(e=>e.reportCorrections??[]))].slice(0,8);
  if (!corrections.length) return;
  const old=[reporter,...reviewers], ids=new Map(old.map(u=>[u.id,randomUUID()]));
  const reset=(u:WorkUnit):WorkUnit=>({...u,id:ids.get(u.id)!,state:"pending",assignedAgentId:undefined,retryAgentId:undefined,
    attemptedAgentIds:[],startedAt:undefined,completedAt:undefined,output:undefined,error:undefined,
    reviewFormatRetries:undefined,reviewFormatFeedback:undefined,workCheckFeedback:undefined,checkpointHandled:undefined,
    dependsOn:u.dependsOn.map(id=>ids.get(id)??id)});
  const replacement=old.map(reset);
  replacement[0].instructions+=`\n# One bounded manuscript correction\nCorrect ONLY these report-local claims/wording/layout using EXISTING verified evidence:\n${corrections.map(s=>`- ${s}`).join("\n")}\nPreserve scientific fail/unverified criteria and every unresolved concern. Do not run experiments, change algorithms, data, tolerances, permissions, protocol or the goal. If a correction needs unavailable evidence, disclose it; do not invent proof. Commit only your verified manuscript changes, rebuild and inspect the PDF. Independent review follows; no further correction loop is allowed in this closure.`;
  const adjustment=currentReviewAdjustment(task);
  return {state:"reporting",error:undefined,resumeFromUnitId:undefined,
    workClosure:{...closure,reportCorrectionAttemptedAt:new Date(now).toISOString()},
    retiredWorkUnits:[...(task.retiredWorkUnits??[]),...old],
    workUnits:[...task.workUnits.filter(u=>!ids.has(u.id)),...replacement],
    ...(adjustment ? {reviewAdjustments:[...(task.reviewAdjustments??[]),{...adjustment,
      unitIds:reviewers.map(u=>ids.get(u.id)!),decidedAt:new Date(now).toISOString(),reason:"限定した原稿修正後、保存済みのレビュー方式で再確認します。"}]} : {})};
}
