import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TaskRecord, WorkUnit } from "./types";
import { ideaGuidance } from "./work-modes";
import { executionTime } from "./execution-time";
import { executionFailureFromCheck, type ExecutionFailure } from "./execution-blocker";
import { taskOnlyInvestigation } from "./work-concurrency";
import { readSubstantiveReport, type SubstantiveReport } from "./substantive-report";
import { readWorkCheckEnvelope, validateContentWorkCheck, type ContentDecision } from "./work-check-format";

// Sum active execution, excluding goal preparation, earlier rounds and paused time.
export function elapsedWorkMinutes(task: TaskRecord, now = Date.now()): number {
  return executionTime(task,now).elapsedMs / 60000;
}
export function timeGuidance(task: TaskRecord, now = Date.now()): string {
  const target = task.autonomy?.targetMinutes;
  const elapsed = elapsedWorkMinutes(task, now);
  const balance = target ? ` Remaining approximate time: ${Math.max(0, target - elapsed).toFixed(1)} minutes.${elapsed >= target ? " Target reached/exceeded: finish required work and report a revised estimate; do not start optional expansion." : ""} Time-adaptive review is authorized: before final reviewers start, the harness compares remaining time with estimated review cost and may reduce all-service cross-review to two, or one, independent review. Plan a focused final check, not duplicate review packages. The harness records the decision and omitted seats; agents do not skip assigned reviews themselves. Already-started reviews are not cancelled. This changes review count only, never evidence, criterion coverage, bibliography double-check requirements, or handling of defects. Reduced review has less assurance and must not be described as full cross-review.` : "";
  return `# Work duration guidance\n${target ? `User's approximate target for this entire round (not per agent): ${target} minutes.` : "No user duration target is set. The planner should give a realistic estimate, not invent a user deadline."} Active work so far: ${elapsed.toFixed(1)} minutes.${balance} Parallel run intervals are counted once, not added per agent; paused time and goal preparation are excluded. This is a SOFT TARGET, never a timeout or permission to omit required work. Exceed it when needed for correctness; explain the reason and revised estimate. Reserve time for the final report and independent review, and run BOTH even after the target has elapsed. Do not skip review, request a stop, or mark work ready solely because of elapsed time. Prefer the smallest complete result near the target and defer optional improvements. Never weaken the approved goal. Include elapsed work, remaining work and an updated estimate in the handoff. Management information belongs in the handoff, not the PDF.
Planning and orchestration: use this target to choose team size, bounded assignments and milestone granularity, not merely to mention a duration. Allocate a small share to planning/coordination, most effort to substantive work, and explicit time for integration, TeX/PDF verification and mandatory independent reviews. Estimate the dependency critical path, including CLI startup, context transfer and integration overhead; parallel agent-minutes are not elapsed minutes. Use independent packages and available services when they shorten that path or improve required verification; prefer a single focused owner when coordination costs more. Respect the configured concurrency, subscription headroom, allowed services, file ownership and review independence. Put per-package estimatedMinutes and time allocations in the existing plan fields/instructions; never invent a new result schema.
At each coordination event or milestone, compare actual progress and remaining estimates with the target. Prioritize required work on the critical path; reuse validated artifacts and scripts, avoid repeated surveys, and decline optional new packages that would delay completion. Refine eligible unstarted assignments within your authority; do not cancel active agents or remove saved requirements. Recommend broader replanning to the primary owner at its normal boundary if necessary. If the required scope cannot fit, explain the shortfall and realistic completion estimate, continue permitted mandatory work, and request approval only for an actual scope/authority change. Never silently reduce accuracy, experimental coverage or review requirements to fit the time.
Bounded repair: do not keep repeating the same self-check when missing work belongs to report/review or cannot be resolved within current authority. Return precise needs-work evidence and remaining owners; use report-ready only for genuinely report-only work. With autonomous iteration enabled, the harness reserves the last worker retry slot for an honest partial report and independent inspection; after one repair it may close sooner when the duration target is insufficient. This ends execution with unmet/unverified conditions, NOT successful goal acceptance. Required experiments/verification not performed must remain disclosed as missing. Explicit scope/permission decisions and actual connection/execution failures are not waived.`;
}
export function roleGuidance(unit: WorkUnit): string {
  if (taskOnlyInvestigation(unit)) return "You are an input-only reasoning specialist. Use ONLY the supplied neutral assignment text and captured instructions/skills. No workspace/artifact/log reads, source downloads, shell commands, code execution, files, jobs or additional agents; harness instruction/skill/result transport is the sole exception. The primary owner may be editing files concurrently, so never inspect them or infer their current state. Give useful alternative mechanisms, bottlenecks, counterexamples and bounded validation suggestions, not invented experimental evidence or final acceptance. If the input is insufficient, explicitly state the missing assumption and return a bounded conditional analysis without fetching mutable inputs.";
  if (unit.ideaPhase) return ideaGuidance;
  if (unit.subtask?.kind === "isolated-work") return `You implement ONE isolated package in the harness-created Git worktree. Write only these owned files: ${JSON.stringify(unit.subtask.ownedFiles)}. Preserve HEAD; do not commit, reset, merge, edit another worktree or start agents. Verify the package and leave changes plus evidence in the owned files. The harness checks file ownership and base hashes before shared integration. Return concrete evidence and remaining work, not a whole-goal work-check. Do not write the shared report. A worktree is collision isolation, not an OS security sandbox.`;
  if (unit.primaryStep) return `You are the primary owner executing ONE bounded implementation/experiment/writing milestone in the saved plan. Perform the specified substantive work within the approved scope, verify its acceptance checks, and hand off changed artifacts, exact evidence paths and unresolved issues. The scheduler grants exclusive workspace access for this step; ${unit.subtask?.allowTaskOnlyPeers ? "input-only reasoning peers may be active, but cannot inspect your files. Do not perform resource-sensitive measurements/benchmarks/jobs in this non-exclusive-machine step; those require a separate exclusive milestone. " : ""}do not start background jobs that outlive the step or spawn other agents. Do not redo independent investigations or complete the entire goal here. Report any unmet milestone honestly. Final integration/self-check, report build and independent review are separate mandatory stages. Do not submit execution-plan, work-plan or a whole-goal work-check in this milestone.`;
  if (unit.subtask) return "You are a read-only specialist. Perform ONLY the specified independent investigation/verification. Return concrete findings, sources, acceptance-check results and limitations. Do not change files, author the report, submit jobs, send external messages (only the scoped harness consultation tools listed in this run's instructions are allowed), launch CLI/subagents or execute commands with side effects. If the task requires writes, report that limitation to the primary owner instead. Completion of this subtask is not acceptance of the full goal.";
  if (unit.checkpointFor) return "You are the original planning role checking progress, not doing the worker's research. Compare actual artifacts with the plan and approved constraints. Spend a small fraction of the work estimate on this check. Hand substantive missing work back to the worker; never transfer it to the reporter.";
  if (unit.primary) return `${roleGuidance({ ...unit, primary: false })}\nPlan briefly, execute and check progress in this SAME session. Do not finish after planning. Spend most effort on actual artifacts, not coordination. Check the approved constraints at each milestone. The report builder is not a substitute for missing substantive work. Before final handoff, finish feasible missing work yourself; genuine user decisions require ask-user. Return exactly one <work-check>JSON</work-check> block: {"status":"ready"|"needs-work"|"ask-user","summary":"...","remainingWork":"...","estimatedRemainingMinutes":number,"evidence":["existing workspace/report file path"]}. This is a self-check, NOT independent acceptance: a separate final reviewer verifies the goal. ready requires substantive TeX and evidence, not just a plan or a completion claim.`;
  switch (unit.role) {
    case "planner": return "Plan only: briefly inspect enough context to make a feasible plan. Do not perform the literature survey, implement, collect a full bibliography, or write the report yourself. Allocate the approximate total time by stage, normally reserving the majority for the worker and a small share for planning/checkpoints. Define concrete worker deliverables, verification and short milestones; estimate what can fit, preserve required scope and list deferrable optional work. If approved constraints forbid the requested work, raise the contradiction; never reinterpret them silently. Put the plan in your handoff, not a Markdown file.";
    case "worker": return "You own the substantive research/analysis/implementation, source verification, plots, and subject-content TeX draft. Actually create and verify artifacts within the approved scope; do not merely return a plan or assign this work to the reporter. Work in coherent milestones and report progress/remaining estimates in the terminal. A runnable prototype or one plausible idea is not automatically a sufficiently refined result: assess goal-relevant weaknesses and promising alternatives, then implement/analyze/evaluate useful improvements with evidence. Use planned peer suggestions before finalizing content, not just as prose for the report. Do not invent optimization or experiments beyond the approved goal. Keep TeX as a concise working draft; leave repeated final layout polishing to the reporter and reuse unchanged verified mechanical checks. The reporter owns TeX build/layout fixes, not the missing research. If constraints block work, say explicitly that no work was performed and request clarification; do not claim completion of the objective.";
    case "reporter": return "You own TeX compilation, citation/layout corrections and PDF verification using the worker's existing substantive artifacts. Do not replace an absent worker by doing the whole investigation or implementation. Missing subject content, evidence or conflicting constraints must be returned as unmet work for the planner/user, not filled with invented research. Fix build errors autonomously; elapsed time is advisory, not a termination condition.";
    default: return "Review actual evidence independently. Keep the review focused on required criteria and concrete defects; time guidance never justifies passing unverified results.";
  }
}
export function progressCheckpoint(worker: WorkUnit): WorkUnit {
  return { id: randomUUID(), role: "planner", mode: "read", title: "進捗確認・残作業の再計画", checkpointFor: worker.id, workAttempt: worker.workAttempt ?? 1,
    state: "pending", dependsOn: [worker.id], attemptedAgentIds: [], instructions:
      'Inspect the actual worker deliverables and its handoff before the reporter starts. Verify scope/constraints, subject-content readiness, evidence and progress against the plan and soft time target. Return exactly one <work-check>JSON</work-check> block in the final handoff: {"status":"ready"|"needs-work"|"ask-user","summary":"...","remainingWork":"...","estimatedRemainingMinutes":number,"evidence":["existing workspace/report file path"]}. ready requires substantive usable artifacts (including report source), not merely a plan, a completion marker or a statement of intent. Use needs-work for missing work the worker can perform within existing authority. Use ask-user for conflicting constraints, missing authority or user decisions. Do not execute research or edit artifacts in this check. Give a concrete revised work estimate even if the target has been exceeded. End with the normal workflow completion marker.' };
}
export interface WorkCheck {
  status: "ready" | "report-ready" | "needs-work" | "ask-user" | "environment-blocked";
  summary: string; remainingWork: string; estimatedRemainingMinutes: number; evidence: string[];
  workReport?: SubstantiveReport; blocker?: ExecutionFailure; contentDecision?: ContentDecision;
  userDecision?: { reason: string; question: string; options: string[] };
}
export class WorkCheckError extends Error {}
export async function parseWorkCheck(output: string, task: TaskRecord, verifyRemote?: (path: string) => Promise<void>): Promise<WorkCheck> {
  try {
    return await readWorkCheck(output, task, verifyRemote);
  } catch (error) {
    throw new WorkCheckError(`進捗確認の提出を受理できません：${error instanceof Error ? error.message : String(error)}\n証拠欄 evidence は既存ファイルのパスだけを1項目に1つ記載してください。説明文・複数パス・URLを混ぜず、説明は summary / remainingWork に残してください。実ファイルを確認して再提出してください。実質的な不足は needs-work と具体的な残作業を返し、未検証の成果を ready にしないでください。`);
  }
}
async function readWorkCheck(output: string, task: TaskRecord, verifyRemote?: (path: string) => Promise<void>): Promise<WorkCheck> {
  const blocks = [...output.matchAll(/<work-check>([\s\S]*?)<\/work-check>/g)];
  if (blocks.length !== 1) throw new Error("進捗確認は48,000文字以下のwork-checkブロックを1つだけ提出してください。");
  const v = readWorkCheckEnvelope(blocks[0][1]);
  if (!v || !["ready", "report-ready", "needs-work", "ask-user", "environment-blocked"].includes(v.status) || typeof v.summary !== "string" || !v.summary.trim() || typeof v.remainingWork !== "string" || !Number.isFinite(v.estimatedRemainingMinutes) || v.estimatedRemainingMinutes < 0 || !Array.isArray(v.evidence) || v.evidence.length > 40 || v.evidence.some((p: unknown) => typeof p !== "string" || !p)) throw new Error("プランナーの進捗確認が不正です。");
  const blocker = executionFailureFromCheck(v);
  if (v.status === "environment-blocked" && !blocker) throw new Error("実行環境の停止には短い原因・復旧方法をblockerに記載してください。");
  if (blocker) v.status = "environment-blocked";
  const contentDecision=validateContentWorkCheck(v);
  if (v.status === "report-ready" && (!v.remainingWork.trim() || !task.report?.texPath || !v.evidence.some((p: string) => resolve(task.cwd, p) === resolve(task.report!.texPath!)))) throw new Error("レポーターへの引継ぎには具体的な残作業とレポートTeXの根拠が必要です。");
  if (v.status === "needs-work" && !v.remainingWork.trim()) throw new Error("ワーカーへの残作業指示がありません。");
  // Optional for legacy submissions. A malformed display aid must not create
  // another submission-repair loop; fall back to the original remainingWork.
  const decision = v.userDecision;
  const userDecision = v.status === "ask-user" && decision
    && [decision.reason, decision.question].every(s => typeof s === "string" && s.trim() && s.length <= 800)
    && Array.isArray(decision.options) && decision.options.length <= 3
    && decision.options.every((s: unknown) => typeof s === "string" && s.trim() && s.length <= 800)
    ? { reason: decision.reason.trim(), question: decision.question.trim(), options: decision.options.map((s: string) => s.trim()) } : undefined;
  if (v.status === "ready" || v.status === "report-ready") {
    if (!v.evidence.length) throw new Error("ワーカーの成果物が確認されていません。");
    const roots = verifyRemote ? [] : await Promise.all([task.cwd, ...(task.report?.texPath ? [dirname(task.report.texPath)] : [])].map(p => realpath(p)));
    for (const p of v.evidence) {
      if (verifyRemote) { await verifyRemote(p); continue; }
      const path = await realpath(resolve(task.cwd, p));
      if (!roots.some(root => { const r = relative(root, path); return r !== ".." && !r.startsWith("../") && !isAbsolute(r); }) || !(await stat(path)).isFile()) throw new Error("根拠は作業フォルダ内の既存ファイルにしてください。");
    }
  }
  const workReport = readSubstantiveReport(v.workReport);
  return { status: v.status, summary: v.summary, remainingWork: v.remainingWork, estimatedRemainingMinutes: v.estimatedRemainingMinutes, evidence: v.evidence, ...(contentDecision ? {contentDecision} : {}), ...(workReport ? {workReport} : {}), ...(blocker ? {blocker} : {}), ...(userDecision ? { userDecision } : {}) };
}

// Submission repair is separate from substantive work cycles. Preserve the
// rejected output and role boundary; normal routing still checks usage limits.
export function workCheckRetry(unit: WorkUnit, error: unknown): Partial<WorkUnit> | undefined {
  if (!(error instanceof WorkCheckError) || (unit.workCheckRetries ?? 0) >= 2) return undefined;
  return { state: "pending", completedAt: undefined, assignedAgentId: undefined,
    attemptedAgentIds: unit.attemptedAgentIds.filter(id => id !== unit.assignedAgentId),
    workCheckRetries: (unit.workCheckRetries ?? 0) + 1, workCheckFeedback: error.message, error: undefined };
}

export function insertCheckpoint(units: WorkUnit[], worker: WorkUnit): WorkUnit[] {
  if (units.some(u => u.checkpointFor === worker.id)) return units;
  const checkpoint = progressCheckpoint(worker);
  const result = units.map(u => u.id === worker.id ? u : { ...u, dependsOn: u.dependsOn.map(id => id === worker.id ? checkpoint.id : id) });
  result.splice(result.findIndex(u => u.id === worker.id) + 1, 0, checkpoint);
  return result;
}

export function returnWork(units: WorkUnit[], checkpoint: WorkUnit, check: WorkCheck): WorkUnit[] {
  if (check.status !== "needs-work") throw new Error("実作業が未完了の場合だけワーカーへ差し戻せます。");
  const worker = checkpoint.primary ? checkpoint : units.find(u => u.id === checkpoint.checkpointFor)!;
  const retry: WorkUnit = { ...worker, id: randomUUID(), title: `残作業の実行 (${(worker.workAttempt ?? 1) + 1})`, state: "pending", workAttempt: (worker.workAttempt ?? 1) + 1,
    instructions: `${worker.instructions}\nPlanner progress check: ${check.summary}\nRequired remaining work: ${check.remainingWork}\nUpdated remaining estimate: ${check.estimatedRemainingMinutes} minutes (advisory).`,
    dependsOn: [checkpoint.id], checkpointHandled: undefined, workCheckRetries: undefined, workCheckFeedback: undefined, attemptedAgentIds: [], assignedAgentId: undefined, output: undefined, error: undefined, startedAt: undefined, completedAt: undefined };
  const result = units.map(u => u.id === checkpoint.id ? { ...u, checkpointHandled: true } : { ...u, dependsOn: u.dependsOn.map(id => id === checkpoint.id ? retry.id : id) });
  result.splice(result.findIndex(u => u.id === checkpoint.id) + 1, 0, retry);
  return result;
}

export function transferReportWork(task: TaskRecord, checkpoint: WorkUnit, check: WorkCheck): WorkUnit[] {
  if (check.status !== "report-ready" || checkpoint.planPhase) throw new Error("計画や実作業の未完了をレポート完了扱いにはできません。");
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const dependency of task.workUnits.find(u => u.id === id)?.dependsOn ?? []) ancestors(dependency, seen);
    return seen;
  };
  const reporter = task.workUnits.find(u => u.role === "reporter" && u.state === "pending" && ancestors(u.id).has(checkpoint.id));
  if (!reporter) throw new Error("引継ぎ先の未完了レポーターがありません。工程を確認してください。");
  return task.workUnits.map(u => u.id === checkpoint.id ? {...u,checkpointHandled:true} : u.id === reporter.id
    ? {...u,instructions:`${u.instructions}\n# Report-only handoff\n${check.summary}\nRequired finishing work: ${check.remainingWork}\nThis transfers only report finishing. Verify the actual sources; missing substantive work is a blocker, never fabricate it.`} : u);
}
