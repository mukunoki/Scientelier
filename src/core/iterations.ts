import { createStandardWorkflow, createExecutionWorkflow } from "./orchestration";
import { AGENT_IDS } from "./types";
import { autonomous, orderAutonomousUnits } from "./autonomy";
import { currentWorkClosure } from "./work-closure";
import { defaultExecution } from "./execution-policy";
import { resumableUnit, resumePatch } from "./recovery";
import type { FollowupInput, TaskRecord, TaskRound, WorkUnit, WorkUnitRole } from "./types";

import { isActiveTaskState } from "./task-state";

export function validateFollowup(value: FollowupInput, task: TaskRecord): FollowupInput {
  if (!value || typeof value.instruction !== "string" || !value.instruction.trim()) throw new Error("追加指示を入力してください。");
  if (value.instruction.length > 50_000) throw new Error("追加指示は50,000文字以内にしてください。");
  if (!["consult", "continue", "review", "report"].includes(value.kind)) throw new Error("作業の種類が不正です。");
  if (value.implementation !== undefined && typeof value.implementation !== "boolean") throw new Error("実装・実験への移行指定が不正です。");
  if (value.implementation && (value.kind !== "continue" || task.workPreset?.manifest.focus !== "idea" || task.goal?.status !== "approved")) throw new Error("承認済みのアイディアモードから「修正・続行」で実装・実験へ移行してください。");
  const change = value.scopeChange;
  if (change !== undefined) {
    if (!change || value.implementation || value.kind !== "continue" || task.goal?.status !== "approved" || change.confirmed !== true
      || typeof change.implementation !== "boolean" || Object.keys(change).some(k => !["goalRevision", "removeConstraints", "removeOutOfScope", "criterionEdits", "implementation", "confirmed"].includes(k))) throw new Error("作業範囲の変更は「修正・続行」の確認画面から承認してください。");
    if (change.goalRevision !== task.goal.revision) throw new Error("ゴールが更新されています。作業範囲の変更画面を開き直してください。");
    for (const [key, source] of [["removeConstraints", task.goal.constraints], ["removeOutOfScope", task.goal.outOfScope]] as const) {
      if (!Array.isArray(change[key]) || change[key].length > 40 || change[key].some(v => typeof v !== "string" || !source.includes(v)) || new Set(change[key]).size !== change[key].length) throw new Error("解除対象は現在の制約・対象外から選んでください。");
    }
    if (value.instruction.trim().length > 8000) throw new Error("作業範囲を変更する追加指示は8,000文字以内にしてください。");
    // Only explicitly selected existing criteria may be edited. Required flags
    // and IDs are immutable here; a reply such as “OK” never changes the goal.
    if (change.criterionEdits !== undefined) {
      const edits = change.criterionEdits;
      if (!Array.isArray(edits) || edits.length > 20 || edits.some(e => !e || typeof e !== "object"
        || Object.keys(e).some(k => !["id", "description", "verification"].includes(k))
        || !task.goal!.criteria.some(c => c.id === e.id)
        || [e.description, e.verification].some(s => typeof s !== "string" || !s.trim() || s.length > 2000))
        || new Set(edits.map(e => e.id)).size !== edits.length) throw new Error("合格条件は現在の項目を選び、変更後の条件と検証方法を各2,000文字以内で入力してください。");
    }
  }
  const assignments: FollowupInput["assignments"] = {};
  for (const role of ["planner", "worker", "reviewer", "reporter"] as const) {
    const assignment = value.assignments?.[role];
    if (!assignment) continue;
    if (assignment.agentId && (!AGENT_IDS.includes(assignment.agentId) || !task.allowedAgentIds.includes(assignment.agentId))) {
      throw new Error("このタスクで許可されていないCLIが指定されています。");
    }
    if (assignment.model !== undefined && typeof assignment.model !== "string") throw new Error("モデル名が不正です。");
    if (assignment.model?.trim() && !assignment.agentId) throw new Error("モデルを指定する場合はCLIも選んでください。");
    assignments[role] = { agentId: assignment.agentId, model: assignment.model?.trim() || undefined, allowFallback: assignment.allowFallback === true };
  }
  return { instruction: value.instruction.trim(), kind: value.kind, assignments, pauseAfterPlan: value.pauseAfterPlan === true, ...(value.implementation ? { implementation: true } : {}), ...(change ? { scopeChange: structuredClone(change) } : {}) };
}

export function createFollowupWorkflow(input: FollowupInput, task?: TaskRecord): WorkUnit[] {
  if (input.kind === "continue") return createExecutionWorkflow({ ...task, ...input, workflowMode: "primary" }, { initial: false });
  const roles: WorkUnitRole[] = input.kind === "consult" ? ["planner"]
    : input.kind === "review" ? ["reviewer"] : input.kind === "report" ? ["reporter"]
      : [];
  const units = createStandardWorkflow().filter((unit) => roles.includes(unit.role));
  return units.map((unit, index) => ({ ...unit, dependsOn: index ? [units[index - 1].id] : [] }));
}

/** An answer to an interruption is not a new planning round. This deliberately
 * does not make a plain Resume button bypass a user-decision checkpoint. */
