import type { TaskRecord, WorkUnit } from "./types";
import { readySubtasks } from "./decomposition";
import { estimatedWork } from "./execution-policy";
import { currentExecutionBlocker } from "./execution-blocker";
import { concurrentAccessAllowed, workAccess, taskOnlyInvestigation } from "./work-concurrency";
import { timeCheckpoint } from "./time-budget";

type UnitResult = "completed" | "rate-limited" | "retry" | "failed" | "cancelled" | "blocked";
type Settled = { unitId: string; result: UnitResult; error?: string };
export type PlannedWorkResult = { status: "done" | "paused" | "failed" | "settings"; unitId?: string; error?: string };

/** Advice may change descendants of a new finding, not unrelated saved work.
 * Final integration also waits because the controller can add a prerequisite. */
function coordinationAffected(task: TaskRecord, events: string[]): Set<string> {
  const affected = new Set(events);
  for (let changed=true; changed;) {
    changed=false;
    for (const u of task.workUnits) if (!affected.has(u.id) && u.dependsOn?.some(id=>affected.has(id))) {
      affected.add(u.id); changed=true;
    }
  }
  for (const u of task.workUnits) if (u.primary && !u.planPhase) affected.add(u.id);
  return affected;
}

// Prioritize the longest remaining dependency chain (an estimate, not a timeout).
export function orderReadyPackages(task: TaskRecord): WorkUnit[] {
  const memo = new Map<string, number>();
  const score = (unit: WorkUnit, visiting = new Set<string>()): number => {
    if (visiting.has(unit.id)) return 0; // defensive for legacy persisted graphs
    const cached = memo.get(unit.id); if (cached !== undefined) return cached;
    const next = new Set(visiting).add(unit.id);
    const successors = task.workUnits.filter(u => u.subtask && u.state !== "completed" && u.dependsOn.includes(unit.id));
    const value = (unit.subtask?.estimatedMinutes ?? estimatedWork(unit) / 1000) + Math.max(0, ...successors.map(u => score(u, next)));
    memo.set(unit.id, value); return value;
  };
  return readySubtasks(task).sort((a, b) => Number(b.mode === "write") - Number(a.mode === "write") || score(b) - score(a));
}

