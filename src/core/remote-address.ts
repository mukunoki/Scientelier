import type { RemoteSystem, TaskRecord } from "./types";
import { isActiveTaskState } from "./task-state";

export interface RemoteAddressUpdate { expectedHost: string; confirmed: true; }

/** Explicit same-machine address change, not a workspace/account migration.
 * Keep each task's final-host identity, permissions, cwd and retirement fence.
 * In particular an unconfirmed remote stop must survive so reconnection can
 * inspect the original tmux session instead of starting a second writer. */
export function remoteAddressUpdates(previous: RemoteSystem | undefined, next: RemoteSystem, tasks: TaskRecord[], input: unknown) {
  if (!previous || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("既存タスクへのIP変更は、登録済み接続先で確認してから保存してください。");
  const value = input as Partial<RemoteAddressUpdate>;
  if (value.confirmed !== true || value.expectedHost !== previous.host) throw new Error("接続先が変更されました。設定を読み直してIP変更を確認してください。");
  // Other connection edits still apply only to future tasks. Combining those
  // with an IP change would conceal a new user, host setup or workspace.
  if ((previous.connectionMode ?? "direct") !== (next.connectionMode ?? "direct")
    || (previous.pythonCommand ?? "python3") !== (next.pythonCommand ?? "python3")
    || ["username", "port", "cwd", "nodeCommand", "startup"].some(key => previous[key as keyof RemoteSystem] !== next[key as keyof RemoteSystem])
    || previous.host.split("@").slice(0, -1).join("@") !== next.host.split("@").slice(0, -1).join("@"))
    throw new Error("既存タスクへの反映は同じマシンのIP・サーバ名変更だけです。ユーザ名・作業フォルダ・接続方式などの変更とは分けて保存してください。");
  const address = next.host.split("@").at(-1)!;
  return tasks.filter(task => task.remote?.id === next.id).flatMap(task => {
    if (isActiveTaskState(task.state) || task.runs.some(run => run.state === "running") || task.workUnits.some(unit => unit.state === "running"))
      throw new Error(`「${task.title}」を一時停止してからIP変更を反映してください。`);
    const before = task.remote!;
    const parts = before.host.split("@");
    const host = parts.length === 2 ? `${parts[0]}@${address}` : address;
    return host === before.host ? [] : [{ id: task.id, patch: { remote: { ...before, host } } }];
  });
}
