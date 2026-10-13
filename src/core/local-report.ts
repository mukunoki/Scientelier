import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ReportSettings, TaskRecord, WorkUnit } from "./types";
import { remoteReportRoot, remoteWorkingDirectory, type RemoteConnection } from "./remote-client";
import { isInternalReportEntry } from "./report-files";

export function localReportUnit(task: TaskRecord, unit: WorkUnit, settings: ReportSettings): boolean {
  // Explicit legacy mode only; current settings always use the task workspace.
  return !!task.remote && unit.role === "reporter" && settings.remoteExecution === "local";
}
export function localReportTask(task: TaskRecord): TaskRecord {
  if (!task.report?.texPath) throw new Error("ローカルレポートの原稿がありません。");
  return { ...task, remote: undefined, cwd: dirname(task.report.texPath) };
}

// A new directory protects remote edits and partial local work. Callers commit
// the returned ID only after the full snapshot has been published successfully.
export async function publishLocalReport(client: RemoteConnection, task: TaskRecord): Promise<string> {
  if (!task.report?.texPath) throw new Error("転送するレポート原稿がありません。");
  const id = randomUUID(), root = dirname(task.report.texPath);
  const destination = relative(remoteWorkingDirectory(task), remoteReportRoot({ ...task, report: { ...task.report, remoteSnapshotId: id } }));
  let bytes = 0, count = 0;
  const files: Array<{ path: string; name: string }> = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("レポート転送対象のリンクは使用できません。必要なファイルをレポート内に配置してください。");
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) {
        if (isInternalReportEntry(task.report!, entry) || [".harness-seeded", ".git"].includes(entry)) continue;
        await visit(join(path, entry));
      }
    } else if (info.isFile()) {
      if (++count > 5000 || info.size > 20 * 1024 * 1024 || (bytes += info.size) > 250 * 1024 * 1024) throw new Error("レポート転送上限（5,000ファイル・1ファイル20MB・合計250MB）を超えました。");
      files.push({ path, name: relative(root, path) });
    } else throw new Error("通常ファイル以外はレポートに転送できません。");
  };
  await visit(root);
  for (const file of files) await client.put(`${destination}/${file.name}`, await readFile(file.path), true);
  await client.put(`${destination}/.harness-seeded`, "Locally built report snapshot.\n", true);
  return id;
}
