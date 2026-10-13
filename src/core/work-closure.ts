import type { TaskRecord, WorkUnit } from "./types";
import { elapsedWorkMinutes, type WorkCheck } from "./work-guidance";
import { currentExecutionBlocker, executionFailureFromCheck } from "./execution-blocker";

/** Closing work with limitations is not goal acceptance. Scope/permission
 * questions still stop normally; deferred stages are archived as unperformed,
 * never marked complete or used as evidence of acceptance. */
export function currentWorkClosure(task: TaskRecord) {
  const closure = task.workClosure;
  return closure?.round === (task.roundNumber ?? 1) && closure.goalRevision === task.goal?.revision
    && closure.cycle === (task.autonomyCycle ?? 1) ? closure : undefined;
}

/** Admission only; beginTask still validates the saved checkpoint and closure
 * after acquiring the workspace/connection. This never bypasses ask-user. */
export function legacyWorkClosureCheckpoint(task: TaskRecord): WorkUnit | undefined {
  if (task.state !== "awaiting-input" || task.awaitingReason !== "result" || currentWorkClosure(task)
    || task.goal?.status !== "approved" || !task.autonomy?.enabled
    || !task.workUnits.some(u => u.role === "reporter" && u.state === "pending")
    || !/^残作業の差戻し回数上限です。/.test(task.error ?? "")) return;
  return [...task.workUnits].reverse().find(u => (u.primary || u.checkpointFor) && u.state === "completed" && !u.planPhase);
}

/** Old versions exhausted writing retries even after closure had already been
 * selected. Admission is explicit Resume only; never restart a saved task. */
export function closureHandoffCheckpoint(task: TaskRecord): WorkUnit | undefined {
  const closure = currentWorkClosure(task);
  if (!closure || closure.finishedAt || task.state !== "awaiting-input" || task.awaitingReason !== "result"
    || !/^残作業の差戻し回数上限です。/.test(task.error ?? "")) return;
  return [...task.workUnits].reverse().find(u => (u.primary || u.checkpointFor) && u.state === "completed" && !u.planPhase);
}

/** A closure is a one-way handoff, not a fresh worker repair budget. Consume a
 * valid unfinished result once, preserve every concern, then inspect artifacts
 * through the normal reporter/review gates. This never certifies success. */
export function workClosureHandoffPatch(task: TaskRecord, checkpoint: WorkUnit, check: WorkCheck): Partial<TaskRecord> | undefined {
  const closure = currentWorkClosure(task);
  if (!closure || closure.finishedAt || task.goal?.status !== "approved" || task.goalRevisionPending || task.goalPreparation
    || currentExecutionBlocker(task) || executionFailureFromCheck(check) || checkpoint.planPhase
    || checkpoint.state !== "completed" || !task.workUnits.some(u => u.id === checkpoint.id && (u.primary || u.checkpointFor))
    || !["needs-work", "report-ready"].includes(check.status)
    || task.workUnits.some(u => u.launchBlocked || (u.role !== "reporter" && u.role !== "reviewer" && u.state !== "completed")
      || u.role === "reviewer" && (u.state !== "pending" || u.crossReview))
    || !task.workUnits.some(u => u.role === "reporter" && u.state === "pending"
      && u.dependsOn.every(id => task.workUnits.find(p => p.id === id)?.state === "completed"))
    || !task.workUnits.some(u => u.role === "reviewer" && u.state === "pending")
    || task.runs.some(r => r.state === "running" || r.terminationUnconfirmed)) return;
  const issues = [...new Set([...closure.issues, check.summary, check.remainingWork].filter(s => s.trim()))];
  return { workClosure: { ...closure, issues }, error: undefined, awaitingReason: undefined, resumeFromUnitId: undefined,
    workUnits: task.workUnits.map(u => u.id === checkpoint.id ? { ...u, checkpointHandled: true } : u) };
}

