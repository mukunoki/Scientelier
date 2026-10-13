import type { AgentId, AgentRun, ExecutionPolicy, TaskRecord, WorkUnit } from "./types";
import { effectiveReviewMode } from "./review-timing";
import { taskCodexPermissions } from "./codex-permissions";

export const defaultExecution: ExecutionPolicy = { reuseContext: true, decompose: true, maxSubtasks: 4, maxParallel: 2 };
// Old saved tasks keep their explicit/implicit pair policy. New installations
// and dispatch defaults use parallel independent reviews plus one consolidator.
export const defaultNewExecution: ExecutionPolicy = { ...defaultExecution, reviewMode: "parallel" };
export function validateExecution(value: unknown): ExecutionPolicy {
  const v = value as ExecutionPolicy;
  if (!v || typeof v.reuseContext !== "boolean" || typeof v.decompose !== "boolean"
    || !Number.isInteger(v.maxSubtasks) || v.maxSubtasks < 1 || v.maxSubtasks > 8
    || !Number.isInteger(v.maxParallel) || v.maxParallel < 1 || v.maxParallel > 8
    || (v.scheduling !== undefined && !["balanced", "throughput"].includes(v.scheduling))
    || (v.reviewMode !== undefined && !["pair", "cross-service", "parallel"].includes(v.reviewMode))
    || (v.contextTokens !== undefined && (!Number.isInteger(v.contextTokens) || v.contextTokens < 4000 || v.contextTokens > 200000))
    || (v.tokenBudget !== undefined && (!Number.isInteger(v.tokenBudget) || v.tokenBudget < 1000 || v.tokenBudget > 10000000))) throw new Error("戦略設定が不正です。分担1〜8、並列1〜8、文脈目安は空欄または4,000〜200,000、予算は空欄または1,000〜10,000,000で指定してください。");
  return { reuseContext: v.reuseContext, decompose: v.decompose, maxSubtasks: v.maxSubtasks, maxParallel: v.maxParallel, contextTokens: v.contextTokens, tokenBudget: v.tokenBudget,
    ...(v.scheduling ? { scheduling: v.scheduling } : {}), ...(v.reviewMode ? { reviewMode: v.reviewMode } : {}) };
}
export function estimatedWork(unit: WorkUnit): number {
  return unit.planPhase ? 1500 : unit.subtask?.estimatedTokens ?? unit.plannedTokens ?? (unit.role === "worker" ? 8000 : unit.role === "reviewer" ? 5000 : 3000);
}
export function tokenEstimate(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 3); }
export function runTokens(run: AgentRun): number {
  if (run.usage?.source === "reported" && run.usage.inputTokens !== undefined && run.usage.outputTokens !== undefined) return run.usage.inputTokens + run.usage.outputTokens;
  return run.estimatedTokens ?? (run.role === "worker" ? 8000 : run.role === "reviewer" ? 5000 : 3000);
}
export function budgetStatus(task: TaskRecord) {
  const runs = task.runs.filter(r => !r.goalPreparation);
  const used = runs.reduce((total, r) => total + runTokens(r), 0);
  // Reserve unfinished build/review; a finished review is never counted twice.
  let reserve = task.workUnits.filter(u => ["reporter", "reviewer"].includes(u.role) && u.state === "pending").reduce((n, u) => n + estimatedWork(u), 0);
  const reviewMode = effectiveReviewMode(task);
  if (reviewMode !== "pair" && !task.workUnits.some(u => u.crossReview) && task.workUnits.some(u => u.role === "reviewer" && u.state === "pending")) {
    // Providers are frozen only when artifacts are ready. Reserve conservatively
    // by allowed CLI count until actual provider grouping is available.
    const placeholder = task.workUnits.filter(u => u.role === "reviewer" && u.state === "pending").reduce((n, u) => n + estimatedWork(u), 0);
    const seats = Math.max(2, task.allowedAgentIds.length);
    reserve += Math.max(0, (reviewMode === "parallel" ? seats + 1 : seats * 2) * 5000 - placeholder);
  }
  return { used, reserve, limit: task.execution?.tokenBudget, estimated: runs.some(r => r.usage?.source !== "reported" || r.usage.inputTokens === undefined || r.usage.outputTokens === undefined) || !runs.length };
}
export function continuation(task: TaskRecord, unit: WorkUnit, agent: AgentId, model?: string): { run?: AgentRun; reason: string } {
  if (!(unit.primary || unit.primaryStep) || unit.mode !== "write") return { reason: "独立した新規会話（調査・計画・レビュー・ビルド）" };
  if (!task.execution?.reuseContext) return { reason: "会話の引継ぎは無効" };
  if (agent === "claude") return { reason: "Claudeは工程ごとのMCP接続を新規会話で確立。成果物・要約から引き継ぎ" };
  if (!["codex", "claude"].includes(agent)) return { reason: "このCLIの会話引継ぎは未対応。成果物から再開" };
  const prior = [...task.runs].reverse().find(r => r.primary && !r.goalPreparation);
  const priorUnit = prior && [...task.workUnits, ...(task.autonomyHistory ?? []).flatMap(h=>h.workUnits), ...(task.history ?? []).flatMap(h=>h.workUnits)].find(u=>u.id === prior.workUnitId);
  if (unit.researchStage && priorUnit?.researchStage !== unit.researchStage && !task.workPreset?.manifest.integratedWorkflow) return { reason: "研究モードの工程切替。別モードの制約を持ち越さず、成果物・要約で引き継ぎ" };
  if (!prior || prior.state !== "completed" || !prior.sessionId || prior.agentId !== agent || prior.model !== model || prior.goalRevision !== task.goal?.revision) return { reason: "互換性のある完了済み主担当の会話なし。成果物から開始" };
  if (agent === "codex" && (prior.codexPermissions ?? "sandbox") !== taskCodexPermissions(task)) return { reason: "Codexの権限設定が変わったため、新規会話で成果物から再開" };
  if (task.execution.contextTokens !== undefined && (prior.contextEstimate ?? 0) >= task.execution.contextTokens) return { reason: "文脈の推定量が目安に到達。成果物と引継ぎで新規会話へ切替" };
  return { run: prior, reason: "保存済み主担当の会話を分岐して継続（元端末を保護）" };
}
export function executionGuidance(task: TaskRecord, unit: WorkUnit): string {
  if (!task.execution) return "";
  const b = budgetStatus(task);
  const changed = task.executionAppliedAt ? `User execution settings were updated at ${task.executionAppliedAt}: maximum concurrent work ${task.execution.maxParallel}, new plan package limit ${task.execution.maxSubtasks}, delegation ${task.execution.decompose ? "enabled" : "disabled"}. These settings govern new launches/plans, not already completed evidence. Preserve the existing dependency graph and completed work. Only the lead may propose changes to remaining work when concretely useful; do not repeat work or relax scope/independence to fill slots.\n` : "";
  const scheduling = task.execution.scheduling === "throughput" ? "Efficiency-first scheduling: minimize elapsed time, not the number of agents. Identify genuinely independent investigations/verifications and their dependencies; explain the useful distinct output of each specialist in the plan. Prefer simultaneous work across different available providers; multiple sessions of the same provider are allowed. Use fewer or zero specialists when coordination, repeated context, shared-file contention or dependencies erase the benefit. Do not invent work to fill slots. Read-only packages use rolling dependency-driven admission. Primary-work milestones start when their prerequisites are complete, draining readers first and running exclusively; primary remains the single writer. Plan the critical path and useful output, not synchronized waves. The harness chooses actual available providers, respecting live subscription limits." : "Balance context reuse, provider load and quota; delegate only independently useful work.";
  const reviews = effectiveReviewMode(task) === "parallel" ? "\nApplication-owned final review: distinct available services independently review in parallel within the concurrency cap; then ONE fresh read-only reviewer consolidates ALL findings and checks evidence. Minority defects/uncertainty remain binding. Reserve time for independent batches plus consolidation; do not duplicate these final review jobs in the work plan. Planned early peer suggestions improve substantive work but do not replace this final review." : "";
  return `# Execution scheduling\n${changed}${scheduling}${reviews}\n\n# Quality and speed, with subscription continuity\nKeep the capable primary owner responsible across phases. Use other available services for useful implementation, optimization, independent alternatives and early scrutiny as well as final review. Total token minimization is NOT an objective and token estimates do NOT gate launches, plans or improvements. A saved token target is telemetry only. Actual rate-limit windows, permitted services, isolation, permissions and independent review still govern launch. Useful duplicate reasoning/implementations are allowed; repetitive unchanged compliance checks are not progress.\nTask-wide cumulative tokens: ${b.used} (may include estimates). Finishing estimate: ${b.reserve}. Current step estimate: ${estimatedWork(unit)}. Context handoff target: ${task.execution.contextTokens ?? "unspecified (do not switch conversations based on context quantity; other isolation and compatibility rules still apply)"}. Prioritize substantive progress and direct evidence; never silently weaken the goal. Never spawn CLI agents yourself; the harness owns delegation. A duration or token estimate is not permission to force-kill work.`;
}
