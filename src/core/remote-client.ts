import { spawn, type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, mkdir, lstat, readdir, utimes, rename, rm } from "node:fs/promises";
import { join, dirname, relative, isAbsolute, posix } from "node:path";
import { tmpdir } from "node:os";
import { quoteShellArgument as q, AGENT_PROFILES, type Invocation } from "./adapters";
import { validateRemoteSystem } from "./remote-systems";
import type { AgentStatus, RemoteSystem, TaskRecord } from "./types";
import type { ProcessSpec } from "./terminal-runner";
import { isInternalReportEntry, LEGACY_REPORT_INTERNAL_NAMES } from "./report-files";
import { remoteModules, remoteModuleLoader } from "./remote-modules";

export interface RemoteConnection {
  system: RemoteSystem; agents: AgentStatus[]; connected: boolean; clockOffset: number; resolvedCwd?: string;
  tmuxAvailable?: boolean;
  request(request: Record<string, unknown>): Promise<any>;
  put(path: string, data: Buffer | string, exclusive?: boolean): Promise<void>;
  attach(): Promise<AgentStatus[]>;
  invocation(value: Invocation): Invocation;
  close(): void;
}

export class RemoteClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  agents: AgentStatus[] = [];
  connected = false;
  clockOffset = 0;
  resolvedCwd?: string;
  tmuxAvailable = false;
  private constructor(readonly system: RemoteSystem, readonly socket: string, readonly bridgeSource: string,
    private ssh = { command: "/usr/bin/ssh", prefix: [] as string[] }) {}
  static async create(system: RemoteSystem, coreDirectory: string, ssh?: { command: string; prefix: string[] }): Promise<RemoteClient> {
    const directory = await mkdtemp(join(tmpdir(), "ah-ssh-"));
    return new RemoteClient(validateRemoteSystem(system), join(directory, "socket"), remoteModuleLoader(await remoteModules(coreDirectory)), ssh);
  }
  masterSpec(): ProcessSpec {
    return { command: this.ssh.command, args: [...this.ssh.prefix, "-M", "-N", "-S", this.socket, "-o", "ControlPersist=no", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", ...this.destination()], cwd: tmpdir() };
  }
  private destination(): string[] {
    return [...(this.system.username ? ["-l", this.system.username] : []), ...(this.system.port ? ["-p", String(this.system.port)] : []), "--", this.system.host];
  }
  private args(tty: boolean): string[] {
    // ProxyCommand=false prevents a silent fresh network login if the master dies.
    return [...this.ssh.prefix, "-S", this.socket, "-o", "ControlMaster=no", "-o", "BatchMode=yes", "-o", "ProxyCommand=false", tty ? "-tt" : "-T", ...this.destination()];
  }
  shell(command: string, enterWorkspace = true): string {
    return `/bin/bash -lc ${q(`set -e\n${this.system.startup}\n${enterWorkspace && this.resolvedCwd ? `cd -- ${q(this.resolvedCwd)}\n` : ""}${command}`)}`;
  }
  async attach(): Promise<AgentStatus[]> {
    await promisify(execFile)(this.ssh.command, [...this.ssh.prefix, "-S", this.socket, "-O", "check", ...this.destination()], { timeout: 5000 });
    if (this.connected) return this.agents;
    const source = `${this.bridgeSource}\nvoid load('./remote-bridge').serveRemoteWorkspace(${JSON.stringify(this.system.cwd)}).catch(error => { process.stderr.write(String(error) + "\\n"); process.exitCode = 1; });`;
    const child = spawn(this.ssh.command, [...this.args(false), this.shell(`exec ${q(this.system.nodeCommand)} -e ${q(source)}`, false)], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child; this.buffer = "";
    let errors = "";
    child.stderr.on("data", data => { errors = (errors + data.toString()).slice(-2000); });
    child.stdout.on("data", data => {
      this.buffer += data.toString();
      if (this.buffer.length > 145 * 1024 * 1024) { this.close(); return; }
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        try {
          const message = JSON.parse(line); const wait = this.pending.get(message.id);
          if (!wait) continue;
          this.pending.delete(message.id); clearTimeout(wait.timer);
          if (message.error) wait.reject(Object.assign(new Error(message.error), { code: message.code })); else wait.resolve(message.result);
        } catch { /* Login banners are not protocol messages. */ }
      }
    });
    const fail = () => {
      if (this.child !== child) return;
      this.connected = false;
      for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(`遠隔接続が終了しました。${errors}`)); }
      this.pending.clear();
    };
    child.on("error", fail); child.on("exit", fail);
    try {
      const probe = await this.request({ op: "probe" });
      this.clockOffset = probe.now - Date.now();
      if (Number(probe.node.replace(/^v/, "").split(".")[0]) < 18) throw new Error("遠隔Node.js 18以上が必要です。");
      this.resolvedCwd = probe.cwd;
      this.tmuxAvailable = !!probe.commands.tmux;
      this.agents = AGENT_PROFILES.map(profile => ({ ...profile, executable: probe.commands[profile.command], installed: !!probe.commands[profile.command], error: probe.commands[profile.command] ? undefined : "遠隔に見つかりません" }));
      this.connected = true; return this.agents;
    } catch (e) { this.close(); throw e; }
  }
  request(request: Record<string, unknown>): Promise<any> {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return Promise.reject(new Error("システム設定でSSH接続・環境確認を行ってください。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("遠隔のファイル操作が応答しません。CLIは強制終了していません。")); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ ...request, id }) + "\n", error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  invocation(value: Invocation): Invocation {
    if (!this.connected || !this.resolvedCwd) throw new Error("SSH認証後に環境確認を行い、作業フォルダを確定してください。");
    return { command: this.ssh.command, args: [...this.args(true), this.shell(`exec ${[value.command, ...value.args].map(q).join(" ")}`)], cwd: tmpdir() };
  }
  close(): void {
    this.connected = false; this.child?.stdin.end(); this.child?.kill();
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error("遠隔接続が閉じられました。")); }
    this.pending.clear();
  }
  async put(path: string, data: Buffer | string, exclusive = false): Promise<void> {
    await this.request({ op: "put", path, data: Buffer.from(data).toString("base64"), exclusive });
  }
}

