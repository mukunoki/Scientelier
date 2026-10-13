import { stripVTControlCharacters } from "node:util";
import type { AgentId } from "./types";

/** Backend capacity is not an account quota. Never overwrite usage/reset data
 * with it. These observations only allow a failed, retired assignment to retry. */
export interface CliFailure { kind: "capacity" | "authentication" | "connection"; summary: string; }
export function nativeCliFailure(agent: AgentId | undefined, screen: string): CliFailure | undefined {
  const text = stripVTControlCharacters(screen);
  if (agent === "codex") {
    // Require the native failed-turn banner and idle composer, not a prompt,
    // quoted error, source listing, approval or active tool output.
    const footer = text.split("\n").slice(-7).join("\n");
    if (!/\? for shortcuts/.test(footer) || !/^\s*› /m.test(footer) || /esc to (?:interrupt|cancel)|running|approve|allow once/i.test(footer)) return;
    if (/^\s*■ Selected model is at capacity\. Please try a different model\.\s*$/m.test(text))
      return { kind: "capacity", summary: "Codexの選択モデルが一時的に混雑しています。成果を保持して別AIへ引き継ぎます。" };
  }
  if (agent === "antigravity" && /^\s*⚠ UNAUTHENTICATED \(code 401\): Request had invalid authentication credentials\./m.test(text)
    && /Error ID:\s*[a-z0-9-]+/i.test(text))
    return { kind: "authentication", summary: "Antigravityの認証が失効しています。成果を保持して別AIへ引き継ぎます。Resourcesで再ログインできます。" };
}

/** Only native CLI failure hooks supply these strings. Do not apply this
 * classifier to successful answers, tool output or user instructions. */
export function hookCliFailure(error: unknown, detail: unknown): CliFailure | undefined {
  if (typeof error !== "string") return;
  const text = typeof detail === "string" ? detail : "";
  if (/^(?:authentication_failed|authentication|unauthorized)$/i.test(error) || /\b(?:401|UNAUTHENTICATED)\b/.test(text))
    return { kind: "authentication", summary: "CLIの認証エラーです。成果を保持して別AIへ引き継ぎます。Resourcesで再ログインしてください。" };
  if (error === "capacity_error" || /selected model is at capacity|model.*(?:overloaded|at capacity)|\b503\b.*(?:overload|capacity)/i.test(text))
    return { kind: "capacity", summary: "選択モデルが一時的に混雑しています。成果を保持して別AIへ引き継ぎます。" };
  if (/^(?:connection_error|network_error)$/i.test(error) || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(text))
    return { kind: "connection", summary: "CLIのAPI接続に失敗しました。成果を保持して別AIへ引き継ぎます。" };
}

export function validCliFailure(value: unknown): value is CliFailure {
  const v = value as Partial<CliFailure> | undefined;
  return !!v && ["capacity", "authentication", "connection"].includes(v.kind ?? "")
    && typeof v.summary === "string" && !!v.summary.trim() && v.summary.length <= 600;
}
