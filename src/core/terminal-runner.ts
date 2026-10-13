import * as pty from "node-pty";
import { readFile, lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecrets } from "./redact";
import { TerminalScreen } from "./terminal-screen";
import { WorkspaceTrust, isWorkspaceTrustPrompt, type WorkspaceTrustAgent } from "./workspace-trust";
import { terminalQuota, exitedQuota } from "./cli-quota";
import { nativeCliFailure, validCliFailure, type CliFailure } from "./cli-transient-failure";
import type { AgentId } from "./types";
import type { RateLimitObservation } from "./usage-tracker";

export interface ProcessSpec { command: string; args: string[]; cwd: string; }
export interface ProcessOutput { stream: "stdout" | "stderr" | "status"; text: string; }
export interface ProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; }
export interface TerminalProcess {
  pid?: number; cols: number; rows: number;
  write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
}

export interface Handoff { status: "completed" | "rate-limited" | "blocked"; summary: string; sessionId?: string; failure?: CliFailure; }
export interface TerminalSnapshot {
  pid?: number;
  data: string; offset: number; cols: number; rows: number;
  alive: boolean; awaitingHandoff: boolean; inputAllowed: boolean;
  notificationIssue?: string;
  startupIssue?: string;
}
export interface TerminalResult extends ProcessResult { handoff?: Handoff; rateLimit?: RateLimitObservation; stopUnconfirmed?: boolean; processId?: number; connectionLost?: boolean; }
export interface TerminalControl {
  path: string; token: string; agentId?: AgentId;
  /** Explicit launch cwd, not a parent whitelist. Never set for login shells. */
  workspaceTrust?: { agent: WorkspaceTrustAgent; directory: string };
  /** File-based completion must have its required scoped results first. */
  validateNotification?: (handoff: Handoff) => Promise<void>;
  /** Trusted submission-only guidance; never includes model-supplied file text. */
  notificationRepairPrompt?: string;
  /** Remote supervisor must confirm child exit AND release its execution lock. */
  stopForHandoff?: () => Promise<void>;
  /** Flush a remote notification before classifying a naturally exited PTY. */
  syncHandoff?: () => Promise<void>;
  /** A scoped supervisor receipt may explain why the CLI never started. */
  exitFailure?: () => Promise<string | undefined>;
  /** tmux attachment loss is not CLI exit. Do not retire a retained writer. */
  connectionLost?: () => Promise<boolean>;
}
interface Session {
  output: (event: ProcessOutput) => void;
  remoteCancellation?: boolean;
  startupTrust?: WorkspaceTrust;
  startupSize?: { cols: number; rows: number };
  startupScreen?: TerminalScreen;
  startupTimer?: NodeJS.Timeout;
  startupIssue?: string;
  quotaScreen?: TerminalScreen;
  failureTimer?: NodeJS.Timeout;
  failureSuppressed?: boolean;
  stopping?: boolean;
  managed: boolean;
  stopForHandoff: (handoff: Handoff, observation?: RateLimitObservation) => void;
  process: TerminalProcess; data: string; offset: number; alive: boolean;
  settled: boolean; cancelled: boolean; timer?: NodeJS.Timeout;
  notificationIssue?: string; notificationRepairDisabled?: boolean;
  finish: (result: TerminalResult) => void;
}
const REPLAY_LIMIT = 1024 * 1024;

/** xterm sends protocol replies through onData, just like keyboard input.
 * Only complete known replies are exempt; a mixed reply/key or an unknown
 * escape sequence still cancels automated input. In particular OSC 10/11
 * color replies are emitted during Antigravity's native startup handshake. */
export function isTerminalDeviceReply(data: string): boolean {
  return /^(?:\x1b\[(?:[?>]?[0-9;]*c|\??[0-9]+;[0-9]+R|0n|\??[0-9]+;[0-4]\$y|8;[0-9]+;[0-9]+t|[IO])|\x1b\](?:1[012]|4;(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2}));rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\))+$/.test(data);
}

/** Restore the user's terminal size after a startup-only wide redraw. */
function restoreStartupSize(session: Session): void {
  const size = session.startupSize;
  session.startupSize = undefined;
  if (!size || !session.alive) return;
  session.startupScreen?.resize(size.cols, size.rows);
  session.quotaScreen?.resize(size.cols, size.rows);
  try { session.process.resize(size.cols, size.rows); } catch { /* Disconnected PTY. */ }
}

