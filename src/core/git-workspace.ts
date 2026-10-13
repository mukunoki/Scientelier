import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { homedir } from "node:os";

const exec = promisify(execFile);

/** Establish version control without staging files, rewriting history or changing
 * user identity. Shared with the SSH bridge, so no additional SSH login is used. */
export async function ensureGitWorkspace(directory: string): Promise<{ root: string; initialized: boolean }> {
  const cwd = await realpath(directory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  const git = async (args: string[]) => (await exec("git", ["-C", cwd, ...args], { env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
  let initialized = false;
  try {
    try {
      const inside = await git(["rev-parse", "--is-inside-work-tree"]);
      if (inside !== "true") throw new Error("通常の作業ツリーではありません（bareリポジトリ等）。");
    } catch (error) {
      // Missing Git, permission errors, or an existing broken/foreign repository
      // must never be treated as an invitation to create a nested repository.
      if ((error as { code?: unknown }).code !== 128) throw error;
      for (let path = cwd; ; path = dirname(path)) {
        try { await lstat(join(path, ".git")); throw new Error("既存の.gitを利用できません。所有者・権限・worktree設定を確認してください。.gitは削除しないでください。"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (dirname(path) === path) break;
      }
      if (cwd === parse(cwd).root || cwd === await realpath(homedir())) throw new Error("ホーム全体やルートではなく、タスク専用の作業フォルダを指定してください。");
      await git(["-c", "init.templateDir=", "init", "--quiet"]);
      initialized = true;
    }
    const root = await realpath(await git(["rev-parse", "--show-toplevel"]));
    return { root, initialized };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Git管理を開始できないため作業を開始しません。${code === "ENOENT" ? "実行環境にGitをインストールしてください。" : error instanceof Error ? error.message : String(error)}\n作業フォルダでgit statusが実行できる状態にして、同じ工程から再開してください。ファイルの追加・コミット・削除は行っていません。`);
  }
}

export const gitWorkPolicy = `# Mandatory Git version control
All task work is version-controlled, in every mode, for both local and remote execution. The harness ensures the task workspace is a Git working tree before execution. At the beginning inspect git status, the repository root and current HEAD; identify pre-existing user changes/staged files and never overwrite, unstage or commit them as your own. No existing commit is a valid initial state, not permission to skip version control. Writers must check git var GIT_AUTHOR_IDENT and git var GIT_COMMITTER_IDENT in each source/report repository BEFORE long work. If unset, use only an explicitly user-approved identity, scoped to this project or command; otherwise ask once at setup, not repeatedly at finishing. Do not copy credentials or guess an author.
Before substantive edits, establish a baseline commit of the relevant source files if they have no committed baseline and can safely be separated from user work. Commit your verified, task-owned changes at coherent milestones and before writer handoff, with meaningful messages. Include the commit ID(s), verification results and any remaining uncommitted files/reason in the handoff. An empty change does not require an empty commit. If existing user changes cannot safely be separated, preserve them and explain the exact conflict rather than committing everything.
Use explicit task-owned file paths; never blindly git add . / -A. Track source, tests, scripts, TeX/BibTeX and small reproducibility metadata. Keep credentials, API keys, private auth files, caches, build outputs and large experiment datasets out of commits; use hashes and reproducible retrieval/generation instructions for large data. Inspect the staged diff before committing. Do not alter global Git settings or invent a human author identity. Missing author identity should be reported precisely for setup.
If TeX/report sources live outside the main repository, a writing role must initialize a separate repository in that report-source directory (or reuse its existing repository) and commit its own source changes there. Do not copy .git between hosts or report snapshots. Coordinate each report copy with its repository on that host.
Read-only specialists/reviewers do not init, stage or commit. They inspect relevant history, verify that task-owned source changes are committed, and report missing version-control evidence as a concrete concern for the writer rather than silently passing it. All isolated-work packages MUST preserve HEAD and leave changes for the primary owner, as required by the worktree protocol; the primary owner commits after verified shared integration. This exception does not remove the task's Git requirement.
No push, publication, remote creation, history rewriting, hard reset, destructive checkout, cleanup or deletion of user files without separate user authorization. A commit records a change, not scientific correctness; all acceptance checks and independent reviews remain required.`;
