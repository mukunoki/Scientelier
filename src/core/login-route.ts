import { isActiveTaskState } from "./task-state";
import type { RemoteSystem, TaskRecord } from "./types";

export interface LoginRouteConfirmation { updatedAt: string; confirmed: true; }

export function sameRemoteConnection(a:RemoteSystem,b:RemoteSystem):boolean {
  if((a.connectionMode ?? "direct")!==(b.connectionMode ?? "direct") || ["host","username","port"].some(key=>a[key as keyof RemoteSystem]!==b[key as keyof RemoteSystem]))return false;
  // A prepared shell's final cwd/runtime are confirmed interactively and pinned
  // separately by task-ready. Registry defaults do not define that final host.
  if(a.connectionMode==="prepared")return true;
  return (a.pythonCommand ?? "python3")===(b.pythonCommand ?? "python3")
    && ["cwd","nodeCommand","startup"].every(key=>a[key as keyof RemoteSystem]===b[key as keyof RemoteSystem]);
}

/** A different first SSH hop, not a different execution environment. Preserve
 * the final identity, workspace, site rules, permissions and retirement fences.
 * The existing task-ready gate checks that identity after manual nested SSH. */
export function loginRoutePatch(task:TaskRecord,system:RemoteSystem,confirmation:unknown):Partial<TaskRecord> {
  const value=confirmation as Partial<LoginRouteConfirmation>|undefined;
  if(value?.confirmed!==true || value.updatedAt!==task.updatedAt)throw new Error("タスクの最新状態で最初のログイン先の変更を確認してください。");
  if(task.remote?.connectionMode!=="prepared" || system.connectionMode!=="prepared")throw new Error("最初のログイン先の変更には、両方の接続先で「手動で接続を準備」を使用してください。");
  if(isActiveTaskState(task.state) || task.runs.some(run=>run.state==="running") || task.workUnits.some(unit=>unit.state==="running"))
    throw new Error("タスクを一時停止してから最初のログイン先を変更してください。");
  const route=(s:RemoteSystem)=>({id:s.id,name:s.name,host:s.host,username:s.username,port:s.port});
  const from=route(task.remote),to=route(system);
  if(JSON.stringify(from)===JSON.stringify(to))return {};
  return {remote:{...task.remote,...to},loginRouteChanges:[...(task.loginRouteChanges ?? []),{at:new Date().toISOString(),from,to}]};
}
