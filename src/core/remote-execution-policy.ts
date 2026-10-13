import type { WorkUnit } from "./types";

/** The scheduler already excludes shared-workspace writers from reader waves.
 * Give admitted independent readers per-run locks in every mode, not only HPC.
 * Writers/primary checkpoints retain the task lock; prepared isolated writers have
 * separate workspaces and are merged only after their dependencies finish. */
export function independentRemoteLock(unit: WorkUnit, isolatedPrepared: boolean): boolean {
  if (unit.primary || unit.primaryStep || unit.role === "reporter") return false;
  return unit.mode === "read" && !!(unit.subtask || unit.crossReview)
    || isolatedPrepared && unit.subtask?.kind === "isolated-work";
}

export function remoteLaunchFailure(receipt: unknown, token: string): string | undefined {
  const value = receipt as { token?: unknown; notStarted?: unknown; code?: unknown } | null;
  // Use the supervisor's scoped receipt, never an agent's prose or terminal text.
  if (value?.token === token && value.notStarted === true && value.code === 75)
    return "遠隔の実行ロックが競合したため、CLIを起動できませんでした。認証・使用枠のエラーではありません。他の担当の終了を待って再開してください。終了後も続く場合は実行環境の復旧で確認してください。";
}
