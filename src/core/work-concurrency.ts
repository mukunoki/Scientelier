import type { SubtaskSpec, WorkUnit } from "./types";

/** Workspace isolation and machine-resource isolation are different. By
 * default every shared writer is exclusive. The only opt-in exception is a
 * text-only peer that cannot inspect the workspace or perform experiments. */
export interface WorkAccess {
  exclusive?: boolean;
  taskOnly?: boolean;
  allowTaskOnlyPeers?: boolean;
}
export function taskOnlyInvestigation(unit: WorkUnit): boolean {
  return unit.role === "worker" && unit.mode === "read" && !unit.planPhase && !unit.orchestrator
    && unit.subtask?.inputScope === "assignment" && (!unit.subtask.kind || unit.subtask.kind === "investigation");
}
export function packageAccess(spec: SubtaskSpec): WorkAccess {
  return { exclusive: spec.kind === "primary-work",
    taskOnly: spec.inputScope === "assignment" && (!spec.kind || spec.kind === "investigation"),
    allowTaskOnlyPeers: spec.kind === "primary-work" && spec.allowTaskOnlyPeers === true };
}
export function workAccess(unit: WorkUnit): WorkAccess {
  return { exclusive: unit.mode === "write" && unit.subtask?.kind !== "isolated-work",
    taskOnly: taskOnlyInvestigation(unit) || !!unit.orchestrator,
    allowTaskOnlyPeers: !!unit.primaryStep && unit.subtask?.kind === "primary-work" && unit.subtask.allowTaskOnlyPeers === true };
}
/** Shared by admission and time estimates, so a claimed speedup uses the same
 * compatibility rule as the actual execution graph. This is not an OS sandbox. */
export function concurrentAccessAllowed(a: WorkAccess, b: WorkAccess): boolean {
  if (a.exclusive && b.exclusive) return false;
  if (a.exclusive) return a.allowTaskOnlyPeers === true && b.taskOnly === true;
  if (b.exclusive) return b.allowTaskOnlyPeers === true && a.taskOnly === true;
  return true;
}