// Rolling admission for planned packages. Never return while an owned run is
// active: failure, pause and budget decisions must not race a surviving writer.
export async function runPlannedWork(options: {
  snapshot: () => TaskRecord;
  execute: (unitId: string) => Promise<UnitResult>;
  paused: () => boolean;
  coordinate?: (completedUnitIds: string[], canApply: () => boolean) => Promise<void>;
  /** Short observation wakeup only; the controller deduplicates actual LLM turns. */
  observationMs?: number;
}): Promise<PlannedWorkResult> {
  const active = new Map<string, { unit: WorkUnit; promise: Promise<Settled> }>();
  let coordinating: Promise<{ coordination: true }> | undefined;
  let affected = new Set<string>();
  // Recovered completed packages are safe to offer again: the controller uses
  // persisted event IDs to discard decisions already made before a restart.
  const completedEvents: string[] = options.snapshot().workUnits.filter(u=>u.subtask && u.state==="completed" && !u.allocatedBy).map(u=>u.id);
  let stopped: PlannedWorkResult | undefined;
  let offeredTimeCheckpoint=0;
  while (true) {
    let task = options.snapshot();
    if (options.paused()) stopped = { status: "paused", unitId: active.keys().next().value };
    const blocker = currentExecutionBlocker(task);
    if (blocker) stopped = {status:"failed",unitId:blocker.unitId,error:blocker.summary};
    // A settings update is a graceful barrier: finish owned PTYs and coordinator
    // first, then let the workflow apply the new policy before any new launch.
    if (!stopped && task.pendingExecution && !active.size && !coordinating) return { status: "settings" };
    if (!stopped && !task.pendingExecution) {
      const ready = orderReadyPackages(task).filter(u => !active.has(u.id));
      const sharedWriter = (u: WorkUnit) => u.mode === "write" && u.subtask?.kind !== "isolated-work";
      const writing = [...active.values()].some(v => sharedWriter(v.unit));
      // Let the saved-plan controller inspect new findings BEFORE launching a
      // dependent package. A writer may overlap only a text-only controller and
      // only by explicit opt-in; measurements retain the exclusive barrier.
      const coordinateSafe = !writing || [...active.values()].filter(v=>sharedWriter(v.unit)).every(v=>v.unit.subtask?.allowTaskOnlyPeers);
      const checkpoint=timeCheckpoint(task);
      const timeDue=checkpoint && checkpoint>offeredTimeCheckpoint && !(task.orchestratorDecisions??[])
        .some(d=>d.round===(task.roundNumber??1) && (d.timeCheckpoint??0)>=checkpoint);
      if (options.coordinate && !coordinating && (completedEvents.length || timeDue) && coordinateSafe
        && active.size < (task.execution?.maxParallel ?? 1)) {
        if(timeDue)offeredTimeCheckpoint=checkpoint;
        const events = completedEvents.splice(0);
        affected = coordinationAffected(task,events);
        coordinating = Promise.resolve().then(() => options.coordinate!(events, () => !stopped && !options.paused() && !options.snapshot().pendingExecution && !currentExecutionBlocker(options.snapshot())))
          .catch(() => { /* optional coordination cannot fail required work */ })
          .then(() => ({ coordination: true as const }));
      }
      // A preflight/light implementation may explicitly overlap input-only
      // reasoning. Ordinary readers, isolated writers and benchmarks still
      // drain before a shared writer. Never infer safety from a task title.
      const runningWriter = [...active.values()].find(v => sharedWriter(v.unit))?.unit;
      // A controller is a text-only peer, not a global barrier. Keep affected
      // descendants and integration pending; admit unrelated compatible work.
      const admissible = coordinating ? ready.filter(u=>!affected.has(u.id)
        && concurrentAccessAllowed({taskOnly:true},workAccess(u))) : ready;
      const admissibleWriter = admissible.find(sharedWriter);
      const candidates = runningWriter
        ? admissible.filter(u => taskOnlyInvestigation(u) && concurrentAccessAllowed(workAccess(runningWriter), workAccess(u)))
        : admissibleWriter ? [admissibleWriter, ...admissible.filter(taskOnlyInvestigation)] : admissible;
      for (const unit of candidates) {
        if (options.paused()) { stopped = { status: "paused", unitId: unit.id }; break; }
        if (active.size + Number(!!coordinating) >= (task.execution?.maxParallel ?? 1)) break;
        if ([...active.values()].some(v => !concurrentAccessAllowed(workAccess(v.unit), workAccess(unit)))) continue;
        // A pending exclusive writer is a drain barrier for ordinary peers.
        if (admissibleWriter && unit.id !== admissibleWriter.id && !active.has(admissibleWriter.id)) continue;
        task = options.snapshot();
        const failure = currentExecutionBlocker(task);
        if (failure) { stopped = {status:"failed",unitId:failure.unitId,error:failure.summary}; break; }
        const promise = Promise.resolve().then(() => options.execute(unit.id))
          .then(result => ({ unitId: unit.id, result }), error => ({ unitId: unit.id, result: "failed" as const, error: String(error) }));
        active.set(unit.id, { unit, promise });
        if (sharedWriter(unit) && !unit.subtask?.allowTaskOnlyPeers) break;
      }
      if (!active.size && !coordinating && !stopped) return { status: "done" };
    }
    if (!active.size && !coordinating) return stopped ?? { status: "done" };
    const pending: Array<Promise<Settled | { coordination: true } | { observation: true }>> = [...active.values()].map(v => v.promise);
    if (coordinating) pending.push(coordinating);
    let observationTimer:NodeJS.Timeout|undefined;
    if (options.coordinate && task.autonomy?.targetMinutes && active.size) pending.push(new Promise(resolve=>{
      observationTimer=setTimeout(()=>resolve({observation:true}),options.observationMs??15000);
    }));
    const settled = await Promise.race(pending);
    clearTimeout(observationTimer);
    if ("observation" in settled) continue;
    if ("coordination" in settled) { coordinating = undefined; affected.clear(); continue; }
    active.delete(settled.unitId);
    if (settled.result === "completed" && !options.snapshot().workUnits.find(u=>u.id===settled.unitId)?.allocatedBy) completedEvents.push(settled.unitId);
    if (settled.result === "cancelled") stopped = { status: "paused", unitId: settled.unitId };
    else if (["failed", "blocked"].includes(settled.result) && !stopped) {
      stopped = { status: "failed", unitId: settled.unitId,
        error: settled.error ?? options.snapshot().workUnits.find(u => u.id === settled.unitId)?.error ?? "計画内の作業が中断しました。" };
    }
    // A rate-limited or recoverable failed unit retries an eligible provider. The
    // routing layer owns attempt/capacity limits; this loop never clears them.
  }
}
