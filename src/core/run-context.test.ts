import test from "node:test";
import assert from "node:assert/strict";
import { taskContextManifest, runControlCommand, scopedEngineCommand, type RunControlLocation } from "./run-context";
import type { TaskRecord, WorkUnit } from "./types";

function unit(id: string, patch: Partial<WorkUnit> = {}): WorkUnit {
  return { id, title: id, role: "worker", mode: "write", state: "pending", instructions: "", dependsOn: [], attemptedAgentIds: [], ...patch };
}
function task(workUnits: WorkUnit[]): TaskRecord {
  return {
    id: "t", prompt: "initial", instruction: "current", cwd: "/work", roundNumber: 2,
    workUnits, runs: [], history: [{ number: 1, instruction: "previous" }],
    goal: { revision: 3, unselected: { deliverables: ["not approved"] } },
    executionPlans: [{ revision: 1 }], report: { texPath: "/report/report.tex" }
  } as unknown as TaskRecord;
}

test("context manifest preserves round instructions and dependencies without mutating task data", () => {
  const dependency = unit("dependency", { state: "completed", output: "evidence" });
  const owner = unit("owner", { primary: true, dependsOn: [dependency.id] });
  const t = task([dependency, owner]);
  const before = JSON.stringify(t);
  const manifest = taskContextManifest(t, owner);
  assert.deepEqual(manifest.userInstructions, [{ round: 1, instruction: "previous" }, { round: 2, instruction: "current" }]);
  assert.deepEqual(manifest.dependencies, [{ title: "dependency", output: "evidence", subtask: undefined }]);
  assert.equal(manifest.executionPlans, t.executionPlans);
  assert.equal(manifest.report, t.report);
  assert.doesNotMatch(JSON.stringify(manifest), /not approved/);
  assert.equal(JSON.stringify(t), before, "context serialization must not remove unselected options from the editable goal");
  assert.equal(taskContextManifest(t, { ...owner, primary: false }).executionPlans, undefined);
  assert.equal(taskContextManifest({ ...t, instruction: undefined }, owner).userInstructions[1].instruction, "initial");
});

test("blind reviewers and independent candidates do not receive dependency verdicts", () => {
  const peer = unit("peer", { state: "completed", output: "peer verdict", subtask: { key: "peer-key" } as WorkUnit["subtask"] });
  const candidate = unit("candidate", { dependsOn: [peer.id], subtask: { requirements: { independentFrom: ["peer-key"] } } as WorkUnit["subtask"] });
  const t = task([peer, candidate]);
  const manifest = taskContextManifest(t, candidate);
  assert.match(manifest.dependencies[0].output ?? "", /Independent peer findings withheld/);
  assert.doesNotMatch(JSON.stringify(manifest.dependencies), /peer verdict/);
  assert.deepEqual(taskContextManifest(t, { ...candidate, role: "reviewer" }).dependencies, []);
  const group = { ...candidate, subtask: { ...candidate.subtask!, requirements: { independenceGroup: "blind" } } };
  assert.deepEqual(taskContextManifest(t, group).dependencies, []);
});
test("context retains user answers separately from both the original request and peer verdicts", () => {
  const owner = unit("owner", { primary: true }), t = task([owner]);
  t.resumeInstructions = [{ round: 1, unitId: "old", at: "2026-10-01T00:00:00Z", instruction: "指定の作者設定を使用してください" }];
  const before = JSON.stringify(t);
  const manifest = taskContextManifest(t, { ...owner, role: "reviewer" });
  assert.deepEqual(manifest.userAnswers, t.resumeInstructions);
  assert.equal(manifest.userInstructions.at(-1)!.instruction, "current");
  assert.deepEqual(manifest.dependencies, []);
  assert.equal(JSON.stringify(t), before);
});

test("primary context retains retired packages and their original log paths", () => {
  const owner = unit("owner", { primary: true });
  const t = task([owner]);
  t.retiredWorkUnits = [unit("old")];
  t.runs = [{ workUnitId: "old", logPath: "/logs/old.log" }, { workUnitId: "owner", logPath: "/logs/current.log" }] as TaskRecord["runs"];
  assert.deepEqual(taskContextManifest(t, owner).retiredWork?.[0].logs, ["/logs/old.log"]);
  assert.equal(taskContextManifest(t, { ...owner, primary: false }).retiredWork, undefined);
});

test("scoped engine commands preserve runtime, argument order and quoting locally and remotely", () => {
  const local: RunControlLocation = { kind: "local", executable: "/Applications/Agent Harness", modules: "/app/core", directory: "/tmp/my run" };
  const remote: RunControlLocation = { kind: "remote", executable: "/opt/node", directory: "/home/u/my run" };
  for (const [module, context] of [
    ["implementation-workspaces", "workspace-context.json"], ["quality", "quality-context.json"],
    ["research-cycle", "research-context.json"], ["hpc", "hpc-context.json"]
  ] as const) {
    assert.equal(scopedEngineCommand(local, module, context), `'/usr/bin/env' 'ELECTRON_RUN_AS_NODE=1' '/Applications/Agent Harness' '/app/core/${module}.js' '/tmp/my run/${context}'`);
    assert.equal(scopedEngineCommand(remote, module, context), `'/opt/node' '/home/u/my run/${module}.js' '/home/u/my run/${context}'`);
  }
  assert.equal(runControlCommand(remote, "result-channel", [remote.directory, "token"]), "'/opt/node' '/home/u/my run/result-channel.js' '/home/u/my run' 'token'");
  assert.equal(runControlCommand({ ...remote, directory: "/home/u/it's here" }, "quality", ["value"]), `'/opt/node' '/home/u/it'"'"'s here/quality.js' 'value'`);
});
