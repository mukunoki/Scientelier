import * as pty from "node-pty";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { AGENT_PROFILES, quoteShellArgument as q, type Invocation } from "./adapters";
import { validateRemoteSystem } from "./remote-systems";
import type { RemoteConnection } from "./remote-client";
import type { AgentStatus, RemoteSystem, PreparedTarget } from "./types";
import type { TerminalProcess, ProcessSpec } from "./terminal-runner";
import { remoteModules } from "./remote-modules";

class ForwardedTerminal implements TerminalProcess {
  cols = 100; rows = 30;
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number }) => void)[] = [];
  private decoder = new StringDecoder("utf8");
  private ended?: number;
  constructor(private send: (request: Record<string, unknown>) => void) {}
  onData(listener: (data: string) => void): void { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number }) => void): void { this.exitListeners.push(listener); if (this.ended !== undefined) listener({ exitCode: this.ended }); }
  data(bytes: Buffer): void { if (this.ended === undefined) { const value = this.decoder.write(bytes); for (const listener of this.dataListeners) listener(value); } }
  exit(code: number): void { if (this.ended !== undefined) return; const tail = this.decoder.end(); if (tail) for (const listener of this.dataListeners) listener(tail); this.ended = code; for (const listener of this.exitListeners) listener({ exitCode: code }); }
  write(data: string): void { if (this.ended !== undefined) throw new Error("Terminal exited"); this.send({ op: "terminal:input", data: Buffer.from(data).toString("base64") }); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; if (this.ended === undefined) this.send({ op: "terminal:resize", cols, rows }); }
  kill(signal = "SIGTERM"): void { if (this.ended === undefined) this.send({ op: "terminal:kill", signal }); }
}

