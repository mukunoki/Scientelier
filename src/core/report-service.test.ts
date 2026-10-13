import assert from "node:assert/strict";
import test from "node:test";
import { buildReportTex, ReportService } from "./report-service";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TaskRecord } from "./types";

test("report TeX escapes task fields and keeps raw CLI output outside the source", () => {
  const task: TaskRecord = {
    id: "task_1",
    title: "分析 & review",
    prompt: "100% 完了\n次の行",
    cwd: "/tmp/a_b",
    agentId: "codex",
    strategy: "balanced",
    allowedAgentIds: ["codex"],
    modelOverrides: {},
    workUnits: [],
    runs: [],
    state: "completed",
    output: "raw output with \\end{document}",
    usage: { inputTokens: 12, outputTokens: 4, source: "reported" },
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:01:00.000Z"
  };

  const tex = buildReportTex(task);
  assert.match(tex, /分析 \\& review/);
  assert.doesNotMatch(tex, /100|次の行/);
  assert.doesNotMatch(tex, /Scientelier|Agent Harness|タスクID|実行概要|依頼内容|ワークフロー|tokens|codex|task_1|a_b/);
  assert.doesNotMatch(tex, /\\author|\\affiliate/);
  assert.match(tex, /\\section\{はじめに\}/);
  assert.doesNotMatch(tex, /作業メモ/);
  assert.doesNotMatch(tex, /VerbatimInput|fvextra|logs\//);
  assert.doesNotMatch(tex, /raw output with/);
});

test("public installation uses per-user IPSJ styles and explains missing templates without changing shipped rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "scientelier-installed-template-"));
  try {
    const template = require("../../scripts/report-template-fixture.cjs").reportTemplateFixture(root);
    const task = { id: "task", title: "Test", runs: [] } as unknown as TaskRecord;
    const settings = { outputDirectory: join(root, "reports") } as import("./types").ReportSettings;
    const shipped = join(root, "absent-styles"), documents = join(process.cwd(), "assets/document-templates");
    await assert.rejects(new ReportService(shipped, documents).syncDraft(task, settings), /npm run templates:ipsj/);
    const report = await new ReportService(shipped, documents, template).syncDraft(task, settings);
    assert.match(await readFile(join(root, "reports/task/ipsj.cls"), "utf8"), /Synthetic test-only/);
    assert.match(await readFile(report.texPath!, "utf8"), /techrep/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
