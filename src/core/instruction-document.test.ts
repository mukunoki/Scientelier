import test from "node:test";
import assert from "node:assert/strict";
import { instructionDocument, instructionFilename } from "./instruction-document";
import { createStandardWorkflow } from "./orchestration";
import { readFileSync } from "node:fs";
import type { TaskRecord, ReportSettings } from "./types";

test("instruction document includes complete saved rules and separates drafts and applied versions", () => {
  const task: TaskRecord = {
    id: "instructions-test", title: "指示書の確認", prompt: "元の依頼", instruction: "今回の確定指示", cwd: "/tmp",
    strategy: "balanced", state: "queued", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, runs: [], output: "", createdAt: "", updatedAt: "saved-time",
    workUnits: createStandardWorkflow(),
    goal: { status: "approved", revision: 2, updatedAt: "", objective: "確定した目的", deliverables: ["成果物"], criteria: [{ id: "a", description: "必須条件", verification: "検証方法", required: true }], constraints: ["禁止事項"], outOfScope: ["対象外事項"], questions: [], unselected: { deliverables: ["UNSELECTED_SECRET_CANDIDATE"], criteria: [], constraints: [], outOfScope: [] } },
    pendingFollowup: { instruction: "未実行の相談", kind: "consult", assignments: {}, pauseAfterPlan: false },
    workPreset: { manifest: { id: "coding", name: "作業モード", description: "", version: 1, rules: "rules.md", goal: { deliverables: [], criteria: [], questions: [] } }, rules: readFileSync("assets/work-presets/coding/rules.md", "utf8") + "\n" + "省略しない文章".repeat(1000), commonRules: "保存された共通ルール", revision: "saved-preset", source: "user", capturedAt: "" }
  };
  task.runs.push({ id: "run", workUnitId: task.workUnits[1].id, role: "worker", agentId: "codex", providerKey: "openai", state: "completed", output: "", startedAt: "", finishingSkill: { revision: "old-writing", rules: "既存工程の執筆ルール", capturedAt: "old-time" } });
  task.workUnits[1].coordinationNotes = [{decisionId:"decision",note:"統括からの保存済み追加確認"}];
  const reports: ReportSettings = { texCommand: "latexmk", texArgs: ["-pdfdvi"], plotCommand: "python3", plotCheckArgs: ["--version"], outputDirectory: "/tmp/reports" };
  const before = JSON.stringify(task);
  const result = instructionDocument(task, reports, { revision: "new-writing", rules: "次回起動用の執筆ルール", capturedAt: "" }, "export-time");
  for (const value of [task.workPreset!.rules, "保存された共通ルール", "今回の確定指示", "禁止事項", "対象外事項", "old-writing", "既存工程の執筆ルール", "new-writing", "次回起動用の執筆ルール", "未実行の追加指示", "未実行の相談", "export-time"]) assert.ok(result.includes(value), value.slice(0, 80));
  assert.doesNotMatch(result, /UNSELECTED_SECRET_CANDIDATE/);
  assert.match(result, /統括からの保存済み追加確認/);
  assert.equal(JSON.stringify(task), before);
  assert.doesNotMatch(result,/Evidence-backed research cycle/);
  assert.match(instructionDocument({...task,researchCycle:1},reports,{revision:"new",rules:"rule",capturedAt:""}),/Evidence-backed research cycle/);
  task.goal!.status = "draft";
  assert.match(instructionDocument(task, reports, { revision: "new", rules: "rule", capturedAt: "" }), /未承認の下書き/);
  assert.equal(instructionFilename('../a/b:*?'), '_a_b___-指示書.txt');
});
