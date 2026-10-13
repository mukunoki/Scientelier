// Executed with the remote Node runtime. Keep this module dependency-free.
import { createInterface } from "node:readline";
import { realpath, lstat, mkdir, open, readdir, rename, stat, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

// Only public configuration metadata, never keyring entries or tokens. Kept in
// this dependency-free bridge so local and remote launches use the same check.
export async function antigravitySettingsSummary(home = homedir()) {
  try {
    const path = join(home, ".gemini", "antigravity-cli", "settings.json");
    if ((await stat(path)).size > 256000) throw new Error("oversized settings");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid settings");
    return { valid: true, provider: !value.modelProvider ? "account" : value.modelProvider === "gemini" ? "api" : "unknown",
      creditsEnabled: value.useG1Credits !== undefined && value.useG1Credits !== false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: true, provider: "account", creditsEnabled: false };
    return { valid: false, provider: "unknown", creditsEnabled: false };
  }
}

export async function prepareRemoteWorkspace(input: string, home = homedir()): Promise<string> {
  const value = input.trim() || "agent-harness";
  if (/^\/+$/.test(value) || /[\0\r\n]/.test(value) || value.split("/").some(p => p === ".." || p === ".")
    || (value.startsWith("~") && value !== "~" && !value.startsWith("~/"))) throw new Error("Invalid remote working directory");
  const homeRelative = !isAbsolute(value);
  const base = homeRelative ? await realpath(home) : "/";
  const suffix = value === "~" ? "" : value.startsWith("~/") ? value.slice(2) : value;
  const segments = suffix.split("/").filter(Boolean);
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    current = await realpath(current);
    if (homeRelative) {
      const rel = relative(base, current);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("ホーム基準の作業フォルダがリンク経由でホームの外を参照しています。外部領域は絶対パスで明示してください。");
    }
    if (!(await lstat(current)).isDirectory()) throw new Error("作業フォルダのパスに通常ファイルがあります。");
  }
  return current;
}

export async function serveRemoteWorkspace(input: string): Promise<void> {
  await serveRemote(await prepareRemoteWorkspace(input));
}

