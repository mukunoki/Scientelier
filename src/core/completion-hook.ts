import { writeFile, rename, stat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Handoff } from "./terminal-runner";
import { redactSecrets } from "./redact";
import { readChannelState } from "./channel-state";
import { captureRunUsage } from "./run-usage";
import { hookCliFailure } from "./cli-transient-failure";

export function completionMarker(token: string, status: Handoff["status"] = "completed"): string {
  return `[[HARNESS_HANDOFF:${token}:${status}]]`;
}

// Inspect the CLI's completed assistant message, never ANSI screen redraws, tool
// output or a subagent response. A bare Stop is not proof that work is finished.
export function completionFromHook(provider: string, payload: unknown, token: string): Handoff | undefined {
  if (!payload || typeof payload !== "object") return;
  const event = payload as Record<string, unknown>;
  if (event.agent_id || event.parent_tool_use_id) return;
  let response: unknown;
  if (provider === "codex" && event.type === "agent-turn-complete") response = event["last-assistant-message"];
  if (provider === "claude" && event.hook_event_name === "Stop") response = event.last_assistant_message;
  if (provider === "opencode" && event.type === "session.idle") response = event.response;
  if (provider === "opencode" && event.type === "session.error" && event.error === "rate_limit") {
    return { status: "rate-limited", summary: redactSecrets(String(event.error_details || "OpenCode reported a rate limit.")).slice(0, 64000) };
  }
  if (provider === "claude" && event.hook_event_name === "StopFailure" && event.error === "rate_limit") {
    return { status: "rate-limited", summary: redactSecrets(String(event.error_details || event.last_assistant_message || "Claude reported a rate limit.")).slice(0, 64000) };
  }
  if (provider === "claude" && event.hook_event_name === "StopFailure" || provider === "opencode" && event.type === "session.error") {
    const failure = hookCliFailure(event.error, event.error_details);
    if (failure) return {status:"blocked",summary:failure.summary,failure};
  }
  if (typeof response !== "string") return;
  const lines = response.trimEnd().split(/\r?\n/);
  const marker = lines.pop()?.trim();
  const status = (["completed", "rate-limited", "blocked"] as const).find((value) => marker === completionMarker(token, value));
  const summary = redactSecrets(lines.join("\n").trim()).slice(0, 64000);
  if (!status || !summary) return;
  const sessionId = provider === "codex" ? event["thread-id"] : event.session_id;
  return { status, summary, ...(typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ? { sessionId } : {}) };
}

// Only a native final-turn event can stop a work unit. Never infer success (or
// failure) from terminal text, a timer, an approval request or a subagent event.
export async function guardedCompletion(provider: string, payload: any, token: string, directory: string): Promise<Handoff | undefined> {
  const result = completionFromHook(provider, payload, token);
  let required: any;
  try { required = JSON.parse(await readFile(join(directory, "channel-required.json"), "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return result; throw e; }
  if (required.token !== token || payload?.agent_id || payload?.parent_tool_use_id) return;
  if (result?.status === "rate-limited" || result?.status === "blocked") return result;
  const final = provider === "claude" && payload?.hook_event_name === "Stop" ? payload.last_assistant_message
    : provider === "codex" && payload?.type === "agent-turn-complete" ? payload["last-assistant-message"]
    : provider === "opencode" && payload?.type === "session.idle" ? payload.response : undefined;
  const failed = (provider === "claude" && payload?.hook_event_name === "StopFailure") || (provider === "opencode" && payload?.type === "session.error");
  if (!failed && (typeof final !== "string" || !final.trim())) return;
  const state = await readChannelState(directory, token);
  if (result?.status === "completed" && state?.phase === "instructions-read") return result;
  const reason = provider === "opencode" && failed && payload.error === "output_limit"
    ? "OpenCodeが1回の応答の出力上限に達し、作業を中断しました。サブスクリプションの残量不足とは別の制限です。"
    : provider === "opencode" && failed && payload.error === "empty_response"
    ? "OpenCodeの応答は終了しましたが、回答本文も完了通知もありません。作業完了とは判定できません。"
    : failed ? "CLIがエラーで応答を終了しました。ログイン・接続状態を確認してください。"
    : state?.phase === "instructions-read" ? "指示は取得済みですが、この工程の有効な完了通知がありません。"
    : state?.phase === "connected" ? "MCP接続は確認できましたが、この工程の指示取得は確認できません。"
    : "この工程のMCP接続・指示取得が確認できません。";
  return { status: "blocked", summary: `${reason} 未完了として停止しました。「中断した工程から再開」で再試行できます。\n${redactSecrets(typeof final === "string" ? final : String(payload?.error_details ?? payload?.error ?? "CLI error")).slice(0, 16000)}` };
}

async function main(): Promise<void> {
  const [provider, path, token, argument] = process.argv.slice(2);
  if (!path || !token || !["codex", "claude", "opencode"].includes(provider)) return;
  // The run owner creates and removes this directory. Late hooks must not recreate it.
  if (!(await stat(dirname(path))).isDirectory()) return;
  let input = argument ?? "";
  if (provider !== "codex") {
    input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024 * 1024) return;
    }
  }
  if (!input || input.length > 1024 * 1024) return;
  const payload = JSON.parse(input);
  // Accounting is optional and bounded; a slow session directory must not hold
  // the work-completion handoff hostage.
  let usageTimer: NodeJS.Timeout | undefined;
  await Promise.race([captureRunUsage(provider, payload, dirname(path), token),
    new Promise<void>(resolve => { usageTimer = setTimeout(resolve, 1500); })]);
  clearTimeout(usageTimer);
  const handoff = await guardedCompletion(provider, payload, token, dirname(path));
  if (!handoff) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ token, ...handoff }), { mode: 0o600 });
  await rename(temporary, path);
}

if (require.main === module) {
  // A notification must not break the CLI session after the harness has closed.
  void main().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") process.stderr.write(`Scientelier notification: ${error.message}\n`);
  });
}
