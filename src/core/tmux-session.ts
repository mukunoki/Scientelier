// Remote terminal persistence only. Work ownership/completion remain in the
// existing supervisor and token-bound receipts; a live pane is never a pass.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, lstat, realpath, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export interface TmuxReceipt { token: string; host: string; socket: string; session: string; directory: string; }
const execute = promisify(execFile);
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
async function json(path: string): Promise<any> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("tmuxの管理記録が不正です。");
  return JSON.parse(await readFile(path, "utf8"));
}
async function location(configPath: string) {
  if (await realpath(configPath) !== configPath) throw new Error("tmux起動記録にリンクがあります。");
  const directory = dirname(configPath), config = await json(configPath);
  if (!/^[0-9a-f-]{36}$/.test(basename(directory)) || typeof config.token !== "string" || !/^[0-9a-f-]{36}$/.test(config.token)
    || config.exitPath !== join(directory, "exit.json")) throw new Error("tmux起動記録を確認できません。");
  const socketDirectory = `/tmp/scientelier-tmux-${process.getuid?.() ?? "user"}`;
  await mkdir(socketDirectory, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
  const info = await lstat(socketDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error("tmuxの保存先が安全な専用フォルダではありません。");
  const receipt: TmuxReceipt = { token: config.token, host: hostname(), directory,
    socket: join(socketDirectory, createHash("sha256").update(directory).digest("hex").slice(0, 24) + ".sock"), session: "sc-" + basename(directory) };
  return { receipt, config };
}
async function command(receipt: TmuxReceipt, args: string[]) {
  // Each run owns a separate socket; never issue commands to the user's server.
  return execute("tmux", ["-S", receipt.socket, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
}
export async function inspectTmuxSession(configPath: string) {
  const { receipt } = await location(configPath);
  const saved = await json(join(receipt.directory, "tmux.json"));
  if (JSON.stringify(saved) !== JSON.stringify(receipt)) throw new Error("tmuxのホスト・実行IDが一致しません。同じ最終マシンへ接続してください。");
  let exit;
  try { exit = await json(join(receipt.directory, "exit.json")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (exit && (exit.token !== receipt.token || exit.host !== receipt.host)) throw new Error("tmuxの終了記録が一致しません。");
  let alive = false;
  try { await command(receipt, ["has-session", "-t", receipt.session]); alive = true; }
  catch (e) { if ((e as { code?: unknown }).code !== 1) throw e; }
  const paneDead = alive ? (await command(receipt,["list-panes","-t",receipt.session,"-F","#{pane_dead}"])).stdout.trim() === "1" : true;
  return { ...receipt, alive, paneDead, exited: !!exit, exitCode: exit?.code ?? 1 };
}
export async function closeTmuxSession(configPath: string): Promise<void> {
  const status = await inspectTmuxSession(configPath);
  if (!status.exited) throw new Error("CLIの終了を確認できず、tmux端末を保持しています。");
  if (status.alive) await command(status,["kill-session","-t",status.session]);
}
export async function startTmuxSession(configPath: string): Promise<TmuxReceipt> {
  const { receipt, config } = await location(configPath);
  // Exclusive receipt prevents a second controller from starting the same run,
  // including after a crash between session creation and acknowledgement.
  await writeFile(join(receipt.directory, "tmux.json"), JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  const file = join(receipt.directory, "tmux.conf");
  await writeFile(file, "set -g remain-on-exit on\nset -g status off\nset -g history-limit 50000\n", { mode: 0o600, flag: "wx" });
  // The supervisor waits for the pipe to be installed before starting the CLI.
  const gated = { ...config, tmuxGate: join(receipt.directory, "tmux-ready.json") };
  const launch = join(receipt.directory, "tmux-launch.json");
  await writeFile(launch, JSON.stringify(gated), { mode: 0o600, flag: "wx" });
  const log = join(receipt.directory, "terminal.raw.log");
  await writeFile(log, "", { mode: 0o600, flag: "wx" });
  const invocation = [process.execPath, join(receipt.directory, "remote-session.js"), launch].map(quote).join(" ");
  await command(receipt, ["-f", file, "new-session", "-d", "-s", receipt.session, "-x", "100", "-y", "30", invocation]);
  await command(receipt, ["pipe-pane", "-O", "-t", receipt.session, `exec cat >> ${quote(log)}`]);
  const temporary = join(receipt.directory, `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ token: receipt.token }), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(receipt.directory, "tmux-ready.json"));
  return receipt;
}

export async function attachTmuxSession(configPath: string): Promise<void> {
  const status = await inspectTmuxSession(configPath);
  if (!status.alive) {
    if (!status.exited) throw new Error("保持したtmux端末がありません。CLIの復旧で終了を確認してください。新しいCLIは起動していません。");
    process.exitCode = status.exitCode; return;
  }
  const child = spawn("tmux", ["-S", status.socket, "attach-session", "-t", status.session], { stdio: "inherit" });
  // Killing this attachment detaches only. Explicit task pause/retirement uses
  // the existing stop.json -> supervisor exit -> lock release handshake.
  const detach = () => child.kill("SIGTERM");
  process.on("SIGTERM", detach); process.on("SIGHUP", detach);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return; checking = true;
    void inspectTmuxSession(configPath).then(s => { if (s.exited) { process.exitCode = s.exitCode; detach(); } })
      .catch(() => { /* Unconfirmed state is never a completion receipt. */ }).finally(() => { checking = false; });
  }, 250);
  try { await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("exit", () => resolve()); }); }
  finally { clearInterval(timer); process.off("SIGTERM", detach); process.off("SIGHUP", detach); }
  // Retain dead-pane history for manual inspection. Only our acknowledged run
  // may be removed later; no kill-server or broad session cleanup is performed.
}
if (require.main === module) void (async () => {
  const [mode, path] = process.argv.slice(2);
  if (!["--start", "--attach"].includes(mode)) throw new Error("Invalid tmux operation");
  if (mode === "--start") await startTmuxSession(path);
  await attachTmuxSession(path);
})().catch(e => { process.stderr.write(`${String(e)}\n`); process.exitCode = 75; });
