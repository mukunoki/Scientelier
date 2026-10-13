import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UsageLimitWindow } from "./types";
import type { RateLimitObservation } from "./usage-tracker";

const execFileAsync = promisify(execFile);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function resetDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

// /api/oauth/usage percentages are already 0–100, unlike stream utilization ratios.
export function parseClaudeCapacityPayload(value: unknown): RateLimitObservation {
  const payload = record(value);
  if (!payload) throw new Error("Claude returned an invalid usage response.");
  const windows = new Map<string, UsageLimitWindow>();
  const add = (id: string, label: string, value: unknown, windowMinutes?: number, model?: string) => {
    const item = record(value);
    const percent = item?.utilization ?? item?.percent ?? item?.used_percentage;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    windows.set(id, {
      id, label, usedPercent: Math.max(0, Math.min(100, percent)), windowMinutes,
      resetAt: resetDate(item?.resets_at), scope: model ? "model" : "shared", model
    });
  };
  add("five_hour", "Current session", payload.five_hour, 300);
  add("seven_day", "Current week (all)", payload.seven_day, 10_080);
  add("seven_day_oauth_apps", "Current week (OAuth apps)", payload.seven_day_oauth_apps, 10_080);
  for (const model of ["Opus", "Sonnet", "Fable"]) {
    add(`seven_day_${model.toLowerCase()}`, `Current week (${model})`, payload[`seven_day_${model.toLowerCase()}`], 10_080, model);
  }
  // Newer CLI versions receive weekly model windows in limits[], not unifiedWindows.
  for (const value of Array.isArray(payload.limits) ? payload.limits : []) {
    const item = record(value);
    const model = record(record(item?.scope)?.model)?.display_name;
    if (item?.kind === "weekly_scoped" && typeof model === "string" && model) {
      add(`seven_day_${model.toLowerCase()}`, `Current week (${model})`, item, 10_080, model);
    }
  }
  for (const value of Array.isArray(payload.model_scoped) ? payload.model_scoped : []) {
    const item = record(value);
    if (typeof item?.display_name === "string" && item.display_name) {
      const model = item.display_name;
      add(`seven_day_${model.toLowerCase()}`, `Current week (${model})`, item, 10_080, model);
    }
  }
  const extra = record(payload.extra_usage);
  if (extra?.is_enabled === true) add("extra_usage", "Monthly extra usage", extra);
  add("cinder_cove", "Claude Code / Cowork credit", payload.cinder_cove);
  if (!windows.size) throw new Error("Claude did not report any subscription usage windows.");
  const shared = [...windows.values()].filter((item) => item.scope === "shared");
  const mostUsed = shared.sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return {
    limited: false, // A full model bucket does not block the entire provider.
    usedPercent: mostUsed?.usedPercent, resetAt: mostUsed?.resetAt,
    windows: [...windows.values()],
    detail: "Claude Code subscription usage"
  };
}

interface ClaudeUsageCredential { token: string; expiresAt?: number; source: "environment" | "keychain" | "file"; }
async function readAccessToken(): Promise<ClaudeUsageCredential> {
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL || process.env.CLAUDE_LOCAL_OAUTH_API_BASE) {
    throw new Error("Custom Claude OAuth endpoints are not supported for usage checks.");
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: "environment" };
  const customDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  const configDir = (customDir || join(homedir(), ".claude")).normalize("NFC");
  const suffix = customDir ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}` : "";
  let credentials: Record<string, unknown> | undefined;
  let source: ClaudeUsageCredential["source"] = "file";
  if (process.platform === "darwin") {
    const name = process.env.USER || userInfo().username;
    const account = /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
    try {
      const result = await execFileAsync("/usr/bin/security", [
        "find-generic-password", "-a", account, "-w", "-s", `Claude Code-credentials${suffix}`
      ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      credentials = record(JSON.parse(result.stdout));
      if (credentials) source = "keychain";
    } catch { /* Claude Code also supports a local credentials file. Never log credentials. */ }
  }
  if (!credentials) {
    try { credentials = record(JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8"))); }
    catch { /* Surface only a safe, actionable error below. */ }
  }
  const oauth = record(credentials?.claudeAiOauth);
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) {
    throw new CapacityRequestError(`Claude使用量APIの認証情報がありません。${CLAUDE_USAGE_RECOVERY}`, 401);
  }
  return { token: oauth.accessToken, source, expiresAt: typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) && oauth.expiresAt > 0 ? oauth.expiresAt : undefined };
}

const CLAUDE_USAGE_RECOVERY = "CLIが使えている場合は再ログイン不要です。Resourcesの「更新」で残量取得を再確認してください。取得できない間は残量未確認として扱います。CLIのログアウトや使用枠切れを示すエラーではありません。";

export class CapacityRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs?: number) { super(message); }
}
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

export async function readClaudeCapacity(deps: {
  credentials?: () => Promise<ClaudeUsageCredential>; request?: typeof fetch; now?: () => number;
} = {}): Promise<RateLimitObservation> {
  const credentials = deps.credentials ?? readAccessToken, request = deps.request ?? fetch, now = deps.now ?? Date.now;
  let credential = await credentials();
  const checkExpiry = () => {
    if (credential.expiresAt !== undefined && credential.expiresAt <= now())
      throw new CapacityRequestError(`Claude使用量APIの認証情報は期限切れです。${CLAUDE_USAGE_RECOVERY}`, 401);
  };
  checkExpiry();
  let response: Response;
  const query = async () => {
    try {
      return await request("https://api.anthropic.com/api/oauth/usage", {
        headers: { Authorization: `Bearer ${credential.token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
        signal: AbortSignal.timeout(10_000), redirect: "error"
      });
    } catch { throw new Error("Claude usage request failed or timed out. Check your network and retry."); }
  };
  response = await query();
  // Claude may rotate its credential during our request. Retry once only if
  // the stored token actually changed; never refresh/write OAuth secrets here.
  if (response.status === 401) {
    const latest = await credentials();
    if (latest.token !== credential.token) {
      credential = latest; checkExpiry(); response = await query();
    }
  }
  if (!response.ok) {
    throw new CapacityRequestError(response.status === 401 || response.status === 403
      ? `Claude使用量APIの認証が拒否されました（HTTP ${response.status}）。${CLAUDE_USAGE_RECOVERY}${credential.source === "environment" ? " 環境変数CLAUDE_CODE_OAUTH_TOKENが保存済みログインより優先されています。CLIでの再ログインだけでは切り替わらないため、起動環境の設定も確認してください。" : " CLIがログイン済みと表示されても、使用量APIの認証成功とは別です。"}`
      : response.status === 429 ? "Claudeの使用量取得APIが要求を制限しています（HTTP 429）。モデル利用枠切れではありません。"
      : `Claude usage request failed (HTTP ${response.status}). Try again later.`, response.status, retryAfterMilliseconds(response.headers.get("retry-after")));
  }
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("Claude returned an unreadable usage response."); }
  return parseClaudeCapacityPayload(payload);
}
