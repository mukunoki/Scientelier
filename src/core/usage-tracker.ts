import { mkdir, readFile } from "node:fs/promises";
import { JsonFileWriter } from "./json-file-writer";
import { isClaudeAuthorizationFailure } from "./claude-login";
import { isCodexAuthorizationFailure } from "./codex-login";
import { dirname } from "node:path";
import { serviceUsageLimit } from "./usage-policy";
import type {
  AgentStatus,
  OrchestrationSettings,
  ProviderResourceSummary,
  RateLimitState,
  TaskRecord,
  UsageLimitWindow,
  ProviderModelInfo
} from "./types";

interface UsageStateFile {
  version: 1;
  rateLimits: RateLimitState[];
  accountHistory?: Array<{ replacedAt: string; previous: RateLimitState }>;
}

export interface RateLimitObservation {
  /** A full account snapshot, including intentionally absent/removed quota fields. */
  replaceQuota?: boolean;
  limited: boolean;
  usedPercent?: number;
  resetAt?: string;
  windows?: UsageLimitWindow[];
  models?: ProviderModelInfo[];
  plan?: string;
  creditBalance?: string;
  ordinaryUsageAllowed?: boolean;
  detail?: string;
}

const LIMIT_PATTERN = /(?:rate.?limit(?:ed| reached| exceeded)?|quota[ ._-]?(?:exhaust|exceed|reached)|resource_exhausted|session limit|weekly limit|usage limit|credit balance is too low|budget limit reached|too many requests|\b429\b)/i;

interface RateScan {
  usedPercent?: number;
  resetAt?: string;
  limited: boolean;
  detail?: string;
  windows: Map<string, UsageLimitWindow>;
  models: Map<string, ProviderModelInfo>;
}

function dateFromUnknown(value: unknown): string | undefined {
  const date = typeof value === "number"
    ? new Date(value > 10_000_000_000 ? value : value * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function readableWindowLabel(id: string): string {
  const normalized = id.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  const labels: Record<string, string> = {
    five_hour: "Current session",
    five_hours: "5 hours",
    five_day: "5 day",
    five_days: "5 days",
    seven_day: "Current week (all)",
    seven_days: "7 days",
    seven_day_fable: "Current week (Fable)",
    seven_day_opus: "Current week (Opus)",
    seven_day_sonnet: "Current week (Sonnet)",
    daily: "daily",
    weekly: "weekly",
    monthly: "monthly"
  };
  return labels[normalized] ?? id.replaceAll("_", " ");
}

function usagePercent(value: unknown, fractional = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, fractional && value <= 1 ? value * 100 : value));
}

function windowFromValue(
  id: string,
  value: unknown,
  scope: UsageLimitWindow["scope"] = "shared"
): UsageLimitWindow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.rateLimitType === "string") id = record.rateLimitType;
  if (id === "seven_day_overage_included") id = "seven_day_fable";
  const explicitPercent = record.usedPercent
      ?? record.used_percentage
      ?? record.usedPercentage
      ?? record.used_percentage_percent
      ?? record.utilizationPercent;
  const usedPercent = explicitPercent !== undefined
    ? usagePercent(explicitPercent) : usagePercent(record.utilization, true);
  if (usedPercent === undefined) return undefined;
  const windowMinutes = typeof record.windowDurationMins === "number"
    ? record.windowDurationMins
    : typeof record.window_minutes === "number"
      ? record.window_minutes
      : typeof record.durationMinutes === "number" ? record.durationMinutes : undefined;
  const resetValue = record.resetsAt ?? record.resetAt ?? record.reset_at ?? record.resets_at;
  const model = typeof record.model === "string" ? record.model
    : ({ seven_day_fable: "Fable", seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" } as Record<string, string>)[id];
  return {
    id,
    label: readableWindowLabel(id),
    usedPercent,
    windowMinutes,
    resetAt: dateFromUnknown(resetValue),
    scope: model ? "model" : scope,
    model
  };
}

function collectWindows(value: unknown, found: RateScan, scope: UsageLimitWindow["scope"] = "shared"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const record = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : undefined;
      const id = typeof record?.id === "string"
        ? record.id
        : typeof record?.name === "string"
          ? record.name
          : typeof record?.type === "string" ? record.type : `window-${index + 1}`;
      const window = windowFromValue(id, item, scope);
      if (window) found.windows.set(window.id, window);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [id, item] of Object.entries(value as Record<string, unknown>)) {
    const window = windowFromValue(id, item, scope);
    if (window) found.windows.set(window.id, window);
  }
}

