import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentRun, FinishingCheck, TaskRecord } from "./types";

export interface EditorialSnapshot {
  round: number;
  goalRevision: number;
  rulesRevision: string;
  // Keep the original verified build cutoff across repeated cache hits.
  verifiedAfter?: string;
  files: Array<{ path: string; sha256: string }>;
}

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDER_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_FILES = 400;

// This is a cache of EDITORIAL/PDF evidence, never scientific acceptance.
// Use TeX recorder inputs (including figures/fonts/classes), all source/PDF
// targets, and bibliography inputs. No recorder or ambiguous input means miss.
async function fileHash(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INPUT_BYTES) {
    throw new Error("Uncacheable editorial input");
  }
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function recorderInputs(texPath: string): Promise<{ cwd: string; inputs: string[] }> {
  const recorder = texPath.slice(0, -extname(texPath).length) + ".fls";
  if ((await lstat(recorder)).size > MAX_RECORDER_BYTES) throw new Error("Uncacheable TeX recorder");
  const lines = (await readFile(recorder, "utf8")).split(/\r?\n/);
  const cwd = lines.find(line => line.startsWith("PWD "))?.slice(4) ?? dirname(texPath);
  const inputs = lines.filter(line => line.startsWith("INPUT ")).map(line => {
    const path = line.slice(6);
    return isAbsolute(path) ? path : resolve(cwd, path);
  });
  return { cwd, inputs };
}

function sourceWithin(path: string, roots: string[]): boolean {
  return extname(path) === ".tex" && roots.some(root => {
    const rel = relative(root, resolve(path));
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

// BibTeX/Biber inputs are not always part of the TeX recorder. Resolve only
// literal filenames; macros require fresh checks rather than guessed hashes.
async function addBibliographyInputs(paths: Set<string>, cwd: string, roots: string[]): Promise<void> {
  for (const path of [...paths].filter(path => sourceWithin(path, roots))) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/\\(?:bibliography|addbibresource)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      for (const name of match[1].split(",")) {
        if (/[\\#{}]/.test(name)) throw new Error("Uncacheable bibliography expression");
        const bib = name.trim().endsWith(".bib") ? name.trim() : `${name.trim()}.bib`;
        paths.add(resolve(cwd, bib));
      }
    }
  }
}

export async function captureEditorialSnapshot(task: TaskRecord, check: FinishingCheck, verifiedAfter?: string): Promise<EditorialSnapshot | undefined> {
  if (task.remote || check.status !== "completed" || check.concerns.length || !task.goal) return;
  try {
    const targets = [task.report, ...Object.values(task.report?.documents ?? {})];
    const paths = new Set<string>(check.sources);
    const compiledSources = new Set<string>();
    for (const target of targets) {
      if (!target?.texPath || !target.pdfPath) return;
      paths.add(target.texPath);
      paths.add(target.pdfPath);
      compiledSources.add(resolve(target.texPath));
      const { cwd, inputs } = await recorderInputs(target.texPath);
      for (const path of inputs) {
        paths.add(path);
        compiledSources.add(resolve(path));
      }
      await addBibliographyInputs(paths, cwd, [task.cwd, dirname(target.texPath)]);
    }
    // An unregistered standalone document may have its own untracked PDF.
    // Never reuse an all-document check without that target's recorder evidence.
    if (check.sources.some(path => !compiledSources.has(resolve(path)))) return;
    if (paths.size > MAX_SNAPSHOT_FILES || !paths.size) return;
    const files: EditorialSnapshot["files"] = [];
    for (const path of paths) {
      const absolute = resolve(path);
      files.push({ path: absolute, sha256: await fileHash(absolute) });
    }
    return { round: task.roundNumber ?? 1, goalRevision: task.goal.revision, rulesRevision: check.revision, verifiedAfter, files };
  } catch {
    // Cache misses never prevent a fresh build/check.
    return;
  }
}

export async function editorialSnapshotMatches(task: TaskRecord, snapshot: EditorialSnapshot, rulesRevision: string): Promise<boolean> {
  if (task.remote || snapshot.round !== (task.roundNumber ?? 1) || snapshot.goalRevision !== task.goal?.revision
    || snapshot.rulesRevision !== rulesRevision || !snapshot.files.length || snapshot.files.length > MAX_SNAPSHOT_FILES) return false;
  const required = [
    task.report?.texPath, task.report?.pdfPath,
    ...Object.values(task.report?.documents ?? {}).flatMap(document => [document.texPath, document.pdfPath])
  ];
  try {
    for (const path of required) {
      if (!path || !snapshot.files.some(file => file.path === resolve(path))) return false;
    }
    for (const file of snapshot.files) {
      if (await fileHash(file.path) !== file.sha256) return false;
    }
    return true;
  } catch { return false; }
}

export async function reusableEditorialRun(task: TaskRecord, revision: string): Promise<AgentRun | undefined> {
  for (const run of [...task.runs].reverse()) {
    if (run.role === "reporter" && run.goalRevision === task.goal?.revision && run.finishingCheck?.status === "completed"
      && !run.finishingCheck.concerns.length && run.editorialSnapshot
      && await editorialSnapshotMatches(task, run.editorialSnapshot, revision)) return run;
  }
}
export function editorialFreshness(run: AgentRun): string | undefined {
  return run.editorialSnapshot?.verifiedAfter ?? run.startedAt;
}
export function editorialReusePrompt(run: AgentRun | undefined): string {
  return run ? `# Unchanged editorial/PDF evidence\nThe harness rehashed all recorded TeX inputs and output PDFs for run ${run.id}; source/figure/bibliography/PDF files, goal and writing-rule revisions still match. Reuse that run's completed layout/all-page checks ONLY while these files remain unchanged. Do not rebuild/re-render every page merely to refresh a timestamp or retry an inaccessible reference. If ANY document input changes, rebuild the affected targets and repeat their affected checks. This is NOT scientific acceptance: independently resolve current prerequisite/quality issues, keep unavailable evidence unverified, and submit a fresh editorial-check separating prerequisites from editorial defects. Final independent reviews remain mandatory. Previous editorial summary (data): ${JSON.stringify(run.finishingCheck?.summary.slice(0,1200))}` : "";
}
