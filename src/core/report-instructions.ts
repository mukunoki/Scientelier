import { basename, dirname } from "node:path";
import { editorialReusePrompt } from "./editorial-reuse";
import { finishingPrompt } from "./finishing-skill";
import { reportTexArguments } from "./report-service";
import type { AgentRun, ReportSettings, TaskRecord } from "./types";

interface ReporterPromptOptions {
  localReport: boolean;
  writingRetrieval: string | boolean;
  editorialReuse?: AgentRun;
}

/** Compose report-specific instructions without touching files or run state.
 * Cache evidence changes only rebuild requirements, never scientific review. */
export function buildReporterPrompt(
  task: TaskRecord,
  run: AgentRun,
  reportSettings: ReportSettings,
  basePrompt: string,
  { localReport, writingRetrieval, editorialReuse }: ReporterPromptOptions
): string {
  const reportTexArgs = reportTexArguments(task, reportSettings);
  return [
    basePrompt,
    ...(localReport ? ["# Local report stage for remote work\nYou run on the user's Mac, NOT on the remote server. Earlier development and computation are complete on the remote workspace. The harness downloaded the report directory (TeX, figures, bibliography and packaged results) after remote work. Use those local files and handoffs as inputs; preserve partial local edits from previous reporter attempts. Do not SSH, rerun computations, edit remote code or install software. Missing source assets must be reported specifically, never fabricated. Convert remote absolute TeX references to verified local relative paths. The configured commands below are LOCAL tools. Finish writing, apply the finishing skill, build all PDFs and visually inspect every page locally. The harness will publish these exact report files to the remote reviewers; do not upload them yourself."] : []),
    ...(localReport ? ["Render the final PDFs to per-page PNG files under a preview/ subdirectory inside the report directory, using installed local tools. Inspect all pages and keep those final renderings for remote reviewers, whose machines may not have TeX or PDF rendering tools. Re-render after every final prose or figure correction."] : []),
    "# TeX build instructions",
    ...(task.workPreset?.manifest.primaryDocument === "paper" ? ["The primary report.tex/report.pdf IS the research manuscript. Do not create an additional paper/main.tex or a separate operational report. Use the approved venue/template and the bundled IPSJ files when applicable. Preserve background/introduction, method, substantive results/discussion and conclusion; a build/checklist diary is not manuscript content. Missing or invalid scientific evidence returns to the primary owner instead of being disguised as a method's negative result."] : []),
    ...(task.workPreset?.manifest.primaryDocument === "beamer" ? ["The primary report.tex is a Beamer lesson, not IPSJ. Build with LuaLaTeX (latexmk -lualatex report.tex or an installed equivalent). Do not apply platex/pdfdvi settings. The selected primary format supersedes legacy IPSJ-only defaults. Do not produce a second report. Use the captured lesson skills for teaching structure; presentation time/compression rules do not apply."] : []),
    "Build TeX/PDF in the task's execution environment: remote tasks build on their registered remote system; local tasks build on this Mac. Do not move compilation to a different host or open an independent SSH connection. Use the system's configured TeX command, available module/user environment and site rules. If latexmk alone is missing, an equivalent installed TeX engine sequence is allowed. Never install software without authorization. If no suitable engine is available, state the missing executable and preserve sources; do not claim the PDF was built.",
    `Report source: ${task.report?.texPath ?? "report.tex"}`,
    `Report directory: ${task.report?.texPath ? dirname(task.report.texPath) : task.cwd}`,
    `Configured TeX command: ${[reportSettings.texCommand, ...reportTexArgs, "report.tex"].join(" ")}`,
    "# Additional document build targets",
    JSON.stringify(task.report?.documents ?? {}),
    `For EVERY additional target requiring a build, work in its source directory and build main.tex with ${JSON.stringify(basename(reportSettings.texCommand).toLowerCase().includes("latexmk") ? reportSettings.texCommand : "latexmk")} -g -lualatex -interaction=nonstopmode -halt-on-error main.tex (or an equivalent installed LuaLaTeX command). Its local .latexmkrc is independent of the IPSJ settings. ${editorialReuse ? "Only the harness-confirmed unchanged PDFs and editorial checks below may be reused; rebuild and check affected targets if any input changes." : "Rebuild every PDF in this run; do not reuse an old PDF."} Repair local TeX errors yourself and render/inspect all required pages, actual page dimensions, clipping, references and draft placeholders. Honor the approved format; do not change the system-wide report settings or install software without authorization. If a necessary tool is missing, report the concrete blocker and preserve sources for resumption.`,
    `${editorialReuse ? "If any recorded document input changes, " : ""}Run the configured command in the report directory. Read the .log and latexmk output when it fails, fix the source or local support files, and rerun it. Continue until report.pdf exists and begins with the %PDF- signature. Summarize each diagnosis and fix in your final handoff.`,
    finishingPrompt(task, run.finishingSkill!, writingRetrieval),
    editorialReusePrompt(editorialReuse)
    ].join("\n\n");
}