function visit(value: unknown, found: RateScan): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item, found);
    return;
  }
  const current = value as Record<string, unknown>;
  const type = typeof current.type === "string" ? current.type : undefined;
  if (type === "rate_limit_event") {
    const info = current.rate_limit_info && typeof current.rate_limit_info === "object"
      ? current.rate_limit_info as Record<string, unknown>
      : undefined;
    const status = typeof info?.status === "string" ? info.status.toLowerCase() : undefined;
    if (status && !["allowed", "available", "ok"].includes(status)) {
      found.limited = true;
      found.detail = `Provider rate status: ${status}`;
    }
    collectWindows(info?.unifiedWindows, found);
    collectWindows(info?.windows, found);
    collectWindows(info?.rateLimits, found);
    const directId = typeof info?.rateLimitType === "string" ? info.rateLimitType : "rate_limit";
    const directWindow = windowFromValue(directId, info);
    if (directWindow) found.windows.set(directWindow.id, directWindow);
  }
  if (type === "assistant") {
    const message = current.message && typeof current.message === "object"
      ? current.message as Record<string, unknown>
      : undefined;
    const model = typeof message?.model === "string"
      ? message.model
      : typeof current.model === "string" ? current.model : undefined;
    if (model) found.models.set(model, { id: model, label: model, source: "observed" });
  }
  for (const [key, nested] of Object.entries(current)) {
    const normalized = key.toLowerCase();
    if (nested && typeof nested === "object" && !Array.isArray(nested)
      && /(?:hour|day|week|month|daily|weekly|monthly|quota|limit)/i.test(key)) {
      const window = windowFromValue(key, nested);
      if (window) found.windows.set(window.id, window);
    }
    if (Array.isArray(nested) && /(?:window|quota|limit)/i.test(key)) collectWindows(nested, found);
    if (["used_percentage", "usedpercent", "used_percentage_percent"].includes(normalized)
      && typeof nested === "number") {
      found.usedPercent = Math.max(found.usedPercent ?? 0, nested);
    }
    if (normalized === "utilization" && typeof nested === "number") {
      const percentage = nested <= 1 ? nested * 100 : nested;
      found.usedPercent = Math.max(found.usedPercent ?? 0, percentage);
    }
    if (["resets_at", "reset_at", "resettime", "reset_time", "resetsat"].includes(normalized)) {
      found.resetAt = dateFromUnknown(nested) ?? found.resetAt;
    }
    if (["error", "message", "detail", "reason"].includes(normalized)
      && typeof nested === "string" && LIMIT_PATTERN.test(nested)) {
      found.limited = true;
      found.detail = nested.trim().slice(0, 600);
    }
    if (["status", "statuscode", "status_code"].includes(normalized) && nested === 429) {
      found.limited = true;
      found.detail = "Provider returned HTTP 429 (rate limit).";
    }
    visit(nested, found);
  }
}

export function parseRateLimitObservation(text: string): RateLimitObservation {
  const found: RateScan = { limited: false, windows: new Map(), models: new Map() };
  const humanLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      visit(JSON.parse(line), found);
    } catch {
      humanLines.push(line);
    }
  }
  const humanText = humanLines.join("\n");
  const limited = found.limited || LIMIT_PATTERN.test(humanText);
  const retry = humanText.match(/(?:retry|resets?)(?:\s+in|\s+after)?\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/i);
  if (retry) {
    const amount = Number(retry[1]);
    const unit = retry[2].toLowerCase();
    const factor = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
    found.resetAt = new Date(Date.now() + amount * factor).toISOString();
  }
  const windows = [...found.windows.values()];
  const mostUsed = windows.reduce<UsageLimitWindow | undefined>(
    (current, item) => !current || item.usedPercent > current.usedPercent ? item : current,
    undefined
  );
  return {
    limited,
    usedPercent: mostUsed?.usedPercent ?? found.usedPercent,
    resetAt: mostUsed?.resetAt ?? found.resetAt,
    windows: windows.length ? windows : undefined,
    models: found.models.size ? [...found.models.values()] : undefined,
    detail: limited
      ? found.detail ?? humanLines.find((line) => LIMIT_PATTERN.test(line))?.trim().slice(0, 600) ?? "Provider rate limit reached."
      : undefined
  };
}

