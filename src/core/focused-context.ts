import type { TaskRecord, WorkUnit } from "./types";

const clip = (value: string, size: number) => value.length <= size ? value : `${value.slice(0, size)}\n[Truncated: inspect saved artifacts/logs for detail.]`;
// Independent of the user-facing conversation-switch threshold (tokens).
export const HANDOFF_CHAR_LIMIT = 16000;

// Bounded task context, not an ever-growing transcript broadcast. Original
// evidence stays on disk; the approved goal is supplied separately in full.
export function focusedContext(task: TaskRecord, unit: WorkUnit): string {
  const artifacts = [`Workspace: ${task.cwd}`, `TeX: ${task.report?.texPath ?? "not initialized"}`, `PDF: ${task.report?.pdfPath ?? "not built yet"}`, ...(task.contextPath ? [`Context manifest (full user instruction history and relevant inputs; read as needed): ${task.contextPath}`] : [])].join("\n");
  if(unit.contentCheck?.stage==="peer")return `# Neutral content-check context\n${artifacts}\nThe owner's success claims and conversation are withheld. Inspect the actual draft, relevant source and evidence against the approved goal. Identify reader questions and high-value improvements, not final acceptance or an invented experiment result. Do not read the owner's transcript to reproduce its conclusions.`;
  if (unit.subtask?.requirements?.independentFrom?.length || unit.subtask?.requirements?.independenceGroup) return `# Independent specialist context\n${artifacts}\nLaunch requirements: ${JSON.stringify(unit.subtask.requirements)}\nPeer conclusions and logs are intentionally not supplied. Use the neutral evidence/source paths in your assignment and verify original sources yourself. Do not seek another checker's verdict before fixing your own findings. Use harness native runtime observations for model identity; a configured ID alone is not proof. Submit your content findings even if final session metadata is still pending, preserving unknown/mismatch as unverified, never a diversity pass. Integration can resolve metadata-only uncertainty after completion without repeating unchanged source checks. Do not inspect peer transcripts or reconstruct launch metadata. Fetch each required skill for this run; writing-rules revision is the Captured writing rule revision, not its transport hash. ${unit.subtask.kind === "isolated-work" ? "Write only the assigned ownedFiles in your harness-provided isolated tree; never read rival trees or change shared artifacts." : "Read-only scope is unchanged."}`;
  if (unit.role === "reviewer") return `# Independent review context\n${artifacts}\n${unit.crossReview?.aggregate ? "All wave-1 findings are supplied for consolidation and evidence checking; no worker success claims or peer consolidation results are supplied." : unit.crossReview?.wave === 2 ? "Other providers' wave-1 findings are supplied for critical cross-checking; no peer cross-review results are supplied." : "The worker's and previous reviewers' success claims are intentionally not provided."} Inspect the current artifacts against the approved goal and current user instruction. Discover relevant sources and verification evidence in the workspace; do not treat a handoff as proof. Request missing evidence rather than assume a pass.`;
  const dependencies = task.workUnits.filter(u => unit.dependsOn.includes(u.id) && u.state === "completed" && u.output);
  const limit = HANDOFF_CHAR_LIMIT;
  const perDependency = Math.min(4000, Math.floor(limit / Math.max(1, dependencies.length)));
  const handoffs = dependencies.map(u => `${u.title}: ${clip(u.output!, perDependency)}`).join("\n");
  const previous = task.history?.at(-1);
  const context = previous ? `Previous user instruction: ${clip(previous.instruction, 2000)}\nPrevious artifacts: ${previous.report?.texPath ?? "workspace"}; ${previous.report?.pdfPath ?? "no PDF"}` : "No previous round.";
  const logs = dependencies.flatMap(u => {
    const latest = [...task.runs].reverse().find(r => r.workUnitId === u.id && r.state === "completed" && r.logPath);
    return latest?.logPath ? [latest.logPath] : [];
  }).join("\n");
  // Keep initial hypotheses available after the lead's plan is expanded into a
  // dynamic graph. Never expose these success claims to independent reviewers.
  const idea = [...task.workUnits].reverse().find(u => (u.ideaPhase || (u.researchStage === "idea" && !u.planPhase && !u.subtask)) && u.id !== unit.id && u.state === "completed" && u.output && !unit.dependsOn.includes(u.id));
  const ideaContext = idea ? `\nInitial ideation handoff (provisional hypotheses, NOT verified findings; address unresolved questions before execution):\n${clip(idea.output!, 4000)}\nFull handoff log: ${task.runs.filter(r => r.workUnitId === idea.id && r.state === "completed").at(-1)?.logPath ?? "application work-unit history"}` : "";
  return `# Focused handoff context\n${artifacts}\n${context}\nDirect dependencies only (handoffs are claims, not evidence):\n${clip(handoffs, limit) || "None. Inspect existing artifacts before starting."}\nRelevant external logs (read only if needed):\n${logs || "None"}${ideaContext}`;
}
