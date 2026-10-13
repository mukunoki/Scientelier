import { ACTIVE_AGENT_IDS } from "./types";
import { isActiveTaskState } from "./task-state";
import type { AgentId, RoleAssignment, TaskRecord, WorkUnit } from "./types";

/** Goal-proposal runs do not count as starting substantive work. A start
 * preference belongs to one round and survives goal approval rebuilding IDs. */
export function initialAssignmentEditable(task: TaskRecord, active = false): boolean {
  return !active && !isActiveTaskState(task.state) && task.state !== "completed"
    && !task.workUnits.some(u => u.state === "running")
    && !task.runs.some(r => !r.goalPreparation);
}

export function workUnitAssignment(task: TaskRecord, unit: WorkUnit): RoleAssignment | undefined {
  const initial = task.initialAssignment;
  if (!task.goalPreparation && initial?.round === (task.roundNumber ?? 1) && task.workUnits[0]?.id === unit.id) return initial;
  return task.assignments?.[unit.role];
}

export function initialAssignmentPatch(task: TaskRecord, value: unknown, updatedAt: string, active = false): Partial<TaskRecord> {
  if (!initialAssignmentEditable(task, active)) throw new Error("本作業の開始前に変更してください。起動済みの担当は変更しません。");
  if (updatedAt !== task.updatedAt) throw new Error("タスクが更新されています。設定を開き直してください。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("開始時のCLI設定が不正です。");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !["agentId", "model", "allowFallback"].includes(k)) || typeof input.allowFallback !== "boolean")
    throw new Error("開始時のCLI設定が不正です。");
  if (input.agentId !== undefined && (typeof input.agentId !== "string" || !ACTIVE_AGENT_IDS.includes(input.agentId as typeof ACTIVE_AGENT_IDS[number])
    || !task.allowedAgentIds.includes(input.agentId as AgentId))) throw new Error("このタスクで利用を許可したCLIを選んでください。");
  if (input.model !== undefined && (typeof input.model !== "string" || input.model.length > 256 || /[\x00-\x1f\x7f]/.test(input.model)))
    throw new Error("モデル名が不正です。");
  const model = (input.model as string | undefined)?.trim() || undefined;
  if (model && !input.agentId) throw new Error("モデルを指定する場合はCLIも選んでください。");
  return { initialAssignment: input.agentId ? { agentId: input.agentId as RoleAssignment["agentId"], model,
    allowFallback: input.allowFallback, round: task.roundNumber ?? 1 } : undefined };
}
