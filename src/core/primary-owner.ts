import type { AgentRun, RoleAssignment, TaskRecord, WorkUnit } from "./types";
import { workUnitAssignment } from "./initial-assignment";

/** Responsibility is task-scoped, not a new provider choice at every phase.
 * Review seats and isolated specialists must never inherit the writer's seat. */
export function primaryOwned(unit: WorkUnit): boolean {
  return !!(unit.primary || unit.primaryStep || unit.orchestrator);
}

export function primaryOwner(task: TaskRecord): AgentRun | undefined {
  return [...task.runs].reverse().find(r => r.primary && !r.goalPreparation
    && ["completed", "running"].includes(r.state));
}

export function effectiveAssignment(task: TaskRecord, unit: WorkUnit): RoleAssignment | undefined {
  if (unit.retryAgentId || unit.crossReview || (unit.subtask && !unit.primaryStep)
    || unit.reviewPass === 2) return;
  const explicit = workUnitAssignment(task, unit);
  if (explicit?.agentId || !primaryOwned(unit) || task.goalPreparation) return explicit;
  const owner = primaryOwner(task);
  // Keep the service, but use the current explicit model configuration. A user
  // model change must not be silently undone by an old run's saved alias.
  return owner ? { agentId: owner.agentId, allowFallback: true } : explicit;
}
