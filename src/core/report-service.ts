import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { copyReportFiles } from "./report-files";
import type {
  AgentRun,
  ReportEnvironmentStatus,
  ReportRecord,
  ReportSettings,
  RunEventType,
  TaskRecord,
  ToolCheck
} from "./types";

interface CommandResult {
  exitCode: number | null;
  output: string;
}

export function reportsReady(report?: ReportRecord): boolean {
  return report?.state === "ready" && Object.values(report.documents ?? {}).every(document => document?.state === "ready");
}
export function reportFailure(report: ReportRecord): string | undefined {
  const failed = Object.entries(report.documents ?? {}).find(([, document]) => document?.state !== "ready");
  const label = failed?.[0] === "paper" ? "論文" : failed?.[0] === "poster" ? "ポスター" : failed?.[0];
  return report.error ?? (failed ? `${label}: ${failed[1]?.error ?? "PDFが未生成です。"}` : undefined);
}

/** Surface a bounded TeX diagnostic, not an ENOENT path to the local mirror.
 * Never follow a log symlink or read an unbounded file into an error banner. */
async function missingPdfReason(texPath: string, pdfPath: string, error: unknown): Promise<string> {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") return error instanceof Error ? error.message : String(error);
  if ((error as NodeJS.ErrnoException).path === texPath) return "TeXソースがありません。執筆工程で本文を作成してください。";
  const log = pdfPath.replace(/\.pdf$/i, ".log");
  if (log !== pdfPath) try {
    const info = await lstat(log);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024) {
      const failure = (await readFile(log, "utf8")).split(/\r?\n/).find(line => /^!\s/.test(line));
      if (failure) return `PDFが未生成です。TeX: ${failure.slice(0, 300)}`;
    }
  } catch { /* Missing/inaccessible logs do not replace the original failure. */ }
  return "PDFが未生成です。本文の執筆とTeXビルドを完了してください。";
}

/** Keep the agent's build instructions and the direct build path in sync.
 * A non-latexmk command retains the user's exact engine arguments. */
export function reportTexArguments(task: TaskRecord, settings: ReportSettings): string[] {
  if (!basename(settings.texCommand).toLowerCase().startsWith("latexmk")) return settings.texArgs;
  const engine = task.workPreset?.manifest.primaryDocument === "beamer" ? "-lualatex" : "-pdfdvi";
  return [...settings.texArgs.filter(arg => !["-lualatex", "-xelatex", "-pdf", "-pdfdvi"].includes(arg)), engine];
}

const PRESET_FILES: Array<[string, string]> = [
  ["ipsj.cls", "ipsj.cls"],
  ["ipsjtech.sty", "ipsjtech.sty"],
  ["ipsjpref.sty", "ipsjpref.sty"],
  ["ipsjsort.bst", "ipsjsort.bst"],
  ["ipsjunsrt.bst", "ipsjunsrt.bst"],
  ["ipsjsort-e.bst", "ipsjsort-e.bst"],
  ["ipsjunsrt-e.bst", "ipsjunsrt-e.bst"],
  ["bibsample.bib", "bibsample.bib"],
  ["tech-jsample.tex", "ipsj-tech-jsample.tex"]
];

function runCommand(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 120_000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      }
    }, timeoutMs);

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 80_000) output = output.slice(-80_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ exitCode, output });
    });
  });
}

function texEscape(value: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "&": "\\&",
    "#": "\\#",
    "%": "\\%",
    "_": "\\_",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}"
  };
  return Array.from(value)
    .map((character) => replacements[character] ?? character)
    .join("")
    .replace(/\r?\n/g, "\\par\n");
}