export class PreparedRemoteClient implements RemoteConnection {
  tmuxAvailable = false;
  agents: AgentStatus[] = []; connected = false; clockOffset = 0; resolvedCwd?: string; target?: PreparedTarget;
  readonly preparation: TerminalProcess;
  stage: "shell" | "checking" | "ready" | "closed" = "shell";
  lastError = "";
  private transport: pty.IPty;
  private display: ForwardedTerminal;
  private nonce = ""; private buffer = ""; private sequence = 0;
  private preparing?: Promise<AgentStatus[]>;
  private ready?: { resolve: (agents: AgentStatus[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private terminals = new Map<string, ForwardedTerminal>();
  private constructor(readonly system: RemoteSystem, private sources: Record<string, string>, spec: ProcessSpec) {
    this.transport = pty.spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" }, cols: 100, rows: 30, name: "xterm-256color" });
    this.display = new ForwardedTerminal(() => {});
    this.preparation = {
      cols: 100, rows: 30,
      onData: listener => this.display.onData(listener), onExit: listener => this.display.onExit(listener),
      write: data => { if (this.stage !== "shell") throw new Error("確定後は連携専用です。エージェントのターミナルを操作してください。"); this.transport.write(data); },
      resize: (cols, rows) => { this.preparation.cols = cols; this.preparation.rows = rows; this.transport.resize(cols, rows); },
      kill: signal => this.transport.kill(signal)
    };
    this.transport.onData(data => this.receive(data));
    this.transport.onExit(({ exitCode }) => {
      this.stage = "closed"; this.connected = false; this.fail(new Error("準備済みの接続が切れました。自動再ログインはしません。再接続して作業環境を確定してください。"));
      for (const terminal of this.terminals.values()) terminal.exit(255);
      this.terminals.clear(); this.display.exit(exitCode);
    });
  }
  static async create(system: RemoteSystem, directory: string, testSpec?: ProcessSpec): Promise<PreparedRemoteClient> {
    const sources = await remoteModules(directory);
    for (const name of ["prepared-pty", "prepared-server"]) sources[`./${name}`] = await readFile(join(directory, `${name}.js`), "utf8");
    const valid = validateRemoteSystem(system);
    return new PreparedRemoteClient(valid, sources, testSpec ?? { command: "/usr/bin/ssh", args: ["-tt", "-o", "ControlMaster=no", "-o", "ControlPath=none", ...(valid.username ? ["-l", valid.username] : []), ...(valid.port ? ["-p", String(valid.port)] : []), "--", valid.host], cwd: tmpdir() });
  }
  private receive(data: string): void {
    if (this.stage === "shell") { this.display.data(Buffer.from(data)); return; }
    this.buffer += data;
    if (this.buffer.length > 160 * 1024 * 1024) { this.close(); return; }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, ""); this.buffer = this.buffer.slice(index + 1);
      const prefix = `AH_${this.nonce}:`; const start = line.indexOf(prefix);
      if (start < 0) { if (this.stage === "checking") this.lastError = (this.lastError + line + "\n").slice(-2000); continue; }
      let packet: any;
      try { packet = JSON.parse(line.slice(start + prefix.length)); } catch { continue; }
      if (packet.event === "bootstrap") { this.transport.write(Buffer.from(JSON.stringify(this.sources)).toString("base64") + "\n"); continue; }
      if (packet.event === "error") { this.fail(new Error(`作業環境を確定できません：${packet.error}`)); continue; }
      if (packet.event === "stopped") {
        this.stage = "shell"; this.connected = false;
        this.fail(new Error(`${packet.error}${this.lastError ? `\n${this.lastError}` : ""}`));
        for (const terminal of this.terminals.values()) terminal.exit(255);
        this.terminals.clear();
        this.display.data(Buffer.from(`\r\n${this.lastError}\r\nシェルに戻りました。環境を修正してから再度確定できます。\r\n`));
        continue;
      }
      if (packet.event === "ready") {
        const probe = packet.probe;
        this.target = { hostname: probe.hostname, username: probe.username, home: probe.home, cwd: probe.cwd, nodeExecutable: probe.nodeExecutable };
        this.resolvedCwd = probe.cwd; this.clockOffset = probe.now - Date.now();
        this.tmuxAvailable = !!probe.commands.tmux;
        this.agents = AGENT_PROFILES.map(profile => ({ ...profile, executable: probe.commands[profile.command], installed: !!probe.commands[profile.command], error: probe.commands[profile.command] ? undefined : "最終マシンに見つかりません" }));
        this.connected = true; this.stage = "ready"; this.lastError = "";
        this.display.data(Buffer.from(`\r\n[作業環境を確定] ${probe.username}@${probe.hostname}:${probe.cwd}\r\nこの端末は連携専用になりました。エージェントの操作はタスクの実行画面で行えます。\r\n`));
        if (this.ready) { clearTimeout(this.ready.timer); const waiting = this.ready; this.ready = undefined; waiting.resolve(this.agents); }
        continue;
      }
      if (packet.event === "data") { this.terminals.get(packet.session)?.data(Buffer.from(packet.data, "base64")); continue; }
      if (packet.event === "exit") { this.terminals.get(packet.session)?.exit(packet.exitCode); this.terminals.delete(packet.session); continue; }
      const wait = this.pending.get(packet.id);
      if (wait) { this.pending.delete(packet.id); clearTimeout(wait.timer); if (packet.error) wait.reject(Object.assign(new Error(packet.error), { code: packet.code })); else wait.resolve(packet.result); }
    }
  }
  attach(): Promise<AgentStatus[]> {
    if (this.connected) return Promise.resolve(this.agents);
    if (this.preparing) return this.preparing;
    if (this.stage !== "shell") return Promise.reject(new Error("先に接続用ターミナルを開き、最終マシンまでログインしてください。"));
    this.nonce = randomUUID().replace(/-/g, ""); this.buffer = ""; this.lastError = ""; this.stage = "checking";
    // The short loader fits canonical TTY line limits. Do not send the source
    // payload until Node confirms raw mode; otherwise it could become shell input.
    const loader = `const p=${JSON.stringify(`AH_${this.nonce}:`)};const fail=e=>{process.stdout.write(p+JSON.stringify({event:'error',error:String(e)})+'\\n');if(process.stdin.isTTY)process.stdin.setRawMode(false);process.exit(1)};try{if(!process.stdin.isTTY)throw Error('TTY required');process.stdin.setRawMode(true);let b='';const f=d=>{b+=d;if(b.length>2000000)return fail('Bootstrap too large');let i=b.indexOf('\\n');if(i<0)return;process.stdin.off('data',f);try{const s=JSON.parse(Buffer.from(b.slice(0,i),'base64').toString());const c={};const load=n=>{if(!s[n])return require(n);if(c[n])return c[n].exports;const m=c[n]={exports:{}};new Function('require','module','exports',s[n])(load,m,m.exports);return m.exports};void load('./prepared-server').servePrepared(${JSON.stringify(this.nonce)},${JSON.stringify(this.system.pythonCommand ?? "python3")}).catch(fail)}catch(e){fail(e)}};process.stdin.on('data',f);process.stdout.write(p+JSON.stringify({event:'bootstrap'})+'\\n')}catch(e){fail(e)}`;
    const failed = `AH_${this.nonce}:` + JSON.stringify({ event: "stopped", error: "連携プログラムが終了しました。最終マシンでNode.js・Python 3を使える状態にしてから再度確定してください。" });
    const command = `${q(this.system.nodeCommand)} -e ${q(loader)}; printf '%s\\n' ${q(failed)}\r`;
    if (Buffer.byteLength(command) > 3500) { this.stage = "shell"; return Promise.reject(new Error("Nodeコマンドのパスが長すぎます。")); }
    this.preparing = new Promise<AgentStatus[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Do not send more input or kill an uncertain remote shell/process.
        this.lastError = `確定の応答がありません。最終マシンのNode.js・Python 3を確認してください。${this.lastError}`;
        this.fail(new Error(this.lastError));
      }, 30000);
      this.ready = { resolve, reject, timer };
      this.display.data(Buffer.from("\r\n[作業環境を確認しています…]\r\n"));
      this.transport.write(command);
    }).finally(() => { this.preparing = undefined; });
    return this.preparing;
  }
  private fail(error: Error): void {
    this.lastError = error.message;
    if (this.ready) { clearTimeout(this.ready.timer); this.ready.reject(error); this.ready = undefined; }
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(error); } this.pending.clear();
  }
  request(request: Record<string, unknown>): Promise<any> {
    if (!this.connected) return Promise.reject(new Error("最終マシンの作業環境を確定してください。"));
    const id = ++this.sequence;
    const line = `AH_${this.nonce}:` + JSON.stringify({ ...request, id }) + "\n";
    if (line.length > 40 * 1024 * 1024) return Promise.reject(new Error("Request too large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("準備済み環境が応答しません。完了とは扱わず、CLIは強制終了していません。")); }, 60000);
      this.pending.set(id, { resolve, reject, timer }); this.transport.write(line);
    });
  }
  invocation(value: Invocation): Invocation { return value; }
  createTerminal(spec: Invocation): TerminalProcess {
    if (!this.connected) throw new Error("準備済み接続が切れています。");
    const id = randomUUID();
    const terminal = new ForwardedTerminal(request => { void this.request({ ...request, session: id }).catch(e => { terminal.data(Buffer.from(String(e))); terminal.exit(255); }); });
    this.terminals.set(id, terminal);
    queueMicrotask(() => { void this.request({ op: "terminal:start", session: id, spec: { ...spec, cols: terminal.cols, rows: terminal.rows } }).catch(e => { terminal.data(Buffer.from(String(e))); terminal.exit(255); this.terminals.delete(id); }); });
    return terminal;
  }
  async put(path: string, data: Buffer | string, exclusive = false): Promise<void> { await this.request({ op: "put", path, data: Buffer.from(data).toString("base64"), exclusive }); }
  close(): void { this.connected = false; this.fail(new Error("準備済み接続を閉じました。")); this.transport.kill(); }
}
