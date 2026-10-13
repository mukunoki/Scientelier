import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, posix } from "node:path";
import type { TaskRecord } from "./types";

export async function taskDirectory(path: string, mode: unknown, create = false): Promise<string> {
  if (mode !== "existing" && mode !== "new") throw new Error("作業ディレクトリを新規作成するか、既存ディレクトリを選んでください。");
  if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) throw new Error("作業ディレクトリを絶対パスで指定してください。");
  const requested = resolve(path);
  if (mode === "existing") {
    if (!(await stat(requested)).isDirectory()) throw new Error("選択した作業場所はディレクトリではありません。");
    return realpath(requested);
  }
  const parent = await realpath(dirname(requested));
  if (!(await stat(parent)).isDirectory()) throw new Error("新規ディレクトリの親フォルダを選択してください。");
  const target = resolve(parent, basename(requested));
  try { await stat(target); throw new Error("同名の作業場所が既にあります。既存ディレクトリを選ぶか、別名を指定してください。"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (create) await mkdir(target); // Exclusive creation; never overwrite or clear user files.
  return target;
}

interface Workspace { taskId: string; title: string; host: string; path: string; remoteId?: string; }
async function workspace(task: TaskRecord): Promise<Workspace> {
  const r = task.remote, target = r?.preparedTarget;
  if (!r) return { taskId: task.id, title: task.title, host: "local", path: (await realpath(task.cwd)).toLowerCase() };
  return { taskId: task.id, title: task.title, remoteId: r.id,
    host: `${target?.username ?? r.username ?? ""}@${(target?.hostname ?? r.host).toLowerCase()}:${target ? "final" : r.port ?? 22}`,
    path: posix.normalize(target?.cwd ?? r.resolvedCwd ?? r.cwd) };
}
function overlaps(a: Workspace, b: Workspace): boolean {
  if (a.remoteId && a.remoteId === b.remoteId) return true; // One registered SSH session owns one cwd.
  return a.host === b.host && (a.path === b.path || a.path.startsWith(b.path.replace(/\/$/, "") + "/") || b.path.startsWith(a.path.replace(/\/$/, "") + "/"));
}

export class TaskWorkspaces {
  private readonly leases = new Map<string, Workspace>();
  async acquire(task: TaskRecord, livePeers: TaskRecord[] = []): Promise<void> {
    const value = await workspace(task);
    const peers = await Promise.all(livePeers.filter(t => t.id !== task.id).map(workspace));
    // No await between check and set, so simultaneous starts cannot both pass.
    const conflict = [...this.leases.values(), ...peers].find(p => p.taskId !== task.id && overlaps(value, p));
    if (conflict) throw new Error(`「${conflict.title}」と作業ディレクトリが重なっています。その作業・端末を終了するか、別のディレクトリを指定してください。`);
    this.leases.set(task.id, value);
  }
  release(taskId: string): void { this.leases.delete(taskId); }
}
