import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { promisify } from "node:util";

export interface DiagnosticCheck { name: string; ok: boolean; detail: string; }
export interface RemoteDiagnostic { platform: string; kernel: string; cwd: string; checks: DiagnosticCheck[]; codexPermissions?: "sandbox" | "full-access"; }

// Self-contained: shipped in memory to the already-connected final machine.
// No LLM requests, config writes, privilege escalation, installs or job submission.
export async function collectRemoteDiagnostics(codex: string, isCodex = true, fullAccess = false): Promise<RemoteDiagnostic> {
  const checks: DiagnosticCheck[] = [];
  const run = async (name: string, command: string, args: string[]) => {
    try {
      const r = await promisify(execFile)(command, args, { timeout: 8000, maxBuffer: 64000, killSignal: "SIGKILL" });
      checks.push({ name, ok: true, detail: (r.stdout + r.stderr).trim().slice(-6000) || "成功" });
    } catch (e) {
      const error = e as Error & { stdout?: string; stderr?: string; code?: unknown };
      checks.push({ name, ok: false, detail: `${error.code ?? "error"}: ${error.stderr || error.stdout || error.message}`.trim().slice(-6000) });
    }
  };
  await run("通常コマンド（/usr/bin/true）", "/usr/bin/true", []);
  await run(isCodex ? "Codexのバージョン" : "CLIのバージョン", codex, ["--version"]);
  if (isCodex && !fullAccess && process.platform === "linux") {
    for (const path of ["/etc/os-release", "/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "/proc/sys/user/max_user_namespaces", "/proc/self/attr/current"]) {
      try { checks.push({ name: path, ok: true, detail: (await readFile(path, "utf8")).trim().slice(0, 2000) }); }
      catch { checks.push({ name: path, ok: false, detail: "取得できません（不存在・権限制限など。無効とは断定できません）" }); }
    }
    await run("PATH上のbubblewrap", "/bin/sh", ["-c", "command -v bwrap"]);
    await run("ユーザ名前空間の作成テスト", "unshare", ["-Ur", "--", "/usr/bin/true"]);
    await run("Codex 読み取り専用サンドボックス", codex, ["sandbox", "linux", "-c", 'sandbox_mode="read-only"', "--", "/usr/bin/true"]);
    await run("Codex 作業用サンドボックス（実行するのは/usr/bin/trueだけ）", codex, ["sandbox", "linux", "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true", "--", "/usr/bin/true"]);
  }
  return { platform: process.platform, kernel: release(), cwd: process.cwd(), checks,
    ...(isCodex ? { codexPermissions: fullAccess ? "full-access" as const : "sandbox" as const } : {}) };
}
