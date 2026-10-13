import { randomUUID } from "node:crypto";
import type { TaskRecord, WorkRequirements, WorkUnit } from "./types";
import { validateWorkRequirements } from "./plan-format";

export function assignmentRecoveryCandidates(task: TaskRecord): WorkUnit[] {
  if (!["paused","blocked","failed","cancelled","awaiting-input"].includes(task.state) || task.goal?.status !== "approved" || task.goalPreparation || task.pendingFollowup) return [];
  const plan=task.executionPlans?.at(-1);
  if (!plan || plan.round!==(task.roundNumber??1) || plan.goalRevision!==task.goal.revision) return [];
  const ids=new Set(Object.values(plan.taskUnitIds));
  return [...task.workUnits,...(task.retiredWorkUnits??[])].filter(u=>ids.has(u.id) && u.subtask && u.mode==="read" && ["failed","blocked","cancelled"].includes(u.state)
    && u.dependsOn.every(id=>task.workUnits.some(d=>d.id===id && d.state==="completed")));
}

/** Explicit user repair, not automatic reinterpretation of arbitrary plan prose.
 * Retired failures remain in history; successful peers, goal and budgets remain
 * untouched. The normal resume path still checks SSH, capacity and the budget. */
export function repairAssignment(task: TaskRecord, unitId: string, input: WorkRequirements): Partial<TaskRecord> {
  const source=assignmentRecoveryCandidates(task).find(u=>u.id===unitId);
  if (!source || task.workUnits.some(u=>u.state==="running")) throw new Error("停止中の最新計画にある失敗した読取担当だけを修復できます。");
  const requirements=validateWorkRequirements(input)!;
  if (!requirements) throw new Error("修復する配置条件を指定してください。");
  const old=source.subtask!.requirements;
  if (old?.modelFamilies && (!requirements.modelFamilies || requirements.modelFamilies.some(f=>!old.modelFamilies!.includes(f)))) throw new Error("既存のモデル系統条件を緩和できません。");
  if (old?.independentFrom?.some(k=>!requirements.independentFrom?.includes(k)) || old?.skills?.some(s=>!requirements.skills?.some(n=>n.id===s.id && (!s.revision || n.revision===s.revision)))) throw new Error("既存の独立性・必須スキル条件を取り除くことはできません。");
  for (const key of requirements.independentFrom??[]) if (!task.workUnits.some(u=>source.dependsOn.includes(u.id) && u.state==="completed" && u.subtask?.key===key)) throw new Error("比較対象は完了済みの直接依存先から指定してください。");
  const plan=task.executionPlans!.at(-1)!;
  const primary=task.workUnits.find(u=>u.id===plan.primaryUnitId);
  if (!primary) throw new Error("統合担当が見つかりません。計画を確認してください。");
  const retired=!task.workUnits.some(u=>u.id===source.id), id=retired?randomUUID():source.id;
  const restored:WorkUnit={...source,id,subtask:{...source.subtask!,requirements},state:"pending",launchBlocked:undefined,attemptedAgentIds:[],assignedAgentId:undefined,output:undefined,error:undefined,startedAt:undefined,completedAt:undefined};
  let units=task.workUnits.filter(u=>u.id!==source.id);
  units.splice(units.findIndex(u=>u.id===primary.id),0,restored);
  const affected=new Set([id,primary.id]);
  for(let changed=true;changed;){changed=false;for(const u of units)if(!affected.has(u.id)&&u.dependsOn.some(d=>affected.has(d))){affected.add(u.id);changed=true;}}
  units=units.map(u=>affected.has(u.id)?{...u,state:"pending",launchBlocked:undefined,attemptedAgentIds:[],assignedAgentId:undefined,output:undefined,error:undefined,startedAt:undefined,completedAt:undefined,checkpointHandled:undefined,
    ...(u.id===primary.id?{title:"主担当 · 配置修復後の統合",planPhase:false,delegationHandled:undefined,dependsOn:[...new Set([...u.dependsOn.filter(d=>d!==source.id),id])],instructions:`${plan.primaryWork}\nVerify: ${plan.acceptance}\nUser-input conditions: ${plan.escalation}\n配置修復後の統合。完了済みの担当・実験・照合記録を保持し、修復した担当の結果を確認して残作業だけ進める。要件・予算・独立最終レビューを緩和しない。`}:{})}:u);
  return {workUnits:units,executionPlans:task.executionPlans!.map(p=>p===plan?{...p,tasks:p.tasks.map(t=>t.key===source.subtask!.key?{...t,requirements}:t),taskUnitIds:{...p.taskUnitIds,[source.subtask!.key]:id}}:p),
    state:"paused",awaitingReason:undefined,autonomyState:undefined,resumeFromUnitId:id,error:"担当の配置条件を修復しました。接続・使用枠を確認し、中断した工程から再開してください。完了済みの担当と成果物は保持しています。",
    evaluations:task.evaluations?.filter(e=>!e.reviewUnitId || !affected.has(e.reviewUnitId))};
}
