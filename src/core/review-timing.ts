import type { TaskRecord } from "./types";
import { elapsedWorkMinutes } from "./work-guidance";
import { currentWorkClosure } from "./work-closure";
import { runInterval } from "./execution-time";

/** A saved admission decision applies only to these exact review seats. It
 * cannot leak across a repair, new goal, additional instruction or replan. */
export function currentReviewAdjustment(task: TaskRecord) {
  const ids = task.workUnits.filter(u => u.role === "reviewer").map(u => u.id);
  return [...(task.reviewAdjustments ?? [])].reverse().find(a => a.round === (task.roundNumber ?? 1)
    && a.cycle === (task.autonomyCycle ?? 1) && a.goalRevision === task.goal?.revision
    && a.unitIds.length === (a.mode === "single" ? 1 : 2) && a.unitIds.length === ids.length && new Set(a.unitIds).size === ids.length
    && ids.every(id => a.unitIds.includes(id)) && task.workUnits.filter(u => u.role === "reviewer").every(u => !u.crossReview));
}
export function requiredReviewPasses(task: TaskRecord): 1 | 2 {
  return currentReviewAdjustment(task)?.mode === "single" ? 1 : 2;
}
export function effectiveReviewMode(task: TaskRecord): "pair" | "cross-service" | "parallel" {
  return currentReviewAdjustment(task) || currentWorkClosure(task) ? "pair" : task.execution?.reviewMode ?? "pair";
}

/** Only unstarted final reviews may be reduced. Never remove a live reviewer,
 * a failed submission, or an existing finding to make a task fit the clock. */
export function reviewTimingPatch(task: TaskRecord, now = Date.now()): Partial<TaskRecord> | undefined {
  const target = task.autonomy?.targetMinutes;
  if (!target || !task.reviewPolicy || task.goal?.status !== "approved" || task.goalPreparation || currentReviewAdjustment(task)) return;
  const reviews = task.workUnits.filter(u => u.role === "reviewer");
  if (reviews.length !== 2 || !reviews.some(u => u.reviewPass === 1) || !reviews.some(u => u.reviewPass === 2)
    || reviews.some(u => u.state !== "pending" || u.crossReview || u.startedAt || u.completedAt || u.output || u.error || task.runs.some(r => r.workUnitId === u.id))
    || task.workUnits.some(u => u.role !== "reviewer" && u.state !== "completed")) return;
  const durations = task.runs.filter(r => r.role === "reviewer" && r.state === "completed" && !r.goalPreparation && r.completedAt)
    .map(r => {const i=runInterval(task,r,now);return i ? (i.end-i.workStart)/60000 : 0;}).filter(n => Number.isFinite(n) && n > 0).slice(-8).sort((a,b) => a-b);
  // A transparent heuristic, not a promised duration or an agent timeout.
  const perReview = durations.length ? Math.max(1, durations[Math.floor(durations.length / 2)]) : 5;
  const elapsed = elapsedWorkMinutes(task, now);
  const remaining = Math.max(0, target - elapsed);
  const cross = task.execution?.reviewMode === "cross-service";
  const parallel = task.execution?.reviewMode === "parallel";
  const batches = Math.ceil(Math.max(2, task.allowedAgentIds.length) / Math.max(1, task.execution?.maxParallel ?? 1));
  const normalEstimate = (parallel ? batches + 1 : cross ? 2 * batches : 2) * perReview;
  if (normalEstimate <= remaining) return;
  const mode = (cross || parallel) && 2 * perReview <= remaining ? "pair" : "single";
  const omitted = mode === "single" ? reviews.filter(u => u.reviewPass === 2) : [];
  const workUnits = task.workUnits.filter(u => !omitted.some(old => old.id === u.id)).map(u => u.role === "reviewer"
    ? { ...u, title: mode === "single" ? "独立レビュー（時間目安に合わせて1回）" : `独立レビュー ${u.reviewPass}/2（クロス検証を省略）` } : u);
  const reason = `目安${target}分に対して経過${elapsed.toFixed(1)}分、残り目安${remaining.toFixed(1)}分。通常のレビューは約${normalEstimate.toFixed(1)}分と見込み、${mode === "single" ? "独立レビュー1回" : "独立レビュー2回（クロス検証なし）"}に調整します。${durations.length ? "過去のレビュー実行時間から推定。" : "実績がないため1回5分で仮置き。"}必須条件・証拠確認・未解決事項の修正は省略しません。`;
  return { workUnits, reviewAdjustments: [...(task.reviewAdjustments ?? []), {
    round: task.roundNumber ?? 1, cycle: task.autonomyCycle ?? 1, goalRevision: task.goal.revision,
    mode, unitIds: workUnits.filter(u => u.role === "reviewer").map(u => u.id), omittedUnits: structuredClone(omitted),
    decidedAt: new Date(now).toISOString(), targetMinutes: target, elapsedMinutes: elapsed, estimatedMinutes: (mode === "single" ? 1 : 2) * perReview, reason
  }] };
}