export function remoteWorkingDirectory(task: TaskRecord): string {
  const path = task.remote?.resolvedCwd ?? task.remote?.cwd;
  if (!path || !posix.isAbsolute(path)) throw new Error("遠隔作業フォルダが未確定です。環境確認を行ってください。");
  return path;
}
export function remoteRoot(task: TaskRecord): string { return posix.join(remoteWorkingDirectory(task), ".agent-harness", task.id); }
export function remoteReportRoot(task: TaskRecord): string {
  const snapshot = task.report?.remoteSnapshotId;
  if (snapshot !== undefined && !/^[0-9a-f-]{36}$/.test(snapshot)) throw new Error("遠隔レポートの版が不正です。");
  return posix.join(remoteRoot(task), ...(snapshot ? ["local-reports", snapshot] : ["report"]));
}
export function mapRemoteText(text: string, task: TaskRecord, toRemote: boolean): string {
  const pairs = [[task.cwd, remoteWorkingDirectory(task)], ...(task.report?.texPath ? [[dirname(task.report.texPath), remoteReportRoot(task)]] : [])];
  const ordered = pairs.map(p => toRemote ? p : [p[1], p[0]]).sort((a, b) => b[0].length - a[0].length);
  // One pass, longest root first; never remap the replacement itself.
  const escaped = ordered.map(p => p[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`(?:${escaped.join("|")})(?=$|/|[\\s"'\\]}),;])`, "g"), match => ordered.find(p => p[0] === match)![1]);
}

