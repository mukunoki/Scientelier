import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReportRecord } from "./types";

export const LEGACY_REPORT_INTERNAL_NAMES = new Set(["versions", "logs", "all-agents.log"]);

/** In isolated reports these names belong to the user, not the harness. */
export function isInternalReportEntry(report: ReportRecord, name: string): boolean {
  return name === ".git" || name === ".tex-cache" || name === ".agent-harness" || (report.storageLayout !== "isolated" && LEGACY_REPORT_INTERNAL_NAMES.has(name));
}

/** Copy without modifying the source. Migration preserves PDF freshness; a restart does not. */
export async function copyReportFiles(report: ReportRecord | undefined, destination: string, preserveState = false): Promise<ReportRecord | undefined> {
  if (!report?.texPath) return undefined;
  const root = dirname(report.texPath);
  try { await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const skip = (name: string) => isInternalReportEntry(report, name) || name === "restart-context.json";
  let bytes = 0, count = 0;
  const inspect = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("引き継ぐ報告書フォルダにリンクまたは特殊ファイルがあります。通常ファイルへ整理してください。");
    if (++count > 5000 || (bytes += info.size) > 250 * 1024 * 1024) throw new Error("報告書の引き継ぎ対象が大きすぎます（250MB・5000項目まで）。");
    if (info.isDirectory()) for (const entry of await readdir(path)) if (!skip(entry)) await inspect(join(path, entry));
  };
  await inspect(root);
  const relocate = (path?: string): string | undefined => {
    if (!path) return undefined;
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("報告書のパスが保存先の外を参照しています。");
    return join(destination, rel);
  };
  const remap = (value: ReportRecord): ReportRecord => ({
    ...(preserveState ? value : { state: "draft" as const, storageLayout: value.storageLayout }),
    texPath: relocate(value.texPath), pdfPath: relocate(value.pdfPath),
    ...(preserveState && value.previewUrl && value.pdfPath ? { previewUrl: pathToFileURL(relocate(value.pdfPath)!).toString() } : {}),
    ...(value.documents ? { documents: Object.fromEntries(Object.entries(value.documents).map(([id, doc]) => [id, remap(doc!)])) } : {})
  });
  const mapped = remap(report);
  // Capture entries BEFORE reserving a child destination, so a migration can
  // never recursively copy its own destination. Existing targets are never used.
  const entries = (await readdir(root)).filter(entry => !skip(entry));
  await mkdir(destination, { recursive: false });
  try {
    for (const entry of entries) await cp(join(root, entry), join(destination, entry), {
      recursive: true, errorOnExist: true, force: false, preserveTimestamps: true,
      filter: path => !relative(root, path).split(/[\\/]/).some(skip)
    });
    return mapped;
  } catch (error) {
    // Only this operation's exclusive destination is removed on failure.
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
