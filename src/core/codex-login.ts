import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudeLoginStatus } from "./claude-login";

// Never forward raw output: API-key status can include part of the key.
export function parseCodexLoginStatus(output: string): ClaudeLoginStatus {
  const checkedAt = new Date().toISOString();
  if (/^Logged in using ChatGPT\s*$/im.test(output)) return {
    checkedAt, loggedIn: true, authMethod: "ChatGPT",
    detail: "CLIはChatGPTにログイン済みです。使用量APIへの接続成功とは別です。"
  };
  if (/^Logged in using an API key\b/im.test(output)) return {
    checkedAt, loggedIn: true, authMethod: "API key",
    detail: "APIキーでログインしています。ChatGPTサブスクリプションの使用量は取得できません。"
  };
  if (/^Not logged in\s*$/im.test(output)) return {
    checkedAt, loggedIn: false, detail: "Codexにログインしていません。"
  };
  return { checkedAt, detail: "認証状態を確認できません。CLIの版・設定・接続を確認してください。" };
}

export async function readCodexLoginStatus(executable: string, cwd: string): Promise<ClaudeLoginStatus> {
  try {
    const result = await promisify(execFile)(executable, ["login", "status"], { cwd, timeout: 10000, maxBuffer: 64000 });
    return parseCodexLoginStatus(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return parseCodexLoginStatus(failure.code === 1 ? `${failure.stdout ?? ""}\n${failure.stderr ?? ""}` : "");
  }
}

export function isCodexAuthorizationFailure(message?: string): boolean {
  return !!message && /\b(?:401|403)\b|not (?:logged|signed) in|unauthenticated|unauthorized|authentication (?:required|failed)|refresh.token|token.{0,30}expired|Codex.*認証/i.test(message);
}
