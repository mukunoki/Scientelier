import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readReportPdf } from "./report-preview";
import type { TaskRecord } from "./types";

test("PDF preview resolves only a task's current or exact historical report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-preview-"));
  try {
    const current = join(directory, "current.pdf"), previous = join(directory, "previous.pdf");
    await writeFile(current, "%PDF-1.7 current");
    await writeFile(previous, "%PDF-1.7 previous");
    const task = {
      report: { state: "ready", pdfPath: current },
      history: [{ number: 1, report: { state: "ready", pdfPath: previous } }]
    } as TaskRecord;
    assert.equal(Buffer.from(await readReportPdf(task)).toString(), "%PDF-1.7 current");
    assert.equal(Buffer.from(await readReportPdf(task, 1)).toString(), "%PDF-1.7 previous");
    await assert.rejects(readReportPdf(undefined));
    for (const round of [0, -1, 1.5, NaN, 2]) await assert.rejects(readReportPdf(task, round));
    await assert.rejects(readReportPdf({ ...task, report: { state: "failed", pdfPath: current } }));
    await writeFile(current, "not a PDF");
    await assert.rejects(readReportPdf(task), /PDFファイル/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
