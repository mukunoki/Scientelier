import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, lstat, writeFile } from "node:fs/promises";
import { installAntigravityUsage, readAntigravityUsage } from "./antigravity-usage";

function locations(home: string) {
  const directory = join(home, ".agent-harness", "service-usage");
  return { directory, script: join(directory, "antigravity-status.cjs"), snapshot: join(directory, "antigravity-quota.json") };
}
export async function readRemoteAntigravityUsage(home = homedir()) {
  const result = await readAntigravityUsage(locations(home).snapshot);
  return result ?? { error: "遠隔のUsage観測がありません。Usage連携を有効化し、CLIを開き直して /usage を実行してください。" };
}
export async function installRemoteAntigravityUsage(source: string, home = homedir(), executable = process.execPath) {
  const paths = locations(home);
  // The script is shipped with this app, never taken from a terminal response.
  for (const directory of [join(home, ".agent-harness"), paths.directory]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Usage保存先にリンクがあります。");
  }
  try { const info = await lstat(paths.script); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Usageスクリプトの保存先が通常ファイルではありません。"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await writeFile(paths.script, source, { mode: 0o600 });
  await installAntigravityUsage(home, paths.script, executable, paths.snapshot);
  return "Usage連携を保存しました。Antigravityを開き直し、CLIで /usage を実行してから「認証・使用枠を更新」を押してください。既存の設定はバックアップしています。";
}
