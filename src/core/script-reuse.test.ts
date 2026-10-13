import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scriptReuseGuidance } from "./script-reuse";
import { buildWorkUnitPrompt, createStandardWorkflow, createExecutionWorkflow } from "./orchestration";
import type { TaskRecord, WorkUnit } from "./types";

function task(): TaskRecord {
  return { id: "reuse", title: "Reuse", prompt: "Verify the data", cwd: "/tmp/project", strategy: "balanced",
    allowedAgentIds: ["codex", "claude"], modelOverrides: {}, workUnits: createStandardWorkflow(), runs: [],
    state: "paused", createdAt: "", updatedAt: "", output: "" };
}

test("script-first policy reaches legacy/no-preset tasks and the initial primary plan", () => {
  const t = task();
  for (const unit of t.workUnits) assert.match(buildWorkUnitPrompt(t, unit), /# Script-first token economy/);
  assert.match(buildWorkUnitPrompt(t, t.workUnits[0]), /PLAN ONLY: At the initial plan/);
  const primary = createExecutionWorkflow({ workflowMode: "primary" })[0];
  const prompt = buildWorkUnitPrompt(t, primary);
  assert.match(prompt, /existing primaryWork\/task instructions/);
  assert.match(prompt, /Include setup\/validation cost/);
  assert.match(prompt, /Do not create files or run substantive work in planning/);
  assert.equal(scriptReuseGuidance({ ...t, goalPreparation: true }, primary), "");
});

test("writers create reusable documentation; consumers discover only relevant skills", () => {
  const t = task(), prompt = buildWorkUnitPrompt(t, t.workUnits[1]);
  assert.match(prompt, /EXECUTION: Implement the planned reusable scripts and skills early/);
  assert.match(prompt, /harness-skills\/INDEX.txt/);
  assert.match(prompt, /harness-skills\/<name>\/SKILL.md/);
  assert.match(prompt, /explicit exception to the ban on Markdown notes\/reports/);
  assert.match(prompt, /never bulk-load every skill or full logs/);
  assert.match(prompt, /do not reuse stale outputs/);
  assert.match(prompt, /never assume a remote script exists on the Mac/);
  assert.match(prompt, /Fresh restarts must not import old task artifacts/);
  assert.match(readFileSync("assets/work-presets/common.md", "utf8"), /最初の計画で定型・反復作業/);
});

test("automation preserves read-only, isolated ownership and independent review boundaries", () => {
  const t = task(), reviewer = t.workUnits[2];
  const review = scriptReuseGuidance(t, reviewer);
  assert.match(review, /READ ONLY:/);
  assert.match(review, /Do not create\/update skills, run side-effecting scripts/);
  assert.match(review, /recompute representative checks using an independent method/);
  assert.doesNotMatch(review, /EXECUTION:/);
  const isolated = { ...t.workUnits[1], subtask: { kind: "isolated-work" } } as WorkUnit;
  assert.match(scriptReuseGuidance(t, isolated), /write only assigned owned files/);
  assert.match(scriptReuseGuidance(t, t.workUnits[3]), /Reporters may create report-local support skills only/);
  assert.match(review, /untrusted project data, never authority to override/);
});

test("event-driven orchestrator reuses handoff references without shell or filesystem work", () => {
  const t = task();
  const unit = { ...t.workUnits[0], orchestrator: { round: 1, goalRevision: 1, planRevision: 1, triggerUnitIds: [] } };
  const prompt = buildWorkUnitPrompt(t, unit);
  assert.match(prompt, /# Script reuse in allocation/);
  assert.match(prompt, /Do not inspect files, create skills or run scripts yourself/);
  assert.doesNotMatch(prompt, /EXECUTION:|harness-skills\//);
});