export function interruptedFollowupUnit(task: TaskRecord): WorkUnit | undefined {
  if (isActiveTaskState(task.state) || task.state === "completed" || task.goalPreparation
    || task.goal?.status !== "approved" || task.goalRevisionPending || task.awaitingReason === "plan"
    || (task.workClosure?.round === (task.roundNumber ?? 1) && task.workClosure.finishedAt)) return;
  const interrupted = resumableUnit(task);
  if (interrupted) return interrupted;
  if (task.state !== "awaiting-input" || task.awaitingReason !== "result" || task.autonomyState !== "needs-input") return;
  // Only an already accepted checkpoint is eligible. Raw CLI text or an older
  // question cannot authorize skipping the application's validation gates.
  const checkpoint = task.workUnits.filter(u => (u.primary || u.checkpointFor) && u.checkpointHandled && u.state === "completed")
    .sort((a, b) => (Date.parse(b.completedAt ?? "") || 0) - (Date.parse(a.completedAt ?? "") || 0))[0];
  if (checkpoint && /^ユーザ確認が必要です。/.test(task.error ?? "")) {
    const blocks = [...(checkpoint.output ?? "").matchAll(/<work-check>([\s\S]*?)<\/work-check>/g)];
    if (blocks.length === 1 && blocks[0][1].length <= 48_000) {
      try { if (JSON.parse(blocks[0][1]).status === "ask-user") return checkpoint; } catch { /* Not an accepted structured question. */ }
    }
  }
  const evaluation = task.evaluations?.at(-1);
  if (evaluation?.nextAction === "ask-user" && evaluation.goalRevision === task.goal.revision
    && evaluation.round === (task.roundNumber ?? 1) && evaluation.cycle === (task.autonomyCycle ?? 1)) {
    // Combined verdicts have no unit ID. Retry the latest question's owner,
    // not the whole team; retain independent peers and revalidate dependents.
    const seen = new Set<string>();
    for (const result of [...(task.evaluations ?? [])].reverse()) {
      if (result.goalRevision !== task.goal.revision || result.round !== evaluation.round || result.cycle !== evaluation.cycle
        || !result.reviewUnitId || seen.has(result.reviewUnitId)) continue;
      seen.add(result.reviewUnitId);
      if (result.nextAction !== "ask-user") continue;
      const reviewer = task.workUnits.find(u => u.id === result.reviewUnitId && u.state === "completed" && u.role === "reviewer");
      if (reviewer) return reviewer;
    }
  }
}

export function interruptedFollowupPatch(task: TaskRecord, input: FollowupInput): Partial<TaskRecord> | undefined {
  const validated = validateFollowup(input, task);
  if (validated.kind !== "continue" || validated.scopeChange || validated.implementation) return;
  const unit = interruptedFollowupUnit(task);
  if (!unit) return;
  return {
    ...resumePatch({ ...task, resumeFromUnitId: unit.id }),
    // Keep the original round instruction; answers are additive and auditable.
    // They never revise acceptance criteria, permission settings or budgets.
    resumeInstructions: [...(task.resumeInstructions ?? []), { round: task.roundNumber ?? 1, unitId: unit.id,
      at: new Date().toISOString(), instruction: validated.instruction }],
    assignments: validated.assignments, pauseAfterPlan: validated.pauseAfterPlan, pendingFollowup: undefined
  };
}

export function captureRound(task: TaskRecord, report = task.report): TaskRound {
  return {
    workClosure: currentWorkClosure(task) ? structuredClone(task.workClosure) : undefined,
    workPreset: task.workPreset ? structuredClone(task.workPreset) : undefined,
    goal: task.goal ? structuredClone(task.goal) : undefined,
    number: task.roundNumber ?? 1, kind: task.roundKind ?? "initial", instruction: task.instruction ?? task.prompt,
    state: task.state, workUnits: structuredClone(task.workUnits), report: report ? structuredClone(report) : undefined,
    finishedAt: new Date().toISOString()
  };
}

export function nextRoundPatch(task: TaskRecord, input: FollowupInput): Partial<TaskRecord> {
  if (isActiveTaskState(task.state)) throw new Error("一時停止してから追加指示を適用してください。");
  const validated = validateFollowup(input, task);
  const history = task.history ?? [];
  if (!history.some((round) => round.number === (task.roundNumber ?? 1))) throw new Error("前回の作業履歴を保存してから続行してください。");
  return {
    // Upgrade only at a new round boundary; saved/in-flight graphs stay intact.
    workflowMode: "primary", execution: task.execution ?? structuredClone(defaultExecution),
    resumeFromUnitId: undefined, lastResumedAt: undefined, workClosure: undefined, executionBlocker: undefined,
    ...(["continue", "report"].includes(validated.kind) && task.report?.documents ? {
      report: { ...task.report, state: "draft" as const, error: undefined, documents: Object.fromEntries(Object.entries(task.report.documents).map(([id, document]) => [id, { ...document, state: "draft" as const, error: undefined }])) }
    } : {}),
    autonomyCycle: 1, autonomyState: undefined,
    roundNumber: (task.roundNumber ?? 1) + 1, roundKind: validated.kind, instruction: validated.instruction,
    assignments: validated.assignments, pauseAfterPlan: validated.pauseAfterPlan, planApproved: false,
    awaitingReason: undefined, pendingFollowup: undefined, legacySingleAgent: false,
    workUnits: autonomous({ ...task, roundKind: validated.kind }) ? orderAutonomousUnits(createFollowupWorkflow(validated, task)) : createFollowupWorkflow(validated, task), state: "queued", output: "", error: undefined
  };
}

export function needsPlanApproval(task: TaskRecord): boolean {
  if (task.workflowMode === "primary" && task.workUnits.some(u => u.planPhase)) {
    return Boolean(task.pauseAfterPlan && !task.planApproved && task.executionPlans?.some(p => p.round === (task.roundNumber ?? 1) && p.goalRevision === task.goal?.revision)
      && task.workUnits.some(u => u.state === "pending"));
  }
  return Boolean(task.pauseAfterPlan && !task.planApproved
    && task.workUnits.some((unit) => unit.role === "planner" && !unit.ideaPhase && unit.state === "completed")
    && task.workUnits.some((unit) => unit.role !== "planner" && unit.state === "pending"));
}