function mergeWindows(
  previous: UsageLimitWindow[] | undefined,
  current: UsageLimitWindow[] | undefined
): UsageLimitWindow[] | undefined {
  if (!previous?.length && !current?.length) return undefined;
  const merged = new Map<string, UsageLimitWindow>();
  for (const window of previous ?? []) merged.set(window.id, window);
  for (const window of current ?? []) {
    const previousWindow = merged.get(window.id);
    merged.set(window.id, {
      ...window,
      windowMinutes: window.windowMinutes ?? previousWindow?.windowMinutes,
      resetAt: window.resetAt ?? previousWindow?.resetAt
    });
  }
  return [...merged.values()];
}

function mergeModels(
  previous: ProviderModelInfo[] | undefined,
  current: ProviderModelInfo[] | undefined
): ProviderModelInfo[] | undefined {
  if (!previous?.length && !current?.length) return undefined;
  const merged = new Map<string, ProviderModelInfo>();
  for (const model of previous ?? []) merged.set(model.id, model);
  for (const model of current ?? []) merged.set(model.id, model);
  return [...merged.values()];
}

export class JsonUsageTracker {
  private data: UsageStateFile = { version: 1, rateLimits: [] };
  private readonly writer: JsonFileWriter;

  constructor(private readonly filePath: string) { this.writer = new JsonFileWriter(filePath); }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as UsageStateFile;
      if (parsed.version === 1 && Array.isArray(parsed.rateLimits)) {
        this.data = parsed;
        const before = this.data.rateLimits.length;
        this.data.rateLimits = this.data.rateLimits.filter((item) =>
          !item.lastError || !/(?:terminal_reason\\?":\\?"max_turns|error_max_turns|Reached maximum number of turns)/i.test(item.lastError)
        );
        if (this.data.rateLimits.length !== before) await this.persist();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  getRateLimits(): RateLimitState[] {
    return structuredClone(this.data.rateLimits);
  }

  async record(
    providerKey: string,
    observation: RateLimitObservation,
    source: "reported-live" | "reported-run" = "reported-live",
    observedAt = new Date().toISOString()
  ): Promise<void> {
    if (!observation.limited
      && observation.usedPercent === undefined
      && !observation.windows?.length
      && !observation.models?.length
      && observation.plan === undefined
      && observation.creditBalance === undefined
      && observation.ordinaryUsageAllowed === undefined) return;
    const existing = this.data.rateLimits.find((item) => item.providerKey === providerKey);
    if (!this.acceptsObservation(providerKey, observedAt)) return;
    if (existing && new Date(observedAt).getTime() < new Date(existing.updatedAt).getTime()) return;
    const now = new Date(observedAt);
    const oldWindows = existing?.windows?.map(window => ({ ...window, observedAt: window.observedAt ?? existing.updatedAt }));
    const newWindows = observation.windows?.map(window => ({ ...window, observedAt }));
    const resetAt = observation.resetAt;
    const fallbackCooldown = new Date(now.getTime() + 15 * 60_000).toISOString();
    const updated: RateLimitState = {
      providerKey,
      accountChangedAt: existing?.accountChangedAt,
      usedPercent: observation.replaceQuota ? observation.usedPercent : observation.usedPercent ?? existing?.usedPercent,
      resetAt: observation.replaceQuota ? resetAt : resetAt ?? existing?.resetAt,
      windows: source === "reported-live" && observation.windows
        ? newWindows : mergeWindows(oldWindows, newWindows),
      models: mergeModels(existing?.models, observation.models),
      plan: observation.plan ?? existing?.plan,
      creditBalance: observation.replaceQuota ? observation.creditBalance : observation.creditBalance ?? existing?.creditBalance,
      ordinaryUsageAllowed: observation.ordinaryUsageAllowed ?? existing?.ordinaryUsageAllowed,
      // A partial/stale usage refresh cannot immediately re-enable a provider
      // which just rejected a run. Retain its explicit reset/cooldown.
      cooldownUntil: observation.limited ? (resetAt ?? fallbackCooldown)
        : existing?.cooldownUntil && Date.parse(existing.cooldownUntil) > now.getTime() ? existing.cooldownUntil : undefined,
      source: observation.limited ? "error-derived" : source,
      lastError: observation.limited ? observation.detail ?? existing?.lastError : undefined,
      refreshError: source === "reported-live" ? undefined : existing?.refreshError,
      refreshRetryAt: source === "reported-live" ? undefined : existing?.refreshRetryAt,
      refreshFailures: source === "reported-live" ? 0 : existing?.refreshFailures,
      updatedAt: now.toISOString()
    };
    this.data.rateLimits = [
      ...this.data.rateLimits.filter((item) => item.providerKey !== providerKey),
      updated
    ];
    await this.persist();
  }

  async recordRefreshFailure(providerKey: string, detail: string, minimumDelayMs = 60_000): Promise<void> {
    const existing = this.data.rateLimits.find((item) => item.providerKey === providerKey);
    const updated: RateLimitState = {
      providerKey,
      ...existing,
      source: existing?.source ?? "unknown",
      refreshError: detail.slice(0, 600),
      refreshFailures: (existing?.refreshFailures ?? 0) + 1,
      refreshRetryAt: new Date(Date.now() + Math.max(minimumDelayMs, Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(existing?.refreshFailures ?? 0, 4)))).toISOString(),
      updatedAt: existing?.updatedAt ?? new Date().toISOString()
    };
    this.data.rateLimits = [
      ...this.data.rateLimits.filter((item) => item.providerKey !== providerKey),
      updated
    ];
    await this.persist();
  }

