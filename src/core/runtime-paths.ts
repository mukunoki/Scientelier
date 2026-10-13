import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";

/** Follow existing ancestors too, so a not-yet-created profile cannot hide
 * inside the source tree behind a symlink. No profile is copied or migrated. */
function physicalPath(path: string): string {
  const missing: string[] = [];
  let base = resolve(path);
  while (!existsSync(base)) {
    const parent = resolve(base, "..");
    if (parent === base) break;
    missing.unshift(relative(parent, base)); base = parent;
  }
  return join(realpathSync(base), ...missing);
}

export function runtimePaths(appData: string, documents: string, sourceRoot: string, dataOverride?: string): { userData: string; reports: string } {
  if (dataOverride !== undefined && (!dataOverride.trim() || !isAbsolute(dataOverride)))
    throw new Error("SCIENTELIER_DATA_DIR はソース外の絶対パスで指定してください。");
  const userData = resolve(dataOverride ?? join(appData, "agent-harness"));
  const rel = relative(physicalPath(sourceRoot), physicalPath(userData));
  if (rel === "" || !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    throw new Error("設定・タスクの保存先をソースやアプリの内部には指定できません。");
  return { userData, reports: dataOverride ? join(userData, "reports") : join(documents, "Agent Harness Reports") };
}