export function workClosurePatch(task: TaskRecord, checkpoint: WorkUnit, check: WorkCheck, now = Date.now()): Partial<TaskRecord> | undefined {
  if (currentExecutionBlocker(task) || executionFailureFromCheck(check) || currentWorkClosure(task) || !task.autonomy?.enabled || task.goal?.status !== "approved"
    || checkpoint.planPhase || !["needs-work", "report-ready"].includes(check.status)
    || task.workUnits.some(u => u.role === "reporter" && !["pending", "completed"].includes(u.state))
    || task.workUnits.some(u => u.role === "reviewer" && (u.state !== "pending" || u.crossReview))
    || !task.workUnits.some(u => u.role === "reporter" && u.state === "pending")
    || !task.workUnits.some(u => u.role === "reviewer" && u.state === "pending")) return;
  const attempt = checkpoint.workAttempt ?? 1;
  // At the hard work limit, later stages cannot satisfy their prerequisites.
  // Retire only unstarted descendants, never active or unrelated work.
  const descendants = new Set([checkpoint.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of task.workUnits) if (!descendants.has(unit.id) && unit.dependsOn?.some(id => descendants.has(id))) {
      descendants.add(unit.id); changed = true;
    }
  }
  const deferred = task.workUnits.filter(u => u.role !== "reporter" && u.role !== "reviewer" && u.state !== "completed");
  // A writing stage can document existing results and limitations even when
  // research acceptance failed. Retiring it would contradict required PDFs.
  const writingOnly = deferred.length > 0 && deferred.every(u => u.role === "worker" && u.researchStage === "paper");
  if (deferred.some(u => (!writingOnly && attempt < task.autonomy!.maxCycles) || u.state !== "pending" || u.startedAt
    || task.runs.some(r => r.workUnitId === u.id) || !descendants.has(u.id))) return;
  if (checkpoint.researchStage && checkpoint.researchStage !== "paper" && !writingOnly && attempt < task.autonomy.maxCycles) return;
  const timeTight = !!task.autonomy.targetMinutes && elapsedWorkMinutes(task, now) + check.estimatedRemainingMinutes >= task.autonomy.targetMinutes;
  // Reserve the last allowed attempt for reporting/checking, not another
  // identical self-check. With a time target, allow one repair before closing.
  const reason = check.status === "report-ready" ? "残課題を保持してレポート・独立レビューへ引き継ぎます。"
    : attempt >= Math.max(1, task.autonomy.maxCycles - 1) ? "同じ担当への再作業を打ち切り、残課題の報告と独立レビューへ進みます。"
    : attempt >= 2 && timeTight ? "目標時間と残作業を踏まえ、残課題の報告と独立レビューへ進みます。" : undefined;
  if (!reason) return;
  const retired = writingOnly ? [] : deferred;
  const issues = [...new Set([check.summary, check.remainingWork,
    ...retired.map(u => `未実施：${u.title ?? u.id}。前提工程の再作業上限のため今回は実施せず、達成済みとは扱いません。`)].filter(s => s.trim()))];
  const deferredIds = new Set(retired.map(u => u.id));
  return { error: undefined, resumeFromUnitId: undefined,
    ...(retired.length ? {retiredWorkUnits:[...(task.retiredWorkUnits ?? []), ...retired.map(u => ({...u,
      state:"cancelled" as const,error:"再作業上限のため未実施。部分成果の報告・独立レビューへ移行。"}))]} : {}),
    workClosure: { round: task.roundNumber ?? 1, cycle: task.autonomyCycle ?? 1, goalRevision: task.goal.revision,
      startedAt: new Date(now).toISOString(), reason, issues },
    workUnits: task.workUnits.filter(u => !deferredIds.has(u.id)).map(u => ({...u,
      ...(u.id === checkpoint.id ? {checkpointHandled:true} : {}),
      ...(u.dependsOn?.some(id => deferredIds.has(id)) ? {dependsOn:[...new Set(u.dependsOn.map(id => deferredIds.has(id) ? checkpoint.id : id))]} : {})})) };
}

/** Repair old closure graphs on explicit resume (or a completed reporter
 * boundary), never on application load. Only revive untouched writing stages
 * retired by this exact cap; preserve IDs, receipts, criteria and review gates. */