  async clearAuthenticationRetry(providerKey: string): Promise<void> {
    const existing = this.data.rateLimits.find(item => item.providerKey === providerKey);
    if (!existing || !(isClaudeAuthorizationFailure(existing.refreshError) || isCodexAuthorizationFailure(existing.refreshError))) return;
    // Keep the last error/usage visible until a real successful API response.
    existing.refreshRetryAt = undefined;
    existing.refreshFailures = 0;
    await this.persist();
  }

  acceptsObservation(providerKey: string, observedAt: string): boolean {
    const boundary = this.data.rateLimits.find(r => r.providerKey === providerKey)?.accountChangedAt;
    return Number.isFinite(Date.parse(observedAt)) && (!boundary || Date.parse(observedAt) > Date.parse(boundary));
  }

  /** A different account invalidates this environment's old quota, not the
   * account's actual server limits. Keep an audit and a replay boundary across
   * restarts, so historical task banners cannot resurrect the old cooldown. */
  async confirmAccountChange(providerKey: string, changedAt = new Date().toISOString()): Promise<void> {
    if (!Number.isFinite(Date.parse(changedAt))) throw new Error("Invalid account change time");
    const previous = this.data.rateLimits.find(r => r.providerKey === providerKey);
    if (previous?.accountChangedAt && Date.parse(changedAt) <= Date.parse(previous.accountChangedAt)) throw new Error("Account change must advance time");
    if (previous) this.data.accountHistory = [...(this.data.accountHistory ?? []), { replacedAt: changedAt, previous: structuredClone(previous) }].slice(-100);
    this.data.rateLimits = [...this.data.rateLimits.filter(r => r.providerKey !== providerKey),
      { providerKey, source: "unknown", updatedAt: changedAt, accountChangedAt: changedAt }];
    await this.persist();
  }

  async clearManualRefreshRetry(providerKey: string): Promise<void> {
    const existing = this.data.rateLimits.find(item => item.providerKey === providerKey);
    if (!existing?.refreshError) return;
    // Only explicit manual recovery can retry early. Respect provider throttling.
    if (/\b429\b|too many requests|retry.after|要求を制限/i.test(existing.refreshError)) return;
    existing.refreshRetryAt = undefined;
    existing.refreshFailures = 0;
    await this.persist();
  }

  async clearExpiredCooldown(providerKey: string): Promise<void> {
    const existing = this.data.rateLimits.find((item) => item.providerKey === providerKey);
    if (!existing?.cooldownUntil || new Date(existing.cooldownUntil).getTime() > Date.now()) return;
    existing.cooldownUntil = undefined;
    existing.lastError = undefined;
    // Expiring a local cooldown is not a fresh provider observation.
    await this.persist();
  }

  private persist(): Promise<void> { return this.writer.write(this.data); }
}

