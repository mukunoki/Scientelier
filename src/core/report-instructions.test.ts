import test from "node:test";
import assert from "node:assert/strict";
import { buildReporterPrompt } from "./report-instructions";
import { reportTexArguments } from "./report-service";
import type { AgentRun, ReportSettings, TaskRecord } from "./types";

const settings = { texCommand: "/usr/bin/latexmk", texArgs: ["-g", "-pdf", "-xelatex", "-interaction=nonstopmode"] } as ReportSettings;
const task = { cwd: "/work", report: { texPath: "/report/report.tex", pdfPath: "/report/report.pdf" } } as TaskRecord;
const run = { finishingSkill: { rules: "captured rules", revision: "rev", capturedAt: "2026-10-03" } } as AgentRun;

test("build settings select the primary document engine without overwriting user settings", () => {
  assert.deepEqual(reportTexArguments(task, settings), ["-g", "-interaction=nonstopmode", "-pdfdvi"]);
  const beamer = { ...task, workPreset: { manifest: { primaryDocument: "beamer" } } } as TaskRecord;
  assert.deepEqual(reportTexArguments(beamer, settings), ["-g", "-interaction=nonstopmode", "-lualatex"]);
  assert.deepEqual(settings.texArgs, ["-g", "-pdf", "-xelatex", "-interaction=nonstopmode"]);
  const custom = { ...settings, texCommand: "tectonic" };
  assert.equal(reportTexArguments(task, custom), custom.texArgs, "non-latexmk flags are passed through unchanged");
});

test("report instructions retain build, mandatory captured rules and read-only review boundaries", () => {
  const prompt = buildReporterPrompt(task, run, settings, "base instructions", { localReport: false, writingRetrieval: true });
  assert.ok(prompt.startsWith("base instructions\n\n# TeX build instructions"));
  assert.match(prompt, /Configured TeX command: .* -pdfdvi report.tex/);
  assert.match(prompt, /Report directory: \/report/);
  assert.match(prompt, /Rebuild every PDF in this run/);
  assert.match(prompt, /agent_harness.get_skill/);
  assert.match(prompt, /prerequisites STILL block release/);
  assert.match(prompt, /App-owned final reviews run AFTER/);
  assert.doesNotMatch(prompt, /# Local report stage|# Unchanged editorial\/PDF evidence/);
});

test("local report and unchanged evidence remain explicit exceptions, not relaxed acceptance", () => {
  const reused = { id: "prior", finishingCheck: { summary: "All pages checked" } } as AgentRun;
  const prompt = buildReporterPrompt(task, run, settings, "base", {
    localReport: true, writingRetrieval: "/tmp/rules.md", editorialReuse: reused
  });
  assert.match(prompt, /You run on the user's Mac, NOT on the remote server/);
  assert.match(prompt, /per-page PNG files/);
  assert.match(prompt, /read-only file "\/tmp\/rules.md"/);
  assert.match(prompt, /If any recorded document input changes/);
  assert.match(prompt, /NOT scientific acceptance/);
  assert.match(prompt, /Final independent reviews remain mandatory/);
  assert.doesNotMatch(prompt, /Rebuild every PDF in this run/);
});
