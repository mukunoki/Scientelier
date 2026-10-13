import { spawn } from "node:child_process";
import type { RateLimitObservation } from "./usage-tracker";
import type { ProviderModelInfo, UsageLimitWindow } from "./types";

interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexSnapshot {
  limitId?: unknown;
  limitName?: unknown;
  normalModelSlug?: unknown;
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  credits?: { balance?: unknown } | null;
  planType?: unknown;
  rateLimitReachedType?: unknown;
  spendControlReached?: unknown;
}

interface CodexCapacityPayload {
  ordinaryUsageAllowed?: unknown;
  rateLimits?: CodexSnapshot;
  rateLimitsByLimitId?: Record<string, CodexSnapshot> | null;
}

interface CodexModelPayload {
  data?: Array<{
    model?: unknown;
    displayName?: unknown;
    isDefault?: unknown;
    hidden?: unknown;
  }>;
}

function isoFromEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
}

function windowLabel(snapshot: CodexSnapshot, kind: "primary" | "secondary"): string {
  const modelName = typeof snapshot.limitName === "string" && snapshot.limitName
    ? snapshot.limitName
    : typeof snapshot.normalModelSlug === "string" && snapshot.normalModelSlug
      ? snapshot.normalModelSlug
      : undefined;
  const name = modelName ?? "Codex shared";
  return `${name} · ${kind === "primary" ? "primary" : "secondary"}`;
}

function parseCodexModels(value: unknown): ProviderModelInfo[] {
  if (!value || typeof value !== "object") return [];
  const payload = value as CodexModelPayload;
  if (!Array.isArray(payload.data)) return [];
  return payload.data.flatMap((item) => {
    if (item.hidden === true || typeof item.model !== "string") return [];
    return [{
      id: item.model,
      label: typeof item.displayName === "string" ? item.displayName : item.model,
      isDefault: item.isDefault === true,
      source: "catalog" as const
    }];
  });
}

export function parseCodexCapacityPayload(value: unknown, modelValue?: unknown): RateLimitObservation {
  if (!value || typeof value !== "object") throw new Error("Codex returned an invalid capacity response.");
  const payload = value as CodexCapacityPayload;
  const snapshots = payload.rateLimitsByLimitId && Object.keys(payload.rateLimitsByLimitId).length
    ? Object.entries(payload.rateLimitsByLimitId)
    : payload.rateLimits ? [["codex", payload.rateLimits] as const] : [];
  const windows: UsageLimitWindow[] = [];
  let plan: string | undefined;
  let creditBalance: string | undefined;
  let reached = payload.ordinaryUsageAllowed === false;

  for (const [fallbackId, snapshot] of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const limitId = typeof snapshot.limitId === "string" && snapshot.limitId ? snapshot.limitId : fallbackId;
    const model = typeof snapshot.limitName === "string" && snapshot.limitName
      ? snapshot.limitName
      : typeof snapshot.normalModelSlug === "string" && snapshot.normalModelSlug
        ? snapshot.normalModelSlug
        : undefined;
    plan ??= typeof snapshot.planType === "string" ? snapshot.planType : undefined;
    if (snapshot.credits && snapshot.credits.balance !== undefined) {
      creditBalance ??= String(snapshot.credits.balance);
    }
    reached ||= Boolean(snapshot.rateLimitReachedType) || snapshot.spendControlReached === true;
    for (const kind of ["primary", "secondary"] as const) {
      const item = snapshot[kind];
      if (!item || typeof item.usedPercent !== "number" || !Number.isFinite(item.usedPercent)) continue;
      windows.push({
        id: `${limitId}:${kind}`,
        label: windowLabel(snapshot, kind),
        usedPercent: Math.max(0, Math.min(100, item.usedPercent)),
        windowMinutes: typeof item.windowDurationMins === "number" ? item.windowDurationMins : undefined,
        resetAt: isoFromEpoch(item.resetsAt),
        scope: model ? "model" : "shared",
        model
      });
    }
  }

  const mostUsed = windows.reduce<UsageLimitWindow | undefined>(
    (current, item) => !current || item.usedPercent > current.usedPercent ? item : current,
    undefined
  );
  return {
    limited: reached,
    usedPercent: mostUsed?.usedPercent,
    resetAt: mostUsed?.resetAt,
    windows,
    models: parseCodexModels(modelValue),
    plan,
    creditBalance,
    ordinaryUsageAllowed: typeof payload.ordinaryUsageAllowed === "boolean"
      ? payload.ordinaryUsageAllowed
      : undefined,
    detail: reached ? "Codex reports that included usage is currently unavailable." : undefined
  };
}

export function readCodexCapacity(
  executable: string,
  cwd: string,
  timeoutMs = 25_000,
  launch = (command: string, args: string[], directory: string) => spawn(command, args, {
    cwd: directory, env: process.env, stdio: ["pipe", "pipe", "pipe"]
  })
): Promise<RateLimitObservation> {
  return new Promise((resolve, reject) => {
    const child = launch(executable, ["app-server", "--stdio"], cwd);
    let settled = false;
    let initialized = false;
    let capacityResult: unknown;
    let capacityObservation: RateLimitObservation | undefined;
    let modelTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutBuffer = "";
    let stderr = "";

    const finish = (error?: Error, observation?: RateLimitObservation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(modelTimer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(observation!);
    };
    const timer = setTimeout(() => capacityObservation ? finish(undefined, capacityObservation)
      : finish(new Error(`Codex使用量取得がタイムアウトしました（${initialized ? "使用量APIの応答待ち" : "CLIの初期化待ち"}）。ログイン切れとは限りません。接続を確認して再取得してください。`)), timeoutMs);
    child.stdin.on("error", () => {
      if (!settled) finish(new Error("Codex使用量取得用CLIとの接続が終了しました。"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1 && !initialized) {
          if (message.error) {
            finish(new Error(message.error.message ?? "Could not initialize Codex capacity API."));
            return;
          }
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({
            id: 2,
            method: "account/rateLimits/read",
            params: { excludeResetCreditDetails: true }
          })}\n`);
        }
        if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message ?? "Codex capacity request failed."));
            return;
          }
          capacityResult = message.result;
          try {
            capacityObservation = parseCodexCapacityPayload(capacityResult);
            if (!capacityObservation.windows?.length) throw new Error("Codexが使用量の上限情報を返しませんでした。CLIが使えている場合は再ログイン不要です。APIキー認証ではサブスクリプション残量を取得できません。");
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error))); return;
          }
          // Model discovery is optional: a slow catalog must not discard fresh usage.
          modelTimer = setTimeout(() => finish(undefined, capacityObservation), Math.min(3000, timeoutMs));
          child.stdin.write(`${JSON.stringify({
            id: 3,
            method: "model/list",
            params: { limit: 100, includeHidden: false }
          })}\n`);
        }
        if (message.id === 3) {
          try {
            finish(undefined, parseCodexCapacityPayload(capacityResult, message.error ? undefined : message.result));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (!settled && capacityObservation) { finish(undefined, capacityObservation); return; }
      if (!settled) finish(new Error(stderr.trim() || `Codex capacity API exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "agent-harness", title: "Scientelier", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }
    })}\n`);
  });
}
