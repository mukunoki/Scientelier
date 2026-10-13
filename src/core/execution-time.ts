import type { AgentRun, TaskRecord } from "./types";
import { isActiveTaskState } from "./task-state";

export function roundRuns(task: TaskRecord): AgentRun[] {
  const cutoff = Math.max(0, ...(task.history ?? []).filter(r => r.number < (task.roundNumber ?? 1)).map(r => Date.parse(r.finishedAt)).filter(Number.isFinite));
  return task.runs.filter(r => !r.goalPreparation && Date.parse(r.startedAt) >= cutoff);
}
// Historical display must not change the round boundary used by the scheduler.
export function executionRuns(task: TaskRecord, scope: "round" | "task" = "round"): AgentRun[] {
  return scope === "task" ? task.runs.filter(r => !r.goalPreparation) : roundRuns(task);
}
export function runInterval(task: TaskRecord, run: AgentRun, now = Date.now()) {
  const start = Date.parse(run.startedAt);
  const live = isActiveTaskState(task.state) && run.state === "running" && !run.completedAt;
  const end = run.completedAt ? Date.parse(run.completedAt) : live ? now : run.state === "running" ? Date.parse(task.updatedAt) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
  const observed = Date.parse(run.executionTiming?.workStartedAt ?? "");
  const workStart = run.executionTiming ? Number.isFinite(observed) ? Math.min(end, Math.max(start, observed)) : end : start;
  return { runId:run.id, unitId:run.workUnitId, agentId:run.agentId, start, end, workStart,
    uncertain:!run.executionTiming, live, waiting:live && !!run.executionTiming && !Number.isFinite(observed) };
}
export function unionMilliseconds(intervals: Array<[number,number]>): number {
  let total = 0, end = 0;
  for (const [a,b] of [...intervals].sort((x,y)=>x[0]-y[0])) { total += Math.max(0,b-Math.max(a,end)); end = Math.max(end,b); }
  return total;
}
export function executionTime(task: TaskRecord, now = Date.now(), scope: "round" | "task" = "round") {
  const intervals = executionRuns(task, scope).flatMap(r => { const i=runInterval(task,r,now); return i?[i]:[]; });
  const events = intervals.flatMap(i=>i.end>i.workStart ? [[i.workStart,1],[i.end,-1]] : []).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let count=0, peak=0, parallelMs=0, last=0;
  for (const [at,delta] of events) { if(count>=2)parallelMs+=at-last; count+=delta; peak=Math.max(peak,count);last=at; }
  const elapsedMs=unionMilliseconds(intervals.map(i=>[i.workStart,i.end]));
  return {elapsedMs, startupMs:unionMilliseconds(intervals.map(i=>[i.start,i.end]))-elapsedMs,
    unknownMs:unionMilliseconds(intervals.filter(i=>i.uncertain).map(i=>[i.workStart,i.end])),
    currentParallel:intervals.filter(i=>i.live&&!i.waiting).length, waitingRuns:intervals.filter(i=>i.waiting).length,
    peakParallel:peak, parallelMs, intervals};
}
