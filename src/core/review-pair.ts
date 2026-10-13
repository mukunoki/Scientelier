import { randomUUID } from "node:crypto";
import type { AgentId, GoalEvaluation, TaskRecord, WorkUnit } from "./types";
import { combineCrossReviews, crossReviewEvaluations } from "./cross-review";
import { requiredReviewPasses } from "./review-timing";

export function pairUnits(units: WorkUnit[]): WorkUnit[] {
  if (units.some(u => u.reviewPass === 1) && units.some(u => u.reviewPass === 2)) return units;
  const old = units.filter(u => u.role === "reviewer");
  if (!old.length && !units.some(u => ["worker", "reporter"].includes(u.role))) return units;
  const base = old[0] ?? { id: randomUUID(), role: "reviewer" as const, mode: "read" as const, state: "pending" as const, title: "Review", instructions: "Independently inspect the final artifacts against the approved goal.", dependsOn: [], attemptedAgentIds: [] };
  const others = units.filter(u => u.role !== "reviewer").map(u => ({ ...u, dependsOn: u.dependsOn.filter(id => !old.some(r => r.id === id)) }));
  // Review the final artifacts only after every producer (including the PDF builder).
  const first: WorkUnit = { ...base, id: randomUUID(), title: "敵対的レビュー 1/2", reviewPass: 1, mode: "read", primary: undefined,
    reviewFormatRetries: undefined, reviewFormatFeedback: undefined,
    state: "pending", output: undefined, error: undefined, assignedAgentId: undefined, startedAt: undefined, completedAt: undefined,
    attemptedAgentIds: [], dependsOn: others.map(u => u.id) };
  const second: WorkUnit = { ...first, id: randomUUID(), title: "敵対的レビュー 2/2", reviewPass: 2, dependsOn: [first.id] };
  return [...others, first, second];
}

/** Prefer reviewers who did not write these artifacts, but allow writer fallback. */
export function writerClis(task: TaskRecord): Set<AgentId> {
  const workerIds = new Set(task.workUnits.filter(u => ["worker", "reporter"].includes(u.role) && u.mode === "write" && !u.planPhase).map(u => u.id));
  const excluded = new Set(task.runs.filter(r => workerIds.has(r.workUnitId) && !r.goalPreparation).map(r => r.agentId));
  if (!task.workUnits.some(u => u.role === "worker" && u.mode === "write" && !u.planPhase)) {
    const planIds = new Set([...task.workUnits, ...(task.autonomyHistory ?? []).flatMap(h => h.workUnits), ...(task.history ?? []).flatMap(h => h.workUnits)].filter(u => u.planPhase).map(u => u.id));
    const previousWorker = [...task.runs].reverse().find(r => r.role === "worker" && !r.goalPreparation && !planIds.has(r.workUnitId));
    if (previousWorker) excluded.add(previousWorker.agentId);
  }
  return excluded;
}

/** If every eligible service helped produce the work, prioritize independence
 * from its LAST editor (usually the reporter), rather than arbitrary ranking. */
export function lastArtifactWriter(task:TaskRecord): AgentId | undefined {
  const units=[...(task.history??[]).flatMap(h=>h.workUnits),...(task.autonomyHistory??[]).flatMap(h=>h.workUnits),
    ...(task.retiredWorkUnits??[]),...task.workUnits];
  const writers=new Set(units.filter(u=>u.mode==="write" && !u.planPhase && !u.orchestrator && ["worker","reporter"].includes(u.role)).map(u=>u.id));
  return [...task.runs].reverse().find(r=>r.state==="completed" && !r.goalPreparation && writers.has(r.workUnitId))?.agentId;
}

/** The predecessor is relative to this unit, not the task's last run (which may be itself). */
export function previousReviewAgent(task: TaskRecord, unit: WorkUnit): AgentId | undefined {
  const index = task.runs.findIndex(run => run.workUnitId === unit.id);
  return [...(index < 0 ? task.runs : task.runs.slice(0, index))].reverse()
    .find(run => run.role === "reviewer" && run.state === "completed" && !run.goalPreparation)?.agentId;
}

/** Adjacent reviews must differ, including across worker repairs and later rounds. */
export function excludedReviewClis(task: TaskRecord, unit: WorkUnit): Set<AgentId> {
  if (unit.crossReview) return new Set(); // Independence is between frozen providers/waves, not racing completion order.
  const previous = previousReviewAgent(task, unit);
  return new Set(previous ? [previous] : []);
}