export async function uploadReport(client: RemoteConnection, task: TaskRecord): Promise<void> {
  if (!task.report?.texPath) return;
  if (task.report.remoteSnapshotId) {
    await client.request({ op: "read", path: `${remoteReportRoot(task)}/.harness-seeded`, maxBytes: 100 });
    return;
  }
  const marker = `.agent-harness/${task.id}/report/.harness-seeded`;
  try { await client.request({ op: "read", path: marker, maxBytes: 100 }); return; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const root = dirname(task.report.texPath); let bytes = 0; let count = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (isInternalReportEntry(task.report!, entry.name) || entry.name === ".harness-seeded") continue;
      const file = join(directory, entry.name); const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("報告書の転送対象にリンクがあります。");
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        if (++count > 5000 || (bytes += info.size) > 250 * 1024 * 1024) throw new Error("報告書の転送対象が大きすぎます。");
        await client.put(`.agent-harness/${task.id}/report/${relative(root, file)}`, await readFile(file), true);
      } else throw new Error("報告書の転送対象に特殊ファイルがあります。");
    }
  };
  await visit(root);
  await client.put(marker, "Remote files are authoritative.\n", true);
}

export async function downloadRemoteFile(client: RemoteConnection, remotePath: string, destination: string, localRoot: string, maxBytes = 100 * 1024 * 1024, options: { replaceReportLink?: boolean } = {}): Promise<void> {
  const rel = relative(localRoot, destination);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("取得先がローカル保存領域外です。");
  let directory = localRoot;
  const rootInfo = await lstat(localRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("取得先にリンクがあります。");
  for (const part of rel.split("/").slice(0, -1)) {
    directory = join(directory, part); await mkdir(directory, { recursive: true });
    const info = await lstat(directory); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("取得先にリンクがあります。");
  }
  const checkDestination = async (): Promise<void> => {
    try {
      const info = await lstat(destination);
      // Only the isolated report cache may replace a leaf link. Never follow
      // it: its target may be another page, a directory, or outside this task.
      if (info.isSymbolicLink() && options.replaceReportLink) return;
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`取得先が通常ファイルではありません：${destination}`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  };
  await checkDestination();
  const value = await client.request({ op: "read", path: remotePath, maxBytes });
  // Recheck ancestors after the network wait before creating any local data.
  directory = localRoot;
  for (const part of ["", ...rel.split("/").slice(0, -1)]) {
    directory = join(directory, part);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`取得先にリンクまたは通常のフォルダでない項目があります：${directory}`);
  }
  const staging = await mkdtemp(join(dirname(destination), ".harness-download-"));
  try {
    const file = join(staging, "content");
    await writeFile(file, Buffer.from(value.data, "base64"), { mode: 0o600, flag: "wx" });
    await utimes(file, new Date(), new Date(value.mtimeMs - client.clockOffset));
    await checkDestination();
    // Atomic replacement preserves the old file/link if fetching or staging
    // fails, and never writes through a destination link or hard link.
    await rename(file, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function downloadReport(client: RemoteConnection, task: TaskRecord): Promise<void> {
  if (!task.report?.texPath) return;
  const root = dirname(task.report.texPath);
  const files = await client.request({ op: "list", path: remoteReportRoot(task) }) as string[];
  // Preflight every path before writing anything. Legacy mixed storage still
  // needs protection; isolated storage has no harness-owned artifact names.
  for (const file of files) {
    if (!file || posix.isAbsolute(file) || file.split("/").some(part => !part || part === "." || part === "..")) throw new Error("遠隔レポートのファイル名が不正です。");
    if (task.report.storageLayout !== "isolated" && LEGACY_REPORT_INTERNAL_NAMES.has(file.split("/")[0])) throw new Error(`遠隔レポートの「${file}」は旧保存領域の内部ログと重なります。アプリを更新して成果物の保存領域を分離してください。`);
  }
  for (const file of files) {
    if(file.split("/").some(part => part === ".agent-harness" || part === ".git")) continue;
    try {
      await downloadRemoteFile(client, posix.join(remoteReportRoot(task), file), join(root, file), root, undefined, {
        replaceReportLink: task.report.storageLayout === "isolated"
      });
    } catch (error) {
      throw new Error(`遠隔レポートのローカル取得に失敗しました（${file}）。保存先：${join(root, file)}。${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
