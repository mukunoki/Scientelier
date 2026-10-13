import { defaultExecution, validateExecution } from "./execution-policy";
import { pairUnits } from "./review-pair";
import type { TaskRecord } from "./types";

/** Save a policy separately from the running policy. In-flight prompts, plan
 * contracts and results must still be interpreted under their original policy. */
export function executionSettingsPatch(task: TaskRecord, value: unknown, active: boolean, revision?: number): Partial<TaskRecord> {
  if (task.workflowMode !== "primary") throw new Error("主担当方式のタスクで設定してください。");
  if (revision !== undefined && revision !== (task.executionRevision ?? 0)) throw new Error("戦略設定が更新されています。画面を開き直して確認してください。");
  const policy = validateExecution(value);
  const reviewChanged = (policy.reviewMode ?? "pair") !== (task.execution?.reviewMode ?? "pair");
  // Review changes alter the graph, not only admission. Keep that operation
  // out of running batches, including the interval before a run is published.
  if (reviewChanged && (active || task.workUnits.some(u => u.role === "reviewer" && task.runs.some(r => r.workUnitId === u.id)))) {
    throw new Error("実行中または開始済みレビューの方式は変更できません。並列数・割当方針などは次の工程から変更できます。");
  }
  const version = (task.executionRevision ?? 0) + 1;
  if (active) {
    const unchanged = JSON.stringify(policy) === JSON.stringify(validateExecution(task.execution ?? defaultExecution));
    return { executionRevision: version, pendingExecution: unchanged ? undefined : { policy, savedAt: new Date().toISOString() } };
  }
  let workUnits = task.workUnits;
  if (reviewChanged && workUnits.some(u => u.crossReview)) {
    const base = workUnits.find(u => u.role === "reviewer")!;
    workUnits = pairUnits([...workUnits.filter(u => u.role !== "reviewer"), { ...base, crossReview: undefined, reviewPass: undefined }]);
  }
  return { execution: policy, pendingExecution: undefined, executionRevision: version, executionAppliedAt: new Date().toISOString(), workUnits };
}

/** Called only after the scheduler has drained all work and consumed results.
 * Never reset work units, limits consumed so far, evidence, or the approved goal. */
export function pendingExecutionPatch(task: TaskRecord): Partial<TaskRecord> | undefined {
  if (!task.pendingExecution) return;
  if (task.workUnits.some(u => u.state === "running") || task.runs.some(r => r.state === "running")) return;
  const policy = validateExecution(task.pendingExecution.policy);
  if ((policy.reviewMode ?? "pair") !== (task.execution?.reviewMode ?? "pair")) throw new Error("予約したレビュー方式が現在の方式と一致しません。戦略設定を確認してください。");
  return { execution: policy, pendingExecution: undefined, executionRevision: (task.executionRevision ?? 0) + 1, executionAppliedAt: new Date().toISOString() };
}
