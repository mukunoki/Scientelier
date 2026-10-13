import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initialAssignmentEditable, initialAssignmentPatch, workUnitAssignment } from "./initial-assignment";
import { createExecutionWorkflow, selectAgent } from "./orchestration";
import { JsonTaskStore } from "./task-store";
import type { AgentPolicy, ProviderResourceSummary, TaskRecord } from "./types";

function task(): TaskRecord {
  const t: TaskRecord = { id: "task", title: "Task", prompt: "Work", cwd: "/tmp", strategy: "balanced", workflowMode: "primary",
    allowedAgentIds: ["codex", "claude"], modelOverrides: {}, runs: [], workUnits: [], state: "queued", output: "",
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:01Z", roundNumber: 1 };
  t.workUnits = createExecutionWorkflow(t); return t;
}
const selection = { agentId: "claude", model: "sonnet", allowFallback: true };

test("start preference is editable before substantive work, including after goal preparation", () => {
  const t = task();
  for (const state of ["queued", "paused", "blocked", "awaiting-input"] as const) assert.equal(initialAssignmentEditable({ ...t, state }), true);
  const proposal = { ...t, runs: [{ goalPreparation: true }] as TaskRecord["runs"] };
  assert.equal(initialAssignmentEditable(proposal), true);
  for (const state of ["planning", "running", "reviewing", "reporting", "completed"] as const)
    assert.equal(initialAssignmentEditable({ ...t, state }), false);
  assert.equal(initialAssignmentEditable(t, true), false, "preflight/start reservations are active too");
  assert.equal(initialAssignmentEditable({ ...t, runs: [{ goalPreparation: false }] as TaskRecord["runs"] }), false);
  assert.equal(initialAssignmentEditable({ ...t, workUnits: [{ ...t.workUnits[0], state: "running" }] }), false);
});

test("saving validates allowed CLI, model, freshness and never modifies goals, permissions or work", () => {
  const t = task(), before = JSON.stringify(t);
  const patch = initialAssignmentPatch(t, selection, t.updatedAt);
  assert.deepEqual(patch, { initialAssignment: { ...selection, round: 1 } });
  assert.equal(JSON.stringify(t), before);
  for (const input of [null, [], {}, { ...selection, agentId: "gemini" }, { ...selection, agentId: "opencode" },
    { ...selection, agentId: 2 }, { ...selection, model: 1 }, { ...selection, model: "bad\nmodel" },
    { ...selection, model: "x".repeat(257) }, { ...selection, agentId: undefined }, { ...selection, allowFallback: "true" },
    { ...selection, permissions: "full-access" }]) assert.throws(() => initialAssignmentPatch(t, input, t.updatedAt));
  assert.throws(() => initialAssignmentPatch(t, selection, "stale"), /更新/);
  assert.throws(() => initialAssignmentPatch(t, selection, t.updatedAt, true), /開始前/);
  assert.deepEqual(initialAssignmentPatch(t, { allowFallback: true }, t.updatedAt), { initialAssignment: undefined });
});

test("a goal-approved graph uses the selection only at its first unit in the saved round", () => {
  const t = { ...task(), ...initialAssignmentPatch(task(), selection, task().updatedAt) };
  // Approval changes IDs; the preference must not depend on a preparation ID.
  t.workUnits = createExecutionWorkflow(t);
  assert.equal(workUnitAssignment(t, t.workUnits[0])?.model, "sonnet");
  assert.equal(workUnitAssignment(t, t.workUnits[1]), undefined);
  assert.equal(workUnitAssignment({ ...t, goalPreparation: true }, t.workUnits[0]), undefined);
  assert.equal(workUnitAssignment({ ...t, roundNumber: 2 }, t.workUnits[0]), undefined);
  const assignments = { worker: { agentId: "codex" as const, allowFallback: false } };
  assert.equal(workUnitAssignment({ ...t, assignments }, t.workUnits[0])?.agentId, "claude");
  assert.equal(workUnitAssignment({ ...t, initialAssignment: undefined, assignments }, t.workUnits[0])?.agentId, "codex");
});

test("routing obeys the initial CLI while retaining cooldown, fallback and task permission gates", () => {
  const t = { ...task(), ...initialAssignmentPatch(task(), selection, task().updatedAt) };
  const policies: AgentPolicy[] = ["codex", "claude"].map(id => ({ agentId: id as "codex" | "claude", providerKey: id, providerLabel: id, enabled: true, authMode: "subscription", priority: id === "codex" ? 100 : 1 }));
  const input = { task: t, unit: t.workUnits[0], agents: policies.map(p => ({ id: p.agentId, label: p.agentId, command: p.agentId, installed: true })),
    settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 90 }, resources: [] };
  assert.equal(selectAgent(input), "claude");
  const cooldown: ProviderResourceSummary = { providerKey: "claude", providerLabel: "Claude", agentIds: ["claude"],
    authModes: ["subscription"], state: "cooldown", totalTokens: 0, inputTokens: 0, outputTokens: 0, runs: 0, failures: 0,
    windows: [], models: [], limitSource: "unknown" };
  assert.equal(selectAgent({ ...input, resources: [cooldown] }), "codex", "cooldown still permits only an allowed fallback");
  assert.equal(selectAgent({ ...input, resources: [cooldown], task: { ...t, initialAssignment: { ...t.initialAssignment!, allowFallback: false } } }), undefined);
  assert.equal(selectAgent({ ...input, agents: input.agents.filter(a => a.id !== "claude") }), "codex");
  assert.equal(selectAgent({ ...input, agents: input.agents.filter(a => a.id !== "claude"), task: { ...t, initialAssignment: { ...t.initialAssignment!, allowFallback: false } } }), undefined);
  assert.equal(selectAgent({ ...input, task: { ...t, goalPreparation: true } }), "codex");
  assert.equal(selectAgent({ ...input, settings: { ...input.settings, agentPolicies: policies.map(p => ({ ...p, enabled: false })) } }), undefined);
});

test("initial CLI persists after application reload without starting work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-initial-cli-"));
  try {
    const file = join(directory, "tasks.json"), store = new JsonTaskStore(file); await store.init();
    const t = await store.create({ title: "Task", prompt: "Work", cwd: directory, strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, goalMode: "manual" });
    const saved = await store.update(t.id, initialAssignmentPatch(t, selection, t.updatedAt));
    const reload = new JsonTaskStore(file); await reload.init();
    assert.deepEqual(reload.get(t.id)?.initialAssignment, saved.initialAssignment);
    assert.deepEqual(saved.goal, t.goal); assert.deepEqual(saved.workUnits, t.workUnits);
    assert.equal(saved.localCodexPermissions, t.localCodexPermissions); assert.equal(saved.runs.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
