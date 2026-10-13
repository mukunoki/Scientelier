import type { FinishingSkillSnapshot, ModelFamily, TaskRecord, WorkUnit } from "./types";

export class WorkRequirementsError extends Error {}

// Classify an explicit model ID, never a CLI name or billing provider. Unknown
// defaults/auto routes cannot certify diversity and are rejected when constrained.
export function modelFamily(model?: string): ModelFamily | undefined {
  const name = model?.toLowerCase().split("/").at(-1) ?? "";
  if (/^(?:gpt-|o[134](?:-|$))/.test(name)) return "openai";
  if (/^(?:claude-|fable(?:-|$)|opus(?:-|$)|sonnet(?:-|$)|haiku(?:-|$))/.test(name)) return "anthropic";
  if (/^gemini-/.test(name)) return "gemini";
  if (/^deepseek(?:-|v)/.test(name)) return "deepseek";
  if (/^glm-/.test(name)) return "glm";
}

export function independencePeers(task: TaskRecord, unit: WorkUnit): WorkUnit[] | undefined {
  const peers: WorkUnit[] = [];
  for (const key of unit.subtask?.requirements?.independentFrom ?? []) {
    const matches = task.workUnits.filter(u=>unit.dependsOn.includes(u.id) && u.subtask?.key===key);
    if (matches.length !== 1 || matches[0].state !== "completed") return;
    peers.push(matches[0]);
  }
  return peers;
}

export function meetsModelRequirements(task: TaskRecord, unit: WorkUnit, model?: string): boolean {
  const requirements = unit.subtask?.requirements;
  if (!requirements?.modelFamilies?.length && !requirements?.independentFrom?.length) return true;
  const family = modelFamily(model), peers = independencePeers(task,unit);
  if (!family || !peers || requirements.modelFamilies && !requirements.modelFamilies.includes(family)) return false;
  return peers.every(peer=>{
    const run = [...task.runs].reverse().find(r=>r.workUnitId===peer.id && r.state==="completed" && r.goalRevision===task.goal?.revision);
    const observed = run?.runtimeIdentity?.models.map(modelFamily);
    const other = observed ? observed.every(f=>!!f && f===observed[0]) ? observed[0] : undefined : modelFamily(run?.model);
    return !!other && other !== family;
  });
}

export function pinnedWritingSnapshot(task: TaskRecord, unit: WorkUnit): FinishingSkillSnapshot | undefined {
  const revision = unit.subtask?.requirements?.skills?.find(s=>s.id==="writing-rules")?.revision;
  if (!revision) return;
  const snapshot = [...task.runs].reverse().find(r=>r.goalRevision===task.goal?.revision && r.finishingSkill?.revision===revision)?.finishingSkill;
  if (!snapshot) throw new WorkRequirementsError("指定された執筆ルールの保存版がこのゴールの実行履歴にありません。別版へ自動置換せず、配置条件を修復してください。");
  return snapshot;
}

export function assertSkillRequirements(unit: WorkUnit, catalog: Array<{id:string;revision:string}>): void {
  for (const required of unit.subtask?.requirements?.skills ?? []) {
    const actual = catalog.find(s=>s.id===required.id);
    if (!actual || required.revision && required.revision!==actual.revision) throw new WorkRequirementsError(`必須スキル ${required.id} が未配布、または指定版と一致しません。配置を修復して同じ工程から再開してください。`);
  }
}
