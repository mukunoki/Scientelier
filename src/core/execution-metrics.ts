import type { AgentRun, TaskRecord, UsageRecord } from "./types";
import { executionTime, executionRuns } from "./execution-time";

export interface ExecutionMetrics {
  elapsedMs: number;
  measuredAt: number;
  ticking: boolean;
  measuredRuns: number;
  totalRuns: number;
  usage: UsageRecord;
  startupMs: number; unknownMs: number; currentParallel: number; waitingRuns: number; peakParallel: number; parallelMs: number;
  intervals: ReturnType<typeof executionTime>["intervals"];
  models: Array<{ agentId: AgentRun["agentId"]; model?: string; measuredRuns: number; totalRuns: number; usage: UsageRecord }>;
}

function summarizeUsage(runs: AgentRun[]) {
  const measured = runs.filter(r => r.usage?.source === "reported" && r.usage.inputTokens !== undefined && r.usage.outputTokens !== undefined);
  const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens") => measured.reduce((s, r) => s + (r.usage?.[key] ?? 0), 0);
  return { measuredRuns: measured.length, totalRuns: runs.length,
    usage: measured.length ? {source:"reported" as const,inputTokens:sum("inputTokens"),outputTokens:sum("outputTokens"),cachedInputTokens:sum("cachedInputTokens")} : {source:"unknown" as const} };
}

// Account quotas include other tasks/apps; never turn quota percentages into tokens.
export function executionMetrics(task: TaskRecord, now = Date.now(), scope: "round" | "task" = "round"): ExecutionMetrics {
  const runs = executionRuns(task, scope);
  // Group saved launch models, not today's settings. Unknown models stay unknown;
  // a default model may change between sessions and must not be guessed.
  const groups = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.agentId, run.model?.trim() || null]);
    const group = groups.get(key) ?? []; group.push(run); groups.set(key, group);
  }
  const time = executionTime(task,now,scope);
  const ticking = time.currentParallel > 0;
  return { ...time, measuredAt: ticking ? now : 0, ticking,
    ...summarizeUsage(runs),
    models: [...groups.values()].map(group => ({agentId:group[0].agentId,model:group[0].model?.trim() || undefined,...summarizeUsage(group)})) };
}
