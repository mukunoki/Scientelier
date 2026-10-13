import { randomUUID } from "node:crypto";
import type { SubtaskSpec, TaskRecord, WorkUnit } from "./types";
import { validatePlanTasks } from "./plan-format";
import { alternativeCandidateInstructions, alternativeSelectionInstructions } from "./alternative-strategy";

export function delegationPrompt(task: TaskRecord, unit: WorkUnit): string {
  if (!task.execution?.decompose || !unit.primary || unit.planPhase || unit.planRevision || task.executionPlans?.some(p => p.round === (task.roundNumber ?? 1)) || unit.delegationUsed || task.goal?.status !== "approved") return "";
  return `# Optional bounded delegation\nPrefer working yourself for tightly coupled or small tasks. Only when independently useful, you may return ONE <work-plan>JSON</work-plan> block INSTEAD OF <work-check>, then the normal completion marker. The harness will run the subtasks and return their findings to you; this is NOT goal completion. Do not start another CLI or subagent yourself. At most ${task.execution.maxSubtasks} subtasks, at most ${task.execution.maxParallel} in parallel. All delegated tasks are READ-ONLY investigation/verification: no file edits, job submission, external messages or side effects. Write operations remain with you. Each has a concrete output and acceptance check tied to approved criterion IDs. Format: {"tasks":[{"key":"research_a","title":"...","instructions":"...","deliverable":"findings with source references","acceptance":"how to check the findings","criterionIds":["approved criterion id"],"dependsOn":[],"estimatedTokens":3000}]}. Dependencies name other keys in this batch. No cycles, duplicate work or invented criteria. Return findings via handoffs; the app persists them in external logs, not Markdown or the PDF. Estimate useful time benefit and integration cost. Total tokens are telemetry, not a reason to reject useful work; actual provider quotas and launch safety still apply. You get only one delegation batch per repair cycle; otherwise execute yourself.`;
}
export function parseWorkPlan(output: string, task: TaskRecord, owner: WorkUnit): SubtaskSpec[] | undefined {
  const blocks = [...output.matchAll(/<work-plan>([\s\S]*?)<\/work-plan>/g)];
  if (!blocks.length) return;
  if (!task.execution?.decompose || !owner.primary || owner.planPhase || owner.planRevision || task.executionPlans?.some(p => p.round === (task.roundNumber ?? 1)) || owner.delegationUsed || task.goal?.status !== "approved" || blocks.length !== 1 || blocks[0][1].length > 32000 || output.includes("<work-check>")) throw new Error("分担案を適用できません。新しい主担当方式では実行計画を更新してください。");
  const value = JSON.parse(blocks[0][1]);
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > task.execution.maxSubtasks) throw new Error("分担数が設定範囲外です。");
  const tasks = validatePlanTasks(value.tasks, { criterionIds: task.goal.criteria.map(c => c.id), requiredCriterionIds: [], maxSubtasks: task.execution.maxSubtasks });
  return tasks;
}
export function expandWorkPlan(units: WorkUnit[], owner: WorkUnit, tasks: SubtaskSpec[]): WorkUnit[] {
  const ids = new Map(tasks.map(t => [t.key, randomUUID()]));
  const children: WorkUnit[] = tasks.map(t => ({ id: ids.get(t.key)!, role: "worker", mode: "read", title: t.title, subtask: t, researchStage: owner.researchStage,
    instructions: `${t.instructions}\nRequired deliverable: ${t.deliverable}\nAcceptance check: ${t.acceptance}\nApproved criterion IDs: ${t.criterionIds.join(", ")}${alternativeCandidateInstructions(t)}`,
    state: "pending", attemptedAgentIds: [], dependsOn: t.dependsOn.length ? t.dependsOn.map(k => ids.get(k)!) : [owner.id] }));
  const integration: WorkUnit = { ...owner, id: randomUUID(), title: "主担当 · 分担成果の統合", delegationUsed: true, delegationHandled: undefined, checkpointHandled: undefined,
    instructions: "Integrate the delegated findings into the approved deliverable. Check sources and acceptance conditions yourself: handoffs are claims, not proof. Resolve conflicts, implement remaining work, update substantive TeX and perform self-verification. This batch is finished; do not issue another work-plan. Continue from existing files without redoing successful independent work." + alternativeSelectionInstructions(tasks),
    state: "pending", dependsOn: children.map(c => c.id), attemptedAgentIds: [], assignedAgentId: undefined, output: undefined, error: undefined, startedAt: undefined, completedAt: undefined };
  const updated = units.map(u => u.id === owner.id ? { ...u, delegationHandled: true, checkpointHandled: true } : { ...u, dependsOn: u.dependsOn.map(id => id === owner.id ? integration.id : id) });
  updated.splice(updated.findIndex(u => u.id === owner.id) + 1, 0, ...children, integration);
  return updated;
}
export function readySubtasks(task: TaskRecord): WorkUnit[] {
  return task.workUnits.filter(u => u.subtask && (u.mode === "read" || ((u.primaryStep || u.subtask.kind === "isolated-work") && u.mode === "write")) && u.state === "pending" && u.dependsOn.every(id => task.workUnits.some(d => d.id === id && d.state === "completed")));
}