export function notificationIssue(value: unknown, token: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "完了通知がJSONオブジェクトではありません。";
  const v = value as { token?: unknown; status?: unknown; summary?: unknown };
  if (v.status === "ready" || v.status === "needs-work" || v.status === "ask-user") return "作業結果と完了通知が混同されています。作業結果は --submit、完了通知は --finish で送ってください。";
  if (v.token !== token) return "完了通知の担当識別子がない、または別の担当のものです。今回の指示にある --finish を使用してください。";
  try { validateHandoff(value); } catch { return "完了通知の状態または要約が不正です。今回の指示にある --finish を使用してください。"; }
}

/** Only a known idle Antigravity footer is safe for automated prompt entry.
 * Unknown screens, streaming responses and approvals never receive input. */
export function antigravitySubmissionIdle(screen: string): boolean {
  const footer = screen.split(/\r?\n/).slice(-5).join("\n");
  return /\?\s+for shortcuts/.test(footer) && !/esc to cancel|generating|running|allow|approve|permission|yes\s*\/\s*no/i.test(footer);
}

export function validateHandoff(value: unknown): Handoff {
  const candidate = value as Partial<Handoff> | null;
  if (!candidate || !["completed", "rate-limited", "blocked"].includes(candidate.status ?? "")
    || typeof candidate.summary !== "string" || !candidate.summary.trim() || candidate.summary.length > 64000) {
    throw new Error("引継ぎには結果と要約（1〜64000文字）が必要です。");
  }
  const sessionId = typeof candidate.sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.sessionId) ? candidate.sessionId : undefined;
  return { status: candidate.status!, summary: redactSecrets(candidate.summary.trim()), ...(sessionId ? { sessionId } : {}),
    ...(candidate.status === "blocked" && validCliFailure(candidate.failure)
      ? { failure: { kind: candidate.failure.kind, summary: redactSecrets(candidate.failure.summary.trim()) } } : {}) };
}

// The PTY is the execution transport, not a second shell watching a piped process.
// Managed task handoffs retire the CLI before releasing the workflow. Unmanaged
// login/SSH shells have a separate lifetime and are not retired by task results.
export class TerminalRunner {
  private readonly sessions = new Map<string, Session>();

  run(id: string, spec: ProcessSpec, onOutput: (event: ProcessOutput & { offset?: number }) => void,
    control?: TerminalControl): Promise<TerminalResult> {
    if (this.sessions.has(id)) throw new Error("Terminal already exists.");
    const child = pty.spawn(spec.command, spec.args, {
      cwd: spec.cwd, env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      name: "xterm-256color", cols: 100, rows: 30
    });
    return this.runProcess(id, child, onOutput, control);
  }

