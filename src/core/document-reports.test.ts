import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkPresetStore } from "./work-presets";
import { JsonTaskStore } from "./task-store";
import { ReportService, reportsReady, reportFailure } from "./report-service";
import { readReportPdf } from "./report-preview";
import type { ReportSettings } from "./types";
const { reportTemplateFixture } = require("../../scripts/report-template-fixture.cjs");

test("new paper and integrated research have exactly one manuscript and PDF", async () => {
  const directory=await mkdtemp(join(tmpdir(),"harness-single-paper-"));
  try {
    const presets=new WorkPresetStore(join(process.cwd(),"assets/work-presets"),join(directory,"presets"));
    const store=new JsonTaskStore(join(directory,"tasks.json"));await store.init();
    const service=new ReportService(reportTemplateFixture(directory));
    const settings:ReportSettings={outputDirectory:directory,texCommand:"unused",texArgs:[],plotCommand:"unused",plotCheckArgs:[]};
    for(const id of ["paper","research-project"]) {
      const preset=await presets.capture(id);
      const task=await store.create({title:id,prompt:"論文を作る",cwd:directory,goalMode:"manual",strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{}},preset);
      assert.equal(task.workPreset!.manifest.primaryDocument,"paper");
      assert.equal(task.workPreset!.documentTemplate,undefined);
      task.report=await service.syncDraft(task,settings);
      assert.equal(task.report.documents,undefined);
      const source=await readFile(task.report.texPath!,"utf8");
      assert.match(source,/techrep/);
      await writeFile(task.report.pdfPath!,"%PDF-1.7 manuscript");
      task.report=await service.verifyPdf(task,settings);
      assert.equal(reportsReady(task.report),true);
      assert.match(Buffer.from(await readReportPdf(task)).toString(),/manuscript/);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("captured paper/poster templates survive direct rule edits, draft updates, verification, history and previews", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-documents-"));
  try {
    const presets = new WorkPresetStore(join(process.cwd(), "assets/work-presets"), join(directory, "presets"));
    const store = new JsonTaskStore(join(directory, "tasks.json")); await store.init();
    const service = new ReportService(reportTemplateFixture(directory));
    const settings: ReportSettings = { outputDirectory: directory, texCommand: "unused", texArgs: [], plotCommand: "unused", plotCheckArgs: [] };
    for (const id of ["paper", "poster"] as const) {
      const original = await presets.capture(id);
      const copy = await presets.saveRules(id, original.revision, original.rules + "\n直接編集したルール");
      assert.deepEqual(copy.documentTemplate, original.documentTemplate);
      // Explicit legacy snapshot: new paper defaults are single-document, but
      // old dual-document goals/artifacts must remain fully supported.
      if (id === "paper") {
        const legacy = { id, source: await readFile(join(process.cwd(),"assets/document-templates/paper/main.tex"),"utf8"), latexmkrc: await readFile(join(process.cwd(),"assets/document-templates/latexmkrc"),"utf8") };
        original.documentTemplate = structuredClone(legacy); copy.documentTemplate = structuredClone(legacy);
        delete original.manifest.primaryDocument; delete copy.manifest.primaryDocument;
        original.manifest.document = "paper"; copy.manifest.document = "paper";
      }
      let task = await store.create({ title: id, prompt: "Fixture", cwd: directory, goalMode: "manual", strategy: "balanced", allowedAgentIds: ["codex"], modelOverrides: {} }, copy);
      copy.documentTemplate!.source = "caller mutation";
      assert.notEqual(task.workPreset!.documentTemplate!.source, copy.documentTemplate!.source);
      task.report = await service.syncDraft(task, settings);
      let document = task.report.documents![id]!;
      assert.equal(await readFile(document.texPath!, "utf8"), original.documentTemplate!.source);
      await writeFile(document.texPath!, "User/agent authored source");
      task.report = await service.syncDraft(task, settings, true);
      assert.equal(await readFile(document.texPath!, "utf8"), "User/agent authored source");
      await writeFile(task.report.pdfPath!, "%PDF-1.7 standard");
      task.report = await service.verifyPdf(task, settings);
      assert.equal(task.report.state, "ready"); assert.equal(reportsReady(task.report), false);
      assert.match(reportFailure(task.report)!, new RegExp(id === "paper" ? "論文" : "ポスター"));
      assert.doesNotMatch(reportFailure(task.report)!, /ENOENT/);
      await writeFile(document.pdfPath!.replace(/\.pdf$/, ".log"), "compiler output\n! LaTeX Error: File `xkeyval.sty' not found.\nprivate unrelated content");
      task.report = await service.verifyPdf(task, settings);
      assert.match(task.report.documents![id]!.error!, /xkeyval\.sty/);
      assert.doesNotMatch(task.report.documents![id]!.error!, /private unrelated content/);
      await writeFile(document.pdfPath!, "%PDF-1.7 additional original");
      await utimes(document.pdfPath!, new Date(0), new Date(0));
      task.report = await service.verifyPdf(task, settings, new Date(Date.now() - 10000).toISOString());
      assert.equal(reportsReady(task.report), false); assert.match(task.report.documents![id]!.error!, /previous PDF/);
      await writeFile(document.pdfPath!, "%PDF-1.7 additional original");
      task.report = await service.verifyPdf(task, settings);
      assert.equal(reportsReady(task.report), true);
      const saved = await service.snapshotVersion(task);
      task.history = [{ number: 1, kind: "initial", instruction: "Fixture", state: "completed", workUnits: [], report: saved, finishedAt: new Date().toISOString() }];
      await writeFile(document.pdfPath!, "%PDF-1.7 additional changed");
      assert.match(Buffer.from(await readReportPdf(task, undefined, id)).toString(), /changed/);
      assert.match(Buffer.from(await readReportPdf(task, 1, id)).toString(), /original/);
      assert.match(Buffer.from(await readReportPdf(task, 1)).toString(), /standard/);
      await assert.rejects(readReportPdf(task, undefined, "../../outside"));
      await assert.rejects(readReportPdf(task, 2, id));
      await assert.rejects(readReportPdf(task, undefined, id === "paper" ? "poster" : "paper"));
      task = await store.update(task.id, { report: task.report, history: task.history });
      const restarted = new JsonTaskStore(join(directory, "tasks.json")); await restarted.init();
      assert.deepEqual(restarted.get(task.id)!.workPreset!.documentTemplate, original.documentTemplate);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
