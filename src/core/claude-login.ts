import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { TerminalProcess } from "./terminal-runner";
import { loginIssue, type LoginIssue } from "./login-issue";

export interface ClaudeLoginStatus {
  loggedIn?: boolean; authMethod?: string; subscriptionType?: string;
  // Connection to a local proxy is not proof of its cloud authentication.
  runtimeReady?: boolean; checkSupported?: boolean;
  checkedAt: string; detail: string;
}
// Return only known, non-secret fields. Neither credentials nor raw status output
// are persisted or sent to the renderer.
export function parseClaudeLoginStatus(output: string): ClaudeLoginStatus {
  const value = JSON.parse(output);
  if (!value || typeof value.loggedIn !== "boolean") throw new Error("Invalid authentication status");
  const field = (key: string) => typeof value[key] === "string" && /^[\w ./-]{1,80}$/.test(value[key]) ? value[key] as string : undefined;
  return { loggedIn: value.loggedIn, authMethod: field("authMethod"), subscriptionType: field("subscriptionType"),
    checkedAt: new Date().toISOString(), detail: value.loggedIn
      ? "CLIはログイン済みと報告しています。使用量APIの認証成功とは別です。"
      : "Claude Codeにログインしていません。" };
}
export async function readClaudeLoginStatus(executable: string, cwd: string): Promise<ClaudeLoginStatus> {
  try {
    const result = await promisify(execFile)(executable, ["auth", "status"], { cwd, timeout: 10000, maxBuffer: 64000 });
    return parseClaudeLoginStatus(result.stdout);
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 1 && typeof failure.stdout === "string") {
      try { return parseClaudeLoginStatus(failure.stdout); } catch { /* Generic failure below. */ }
    }
    return { checkedAt: new Date().toISOString(), detail: "認証状態を確認できません。CLIの版・設定・接続を確認してください。" };
  }
}

export function isClaudeAuthorizationFailure(message?: string): boolean {
  return !!message && /Claude usage authorization failed|Claude usage unavailable\. Sign in|Claude使用量APIの認証/.test(message);
}

// Dedicated login PTY, never a task/agent terminal. No disk logs or history,
// no shell interpolation, no model prompt, no automatic logout/token refresh.
export class ClaudeLoginSession {
  private session?: { id: string; process: TerminalProcess; data: string; offset: number; alive: boolean; exitCode?: number; loginProvider: string; issue?: LoginIssue };
  constructor(private spawn: (executable: string, args: string[], cwd: string) => TerminalProcess,
    private provider: "claude" | "codex" | "opencode" | "antigravity" = "claude") {}
  start(executable: string, cwd: string, loginProvider: "zai-coding-plan" | "ollama-cloud" = "zai-coding-plan"): string {
    if (!["zai-coding-plan", "ollama-cloud"].includes(loginProvider)) throw new Error("認証先が不正です。");
    return this.startCommand(executable, this.provider === "antigravity" ? [] : this.provider === "codex" ? ["login"] : this.provider === "opencode" ? ["auth", "login", "--provider", loginProvider] : ["auth", "login"], cwd, loginProvider);
  }
  // Used only by trusted application code for a user-operated OpenCode CLI.
  // Reuse the same PTY lifecycle, without interpreting terminal output as task work.
  startCommand(executable: string, args: string[], cwd: string, loginProvider: string): string {
    if (this.session?.alive) {
      if (this.session.loginProvider !== loginProvider) throw new Error("別の接続先のログイン操作中です。閉じてから切り替えてください。");
      return this.session.id;
    }
    this.close();
    const child = this.spawn(executable, args, cwd);
    const session = { id: randomUUID(), process: child, data: "", offset: 0, alive: true, exitCode: undefined as number | undefined, loginProvider, issue: undefined as LoginIssue | undefined };
    this.session = session;
    child.onData(data => {
      if (this.session !== session) return;
      session.data = (session.data + data).slice(-64000); session.offset += data.length;
      const issue = loginIssue(this.provider, session.data);
      if (issue && (!session.issue || issue.code === "unsupported-client")) session.issue = issue;
    });
    child.onExit(event => { session.alive = false; session.exitCode = event.exitCode; });
    return session.id;
  }
  snapshot(id: string) {
    const s = this.require(id);
    return { data: s.data, offset: s.offset, alive: s.alive, exitCode: s.exitCode, issue: s.issue };
  }
  currentIssue(): LoginIssue | undefined { return this.session?.issue; }
  activeId(): string | undefined { return this.session?.alive ? this.session.id : undefined; }
  input(id: string, data: string): void {
    const s = this.require(id);
    if (!s.alive || typeof data !== "string" || data.length > 16000) throw new Error("ログイン端末に入力できません。");
    s.process.write(data);
  }
  resize(id: string, cols: number, rows: number): void {
    const s = this.require(id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) throw new Error("Invalid terminal size");
    if (s.alive) s.process.resize(cols, rows);
  }
  close(id?: string): void {
    if (id) this.require(id);
    const s = this.session; this.session = undefined;
    if (s) { s.data = ""; if (s.alive) { try { s.process.kill(); } catch { /* Already exited. */ } } }
  }
  private require(id: string) {
    if (!this.session || this.session.id !== id) throw new Error("ログイン端末は終了しています。");
    return this.session;
  }
}