export function summarizeResources(
  policies: OrchestrationSettings,
  agents: AgentStatus[],
  tasks: TaskRecord[],
  rateLimits: RateLimitState[]
): ProviderResourceSummary[] {
  const groups = new Map<string, OrchestrationSettings["agentPolicies"]>();
  for (const policy of policies.agentPolicies) {
    const current = groups.get(policy.providerKey) ?? [];
    current.push(policy);
    groups.set(policy.providerKey, current);
  }

  return [...groups.entries()].map(([providerKey, members]) => {
    const agentIds = members.map((member) => member.agentId);
    const runs = tasks.flatMap((task) => task.runs).filter((run) => run.providerKey === providerKey);
    const legacy = tasks.filter((task) => task.legacySingleAgent && task.runs.length === 0 && task.agentId && agentIds.includes(task.agentId));
    const inputTokens = runs.reduce((total, run) => total + (run.usage?.inputTokens ?? 0), 0)
      + legacy.reduce((total, task) => total + (task.usage?.inputTokens ?? 0), 0);
    const outputTokens = runs.reduce((total, run) => total + (run.usage?.outputTokens ?? 0), 0)
      + legacy.reduce((total, task) => total + (task.usage?.outputTokens ?? 0), 0);
    const totalTokens = inputTokens + outputTokens;
    const failures = runs.filter((run) => ["failed", "rate-limited"].includes(run.state)).length;
    const rate = rateLimits.find((item) => item.providerKey === providerKey);
    const percentagePolicy = members.some(member => member.usageLimitPercent !== undefined);
    const softTokenBudget = percentagePolicy ? undefined : members.map((member) => member.softTokenBudget).find((value) => value !== undefined);
    const drainPercent = serviceUsageLimit(policies, members[0]);
    const configuredPercent = softTokenBudget ? Math.min(100, totalTokens / softTokenBudget * 100) : undefined;
    const windows = rate?.windows ?? [];
    const models = rate?.models ?? [];
    const configuredModel = members.map((member) => member.defaultModel).find((value) => value !== undefined);
    const defaultModel = models.find((model) => model.isDefault);
    const targetModel = configuredModel ?? defaultModel?.id ?? defaultModel?.label;
    const normalizeModel = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const relevantWindows = windows.filter((window) => {
      // Display Antigravity buckets without treating one exhausted model group
      // as exhaustion of the whole service. No model-to-bucket mapping yet.
      if (providerKey === "google-antigravity" && window.scope === "unknown") return false;
      if (window.scope !== "model") return true;
      if (!targetModel || !window.model) return false;
      return normalizeModel(window.model) === normalizeModel(targetModel);
    });
    const windowPercent = relevantWindows.length
      ? Math.max(...relevantWindows.map((window) => window.usedPercent))
      : undefined;
    const usedPercent = windowPercent ?? rate?.usedPercent ?? configuredPercent;
    const cooldown = rate?.cooldownUntil && new Date(rate.cooldownUntil).getTime() > Date.now();
    const installed = members.some((member) => member.enabled && agents.some((agent) => agent.id === member.agentId && agent.installed));
    let state: ProviderResourceSummary["state"] = installed ? "available" : "unavailable";
    if (cooldown) state = "cooldown";
    else if (usedPercent !== undefined && usedPercent >= drainPercent) state = "draining";
    else if (usedPercent !== undefined && usedPercent >= Math.min(policies.warningPercent, drainPercent)) state = "warning";
    return {
      providerKey,
      providerLabel: members[0]?.providerLabel ?? providerKey,
      agentIds,
      authModes: [...new Set(members.map((member) => member.authMode))],
      state,
      totalTokens,
      inputTokens,
      outputTokens,
      runs: runs.length,
      failures,
      usedPercent,
      softTokenBudget,
      resetAt: rate?.resetAt,
      windows,
      models,
      configuredModel,
      plan: rate?.plan,
      creditBalance: rate?.creditBalance,
      ordinaryUsageAllowed: rate?.ordinaryUsageAllowed,
      capacityUpdatedAt: providerKey === "ollama-cloud" && rate?.source === "unknown" ? undefined : rate?.updatedAt,
      capacityError: rate?.refreshError,
      capacityRetryAt: rate?.refreshRetryAt,
      cooldownUntil: cooldown ? rate?.cooldownUntil : undefined,
      limitSource: rate?.source ?? (softTokenBudget ? "configured" : runs.length ? "reported-run" : "unknown")
    };
  });
}