export async function remoteOperation(root: string, request: any): Promise<unknown> {
  const canonicalRoot = await realpath(root);
  if (request.op === "git-ensure") return require("./git-workspace").ensureGitWorkspace(canonicalRoot);
  if (request.op === "antigravity-usage-install") return require("./antigravity-remote").installRemoteAntigravityUsage(require("./antigravity-hook-source").source);
  if (request.op === "service-capacity") {
    // These probes never ask a model to generate text or return credentials.
    try {
      if (request.agentId === "codex") return { observation: await require("./capacity-probes").readCodexCapacity("codex", canonicalRoot) };
      if (request.agentId === "claude") return { observation: await require("./claude-capacity").readClaudeCapacity() };
      if (request.agentId === "antigravity") return await require("./antigravity-remote").readRemoteAntigravityUsage();
      return { unsupported: true };
    } catch (e) {
      // CLI errors may include arbitrary stderr. Do not expose it or secrets.
      const status = (e as { status?: number }).status;
      const retry = (e as { retryAfterMs?: number }).retryAfterMs;
      return { error: status === 401 || status === 403 ? "遠隔CLIの使用量認証が拒否されました。端末でログインを更新してください。"
        : status === 429 ? "使用量APIの一時制限です。再ログインせず、時間を置いて更新してください。"
        : "遠隔の使用枠を取得できません。CLIの契約認証・外部通信・バージョンを確認してください。",
        retryAfterMs: Number.isFinite(retry) && retry! > 0 ? retry : 60_000 };
    }
  }
  if (request.op === "clock") return { now: Date.now() };
  if (request.op === "tmux-status" || request.op === "tmux-close") {
    if (![request.taskId, request.runId].every(id => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))) throw new Error("Invalid tmux run");
    const directory = join(canonicalRoot, ".agent-harness", request.taskId, "runs", request.runId);
    if (await realpath(directory) !== directory) throw new Error("tmux path contains a link");
    const module = require(join(directory, "tmux-session.js"));
    return request.op === "tmux-close" ? module.closeTmuxSession(join(directory,"launch.json")) : module.inspectTmuxSession(join(directory, "launch.json"));
  }
  if (request.op === "login-status") {
    const checkedAt = new Date().toISOString();
    const commands: Record<string, string[]> = { codex: ["login", "status"], claude: ["auth", "status"] };
    if (typeof request.agentId !== "string" || !Object.hasOwn(commands, request.agentId)) {
      return { checkedAt, checkSupported: false, detail: "このCLIの認証単独の自動判定は未対応です。使用枠の取得とは別の状態であり、認証エラーを意味しません。" };
    }
    // Fixed, read-only status commands over the existing connection. Never
    // return raw output (which may include an account address or API key).
    let output = "";
    try {
      const result = await promisify(execFile)(request.agentId, commands[request.agentId], { cwd: canonicalRoot, timeout: 10000, maxBuffer: 64000 });
      output = request.agentId === "claude" ? result.stdout : `${result.stdout}\n${result.stderr}`;
    } catch (e) {
      const failure = e as { code?: number; stdout?: string; stderr?: string };
      if (failure.code === 1) output = request.agentId === "claude" ? failure.stdout ?? "" : `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    }
    let loggedIn: boolean | undefined;
    if (request.agentId === "claude") {
      try { const value = JSON.parse(output); if (typeof value?.loggedIn === "boolean") loggedIn = value.loggedIn; } catch { /* Unknown, not success. */ }
    } else {
      if (/^Logged in using (?:ChatGPT\s*$|an API key\b)/im.test(output)) loggedIn = true;
      else if (/^Not logged in\s*$/im.test(output)) loggedIn = false;
    }
    return { checkedAt, loggedIn, detail: loggedIn === true ? "遠隔CLIはログイン済みと報告しています。モデル実行・残量の保証ではありません。"
      : loggedIn === false ? "遠隔CLIにログインしていません。" : "遠隔CLIの認証状態を確認できません。" };
  }
  if (request.op === "cli-recovery") {
    if (typeof request.taskId!=="string" || !/^[0-9a-f-]{36}$/.test(request.taskId)) throw new Error("Invalid task ID");
    const path=join(canonicalRoot,".agent-harness",request.taskId,"cli-recovery.js");
    if (await realpath(path)!==path) throw new Error("Recovery path contains a link");
    return require(path).recoverRemoteRun(canonicalRoot,request.taskId,request.runId,request.action,request.manual===true,request.legacy);
  }
  if (request.op === "quality") {
    if(typeof request.taskId!=="string"||!/^[0-9a-f-]{36}$/.test(request.taskId))throw new Error("Invalid task ID");
    const modulePath=join(canonicalRoot,".agent-harness",request.taskId,"quality.js");
    if(await realpath(modulePath)!==modulePath)throw new Error("Quality runtime path contains a link");
    const evidenceRoot=request.reportPath?resolve(canonicalRoot,request.reportPath):canonicalRoot;
    const rel=relative(canonicalRoot,evidenceRoot);
    if(rel.startsWith("../")||rel===".."||isAbsolute(rel)||await realpath(evidenceRoot)!==evidenceRoot)throw new Error("Quality evidence root is outside the workspace or linked");
    return require(modulePath).qualityOperation({...request.context,root:evidenceRoot,taskId:request.taskId},request.request);
  }
  if (request.op === "research") {
    if (typeof request.taskId !== "string" || !/^[0-9a-f-]{36}$/.test(request.taskId)) throw new Error("Invalid task ID");
    const modulePath = join(canonicalRoot, ".agent-harness", request.taskId, "research-cycle.js");
    if (await realpath(modulePath) !== modulePath) throw new Error("Research runtime path contains a link");
    return require(modulePath).researchOperation({ ...request.context, root: canonicalRoot, taskId: request.taskId }, request.request);
  }
  if (request.op === "antigravity-settings") return antigravitySettingsSummary();
  if (request.op === "skills") {
    if (typeof request.taskId !== "string" || !/^[0-9a-f-]{36}$/.test(request.taskId)) throw new Error("Invalid task ID");
    const modulePath = join(canonicalRoot,".agent-harness",request.taskId,"skills-runtime.js");
    if (await realpath(modulePath) !== modulePath) throw new Error("Skill runtime path contains a link");
    return require(modulePath).skillStoreOperation(join(canonicalRoot,"harness-skills"),request.action,request.value);
  }
  if (request.op === "workspace") {
    if (typeof request.taskId !== "string" || !/^[0-9a-f-]{36}$/.test(request.taskId)) throw new Error("Invalid task ID");
    const modulePath = join(canonicalRoot,".agent-harness",request.taskId,"implementation-workspaces.js");
    if(await realpath(modulePath)!==modulePath)throw new Error("Workspace runtime path contains a link");
    return require(modulePath).workspaceOperation({...request.context,root:canonicalRoot,taskId:request.taskId},request.request);
  }
  if (request.op === "hpc") {
    if (typeof request.taskId !== "string" || !/^[0-9a-f-]{36}$/.test(request.taskId)) throw new Error("Invalid task ID");
    const modulePath = join(canonicalRoot, ".agent-harness", request.taskId, "hpc-runtime.js");
    if (await realpath(modulePath) !== modulePath) throw new Error("HPC runtime path contains a link");
    return require(modulePath).hpcOperation({ ...request.context, root: canonicalRoot, taskId: request.taskId }, request.request);
  }
  const inside = (path: string) => { const rel = relative(canonicalRoot, path); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
  const target = async (path: unknown) => {
    if (typeof path !== "string" || path.includes("\0")) throw new Error("Invalid path");
    const canonical = await realpath(resolve(canonicalRoot, path));
    if (!inside(canonical)) throw new Error("Path is outside the remote workspace");
    return canonical;
  };
  if (request.op === "workspace-directory") {
    const cwd = await target(request.path);
    if (!(await stat(cwd)).isDirectory()) throw new Error("作業場所がディレクトリではありません。");
    return { cwd };
  }
  if (request.op === "probe") {
    const commands: Record<string, string | undefined> = {};
    for (const command of ["codex", "claude", "opencode", "agy", "latexmk", "tmux"]) {
      try { commands[command] = (await promisify(execFile)("/bin/sh", ["-c", `command -v ${command}`])).stdout.trim(); } catch { /* Missing is unavailable. */ }
    }
    return { cwd: canonicalRoot, node: process.version, now: Date.now(), hostname: (await import("node:os")).hostname(), commands };
  }
  if (request.op === "put") {
    // Harness writes only its own task support/report directories, never project sources.
    if (typeof request.path !== "string" || !/^\.agent-harness\/[0-9a-f-]{36}\//.test(request.path)
      || request.path.split("/").some((s: string) => s === ".." || !s)) throw new Error("Invalid managed path");
    if (typeof request.data !== "string" || request.data.length > 28 * 1024 * 1024) throw new Error("Upload too large");
    const segments = request.path.split("/");
    let dir = canonicalRoot;
    for (const part of segments.slice(0, -1)) {
      dir = join(dir, part);
      try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Managed path contains a link");
    }
    const destination = join(dir, segments.at(-1)!);
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Destination is not a regular file");
      if (request.exclusive) return { created: false };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const temp = join(dir, `${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(Buffer.from(request.data, "base64")); } finally { await file.close(); }
    await rename(temp, destination); return { created: true };
  }
  const path = await target(request.path);
  if (request.op === "list") {
    const files: string[] = []; let bytes = 0;
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        // Git internals (including linked-worktree pointers) belong to their
        // host. Never traverse or transfer them with report artifacts.
        if (entry.name === ".git") continue;
        const file = join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Report contains a symbolic link; copy it to a regular file first");
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) {
          const info = await lstat(file);
          if (files.length >= 5000 || (bytes += info.size) > 250 * 1024 * 1024 || info.size > 100 * 1024 * 1024) throw new Error("Report transfer exceeds 250MB / 5000 files / 100MB per file");
          files.push(relative(path, file));
        } else throw new Error("Report contains a special file");
      }
    };
    await visit(path); return files;
  }
  if (request.op !== "read" && request.op !== "hash") throw new Error("Unknown operation");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    const limit = Math.min(Number(request.maxBytes) || 20 * 1024 * 1024, 100 * 1024 * 1024);
    if (!info.isFile()) throw new Error(`取得元が通常ファイルではありません：${path}`);
    if (info.size > limit) throw new Error(`取得元ファイルが読み取り上限を超えています：${path}（${info.size} bytes / 上限 ${limit} bytes）`);
    if (request.startedAt && info.mtimeMs > Date.parse(request.startedAt)) throw new Error("Evidence changed during review");
    const data = await file.readFile(); const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("File changed while reading");
    return { path, hash: createHash("sha256").update(data).digest("hex"), mtimeMs: info.mtimeMs,
      ...(request.op === "read" ? { data: data.toString("base64") } : {}) };
  } finally { await file.close(); }
}

export async function serveRemote(root: string): Promise<void> {
  // One SSH channel for bounded support-file operations, not one login per poll.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request: any;
    try {
      if (line.length > 30 * 1024 * 1024) throw new Error("Request too large");
      request = JSON.parse(line);
      if (["service-capacity", "login-status"].includes(request.op)) {
        const id = request.id;
        void remoteOperation(root, request).then(result => process.stdout.write(JSON.stringify({ id, result }) + "\n"),
          () => process.stdout.write(JSON.stringify({ id, error: "遠隔の状態確認に失敗しました。" }) + "\n"));
      } else process.stdout.write(JSON.stringify({ id: request.id, result: await remoteOperation(root, request) }) + "\n");
    } catch (e) { process.stdout.write(JSON.stringify({ id: request?.id, error: e instanceof Error ? e.message : String(e), code: (e as NodeJS.ErrnoException).code }) + "\n"); }
  }
}
