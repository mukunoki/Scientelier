import { readFile, stat } from "node:fs/promises";
import type { AgentRun } from "./types";

// Old PTY logs mix terminal bytes and timestamped harness events. Only recover
// the explicit harness instruction-read event; never trust an agent's time claim.
export function timingFromLog(run: AgentRun, text: string): AgentRun["executionTiming"] {
  const match = text.match(/^\[([^\]\r\n]+)\] \[status\] MCP：この工程の指示取得を確認しました。\r?$/m);
  const time = Date.parse(match?.[1] ?? "");
  if (!Number.isFinite(time) || time < Date.parse(run.startedAt) || !run.completedAt || time > Date.parse(run.completedAt)) return;
  return {workStartedAt:new Date(time).toISOString(),source:"log"};
}
export async function recoverTiming(run: AgentRun): Promise<AgentRun["executionTiming"]> {
  if (run.executionTiming || !run.logPath || !run.completedAt) return run.executionTiming;
  try {
    const info=await stat(run.logPath); if(!info.isFile() || info.size>64*1024*1024)return;
    return timingFromLog(run,await readFile(run.logPath,"utf8"));
  } catch { return; } // Missing evidence stays unknown; startup must remain usable.
}
