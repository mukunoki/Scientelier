import { ACTIVE_AGENT_IDS, type AgentId, type TaskRecord, type WorkUnit } from "./types";
import { resumableUnit } from "./recovery";
import { crossReviewEvaluations } from "./cross-review";

/** Drop a failed, unaccepted seat, never a dissenting verdict. Two independent
 * services must remain; all their original findings and both waves are required. */
export function reduceCrossReviewTask(task:TaskRecord,runId:string):TaskRecord {
  const unit=cliHandoffUnit(task,runId);
  if(unit.crossReview?.wave!==1)throw new Error("再編できるのは独立レビュー段階で失敗した担当です。");
  const removedProvider=unit.crossReview.providerKey;
  const removed=task.workUnits.filter(u=>u.crossReview?.providerKey===removedProvider&&!u.crossReview.aggregate),ids=new Set(removed.map(u=>u.id));
  if(removed.some(u=>u.state==="completed") || task.runs.some(r=>ids.has(r.workUnitId)&&r.state==="completed")
    || task.evaluations?.some(e=>ids.has(e.reviewUnitId??"")))throw new Error("提出済みの判定・指摘がある担当は除外できません。");
  const first=task.workUnits.filter(u=>u.crossReview?.wave===1&&!ids.has(u.id));
  const second=task.workUnits.filter(u=>u.crossReview?.wave===2&&!ids.has(u.id));
  const accepted=crossReviewEvaluations(task);
  if(first.length<2 || new Set(first.map(u=>u.crossReview!.providerKey)).size!==first.length
    || first.some(u=>u.state!=="completed"||!accepted.some(e=>e.reviewUnitId===u.id)))throw new Error("異なる2サービス以上の有効な独立レビューが必要です。");
  for(const u of first){
    const e=accepted.find(e=>e.reviewUnitId===u.id)!,r=task.runs.filter(r=>r.workUnitId===u.id&&r.state==="completed").at(-1);
    if(!r||r.providerKey!==u.crossReview!.providerKey||r.agentId!==e.reviewerAgentId||r.continuedFrom||u.mode!=="read"||u.primary)throw new Error("保持する独立レビューの実行記録が一致しません。");
  }
  if(new Set(first.map(u=>accepted.find(e=>e.reviewUnitId===u.id)!.reviewerAgentId)).size<2)throw new Error("異なるCLIによる独立レビューが必要です。");
  const allSecond=task.workUnits.filter(u=>u.crossReview?.wave===2);
  const aggregate = allSecond.length === 1 && allSecond[0].crossReview!.aggregate === true;
  if((aggregate ? second.length !== 1 : second.length!==first.length || second.some(s=>s.crossReview!.aggregate) || first.some(u=>second.filter(s=>s.crossReview!.providerKey===u.crossReview!.providerKey).length!==1))
    || allSecond.some(u=>u.state!=="pending"||task.runs.some(r=>r.workUnitId===u.id)))throw new Error("クロスレビュー開始後の担当枠はこの操作では変更できません。");
  if(task.workUnits.some(u=>!ids.has(u.id)&&u.crossReview?.wave!==2&&u.dependsOn.some(id=>ids.has(id))))throw new Error("除外対象に依存する別の工程があります。計画の確認が必要です。");
  const workUnits=task.workUnits.filter(u=>!ids.has(u.id)).map(u=>u.crossReview?.wave===2?{...u,
    dependsOn:first.map(f=>f.id),crossReview:{...u.crossReview,sourceUnitIds:first.filter(f=>u.crossReview!.aggregate || f.crossReview!.providerKey!==u.crossReview!.providerKey).map(f=>f.id)}
  }:u);
  return {...task,workUnits,resumeFromUnitId:second[0].id,
    retiredWorkUnits:[...(task.retiredWorkUnits??[]),...removed],
    crossReviewReplans:[...(task.crossReviewReplans??[]),{at:new Date().toISOString(),round:task.roundNumber??1,removedProvider,workUnits:removed}]};
}

/** Only the latest failed attempt of an unfinished, current-round unit is transferable. */
export function cliHandoffUnit(task: TaskRecord, runId: string): WorkUnit {
  const run = task.runs.find(r => r.id === runId);
  const unit = task.workUnits.find(u => u.id === run?.workUnitId);
  if (!resumableUnit(task) || task.pendingFollowup || task.goalPreparation || task.goal?.status !== "approved"
    || task.runs.some(r => r.state === "running") || !run || !unit || unit.state === "completed"
    || !["failed", "cancelled", "rate-limited"].includes(run.state)
    || task.runs.filter(r => r.workUnitId === unit.id).at(-1)?.id !== runId) {
    throw new Error("この端末は引き継ぎ対象ではありません。最新の失敗・中断端末を選び、タスクを一時停止してください。");
  }
  return unit;
}

/** Prepare a scoped override; never edit the task-wide role or mark failed work successful. */
export function cliHandoffTask(task: TaskRecord, runId: string, agentId: AgentId, providerKey: string): TaskRecord {
  const unit = cliHandoffUnit(task, runId), run = task.runs.find(r => r.id === runId)!;
  if (!ACTIVE_AGENT_IDS.some(id=>id===agentId) || agentId === run.agentId) throw new Error("別のCLIを選んでください。");
  let units = task.workUnits;
  if (unit.crossReview && !unit.crossReview.aggregate && unit.crossReview.providerKey !== providerKey) {
    const oldKey = unit.crossReview.providerKey;
    // A cross-review seat consists of two waves. Keep other providers' completed
    // verdicts, and never relabel them or count the same provider as independent.
    if (units.some(u => u.crossReview?.providerKey === providerKey && !u.crossReview.aggregate)) throw new Error("このサービスは既に別のクロスレビューを担当しています。独立性を保つため、未参加のサービスを選んでください。");
    if (units.some(u => u.crossReview?.providerKey === oldKey && !u.crossReview.aggregate && ["completed", "running"].includes(u.state))) throw new Error("このサービスのレビューは既に受理されています。2段階の独立性を保つため、この担当を別サービスへ変更できません。");
    units = units.map(u => u.crossReview?.providerKey === oldKey && !u.crossReview.aggregate ? { ...u,
      crossReview: { ...u.crossReview, providerKey },
      title: `${u.crossReview.wave === 1 ? "独立レビュー" : "クロスレビュー"} · ${providerKey}`
    } : u);
  }
  return { ...task, resumeFromUnitId: unit.id,
    allowedAgentIds: [...new Set([...task.allowedAgentIds, agentId])],
    workUnits: units.map(u => u.id === unit.id ? { ...u, retryAgentId: agentId, attemptedAgentIds: [], launchBlocked: undefined } : u)
  };
}
