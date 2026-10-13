import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionWorkflow, selectAgent } from "./orchestration";
import { defaultExecution, validateExecution, budgetStatus, continuation, executionGuidance } from "./execution-policy";
import { parseWorkPlan, expandWorkPlan, readySubtasks } from "./decomposition";
import { completionFromHook, completionMarker } from "./completion-hook";
import { buildInvocation } from "./adapters";
import { elapsedWorkMinutes } from "./work-guidance";
import { resumePatch } from "./recovery";
import { taskCodexPermissions, codexPermissionPatch } from "./codex-permissions";
import type { AgentRun, TaskRecord, SubtaskSpec, ProviderResourceSummary } from "./types";

const sessionId = "01234567-1234-1234-1234-0123456789ab";
function task(): TaskRecord {
  return { id: "x", title: "test", cwd: "/tmp", prompt: "subject", state: "queued", strategy: "balanced", workflowMode: "primary", execution: { ...defaultExecution }, allowedAgentIds: ["codex", "claude"], modelOverrides: {}, runs: [], workUnits: createExecutionWorkflow({ workflowMode: "primary" }), output: "", createdAt: "", updatedAt: "",
    goal: { objective: "subject", deliverables: ["PDF"], criteria: [{ id: "c", description: "correct", verification: "inspect", required: true }], constraints: [], outOfScope: [], questions: [], status: "approved", revision: 1, updatedAt: "" } };
}
const spec = (key: string, dependsOn: string[] = []): SubtaskSpec => ({ key, title: key, instructions: "Inspect only", deliverable: "findings", acceptance: "check sources", criterionIds: ["c"], dependsOn, estimatedTokens: 1000 });
const output = (tasks: unknown[]) => `<work-plan>${JSON.stringify({ tasks })}</work-plan>`;
function run(): AgentRun { return { id: "r", workUnitId: "w", role: "worker", primary: true, agentId: "codex", providerKey: "openai", state: "completed", sessionId, goalRevision: 1, estimatedTokens: 8000, contextEstimate: 10000, output: "", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:10:00Z" }; }

test("session IDs come from native final hooks and only compatible primary work inherits context", () => {
  const handoff = completionFromHook("codex", { type: "agent-turn-complete", "thread-id": sessionId, "last-assistant-message": `Done\n${completionMarker("token")}` }, "token");
  assert.equal(handoff?.sessionId, sessionId);
  assert.equal(completionFromHook("claude", { hook_event_name: "Stop", session_id: sessionId, last_assistant_message: `Done\n${completionMarker("token")}` }, "token")?.sessionId, sessionId);
  const t = task(); t.runs = [run()];
  assert.equal(continuation(t, t.workUnits[0], "codex").run?.id, "r");
  assert.equal(continuation(t, t.workUnits[2], "codex").run, undefined);
  assert.equal(continuation(t, t.workUnits[0], "claude").run, undefined);
  assert.equal(continuation(t, t.workUnits[0], "codex", "other-model").run, undefined);
  t.goal!.revision++; assert.equal(continuation(t, t.workUnits[0], "codex").run, undefined); t.goal!.revision--;
  t.execution!.contextTokens = 32000;
  t.runs[0].contextEstimate = 32000; assert.equal(continuation(t, t.workUnits[0], "codex").run, undefined);
  t.runs[0].contextEstimate = 100; t.runs[0].state = "failed"; assert.equal(continuation(t, t.workUnits[0], "codex").run, undefined);
});

test("native conversation forks preserve permissions and reject invalid IDs or read-only reuse", () => {
  for (const id of ["codex", "claude"] as const) {
    const status = { id, label: id, command: id, executable: "/fake", installed: true };
    const args = buildInvocation(status, { prompt: "Continue", mode: "write", cwd: "/tmp", continueSession: sessionId }).args;
    assert.ok(args.includes(sessionId)); assert.ok(args.includes(id === "codex" ? "fork" : "--fork-session"));
    assert.ok(args.includes(id === "codex" ? "workspace-write" : "bypassPermissions"));
    assert.throws(() => buildInvocation(status, { prompt: "Review", mode: "read", cwd: "/tmp", continueSession: sessionId }));
    assert.throws(() => buildInvocation(status, { prompt: "Continue", mode: "write", cwd: "/tmp", continueSession: "--last" }));
  }
});

test("unspecified context threshold only disables quantity-based conversation switching", () => {
  const t = task(); t.runs = [{ ...run(), contextEstimate: 900000 }];
  t.execution = validateExecution({ ...defaultExecution, contextTokens: undefined });
  assert.equal(t.execution.contextTokens, undefined);
  assert.equal(continuation(t, t.workUnits[0], "codex").run?.id, "r");
  assert.equal(continuation(t, t.workUnits[2], "codex").run, undefined);
  assert.equal(continuation(t, t.workUnits[0], "claude").run, undefined);
  assert.equal(continuation(t, t.workUnits[0], "codex", "other-model").run, undefined);
  assert.match(executionGuidance(t, t.workUnits[0]), /Context handoff target: unspecified/);
  assert.doesNotMatch(executionGuidance(t, t.workUnits[0]), /undefined/);
  t.execution.reuseContext = false;
  assert.equal(continuation(t, t.workUnits[0], "codex").run, undefined);
  for (const contextTokens of [null, "", 0, 3999, 200001, 4000.5, NaN, Infinity]) assert.throws(() => validateExecution({ ...defaultExecution, contextTokens }));
  for (const contextTokens of [4000, 32000, 200000]) assert.equal(validateExecution({ ...defaultExecution, contextTokens }).contextTokens, contextTokens);
});

test("Codex conversations only continue with the same explicit permission mode", () => {
  const t = task(); t.runs = [run()];
  t.remote = { id: "cluster", name: "Cluster", host: "localhost", cwd: "/work", nodeCommand: "node", startup: "", instructions: "", texCommand: "latexmk", codexPermissions: "full-access" };
  assert.equal(continuation(t, t.workUnits[0], "codex").run, undefined);
  t.runs[0].codexPermissions = "full-access";
  assert.equal(continuation(t, t.workUnits[0], "codex").run?.id, "r");
  t.remote.codexPermissions = "sandbox";
  assert.equal(continuation(t, t.workUnits[0], "codex").run, undefined);
});

test("Claude uses fresh per-run MCP context while preserving saved artifacts and history", () => {
  const t = task(); t.runs = [{...run(),agentId:"claude"}];
  const before = structuredClone(t);
  const next = continuation(t,t.workUnits[0],"claude");
  assert.equal(next.run,undefined); assert.match(next.reason,/MCP.*新規会話/);
  assert.deepEqual(t,before);
});

test("local Full access is explicit, does not inherit remote authority, and starts a new conversation", () => {
  const t=task();t.runs=[run()];
  assert.equal(taskCodexPermissions(t),"sandbox");
  assert.throws(()=>codexPermissionPatch(t,"full-access",false),/確認/);
  assert.throws(()=>codexPermissionPatch(t,"unknown",true),/不正/);
  const before=structuredClone(t);
  const patch=codexPermissionPatch(t,"full-access",true);
  assert.deepEqual(t,before);assert.deepEqual(patch,{localCodexPermissions:"full-access"});
  Object.assign(t,patch);assert.equal(continuation(t,t.workUnits[0],"codex").run,undefined);
  t.runs[0].codexPermissions="full-access";
  assert.equal(continuation(t,t.workUnits[0],"codex").run?.id,"r");
  for (const mode of ["read","write"] as const) {
    const invocation=buildInvocation({id:"codex",label:"Codex",command:"codex",executable:"/bin/codex",installed:true}, {prompt:"Inspect GPU",cwd:"/tmp",mode,codexPermissions:taskCodexPermissions(t)});
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox")+1],"danger-full-access");
  }
  t.localCodexPermissions="sandbox";
  assert.equal(continuation(t,t.workUnits[0],"codex").run,undefined);
  t.remote={id:"r",name:"r",host:"r",cwd:"/work",nodeCommand:"node",startup:"",instructions:"",texCommand:"latexmk",codexPermissions:"full-access"};
  assert.equal(taskCodexPermissions(t),"full-access");assert.equal(taskCodexPermissions(t,true),"sandbox");
  assert.equal(codexPermissionPatch(t,"sandbox",false).localCodexPermissions,undefined);
});

test("bounded decomposition validates criteria, cycles, authority and complete batch budget", () => {
  const t = task(), owner = { ...t.workUnits[0], planPhase: false };
  assert.equal(parseWorkPlan(output([spec("a"), spec("b", ["a"])]), t, owner)?.length, 2);
  for (const bad of [[spec("a"), spec("a")], [spec("a", ["a"])], [spec("a", ["missing"])], [spec("a", ["b"]), spec("b", ["a"])], [{ ...spec("a"), criterionIds: ["invented"] }], [{ ...spec("a"), mode: "write" }]]) assert.throws(() => parseWorkPlan(output(bad), t, owner));
  assert.throws(() => parseWorkPlan(output([spec("a")]), t, { ...owner, delegationUsed: true }));
  assert.throws(() => parseWorkPlan(output([spec("a")]) + "<work-check>{}</work-check>", t, owner));
  t.execution!.tokenBudget = 10000; assert.ok(parseWorkPlan(output([spec("a")]), t, owner), "token telemetry never blocks useful delegation");
});

test("dependency expansion only parallelizes read-only tasks and resume retains completed siblings", () => {
  const t = task(), owner = { ...t.workUnits[0], state: "completed" as const };
  t.workUnits = expandWorkPlan([owner, ...t.workUnits.slice(1)], owner, [spec("a"), spec("b"), spec("c", ["a"])]);
  assert.deepEqual(readySubtasks(t).map(u => u.subtask!.key), ["a", "b"]);
  assert.ok(readySubtasks(t).every(u => u.mode === "read"));
  const [a, b, c] = t.workUnits.filter(u => u.subtask);
  a.state = "completed"; b.state = "failed"; c.state = "cancelled";
  t.state = "paused"; t.resumeFromUnitId = b.id;
  const patch = resumePatch(t);
  assert.equal(patch.workUnits!.find(u => u.id === a.id)?.state, "completed");
  assert.equal(patch.workUnits!.find(u => u.id === b.id)?.state, "pending");
  assert.equal(patch.workUnits!.find(u => u.id === c.id)?.state, "pending");
  const integration = t.workUnits.find(u => u.primary && u.id !== owner.id)!;
  assert.equal(integration.dependsOn.length, 3); assert.equal(integration.delegationUsed, true);
});

test("token telemetry retains finishing estimates and uncertainty without controlling admission", () => {
  const t = task(); t.execution!.tokenBudget = 16000;
  assert.equal(budgetStatus(t).reserve, 8000);
  t.runs = [run()]; assert.equal(budgetStatus(t).used, 8000);
  t.runs[0].estimatedTokens = 50000;
  assert.equal(budgetStatus(t).used, 50000);
  assert.equal(budgetStatus(t).estimated, true);
  assert.throws(() => validateExecution({ ...defaultExecution, maxParallel: 20 }));
  assert.throws(() => validateExecution({ ...defaultExecution, tokenBudget: NaN }));
});

test("parallel active duration counts wall time once, not one deadline per agent", () => {
  const t = task(); t.runs = [run(), { ...run(), id: "other", startedAt: "2026-01-01T00:05:00Z", completedAt: "2026-01-01T00:15:00Z" }];
  assert.equal(elapsedWorkMinutes(t), 15);
});

test("routing balances shared-provider active load without treating unknown quotas as free", () => {
  const t = task(), unit = t.workUnits[0];
  const policies = [{ agentId: "codex" as const, enabled: true, providerKey: "openai", providerLabel: "OpenAI", authMode: "subscription" as const, priority: 80 }, { agentId: "claude" as const, enabled: true, providerKey: "anthropic", providerLabel: "Anthropic", authMode: "subscription" as const, priority: 80 }];
  const resources = policies.map(p => ({ providerKey: p.providerKey, state: "available", usedPercent: 10, windows: [], models: [], totalTokens: 0, capacityUpdatedAt: new Date().toISOString() } as unknown as ProviderResourceSummary));
  const input = { task: t, unit, agents: policies.map(p => ({ id: p.agentId, label: "", command: "", installed: true })), settings: { agentPolicies: policies, warningPercent: 70, drainPercent: 85 }, resources };
  assert.equal(selectAgent({ ...input, providerReservations: { openai: 1 } }), "claude");
  t.assignments = { worker: { agentId: "codex", allowFallback: false } };
  assert.equal(selectAgent({ ...input, unit: { ...unit, primary: false, subtask: spec("a"), mode: "read" }, providerReservations: { openai: 1 } }), "claude", "primary assignment does not pin every independent specialist");
  t.assignments = {};
  resources[0].capacityUpdatedAt = undefined; resources[0].usedPercent = undefined;
  resources[1].usedPercent = 0;
  assert.equal(selectAgent(input), "claude");
  resources[1].usedPercent = 50;
  assert.equal(selectAgent(input), "codex", "uncertainty is a separate penalty, not fabricated 50% consumption");
});