  runProcess(id: string, child: TerminalProcess, onOutput: (event: ProcessOutput & { offset?: number }) => void,
    control?: TerminalControl): Promise<TerminalResult> {
    if (this.sessions.has(id)) throw new Error("Terminal already exists.");
    return new Promise((resolve) => {
      const startupTrust = control?.workspaceTrust && (!control.agentId || control.agentId === control.workspaceTrust.agent)
        ? new WorkspaceTrust(control.workspaceTrust.agent, control.workspaceTrust.directory) : undefined;
      let exited: (() => void) | undefined;
      let notificationFingerprint = "", stableSince = 0, announcedFingerprint = "", repairFingerprint = "", repairAttempts = 0;
      let submissionIdle = false;
      let failureFingerprint = "";
      const session: Session = { output: onOutput, managed: !!control, remoteCancellation: !!control?.connectionLost, stopForHandoff: (handoff, observation) => {
        if (session.settled || session.stopping) return;
        session.stopping = true;
        startupTrust?.disable();
        restoreStartupSize(session);
        clearTimeout(session.startupTimer);
        clearTimeout(session.failureTimer);
        session.quotaScreen?.dispose();
        clearInterval(session.timer);
        onOutput({stream:"status",text:"Terminal retiring: 担当の終了を確認しています。完了するまで次の担当は開始しません。"});
        void (async () => {
          try {
            if (control) await writeFile(join(dirname(control.path), "retired.json"), JSON.stringify({token:control.token}), {mode:0o600});
            if (control?.stopForHandoff) await control.stopForHandoff();
            else if (session.alive) await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("前のCLIの終了を確認できません。二重実行を防ぐため引き継ぎを保留します。")), 10000);
              exited = () => { clearTimeout(timer); resolve(); };
              // This follows an explicit final/error handoff, never a work-duration limit.
              try { child.kill("SIGTERM"); } catch (error) { clearTimeout(timer); reject(error); }
            });
            session.finish({exitCode:0,signal:session.cancelled?"SIGTERM":null,stdout:session.data,stderr:"",
              ...(session.cancelled ? {} : {handoff,rateLimit:observation})});
          } catch (error) {
            // Keep the screen, but never reopen stdin on a retired execution.
            session.finish({exitCode:1,signal:session.cancelled?"SIGTERM":null,stdout:session.data,stderr:String(error),
              stopUnconfirmed:true,processId:child.pid,
              handoff:{status:"blocked",summary:`前の担当の停止確認に失敗しました。代替AI・再計画は開始できません。${String(error)}`}});
          }
        })();
      }, startupTrust, startupScreen: startupTrust ? new TerminalScreen(screen => {
        if (!session.alive || session.cancelled || session.settled || session.stopping) return;
        clearTimeout(session.startupTimer);
        if (startupTrust.finished) { restoreStartupSize(session); return; }
        // Native confirmation dialogs ignore keys immediately after appearing.
        // Wait for a stable current frame, then validate before either key.
        // A redraw, human input, instruction receipt or retirement cancels it.
        session.startupTimer = setTimeout(() => {
          if (!session.alive || session.cancelled || session.settled || session.stopping) return;
          const action = startupTrust.inspect(screen, session.process.cols);
          if (action) {
            // SSH/PTY loss can race the alive flag. Never let a startup key
            // failure escape the timer or retry it against another prompt.
            try {
              if (typeof action === "string") child.write(action);
              else {
                session.startupSize ??= { cols: session.process.cols, rows: session.process.rows };
                session.startupScreen?.resize(action.cols, session.process.rows);
                session.quotaScreen?.resize(action.cols, session.process.rows);
                child.resize(action.cols, session.process.rows);
              }
            }
            catch {
              startupTrust.disable();
              restoreStartupSize(session);
              session.startupIssue = "起動確認への自動入力に失敗しました。このCLI端末の接続を確認し、表示されたフォルダの確認に回答してください。";
              onOutput({stream:"status",text:`Terminal startup: ${session.startupIssue}`});
              return;
            }
            if (session.startupIssue) onOutput({stream:"status",text:"Terminal startup: "});
            session.startupIssue = undefined;
            if (action === "\r") onOutput({stream:"status",text:`${startupTrust.agent === "claude" ? "Claude Code" : "Antigravity CLI"}起動フォルダの信頼確認を自動承認しました：${startupTrust.directory}`});
          } else if (isWorkspaceTrustPrompt(screen) && !startupTrust.waitingForSelection && !session.startupIssue) {
            // A complete but unrecognized dialog stays manual for this launch.
            // Do not retain a widened pane or reinterpret it after another redraw.
            startupTrust.disable();
            session.startupIssue = "起動フォルダの確認を自動承認できません。表示されたフォルダと許可内容を確認し、このCLI端末で回答してください。ログイン・OS権限・別フォルダの許可は自動承認しません。";
            onOutput({stream:"status",text:`Terminal startup: ${session.startupIssue}`});
          }
          if (!action && startupTrust.finished) restoreStartupSize(session);
        }, 1000);
      }, true) : undefined, process: child, data: "", offset: 0, alive: true,
        settled: false, cancelled: false, finish: (result) => {
          if (session.settled) return;
          session.settled = true;
          startupTrust?.disable();
          restoreStartupSize(session);
          clearTimeout(session.startupTimer);
          clearTimeout(session.failureTimer);
          session.startupScreen?.dispose();
          session.quotaScreen?.dispose();
          clearInterval(session.timer);
          resolve(result);
        } };
      this.sessions.set(id, session);
      session.startupScreen?.resize(child.cols, child.rows);
      if (control?.agentId) session.quotaScreen = new TerminalScreen(screen => {
        if (session.cancelled || session.settled || session.stopping) return;
        submissionIdle = antigravitySubmissionIdle(screen);
        const observation = terminalQuota(control.agentId, screen);
        if (observation) { session.stopForHandoff({status:"rate-limited",summary:observation.detail!}, observation); return; }
        const failure = nativeCliFailure(control.agentId, screen);
        const fingerprint=failure?.kind??"";
        if (!failure) { clearTimeout(session.failureTimer); failureFingerprint=""; session.failureSuppressed=false; return; }
        if (session.failureSuppressed || fingerprint===failureFingerprint) return;
        clearTimeout(session.failureTimer); failureFingerprint=fingerprint;
        // Stable native failure frame, not an inactivity deadline. A changed
        // screen, completion, pause or manual input cancels this observation.
        if (failure) session.failureTimer = setTimeout(() => {
          if (!session.alive || session.cancelled || session.settled || session.stopping) return;
          session.stopForHandoff({status:"blocked",summary:failure.summary,failure});
        }, 1000);
      }, true);
      session.quotaScreen?.resize(child.cols, child.rows);
      child.onData((data) => {
        // Keep the original terminal stream for faithful cursor/ANSI rendering.
        // The caller redacts the separately persisted external log.
        session.offset += data.length;
        session.data = (session.data + data).slice(-REPLAY_LIMIT);
        startupTrust?.observeData(data);
        session.startupScreen?.write(data);
        session.quotaScreen?.write(data);
        onOutput({ stream: "stdout", text: data, offset: session.offset });
      });
      child.onExit(({ exitCode }) => {
        session.alive = false;
        clearTimeout(session.startupTimer);
        clearTimeout(session.failureTimer);
        session.startupScreen?.dispose();
        session.quotaScreen?.dispose();
        exited?.();
        onOutput({ stream: "status", text: `Terminal exited (${exitCode}).` });
        if (session.stopping) return; // Remote acknowledgement still owns settlement.
        void (async () => {
          let disconnected=false;
          if(!session.cancelled && control?.connectionLost) {
            try { disconnected=await control.connectionLost(); } catch { disconnected=true; }
          }
          if (disconnected) {
            session.finish({exitCode, signal:null, stdout:session.data, stderr:"SSH接続が切れました。遠隔CLIはtmuxで保持しています。再接続し、同じ工程から再開してください。",connectionLost:true});
            return;
          }
          try { await control?.syncHandoff?.(); } catch { /* Stop acknowledgement below still must succeed. */ }
          if (session.stopping || session.settled) return;
          // A CLI can exit immediately after its hook commits the notification,
          // before the periodic reader has observed it.
          if (control && !session.cancelled) try {
            const info = await lstat(control.path);
            if (info.isFile() && !info.isSymbolicLink() && info.size <= 512000) {
              const value = JSON.parse(await readFile(control.path,"utf8"));
              const issue = notificationIssue(value, control.token);
              if (!issue) {
                const handoff = validateHandoff(value);
                await control.validateNotification?.(handoff);
                if (!session.cancelled && !session.stopping && !session.settled) { session.stopForHandoff(handoff); return; }
              } else session.notificationIssue = issue;
            } else session.notificationIssue = "完了通知が通常ファイルではない、またはサイズ上限を超えています。";
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") session.notificationIssue ??= error instanceof SyntaxError
              ? "完了通知のJSONを読み取れません。同じ工程から再開し、--finish で送り直してください。"
              : `完了通知を受理できません。${redactSecrets(error instanceof Error ? error.message : "通知を確認してください。").slice(0, 350)}`;
          }
          if (session.stopping || session.settled) return;
          const quota = !session.cancelled ? exitedQuota(control?.agentId, session.data, "") : undefined;
          if (quota) { session.stopForHandoff({status:"rate-limited",summary:quota.detail!}, quota); return; }
          let failure: string | undefined;
          if (!session.cancelled) try { failure = await control?.exitFailure?.(); } catch { /* No verified receipt: keep the generic diagnosis. */ }
          const summary = failure ?? session.notificationIssue ?? "CLIが終了しました。工程完了の通知は受信していません。";
          // Remote PTY/SSH exit is not proof that the remote CLI has exited.
          if (control?.stopForHandoff) { session.stopForHandoff({status:"blocked",summary}); return; }
          session.finish({exitCode,signal:session.cancelled?"SIGTERM":null,stdout:session.data,stderr:summary});
        })();
      });
      if (control) {
        let checking = false;
        session.timer = setInterval(async () => {
          if (checking || session.settled || session.cancelled || session.stopping) return;
          checking = true;
          try {
            const info = await lstat(control.path);
            let issue: string | undefined, raw = "", handoff: Handoff | undefined;
            if (!info.isFile() || info.isSymbolicLink() || info.size > 512000) issue = "完了通知が通常ファイルではない、またはサイズ上限を超えています。--finish で送り直してください。";
            else {
              raw = await readFile(control.path, "utf8");
              try {
                const value = JSON.parse(raw);
                issue = notificationIssue(value, control.token);
                if (!issue) { handoff = validateHandoff(value); await control.validateNotification?.(handoff); }
              } catch (error) {
                issue = error instanceof SyntaxError ? "完了通知のJSONを読み取れません。--finish で送り直してください。"
                  : redactSecrets(error instanceof Error ? error.message : "完了通知を確認してください。").slice(0, 350);
              }
            }
            // Async reads/validation may finish after pause or another handoff.
            if (session.cancelled || session.stopping || session.settled) return;
            if (!issue && handoff) { session.notificationIssue = undefined; this.complete(id, handoff); return; }
            // SSH polling can rewrite identical local copies every two seconds.
            // Stability is about content, not a transport's modification time.
            const fingerprint = `${info.size}:${info.isFile()}:${info.isSymbolicLink()}:${raw}`;
            if (fingerprint !== notificationFingerprint) { notificationFingerprint = fingerprint; stableSince = Date.now(); return; }
            // Ignore in-progress writes. This is a file-stability debounce, not
            // a work time limit: an invalid draft never completes/kills a CLI.
            if (Date.now() - stableSince < 2000) return;
            session.notificationIssue = `完了通知は未受理です。${issue}`;
            if (repairAttempts >= 2 && repairFingerprint !== fingerprint) {
              session.notificationIssue += " 自動修正の上限です。一時停止し、同じ工程から再開してください。成果物とログは保持します。";
            } else if (repairFingerprint === fingerprint) {
              session.notificationIssue += ` 提出形式の自動修正を依頼しました（${repairAttempts}/2）。`;
            } else if (session.notificationRepairDisabled) {
              session.notificationIssue += " 手入力があるため自動入力は保留しています。必要なら一時停止し、同じ工程から再開してください。";
            }
            if (announcedFingerprint !== fingerprint) {
              announcedFingerprint = fingerprint;
              onOutput({stream:"status",text:`Terminal notification: ${session.notificationIssue}`});
            }
            if (control.notificationRepairPrompt && submissionIdle && session.alive && !session.notificationRepairDisabled
              && repairFingerprint !== fingerprint && repairAttempts < 2) {
              repairFingerprint = fingerprint; repairAttempts++;
              const repair = control.notificationRepairPrompt.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 8000);
              session.process.write(`\x1b[200~${repair}\x1b[201~\r`);
              session.notificationIssue += ` 提出形式の自動修正を依頼しました（${repairAttempts}/2）。`;
              onOutput({stream:"status",text:`Terminal notification: ${session.notificationIssue}`});
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !session.cancelled && !session.settled && !session.stopping) {
              const issue = "完了通知を読み取れません。通知ファイルへのアクセスを確認し、必要なら一時停止して同じ工程から再開してください。";
              if (session.notificationIssue !== issue) {
                session.notificationIssue = issue;
                onOutput({stream:"status",text:`Terminal notification: ${issue}`});
              }
            }
          }
          finally { checking = false; }
        }, 500);
      }
    });
  }

  snapshot(id: string): TerminalSnapshot | undefined {
    const s = this.sessions.get(id);
    return s && { pid:s.process.pid, data: s.data, offset: s.offset, cols: s.process.cols, rows: s.process.rows,
      alive: s.alive, awaitingHandoff: !s.settled, inputAllowed: s.alive && !s.cancelled && !s.stopping && !(s.managed && s.settled), notificationIssue: s.notificationIssue, startupIssue:s.startupIssue };
  }
  disableStartupApproval(id: string): void {
    const s = this.sessions.get(id); s?.startupTrust?.disable(); s?.startupScreen?.dispose();
    if (s) {
      restoreStartupSize(s); clearTimeout(s.startupTimer);
      const hadIssue = !!s.startupIssue;
      s.startupIssue = undefined;
      // The backend owns recognition and notices; the renderer must not have
      // a second, divergent definition of human versus terminal input.
      if (hadIssue) s.output({ stream: "status", text: "Terminal startup: " });
    }
  }
  write(id: string, data: string): void {
    if (typeof data !== "string" || data.length > 64000) throw new Error("Terminal input is too large.");
    const s = this.sessions.get(id);
    if (!s?.alive || s.cancelled || s.stopping || s.managed && s.settled) throw new Error("この担当は終了または引き継ぎ処理中です。認証はシステム設定のログイン管理で行ってください。");
    if (!isTerminalDeviceReply(data)) {
      this.disableStartupApproval(id); s.notificationRepairDisabled = true;
      clearTimeout(s.failureTimer); s.failureSuppressed=true;
    }
    s.process.write(data);
  }
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) {
      throw new Error("Invalid terminal dimensions.");
    }
    const s = this.sessions.get(id);
    if (s?.alive) {
      if (s.startupTrust && !s.startupTrust.finished) {
        // Tiny GUI panes can scroll the header/path out of the CLI's screen
        // before recognition. Keep just the startup dialog readable. This is
        // not a permanent minimum size, and never applies to login shells.
        const requested = { cols, rows };
        cols = Math.max(cols, 100, s.startupSize ? s.process.cols : 0);
        rows = Math.max(rows, 40);
        if (s.startupSize || cols !== requested.cols || rows !== requested.rows) s.startupSize = requested;
      }
      // A captured frame at the old dimensions is no longer safe for input.
      // Repeated same-size GUI events must not starve the stable-frame timer.
      if (s.process.cols !== cols || s.process.rows !== rows) clearTimeout(s.startupTimer);
      s.startupScreen?.resize(cols, rows); s.quotaScreen?.resize(cols, rows); s.process.resize(cols, rows);
    }
  }
  complete(id: string, value: Handoff): void {
    const s = this.sessions.get(id);
    if (!s || s.settled || s.cancelled || s.stopping) throw new Error("この工程は引継ぎ待ちではありません。");
    const handoff = validateHandoff(value);
    if (s.managed || handoff.status !== "completed") { s.stopForHandoff(handoff); return; }
    s.finish({ exitCode: 0, signal: null, stdout: s.data, stderr: "", handoff });
  }
  cancel(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s?.alive) return false;
    s.cancelled = true;
    clearTimeout(s.startupTimer);
    clearInterval(s.timer);
    if (s.remoteCancellation) {
      s.stopForHandoff({status:"blocked",summary:"ユーザーの操作で一時停止しました。"});
      return true;
    }
    // CLI tool children normally share the session's process group.
    const signal = (name: NodeJS.Signals) => {
      if (!s.alive) return;
      try { if (s.process.pid) process.kill(-s.process.pid, name); else s.process.kill(name); }
      catch { try { s.process.kill(name); } catch { /* Already exited. */ } }
    };
    signal("SIGTERM");
    const timeout = setTimeout(() => signal("SIGKILL"), 2000);
    timeout.unref();
    return true;
  }
  forget(id: string): void {
    this.cancel(id);
    this.sessions.get(id)?.startupScreen?.dispose();
    this.sessions.get(id)?.quotaScreen?.dispose();
    this.sessions.delete(id);
  }
  cancelAll(): void { for (const id of this.sessions.keys()) this.cancel(id); }
  /** Closing the app drops tmux attachments, not retained remote writers.
   * Explicit pause still goes through cancel/acknowledged retirement. */
  shutdown(): void {
    for(const [id,session] of this.sessions) {
      if(session.remoteCancellation && session.alive && !session.cancelled && !session.stopping) {
        try { session.process.kill("SIGTERM"); } catch {}
      } else this.cancel(id);
    }
  }
}
