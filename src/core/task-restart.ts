import { randomUUID } from "node:crypto";
import { copyReportFiles } from "./report-files";
import { createExecutionWorkflow } from "./orchestration";
import { defaultExecution } from "./execution-policy";
import { autonomous, orderAutonomousUnits } from "./autonomy";
import { pairUnits } from "./review-pair";
import { initialGoal } from "./goals";
import type { ReportRecord, TaskRecord } from "./types";

export type RestartMode = "carry" | "fresh";
export function validateRestart(task: TaskRecord | undefined, mode: unknown): asserts task is TaskRecord {
  if (!task) throw new Error("元のタスクが見つかりません。");
  if (mode !== "carry" && mode !== "fresh") throw new Error("やり直し方法が不正です。");
  if (!["completed", "paused", "blocked", "failed", "cancelled", "awaiting-input"].includes(task.state) || task.goalPreparation) throw new Error("実行を停止してからやり直してください。");
}

/** Allowlist settings: never inherit runs, conversation IDs, evaluation or budget consumption. */
export function restartedTask(source: TaskRecord, mode: RestartMode, cwd: string, id = randomUUID()): TaskRecord {
  validateRestart(source, mode);
  const now = new Date().toISOString();
  const goal = structuredClone(source.goal) ?? initialGoal(source.prompt, source.workPreset);
  const task: TaskRecord = {
    lessonSources: structuredClone(source.lessonSources),
    lessonSkills: structuredClone(source.lessonSkills),
    remote: source.remote ? structuredClone(source.remote) : undefined,
    // A restart creates a new task: apply the new-local default to legacy
    // unspecified permissions, but preserve explicit restrictions and remote scope.
    localCodexPermissions: source.localCodexPermissions ?? (source.remote ? undefined : "full-access"),
    researchCycle: source.researchCycle,
    qualityCycle: source.qualityCycle,
    id, title: `${source.title}（${mode === "carry" ? "引き継ぎ" : "新規やり直し"}）`, prompt: source.prompt, cwd,
    strategy: source.strategy, workflowMode: "primary",
    reviewPolicy: "adversarial-pair",
    allowedAgentIds: structuredClone(source.allowedAgentIds), modelOverrides: structuredClone(source.modelOverrides),
    execution: structuredClone(source.pendingExecution?.policy ?? source.execution ?? defaultExecution), autonomy: structuredClone(source.autonomy) ?? { enabled: true, maxCycles: 3 },
    workPreset: structuredClone(source.workPreset), goal, goalHistory: structuredClone(source.goalHistory),
    scopeTransition: structuredClone(source.scopeTransition),
    assignments: structuredClone(source.assignments), pauseAfterPlan: source.pauseAfterPlan, planApproved: false,
    goalPreparation: false, roundNumber: 1, roundKind: "initial", autonomyCycle: 1,
    instruction: mode === "carry" ? source.instruction ?? source.prompt : source.prompt,
    state: goal.status === "draft" ? "awaiting-input" : "queued",
    awaitingReason: goal.status === "draft" ? "goal" : undefined,
    runs: [], workUnits: [], output: "", createdAt: now, updatedAt: now,
    restart: { sourceTaskId: source.id, mode }
  };
  if (mode === "carry") {
    const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) + "\n[truncated; inspect saved files/logs]" : text;
    task.restart!.handoff = clip([
      "Prior work is a starting point, not verified success. Replan against the unchanged goal and verify all outputs again.",
      `Previous status: ${source.state}; ${source.error ?? ""}`,
      `Previous report (reference only): ${source.report?.texPath ?? "none"}`,
      ...(source.history ?? []).slice(-5).map(r => `User instruction, round ${r.number}: ${clip(r.instruction, 1500)}`),
      ...(source.history ?? []).slice(-2).flatMap(r => r.workUnits.slice(-3).map(u => `Previous round ${r.number}, ${u.title}: ${clip(u.output ?? u.error ?? "", 1000)}`)),
      ...(source.pendingFollowup ? [`Saved but unexecuted user instruction: ${clip(source.pendingFollowup.instruction, 2000)}`] : []),
      ...source.workUnits.slice(-12).map(u => `${u.title} [${u.state}]: ${clip(u.output ?? u.error ?? "", 1500)}`),
      "Prior external logs (read only as needed):", ...source.runs.filter(r => r.logPath).slice(-12).map(r => r.logPath!)
    ].join("\n\n"), 20000);
  }
  const units = createExecutionWorkflow(task);
  task.workUnits = autonomous(task) ? orderAutonomousUnits(units) : units;
  if (task.reviewPolicy) task.workUnits = pairUnits(task.workUnits);
  return task;
}

/** Copy report source/assets to the NEW task only. Old PDFs are not fresh evidence. */
export async function copyRestartReport(report: ReportRecord | undefined, destination: string): Promise<ReportRecord | undefined> {
  return copyReportFiles(report, destination);
}