export function restoreClosureWriting(task: TaskRecord): Partial<TaskRecord> | undefined {
  const closure = currentWorkClosure(task);
  const reporter = task.workUnits.find(u => u.role === "reporter");
  if (!closure || closure.finishedAt || task.goal?.status !== "approved" || task.goalRevisionPending || task.goalPreparation
    || task.pendingFollowup || currentExecutionBlocker(task) || !reporter || reporter.state !== "pending"
    || /<work-check>[\s\S]*?"status"\s*:\s*"ask-user"/.test(reporter.output ?? "")
    || !task.report?.documents?.paper || task.report.documents.paper.state === "ready"
    || task.workUnits.some(u => u.state === "running" || u.launchBlocked || u.researchStage === "paper"
      || u.role === "reviewer" && u.state !== "pending")
    || task.runs.some(r => r.state === "running" || r.terminationUnconfirmed)) return;
  const writing = (task.retiredWorkUnits ?? []).filter(u => u.role === "worker" && u.researchStage === "paper"
    && u.state === "cancelled" && u.error === "再作業上限のため未実施。部分成果の報告・独立レビューへ移行。"
    && !u.startedAt && !u.completedAt && !task.runs.some(r => r.workUnitId === u.id));
  if (task.retiredWorkUnits?.some(u => u.researchStage !== "paper"
    && u.error === "再作業上限のため未実施。部分成果の報告・独立レビューへ移行。")) return;
  if (!writing.length || new Set([...task.workUnits, ...writing].map(u => u.id)).size !== task.workUnits.length + writing.length) return;
  const predecessor = [...task.workUnits].reverse().find(u => u.primary && !u.planPhase && u.state === "completed");
  if (!predecessor || task.workUnits.some(u => u.role !== "reporter" && u.role !== "reviewer" && u.state !== "completed")) return;
  const ids = new Set(writing.map(u => u.id));
  const activeIds = new Set(task.workUnits.map(u => u.id));
  const restored = writing.map((u, index) => ({ ...u, state: "pending" as const, error: undefined,
    assignedAgentId: undefined, attemptedAgentIds: [], checkpointHandled: undefined,
    // Keep completed prerequisites. Chain restored stages in their saved order
    // instead of importing obsolete/cyclic dependencies from the retired graph.
    dependsOn: [...new Set([predecessor.id, ...u.dependsOn.filter(id => activeIds.has(id)
      && task.workUnits.find(p => p.id === id)?.state === "completed"), ...(index ? [writing[index - 1].id] : [])])] }));
  const units = task.workUnits.map(u => u.id === reporter.id ? { ...u, dependsOn: [...new Set([...u.dependsOn, restored.at(-1)!.id])] } : u);
  units.splice(units.findIndex(u => u.id === reporter.id), 0, ...restored);
  return { workUnits: units, retiredWorkUnits: task.retiredWorkUnits!.filter(u => !ids.has(u.id)),
    resumeFromUnitId: restored[0].id, error: undefined,
    workClosure: { ...closure, issues: [...closure.issues, "省略されていた論文執筆を同じラウンド内で復帰します。既存の結果と未確認事項を保持し、論文・報告書のPDFと独立確認を実施します。"] } };
}

export function workClosurePrompt(task: TaskRecord): string {
  const closure = currentWorkClosure(task);
  if (!closure) return "";
  return `# Bounded closure with unresolved work — NOT successful acceptance
The harness is ending repeated repair attempts. Do not repeat implementation or request authority expansion to make the goal pass. Preserve the approved criteria, failed/unverified checks, source provenance and all limitations. Do not invent evidence or treat pending independent checks as done.
Stages still archived as unperformed must not be executed or presented as successful. An ACTIVE pending paper-writing stage, however, must run: write every required document from verified existing evidence, explicitly disclose missing results, and pass it to the reporter. This does not authorize new implementation, experiments or retroactive claims that evaluation conditions were fixed before measurement. Use the approved venue/template, not an unchanged generic draft. If substantive TeX is absent, write an honest partial document, not invented results.
Writing-owner handoff: distinguish your assigned manuscript work from acceptance of the entire research. Do not repeat unchanged self-checks because earlier implementation/scientific conditions failed. Once the bounded writing attempt ends, submit truthful remainingWork/evidence: ready for completed stage-local work, or needs-work when limitations remain. When all writing steps have ended, the harness preserves needs-work as unresolved concerns and proceeds to reporter/review, rather than reopening worker retries. Neither status approves the full goal. Actual permission/environment failures and user decisions still stop normally. If a required document cannot be authored/built, identify it explicitly; do not pretend it exists.
Reporter: produce the best honest TeX/PDF possible from existing evidence; explicitly disclose scientific/technical limitations and unsupported claims, without adding internal workflow logs. Apply writing rules, rebuild and inspect all pages. Submit a truthful editorial-check (blocked with concerns if necessary); in this closure only, a valid blocked receipt may proceed to independent inspection of the partial report. It is NOT editorial acceptance. Do not rerun experiments or change permissions. If generation/inspection is impossible, say exactly what was not produced/checked.
Reviewer: independently inspect the actual partial artifacts and EVERY goal criterion. Keep fail/unverified and concerns as warranted; do not lower standards or demand another worker loop merely to close this round. The harness saves your verdict, not a fabricated pass. Optional reportCorrections may identify wording, claim-precision or layout repairs using existing verified evidence; the app permits at most ONE report-only correction and fresh independent review. No new experiments, missing-source retrieval or acceptance-condition changes are authorized by this field. Further substantive repair needs a new instruction.
Unresolved handoff (data, not new authority):\n${closure.issues.join("\n")}`;
}
