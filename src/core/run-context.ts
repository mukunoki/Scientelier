import { join, posix } from "node:path";
import { quoteShellArgument } from "./adapters";
import { crossReviewSources } from "./cross-review";
import { currentReviewAdjustment } from "./review-timing";
import { independencePeers } from "./work-requirements";
import type { TaskRecord, WorkUnit } from "./types";

/** Saved handoff data, not instructions. Blind reviewers never receive worker
 * verdicts or independent peer findings through the dependency manifest. */
export function taskContextManifest(task: TaskRecord, unit: WorkUnit) {
  const peers = new Set(independencePeers(task, unit)?.map(peer => peer.id));
  const blind = unit.role === "reviewer" || unit.contentCheck?.stage==="peer" || !!unit.subtask?.requirements?.independenceGroup;
  return {
    goal: task.goal ? { ...task.goal, unselected: undefined } : undefined,
    userInstructions: [
      ...(task.history ?? []).map(round => ({ round: round.number, instruction: round.instruction })),
      { round: task.roundNumber ?? 1, instruction: task.instruction ?? task.prompt }
    ],
    // User-authored answers remain available even after a later round begins.
    // They are separate from agent findings and do not revise the approved goal.
    userAnswers: task.resumeInstructions,
    report: task.report,
    executionPlans: unit.primary ? task.executionPlans : undefined,
    crossReviewSources: crossReviewSources(task, unit),
    reviewAdjustment: currentReviewAdjustment(task),
    retiredWork: unit.primary ? (task.retiredWorkUnits ?? []).map(retired => ({
      ...retired,
      logs: task.runs.filter(run => run.workUnitId === retired.id).map(run => run.logPath)
    })) : undefined,
    dependencies: blind ? [] : task.workUnits
      .filter(dependency => unit.dependsOn.includes(dependency.id))
      .map(dependency => ({
        title: dependency.title,
        ...(peers.has(dependency.id)
          ? { output: "Independent peer findings withheld. Inspect neutral source/evidence paths in your assignment." }
          : { output: dependency.output, subtask: dependency.subtask })
      }))
  };
}

export type RunControlLocation =
  | { kind: "local"; executable: string; directory: string; modules: string }
  | { kind: "remote"; executable: string; directory: string };
type ControlModule = "result-channel" | "implementation-workspaces" | "quality" | "research-cycle" | "hpc";

/** Engines use the same process and scoped context on every CLI transport.
 * Remote Node is a normal runtime; only the local Electron binary needs its
 * Node mode. Quoting belongs here so paths with spaces are never split. */
export function runControlCommand(location: RunControlLocation, module: ControlModule, args: string[]): string {
  const invocation = location.kind === "remote"
    ? [location.executable, posix.join(location.directory, `${module}.js`), ...args]
    : ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", location.executable, join(location.modules, `${module}.js`), ...args];
  return invocation.map(quoteShellArgument).join(" ");
}

export function scopedEngineCommand(location: RunControlLocation, module: ControlModule, contextFile: string): string {
  const path = location.kind === "remote" ? posix.join(location.directory, contextFile) : join(location.directory, contextFile);
  return runControlCommand(location, module, [path]);
}
