import { open } from "node:fs/promises";
import type { TaskRecord } from "./types";

/** Resolve only reports belonging to this task; never accept a renderer-supplied path. */
export async function readReportPdf(task: TaskRecord | undefined, round?: number, document = "report"): Promise<Uint8Array> {
  if (!task) throw new Error("タスクが見つかりません。");
  if (round !== undefined && (!Number.isSafeInteger(round) || round < 1)) throw new Error("レポートの版が不正です。");
  if (!["report", "paper", "poster"].includes(document)) throw new Error("成果物の指定が不正です。");
  const bundle = round === undefined ? task.report : task.history?.find(item => item.number === round)?.report;
  const report = document === "report" ? bundle : bundle?.documents?.[document as "paper" | "poster"];
  if (report?.state !== "ready" || !report.pdfPath) throw new Error("表示できるPDFがありません。");
  const file = await open(report.pdfPath, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error("PDFは100MB以下のファイルにしてください。");
    const bytes = await file.readFile();
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("PDFファイルを読み込めません。");
    return new Uint8Array(bytes);
  } finally {
    await file.close();
  }
}