/** Stable chronological labels; repair resets the pass streak, never the CLI predecessor. */
export function reviewNumber(task: TaskRecord, unit: WorkUnit): number {
  const ids = [...new Set(task.runs.filter(r => r.role === "reviewer" && !r.goalPreparation).map(r => r.workUnitId))];
  const index = ids.indexOf(unit.id);
  if (index >= 0) return index + 1;
  const pending = task.workUnits.filter(u => u.role === "reviewer" && !ids.includes(u.id));
  return ids.length + pending.findIndex(u => u.id === unit.id) + 1;
}

export function currentReviewPair(task: TaskRecord, evaluations = task.evaluations ?? []): GoalEvaluation[] {
  if (task.workUnits.some(u => u.crossReview)) return crossReviewEvaluations(task, evaluations);
  return ([1, 2] as const).flatMap(pass => {
    const unit = task.workUnits.find(u => u.reviewPass === pass);
    const evaluation = [...evaluations].reverse().find(e => e.reviewUnitId === unit?.id && e.reviewPass === pass && e.goalRevision === task.goal?.revision && e.round === (task.roundNumber ?? 1) && e.cycle === (task.autonomyCycle ?? 1));
    return unit?.state === "completed" && evaluation ? [evaluation] : [];
  });
}
export function combineReviewPair(task: TaskRecord, evaluations = task.evaluations ?? []): GoalEvaluation {
  if (task.workUnits.some(u => u.crossReview)) return combineCrossReviews(task, evaluations);
  const pair = currentReviewPair(task, evaluations);
  if (requiredReviewPasses(task) === 1) {
    const e = pair[0];
    const unit = task.workUnits.find(u => u.id === e?.reviewUnitId);
    const run = [...task.runs].reverse().find(r => r.workUnitId === unit?.id && r.state === "completed");
    if (pair.length !== 1 || !e?.reviewerAgentId || !unit || unit.reviewPass !== 1 || unit.mode !== "read" || unit.primary
      || !run || run.agentId !== e.reviewerAgentId || run.continuedFrom || !unit.startedAt || !(Date.parse(e.reviewedAt) >= Date.parse(unit.startedAt)) || excludedReviewClis(task, unit).has(e.reviewerAgentId)
      || task.goal!.criteria.some(c => !e.criteria.some(f => f.criterionId === c.id))) throw new Error("時間調整後の独立レビューを検証できません。");
    return { ...e, reviewPass: undefined, reviewUnitId: undefined, reviewerAgentId: undefined,
      summary: `時間目安に応じた独立レビュー1回（クロス検証は未実施）：${e.summary}` };
  }
  if (pair.length !== 2 || !pair[0].reviewerAgentId || !pair[1].reviewerAgentId || pair[0].reviewerAgentId === pair[1].reviewerAgentId) throw new Error("異なるCLIによる2回のレビューが完了していません。");
  for (const e of pair) {
    const unit = task.workUnits.find(u => u.id === e.reviewUnitId)!;
    if (excludedReviewClis(task, unit).has(e.reviewerAgentId!)) throw new Error("レビューの担当独立性を満たしていません。");
  }
  return { ...pair[1], reviewPass: undefined, reviewUnitId: undefined, reviewerAgentId: undefined,
    criteria: task.goal!.criteria.map(c => {
      const findings = pair.map(e => e.criteria.find(f => f.criterionId === c.id)!);
      const worst = findings.find(f => f.status === "fail") ?? findings.find(f => f.status === "unverified") ?? findings[0];
      return { ...worst, detail: findings.map((f, i) => `Review ${i + 1}: ${f.detail}`).join("\n"), evidence: findings.flatMap(f => f.evidence) };
    }),
    concerns: pair.flatMap(e => e.concerns ?? []),
    reportCorrections: [...new Set(pair.flatMap(e=>e.reportCorrections??[]))].slice(0,8),
    nextAction: pair.some(e => e.nextAction === "ask-user") ? "ask-user" : "repair",
    repairInstructions: pair.map((e, i) => `Review ${i + 1}: ${e.repairInstructions || "none"}`).join("\n"),
    summary: pair.map((e, i) => `Review ${i + 1}: ${e.summary}`).join("\n")
  };
}
