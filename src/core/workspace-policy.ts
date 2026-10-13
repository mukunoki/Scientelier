import type { TaskRecord, WorkUnit } from "./types";

// Use captured scope metadata: experimental ideation permits small prototypes,
// unlike old read-only idea presets. A mode name alone never grants that scope.
export function generalImplementation(task: TaskRecord, unit?: WorkUnit): boolean {
  const mode = task.workPreset?.manifest.id;
  const stage = mode === "research-project" ? task.workPreset?.stages?.find(p => p.manifest.id === unit?.researchStage) : task.workPreset;
  const experimentalIdea = stage?.manifest.focus === "idea" && stage.manifest.ideaApproach === "experimental";
  // Integrated research has no stage label. Use its captured metadata, not the
  // current preset or the mode name, so old stage-local scopes remain unchanged.
  const integratedResearch = mode === "research-project"
    && task.workPreset?.manifest.integratedWorkflow === true && !unit?.researchStage;
  return mode === "coding" || integratedResearch || mode === "research-project" && unit?.researchStage === "coding" || experimentalIdea;
}
export function hasImplementationWorkspaces(task: TaskRecord): boolean {
  return task.workPreset?.manifest.id !== "hpc-refactoring"
    && [...task.workUnits, ...(task.retiredWorkUnits ?? [])].some(u => u.subtask?.kind === "isolated-work");
}
