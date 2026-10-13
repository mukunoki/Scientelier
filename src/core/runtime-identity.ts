import type { AgentRun, TaskRecord, WorkUnit } from "./types";

/** Native CLI metadata, not server attestation or proof of correctness.
 * Multiple observed models stay explicit; a requested alias is not evidence. */
export interface RuntimeIdentity {
  source: "native-session" | "native-status";
  sessionId: string;
  models: string[];
  provider?: string;
  observedAt: string;
}
const identifier = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_.:/-]{1,256}$/.test(v);
export function validRuntimeIdentity(v: unknown): v is RuntimeIdentity {
  const value = v as RuntimeIdentity | undefined;
  return !!value && ["native-session", "native-status"].includes(value.source) && identifier(value.sessionId)
    && Array.isArray(value.models) && value.models.length > 0 && value.models.length <= 8 && value.models.every(identifier)
    && (value.provider === undefined || identifier(value.provider)) && typeof value.observedAt === "string" && Number.isFinite(Date.parse(value.observedAt));
}
/** Keep the metadata handoff allowlisted even for a malformed legacy receipt. */
export function parseRuntimeIdentity(value:unknown):RuntimeIdentity|undefined {
  if (!validRuntimeIdentity(value)) return;
  return {source:value.source,sessionId:value.sessionId,models:[...value.models],observedAt:value.observedAt,
    ...(value.provider ? {provider:value.provider} : {})};
}
export function transcriptIdentity(provider: string, text: string, startedAt: number, sessionId: unknown): RuntimeIdentity | undefined {
  if (!Number.isFinite(startedAt) || !identifier(sessionId)) return;
  const models = new Set<string>(); let actualProvider: string | undefined, at: string | undefined;
  let codexSession = false;
  for (const line of text.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (provider === "codex" && e.type === "session_meta" && e.payload?.id === sessionId) {
      codexSession = true;
      if (identifier(e.payload.model_provider)) actualProvider = e.payload.model_provider;
    }
    if (!Number.isFinite(Date.parse(e.timestamp)) || Date.parse(e.timestamp) < startedAt) continue;
    const model = provider === "codex" && codexSession && e.type === "turn_context" ? e.payload?.model
      : provider === "claude" && e.type === "assistant" && !e.isSidechain && (!e.sessionId || e.sessionId === sessionId) ? e.message?.model : undefined;
    if (identifier(model)) { models.add(model); at = e.timestamp; }
  }
  if (!models.size || models.size > 8 || !at) return;
  return {source:"native-session",sessionId,models:[...models],observedAt:at,...(actualProvider ? {provider:actualProvider} : {})};
}
export function claudeStatusIdentity(payload: any): RuntimeIdentity | undefined {
  if (!identifier(payload?.session_id) || !identifier(payload?.model?.id)) return;
  return {source:"native-status",sessionId:payload.session_id,models:[payload.model.id],observedAt:new Date().toISOString()};
}
const observation = (r: AgentRun) => ({runId:r.id,unitId:r.workUnitId,cli:r.agentId,requestedModel:r.model,
  observed:parseRuntimeIdentity(r.runtimeIdentity) ?? null,writingRevision:r.finishingSkill?.revision,
  skills:r.skillUsage?.reads.map(s=>({id:s.id,revision:s.revision}))});
export function runtimeEvidence(task: TaskRecord, unit: WorkUnit) {
  const blind = unit.role === "reviewer" || unit.subtask?.requirements?.independentFrom?.length || unit.subtask?.requirements?.independenceGroup;
  const ids = new Set(unit.dependsOn);
  // Metadata only: no outputs, verdicts, tokens, log paths or peer conclusions.
  const runs = task.runs.filter(r=>r.goalRevision===task.goal?.revision && !r.goalPreparation
    && (!blind || ids.has(r.workUnitId) || r.workUnitId===unit.id));
  const observations=runs.slice(-24).map(observation);
  // Drop whole older observations rather than truncate JSON or native IDs.
  // Leave space for current-run metadata within the fixed 32 KB MCP limit.
  while(observations.length && Buffer.byteLength(JSON.stringify(observations))>24000)observations.shift();
  return observations;
}
export function runtimeEvidencePrompt(task: TaskRecord, unit: WorkUnit): string {
  if (task.goalPreparation || unit.orchestrator) return "";
  return `# Harness runtime observations (metadata only)\n${JSON.stringify(runtimeEvidence(task,unit))}\nRequested model is NOT observed identity. Native status/session evidence is local CLI telemetry, not cryptographic provider attestation or proof of findings. The harness captures this run's native model evidence when available and attaches final session evidence on completion; get_run_evidence (where available) returns the current observations. File-channel agents may read only their own captured run-evidence.json next to instructions.txt instead; unavailable identity stays unknown. Submit substantive verification separately from identity uncertainty. Do not repeat source/content checks solely to reconstruct launch/model/skill metadata or inspect other agents' transcripts. Integration may resolve metadata-only uncertainty using these saved native observations after completion; missing/conflicting identity remains unverified and cannot certify model diversity. Multiple models remain explicit. Never insert this administrative information into the report.`;
}