function logFileName(run: Pick<AgentRun, "id" | "agentId">): string {
  const safeId = run.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${run.agentId}-${safeId}.log`;
}

export function buildReportTex(task: TaskRecord): string {
  return `\\documentclass[submit,techrep,noauthor]{ipsj}
\\usepackage[dvipdfmx]{graphicx}
\\usepackage{booktabs}
\\usepackage{tabularx}
\\usepackage[hidelinks]{hyperref}

\\title{${texEscape(task.title)}}

\\begin{abstract}
% 主題・方法・主要な結果を簡潔にまとめる。依頼文や運用情報は転載しない。
\\end{abstract}

\\begin{document}
\\maketitle

\\section{はじめに}
% 主題の背景・目的・対象範囲を記述する。

\\section{方法と結果}
% 主題に関係する分析、根拠、図表、検証結果を記述する。

\\section{考察}
% 結果の解釈と主題に関係する限界・未解決点を記述する。

\\section{まとめ}
% 主題について得られた結論を記述する。

\\end{document}
`;
}

async function checkTool(command: string, args: string[]): Promise<ToolCheck> {
  try {
    const result = await runCommand(command, args, undefined, 10_000);
    const firstLine = result.output.trim().split(/\r?\n/).find(Boolean) ?? "Command completed.";
    return {
      ok: result.exitCode === 0,
      command: [command, ...args].join(" "),
      detail: result.exitCode === 0 ? firstLine : `Exited with code ${result.exitCode ?? "unknown"}: ${firstLine}`
    };
  } catch (error) {
    return {
      ok: false,
      command: [command, ...args].join(" "),
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkReportEnvironment(
  settings: ReportSettings
): Promise<ReportEnvironmentStatus> {
  const [tex, plot] = await Promise.all([
    checkTool(settings.texCommand, ["-v"]),
    checkTool(settings.plotCommand, settings.plotCheckArgs)
  ]);
  return { tex, plot, checkedAt: new Date().toISOString() };
}

export class ReportService {
  async snapshotVersion(task: TaskRecord, archiveDirectory?: string): Promise<ReportRecord | undefined> {
    if (!task.report?.texPath) return undefined;
    const root = dirname(task.report.texPath);
    const directory = archiveDirectory ?? join(task.report.storageLayout === "isolated" ? dirname(root) : root, "versions", `round-${task.roundNumber ?? 1}-${randomUUID()}`);
    await mkdir(directory, { recursive: true });
    const saved: ReportRecord = { ...task.report, storageLayout: undefined, texPath: undefined, pdfPath: undefined, previewUrl: undefined };
    const copy = async (source: string | undefined, name: string): Promise<string | undefined> => {
      if (!source) return undefined;
      const target = join(directory, name);
      try { await copyFile(source, target); return target; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    };
    saved.texPath = await copy(task.report.texPath, "report.tex");
    if (task.report.state === "ready") saved.pdfPath = await copy(task.report.pdfPath, "report.pdf");
    if (saved.pdfPath) saved.previewUrl = pathToFileURL(saved.pdfPath).toString();
    else saved.state = "draft";
    if (task.report.documents) {
      saved.documents = {};
      for (const id of ["paper", "poster"] as const) {
        const document = task.report.documents[id];
        if (document) saved.documents[id] = await this.snapshotVersion({ ...task, report: { ...document, documents: undefined } }, join(directory, id));
      }
    }
    return saved;
  }
  constructor(
    private readonly templateDirectory = join(process.cwd(), "assets", "ipsj-tech-report", "runtime"),
    private readonly documentTemplates = join(templateDirectory, "..", "..", "document-templates"),
    private readonly installedIpsj?: string
  ) {}

  private reportDirectory(taskId: string, settings: ReportSettings): string {
    return join(settings.outputDirectory, taskId);
  }

  runLogPath(taskId: string, run: Pick<AgentRun, "id" | "agentId">, settings: ReportSettings): string {
    return join(this.reportDirectory(taskId, settings), "logs", logFileName(run));
  }

  private async copyPreset(reportDirectory: string, preserveSource = false): Promise<void> {
    for (const [sourceName, targetName] of PRESET_FILES) {
      const target = join(reportDirectory, targetName);
      try {
        await access(target);
      } catch {
        // Public distributions acquire IPSJ files per user, outside the source
        // tree. Private development checkouts retain their existing presets.
        let source = join(this.templateDirectory, sourceName);
        try { await access(source); }
        catch {
          if (!this.installedIpsj) throw new Error("IPSJテンプレートがありません。インストール手順の npm run templates:ipsj を実行してください。");
          source = join(this.installedIpsj, sourceName);
          try { await access(source); }
          catch { throw new Error("IPSJテンプレートがありません。インストール手順の npm run templates:ipsj を実行してください。"); }
        }
        await copyFile(source, target);
      }
    }
    const latexmkrc = join(reportDirectory, ".latexmkrc");
    if (!preserveSource) {
      await writeFile(latexmkrc, [
        "$latex = 'platex -kanji=utf8 %O %S';",
        "$dvipdf = 'dvipdfmx %O -o %D %S';",
        "$pdf_mode = 3;",
        ""
      ].join("\n"), "utf8");
    } else {
      try {
        await access(latexmkrc);
      } catch {
        await writeFile(latexmkrc, [
          "$latex = 'platex -kanji=utf8 %O %S';",
          "$dvipdf = 'dvipdfmx %O -o %D %S';",
          "$pdf_mode = 3;",
          ""
        ].join("\n"), "utf8");
      }
    }
  }

  private async clearTeXBuildArtifacts(reportDirectory: string): Promise<void> {
    await Promise.all([
      "report.aux",
      "report.dvi",
      "report.fdb_latexmk",
      "report.fls",
      "report.log",
      "report.out",
      "report.toc",
      "report.xdv"
    ].map((file) => rm(join(reportDirectory, file), { force: true })));
  }

  private async ensureHistoricalLogs(task: TaskRecord, reportDirectory: string): Promise<void> {
    const logDirectory = join(reportDirectory, "logs");
    await mkdir(logDirectory, { recursive: true });
    for (const run of task.runs) {
      if (run.state === "running") continue;
      const path = join(logDirectory, logFileName(run));
      try {
        await access(path);
      } catch {
        await writeFile(path, run.output || "No CLI output was captured.\n", "utf8");
      }
    }
  }

  async syncDraft(
    task: TaskRecord,
    settings: ReportSettings,
    preserveSource = false
  ): Promise<ReportRecord> {
    const managementDirectory = this.reportDirectory(task.id, settings);
    await mkdir(managementDirectory, { recursive: true });
    if (task.remote && task.report?.storageLayout !== "isolated") {
      // Keep old files/logs intact. Remote evidence named logs/ or versions/
      // is downloaded into this exclusive artifact directory, never over them.
      const destination = join(managementDirectory, `artifacts-${randomUUID()}`);
      const copied = await copyReportFiles(task.report, destination, true);
      if (!copied) await mkdir(destination);
      task = { ...task, report: { ...copied, state: copied?.state ?? "draft", storageLayout: "isolated",
        texPath: join(destination, "report.tex"), pdfPath: join(destination, "report.pdf") } };
    }
    const reportDirectory = task.report?.storageLayout === "isolated" && task.report.texPath
      ? dirname(task.report.texPath) : managementDirectory;
    const texPath = join(reportDirectory, "report.tex");
    const pdfPath = join(reportDirectory, "report.pdf");
    await mkdir(reportDirectory, { recursive: true });
    const beamer = task.workPreset?.manifest.primaryDocument === "beamer";
    if (beamer) {
      try { await writeFile(join(reportDirectory, ".latexmkrc"), "$pdf_mode = 4;\n", { flag: "wx" }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      try { await copyFile(join(this.documentTemplates, "beamer", "check-lesson.cjs"), join(reportDirectory, "check-lesson.cjs"), constants.COPYFILE_EXCL); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    } else await this.copyPreset(reportDirectory, preserveSource);
    await this.ensureHistoricalLogs(task, managementDirectory);
    const source = beamer ? await readFile(join(this.documentTemplates, "beamer", "main.tex"), "utf8") : buildReportTex(task);
    if (!preserveSource) {
      await writeFile(texPath, source, "utf8");
    } else {
      try {
        await access(texPath);
      } catch {
        await writeFile(texPath, source, "utf8");
      }
    }
    const state = task.report?.state ?? "draft";
    const template = task.workPreset?.documentTemplate;
    let documents = task.report?.documents;
    if (template) {
      const directory = join(reportDirectory, template.id);
      await mkdir(directory, { recursive: true });
      if (await realpath(directory) !== join(await realpath(reportDirectory), template.id)) throw new Error("Document directory must not be a symbolic link.");
      // Exclusive creation preserves agent edits and never follows an existing file symlink.
      for (const [name, contents] of [["main.tex", template.source], [".latexmkrc", template.latexmkrc]]) {
        try { await writeFile(join(directory, name), contents, { encoding: "utf8", flag: "wx" }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      documents = { ...documents, [template.id]: documents?.[template.id] ?? {
        state: "draft", texPath: join(directory, "main.tex"), pdfPath: join(directory, "main.pdf")
      } };
    }
    return {
      ...task.report,
      documents,
      state,
      texPath,
      pdfPath,
      previewUrl: state === "ready" ? pathToFileURL(pdfPath).toString() : task.report?.previewUrl
    };
  }

  async initializeRunLog(
    taskId: string,
    run: Pick<AgentRun, "id" | "agentId" | "role" | "model" | "startedAt">,
    settings: ReportSettings
  ): Promise<string> {
    const reportDirectory = this.reportDirectory(taskId, settings);
    const logDirectory = join(reportDirectory, "logs");
    await mkdir(logDirectory, { recursive: true });
    const path = this.runLogPath(taskId, run, settings);
    const header = [
      `Agent: ${run.agentId}`,
      `Role: ${run.role}`,
      `Model: ${run.model ?? "CLI default"}`,
      `Started: ${run.startedAt}`,
      ""
    ].join("\n");
    await writeFile(path, header, "utf8");
    await appendFile(join(reportDirectory, "all-agents.log"), `\n===== ${run.agentId} · ${run.role} · ${run.id} =====\n${header}`, "utf8");
    return path;
  }

  async appendRunLog(
    taskId: string,
    logPath: string,
    type: RunEventType,
    text: string,
    at: string,
    settings: ReportSettings
  ): Promise<void> {
    const prefix = type === "stdout" ? "" : `[${at}] [${type}] `;
    const value = `${prefix}${text}${text.endsWith("\n") ? "" : "\n"}`;
    await Promise.all([
      appendFile(logPath, value, "utf8"),
      appendFile(join(this.reportDirectory(taskId, settings), "all-agents.log"), value, "utf8")
    ]);
  }

  async generate(task: TaskRecord, settings: ReportSettings): Promise<ReportRecord> {
    const draft = await this.syncDraft(task, settings);
    const reportDirectory = dirname(draft.texPath!);
    await this.clearTeXBuildArtifacts(reportDirectory);
    const texArgs = reportTexArguments(task, settings);
    const result = await runCommand(
      settings.texCommand,
      [...texArgs, "report.tex"],
      reportDirectory
    );
    if (result.exitCode !== 0) {
      throw new Error(`TeX build failed with code ${result.exitCode ?? "unknown"}.\n${result.output.slice(-4000)}`);
    }
    await access(draft.pdfPath!);
    const header = (await readFile(draft.pdfPath!)).subarray(0, 5).toString("ascii");
    if (header !== "%PDF-") throw new Error("TeX command did not create a valid PDF file.");

    return {
      ...draft,
      state: "ready",
      texPath: draft.texPath,
      pdfPath: draft.pdfPath,
      previewUrl: pathToFileURL(draft.pdfPath!).toString(),
      builtAt: new Date().toISOString()
    };
  }

  /**
   * Verify the artifact produced by the report-building agent without
   * rewriting report.tex. This is intentionally separate from syncDraft so
   * an agent's TeX fixes survive the final verification pass.
   */
  async verifyPdf(
    task: TaskRecord,
    settings: ReportSettings,
    notBefore?: string
  ): Promise<ReportRecord> {
    const reportDirectory = this.reportDirectory(task.id, settings);
    const texPath = task.report?.texPath ?? join(reportDirectory, "report.tex");
    const pdfPath = task.report?.pdfPath ?? join(reportDirectory, "report.pdf");
    const documents: ReportRecord["documents"] = task.report?.documents ? {} : undefined;
    for (const id of ["paper", "poster"] as const) {
      const document = task.report?.documents?.[id];
      if (document && documents) documents[id] = await this.verifyPdf({ ...task, report: { ...document, documents: undefined } }, settings, notBefore);
    }
    try {
      await access(texPath);
      await access(pdfPath);
      const info = await stat(pdfPath);
      if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error("PDF must be a file no larger than 100MB.");
      if (notBefore) {
        const builtAt = Date.parse(notBefore);
        const pdfStat = await stat(pdfPath);
        if (Number.isFinite(builtAt) && pdfStat.mtimeMs < builtAt) {
          throw new Error("The report agent did not replace the previous PDF.");
        }
      }
      const header = (await readFile(pdfPath)).subarray(0, 5).toString("ascii");
      if (header !== "%PDF-") throw new Error("The report agent produced an invalid PDF file.");
      return {
        documents,
        state: "ready",
        remoteSnapshotId: task.report?.remoteSnapshotId,
        storageLayout: task.report?.storageLayout,
        texPath,
        pdfPath,
        previewUrl: pathToFileURL(pdfPath).toString(),
        builtAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        documents,
        state: "failed",
        remoteSnapshotId: task.report?.remoteSnapshotId,
        storageLayout: task.report?.storageLayout,
        texPath,
        pdfPath,
        previewUrl: task.report?.previewUrl,
        error: await missingPdfReason(texPath, pdfPath, error)
      };
    }
  }
}
