import { stripVTControlCharacters } from "node:util";

export interface LoginIssue { code: "unsupported-client" | "authentication-failed"; message: string; }

// Classify only explicit errors in the dedicated auth PTY. Never return raw
// output (which may contain OAuth URLs, account identifiers or credentials).
export function loginIssue(provider: string, output: string): LoginIssue | undefined {
  if (provider !== "gemini" && provider !== "antigravity") return undefined;
  const text = stripVTControlCharacters(output).replace(/\s+/g, " ");
  if (/This client is no longer supported for Gemini Code Assist for individuals/i.test(text)) {
    return { code: "unsupported-client", message: "Google側が個人向けGemini CLIの利用を拒否しています。ブラウザ認証後の処理は失敗しました。個人向けサブスクはAntigravityログイン管理を使ってください。再ログインの繰り返しでは解消しません。" };
  }
  if (/Failed to sign in|Authentication failed|Login failed|failed to authenticate/i.test(text)) {
    return { code: "authentication-failed", message: "CLIが認証失敗を報告しました。下の端末に表示された理由を確認してください。端末が開いていても認証成功とは限りません。" };
  }
  return undefined;
}
