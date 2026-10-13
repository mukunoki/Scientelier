// Portable to the SSH host: Node built-ins only. The same engine backs MCP and GUI.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { readFile, writeFile, mkdir, lstat, realpath, rename, unlink, copyFile } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";

const exec = promisify(execFile);
const stages = ["reference", "replay", "unit", "integration", "mpi", "performance"] as const;
type Stage = typeof stages[number];
type Cost = { gpuHours: number; nodeHours: number; storageGB: number };
export interface HpcContext {
  root: string; taskId: string; actor: string; write: boolean; manage: boolean;
  user?: boolean; workspaceId?: string;
}
export interface HpcCheck {
  id: string; unitId: string; stage: Stage; caseId: string; at: string; actor: string;
  fingerprint: string; reference: string; actual: string; environment: string; verifier: string;
  evidence: Record<string, string>; passed: boolean; stale?: boolean; reason?: string;
  metrics: Array<{ variable: string; count: number; failures: number; maxAbsolute: number; maxRelative: number | null }>;
}
export interface HpcUnit {
  id: string; title: string; files: string[]; dependsOn: string[];
  cases: Array<{ id: string; stage: Stage; absolute: number; relative: number }>;
  policyNote: string; checks: HpcCheck[]; state: string;
}
export interface HpcJob {
  id: string; key: string; unitId: string; label: string; input: Record<string, string>;
  submit: string; probe: string; schedulerId?: string; state: "unknown" | "queued" | "running" | "succeeded" | "failed";
  reserved: Cost; actual?: Cost; cwd: string; outputDirectory: string; createdAt: string; updatedAt: string;
  observations: Array<{ at: string; output: string; error?: string }>;
}
export interface HpcWorkspace {
  id: string; path: string; files: string[]; base: Record<string, string>; commit: string;
  state: "preparing" | "active" | "merged" | "abandoned"; changes?: string[]; createdAt: string; checks: HpcCheck[];
}
export interface HpcLedger {
  version: 1; revision: number; units: HpcUnit[]; jobs: HpcJob[]; workspaces: HpcWorkspace[];
  budget: Partial<Cost & { jobs: number }>; updatedAt: string;
  events: Array<{ at: string; actor: string; action: string }>;
}
const now = () => new Date().toISOString();
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function text(v: unknown, max = 1000): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0")) throw new Error("空でない適切な長さの文字列が必要です。");
  return v;
}
function id(v: unknown): string { const s = text(v, 100); if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("IDは英数字・_・-で指定してください。"); return s; }
function number(v: unknown): number { if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("0以上の有限数が必要です。"); return v; }
function fileName(v: unknown): string {
  const s = text(v, 500);
  if (isAbsolute(s) || /[\\\r\n]/.test(s) || s.split("/").some(p => !p || p === "." || p === ".." || p === ".git" || p === ".agent-harness")) throw new Error("管理領域を除く、作業場所内の相対ファイル名を指定してください。");
  return s;
}
function strings(v: unknown, max: number, parse: (s: unknown) => string): string[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`配列は${max}件以内で指定してください。`);
  const values = v.map(parse); if (new Set(values).size !== values.length) throw new Error("重複した項目があります。"); return values;
}
// Reject symlinks in every component, including managed directories. Never follow
// an agent-produced evidence link into another project or a credential directory.
export async function safePath(root: string, suffix: string, createParents = false): Promise<string> {
  let current = await realpath(root);
  const parts = suffix.split("/");
  if (isAbsolute(suffix) || parts.some(p => !p || p === "." || p === "..")) throw new Error("不正な相対パスです。");
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (i < parts.length - 1 && createParents) {
        // Concurrent agents can create the same managed parent. Revalidate it
        // below instead of treating a benign creation race as a task failure.
        try { await mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        info = await lstat(current);
      }
      else if (i === parts.length - 1) return current;
      else throw e;
    }
    if (info?.isSymbolicLink() || (i < parts.length - 1 && !info?.isDirectory())) throw new Error("リンクを含むパスは使用できません。");
  }
  return current;
}
export async function data(root: string, path: string, max = 32 * 1024 * 1024): Promise<Buffer> {
  const p = await safePath(root, fileName(path)); const info = await lstat(p);
  if (!info.isFile() || info.size > max) throw new Error("検証対象は32MB以下の通常ファイルに分割してください。");
  return readFile(p);
}
export async function digest(root: string, file: string, allowMissing = false): Promise<string> {
  try { const bytes = await data(root, file); const mode = (await lstat(await safePath(root, file))).mode & 0o111; return hash(Buffer.concat([Buffer.from(`${mode}:`), bytes])); }
  catch (e) { if (allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw e; }
}
function fresh(): HpcLedger { return { version: 1, revision: 0, units: [], jobs: [], workspaces: [], budget: {}, events: [], updatedAt: now() }; }
export function hpcBlockers(ledger: HpcLedger): string[] {
  return [
    ...(!ledger.units.length ? ["移行単位と必須ケースが未登録です。"] : []),
    ...ledger.units.filter(u => u.state !== "統合検証済").map(u => `${u.id}: ${u.state}`),
    ...ledger.jobs.filter(j => !["succeeded", "failed"].includes(j.state)).map(j => `ジョブ ${j.id}: 状態照合が必要`),
    ...ledger.workspaces.filter(w => ["active", "preparing"].includes(w.state)).map(w => `作業場所 ${w.id}: 未統合`)
  ];
}

export async function assertHpcRunActive(directory: string, token: string): Promise<void> {
  for (const name of ["handoff.json", "exit.json", "retired.json"]) {
    let value;
    try { value = JSON.parse(await readFile(join(directory, name), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" || name === "handoff.json" && e instanceof SyntaxError) continue; throw e; }
    // An invalid draft is not retirement. Permit the same owner to correct it;
    // exit/retired receipts and valid final notifications still fence all writes.
    if (name === "handoff.json"
      && await lstat(join(directory, "completion-contract.json")).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false)
      && (!value || value.receiptValidated !== true || !["completed", "blocked", "rate-limited"].includes(value.status)
        || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 64000)) continue;
    if (value.token === token) throw new Error("この担当は終了済みです。次の担当のHPC操作を使用してください。");
  }
}
async function paths(c: HpcContext) {
  id(c.taskId); id(c.actor);
  const directory = `.agent-harness/${c.taskId}/hpc`;
  const path = await safePath(c.root, `${directory}/ledger.json`, true);
  return { path, directory: dirname(path) };
}
async function load(path: string): Promise<HpcLedger> {
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("移行台帳が不正です。");
    const v = JSON.parse(await readFile(path, "utf8"));
    if (v.version !== 1 || !Array.isArray(v.units) || !Array.isArray(v.jobs) || !Array.isArray(v.workspaces)) throw new Error("移行台帳の形式が不正です。");
    return v;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fresh(); throw e; }
}
async function save(path: string, ledger: HpcLedger) {
  ledger.revision++; ledger.updatedAt = now();
  const value = JSON.stringify(ledger); if (Buffer.byteLength(value) > 16 * 1024 * 1024) throw new Error("移行台帳が上限に達しました。タスクを区切ってください。");
  const tmp = `${path}.${randomUUID()}.tmp`; await writeFile(tmp, value, { flag: "wx", mode: 0o600 }); await rename(tmp, path);
}
export async function locked<T>(directory: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(directory, "lock"); const token = randomUUID();
  // The lock file is created atomically with its owner. A crashed owner can be
  // recovered only when its same-host PID no longer exists, never by timeout.
  for (let retry = 0; ; retry++) {
    try { await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token }), { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let info;
      try { info = await lstat(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("台帳ロックが不正です。");
      let owner; try { owner = JSON.parse(await readFile(lock, "utf8")); } catch { /* owner is still being written */ }
      if (owner?.host === hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new Error("台帳更新が中断されています。タスクを停止してGUIの「台帳ロックを復旧」を実行してください。処理中のジョブは再投入しません。");
        }
      }
      if (retry > 300) throw new Error("移行台帳を更新中です。再試行してください。");
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { return await fn(); }
  finally { if (JSON.parse(await readFile(lock, "utf8")).token === token) await unlink(lock); }
}
async function fingerprint(c: HpcContext, ledger: HpcLedger, unit: HpcUnit, visited = new Set<string>(), memo = new Map<string, Promise<string>>()): Promise<string> {
  if (visited.has(unit.id)) throw new Error("移行単位の依存が循環しています。");
  const cached = memo.get(unit.id); if (cached) return cached;
  const next = new Set(visited).add(unit.id);
  const pending = (async () => {
    const files = await Promise.all(unit.files.map(async f => [f, await digest(c.root, f)]));
    const deps = await Promise.all(unit.dependsOn.map(async key => {
      const d = ledger.units.find(u => u.id === key); if (!d) throw new Error(`依存単位が未登録です: ${key}`);
      return [key, await fingerprint(c, ledger, d, next, memo)];
    }));
    return hash(JSON.stringify({ files, deps, cases: unit.cases, policyNote: unit.policyNote }));
  })();
  memo.set(unit.id, pending); return pending;
}
async function refresh(c: HpcContext, ledger: HpcLedger): Promise<void> {
  const memo = new Map<string, Promise<string>>();
  for (const u of ledger.units) {
    let fp: string | undefined; try { fp = await fingerprint(c, ledger, u, new Set(), memo); } catch { /* Missing files are unverified. */ }
    for (const check of u.checks) {
      if (check.stale) continue;
      try {
        const same = await Promise.all(Object.entries(check.evidence).map(async ([p, h]) => await digest(c.root, p) === h));
        if (check.fingerprint !== fp || same.includes(false)) { check.stale = true; check.reason = "コード・入力・検証器・環境または依存先が変更されました。"; }
      } catch { check.stale = true; check.reason = "証拠ファイルを確認できません。"; }
    }
    const latest = u.cases.map(t => [...u.checks].reverse().find(x => x.caseId === t.id && !x.stale));
    u.state = latest.some(x => x && !x.passed) ? "差戻し" : u.cases.length && latest.every(x => x?.passed) ? "統合検証済" : u.checks.some(x => x.stale) ? "再検証待ち" : latest.some(x => x?.stage === "unit" && x.passed) ? "単体検証済" : latest.some(x => x?.stage === "replay" && x.passed) ? "CPU再現確認" : latest.some(x => x?.stage === "reference" && x.passed) ? "基準確立" : "未検証";
  }
  // A dependent cannot become complete while its predecessor still has a
  // failing/missing case, even when no source bytes changed.
  for (let i = 0; i < ledger.units.length; i++) for (const u of ledger.units) {
    if (u.state === "統合検証済" && u.dependsOn.some(d => ledger.units.find(x => x.id === d)?.state !== "統合検証済")) u.state = "依存検証待ち";
  }
}
export function compareNumerics(reference: unknown, actual: unknown, absolute: number, relativeTolerance: number): HpcCheck["metrics"] {
  number(absolute); number(relativeTolerance);
  const parse = (input: any): Record<string, number[]> => {
    if (!input || !input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw new Error('数値ファイルは {"values":{"変数名":[数値,...]}} 形式です。');
    const entries = Object.entries(input.values);
    if (!entries.length || entries.length > 1000) throw new Error("比較変数がありません、または多すぎます。");
    for (const [key, value] of entries) if (!key || !Array.isArray(value) || !value.length || value.length > 1000000 || value.some(x => typeof x !== "number" || !Number.isFinite(x))) throw new Error("空配列・NaN/Inf・数値でない値は検証不合格です。");
    return input.values;
  };
  const a = parse(reference), b = parse(actual);
  if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(b).sort())) throw new Error("比較対象の変数が一致しません。");
  return Object.entries(a).map(([variable, values]) => {
    if (values.length !== b[variable].length) throw new Error(`配列長が一致しません: ${variable}`);
    let failures = 0, maxAbsolute = 0, maxRelative = 0;
    values.forEach((value, i) => {
      const difference = Math.abs(value - b[variable][i]);
      const threshold = absolute + relativeTolerance * Math.abs(value);
      if (!Number.isFinite(difference) || !Number.isFinite(threshold) || difference > threshold) failures++;
      maxAbsolute = Math.max(maxAbsolute, difference); maxRelative = Math.max(maxRelative, value === 0 ? difference === 0 ? 0 : Infinity : difference / Math.abs(value));
    });
    return { variable, count: values.length, failures, maxAbsolute: Number.isFinite(maxAbsolute) ? maxAbsolute : Number.MAX_VALUE, maxRelative: Number.isFinite(maxRelative) ? maxRelative : null };
  });
}
function cost(v: any): Cost { return { gpuHours: number(v?.gpuHours), nodeHours: number(v?.nodeHours), storageGB: number(v?.storageGB) }; }
// Shared recovery for durable ledgers: never reclaim by age or kill an owner.
export async function recoverLedgerLock(directory: string): Promise<void> {
  const lock=join(directory,"lock"), info=await lstat(lock);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("ロック形式が不正です。");
  const value=await readFile(lock,"utf8"), owner=JSON.parse(value);
  if (owner.host!==hostname() || !Number.isSafeInteger(owner.pid) || owner.pid<=0) throw new Error("ロック所有者を確認できません。接続先で確認してください。");
  try { process.kill(owner.pid,0); throw new Error("所有プロセスは動作中です。ロックを解除しません。"); }
  catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH") throw e;}
  if(await readFile(lock,"utf8")!==value) throw new Error("ロック所有者が変わりました。");
  await unlink(lock);
}
function requireWriter(c: HpcContext) { if (!c.write) throw new Error("この担当は読み取り専用です。"); }
function requireManager(c: HpcContext) { if (!c.manage) throw new Error("主担当だけが移行単位を設定できます。"); }
async function git(root: string, args: string[]) { return (await exec("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 })).stdout.trim(); }
async function ownWorkspace(c: HpcContext, ledger: HpcLedger) {
  if (!c.workspaceId) return c.root;
  const w = ledger.workspaces.find(w => w.id === c.workspaceId && w.state === "active"); if (!w) throw new Error("分離作業場所を確認できません。"); return w.path;
}

export async function hpcOperation(c: HpcContext, request: any): Promise<any> {
  if (request?.workspaceId !== undefined) {
    if (!c.manage || !c.write || request.action !== "verify") throw new Error("主担当の検証以外は別の作業場所を指定できません。");
    c = { ...c, workspaceId: id(request.workspaceId) };
  }
  const { path, directory } = await paths(c);
  if (request?.action === "recover-lock") {
    if (!c.user) throw new Error("ロック復旧はユーザー操作が必要です。");
    await recoverLedgerLock(directory); return { recovered: true };
  }
  if (request?.action === "snapshot") {
    const ledger = await load(path); await refresh(c, ledger);
    if (c.user) return ledger;
    // Keep the orchestrator's context bounded; full history stays on disk/GUI.
    const offset = Number.isSafeInteger(request.offset) && request.offset >= 0 ? request.offset : 0;
    return { ...ledger, events: ledger.events.slice(-10), totalUnits: ledger.units.length, totalJobs: ledger.jobs.length,
      units: ledger.units.filter(u=>!request.unitId || u.id===request.unitId).slice(offset,offset+50).map(u=>({...u,checks:u.cases.map(t=>[...u.checks].reverse().find(x=>x.caseId===t.id)).filter(Boolean).map(x=>({...x,metrics:x!.metrics.slice(0,20)}))})),
      jobs: ledger.jobs.filter(j=>!request.jobId || j.id===request.jobId).slice(offset,offset+50).map(j=>({...j,observations:j.observations.slice(-1)})),
      workspaces: ledger.workspaces.map(w=>({...w,checks:w.checks.slice(-5)})) };
  }
  if (request?.action === "workspace-diff") {
    const ledger = await load(path), w = ledger.workspaces.find(w=>w.id === request.id);
    if (!w) throw new Error("分離作業場所が見つかりません。");
    let diff = await git(w.path, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...w.files]);
    for (const file of w.files.filter(f=>w.base[f] === "missing")) {
      try { diff += `\n--- 新規ファイル ${file}\n${(await data(w.path,file)).toString("utf8").slice(0,20000)}\n`; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return { diff: diff.slice(0,200000), truncated: diff.length > 200000 };
  }
  return locked(directory, async () => {
    const ledger = await load(path);
    if (request?.revision !== undefined && request.revision !== ledger.revision) throw new Error("台帳が更新されました。再読み込みしてください。");
    let result: unknown;
    const action = request?.action;
    if (action === "budget") {
      if (!c.user) throw new Error("資源上限はユーザーだけが設定できます。");
      const budget: HpcLedger["budget"] = {};
      for (const key of ["jobs", "gpuHours", "nodeHours", "storageGB"] as const) if (request.budget?.[key] !== undefined && request.budget[key] !== null) budget[key] = number(request.budget[key]);
      if (budget.jobs !== undefined && !Number.isSafeInteger(budget.jobs)) throw new Error("ジョブ数は整数です。");
      ledger.budget = budget;
    } else if (action === "define") {
      requireManager(c);
      if (c.workspaceId) throw new Error("分離担当は共有台帳の定義を変更できません。");
      const v = request.unit, key = id(v?.id), old = ledger.units.find(u => u.id === key);
      if (old && !c.user) throw new Error("既存単位・許容誤差は変更できません。追加ケースは別単位で登録するか、ユーザーが設定を改訂してください。");
      const files = strings(v.files, 100, fileName), dependsOn = strings(v.dependsOn, 100, id);
      if (!files.length || dependsOn.includes(key) || dependsOn.some(d => !ledger.units.some(u => u.id === d))) throw new Error("ファイルと既存の依存単位を指定してください。");
      if (!Array.isArray(v.cases) || !v.cases.length || v.cases.length > 100) throw new Error("検証ケースは1〜100件です。");
      const cases: HpcUnit["cases"] = v.cases.map((x: any) => {
        if (!stages.includes(x.stage)) throw new Error("検証段階が不正です。");
        return { id: id(x.id), stage: x.stage, absolute: number(x.absolute), relative: number(x.relative) };
      });
      if (new Set(cases.map(x => x.id)).size !== cases.length || !["reference", "replay", "unit", "integration"].every(s => cases.some(x => x.stage === s))) throw new Error("重複しないケースIDと、reference/replay/unit/integrationの4段階が必要です。");
      const unit: HpcUnit = { id: key, title: text(v.title, 200), files, dependsOn, cases, policyNote: text(v.policyNote, 2000), checks: old?.checks ?? [], state: "未検証" };
      const other = ledger.units.filter(u => u.id !== key); if (other.length >= 500) throw new Error("移行単位は500件以内でタスクを区切ってください。");
      ledger.units = [...other, unit];
      // Validate cycles even before source files have been created.
      const visit = (u: HpcUnit, seen = new Set<string>()) => { if (seen.has(u.id)) throw new Error("依存が循環しています。"); const next = new Set(seen).add(u.id); u.dependsOn.forEach(k => visit(ledger.units.find(x => x.id === k)!, next)); }; visit(unit);
      if (old) unit.checks.forEach(x => { x.stale = true; x.reason = "ユーザーが単位定義を改訂しました。"; });
    } else if (action === "verify") {
      requireWriter(c);
      const u = ledger.units.find(u => u.id === request.unitId); if (!u) throw new Error("移行単位が未登録です。");
      const test = u.cases.find(t => t.id === request.caseId); if (!test) throw new Error("ケースが未登録です。許容誤差をその場で変更することはできません。");
      const root = await ownWorkspace(c, ledger);
      const workspace = c.workspaceId ? ledger.workspaces.find(w => w.id === c.workspaceId)! : undefined;
      if (workspace && u.files.some(f => !workspace.files.includes(f))) throw new Error("担当外の移行単位は検証できません。");
      const checks = workspace ? workspace.checks.filter(x => x.unitId === u.id) : u.checks;
      const context = { ...c, root };
      const fp = await fingerprint(context, ledger, u);
      // Worktree proofs remain separate until shared integration is re-tested.
      if (!workspace) await refresh(context, ledger);
      const order = stages.indexOf(test.stage);
      const prerequisite = u.cases.filter(t => stages.indexOf(t.stage) < order && ["reference", "replay"].includes(t.stage));
      if (prerequisite.some(t => ![...checks].reverse().find(x => x.caseId === t.id && x.fingerprint === fp && !x.stale)?.passed)) throw new Error("先にCPU基準とCPU再現ケースを合格させてください。");
      const reference = fileName(request.reference), actual = fileName(request.actual), environment = fileName(request.environment), verifier = fileName(request.verifier);
      if (reference === actual) throw new Error("基準と結果は異なるファイルにしてください。");
      const evidence: Record<string, string> = Object.create(null);
      for (const p of [reference, actual, environment, verifier]) evidence[p] = await digest(root, p);
      const previous = [...checks].reverse().find(x => x.caseId === test.id && !x.reason?.includes("定義を改訂"));
      if (previous && (previous.reference !== reference || previous.evidence[reference] !== evidence[reference])) throw new Error("固定された基準結果が変わっています。ユーザーが単位定義を改訂するまで比較基準を差し替えられません。");
      let metrics: HpcCheck["metrics"] = [], reason: string | undefined;
      try { metrics = compareNumerics(JSON.parse((await data(root, reference)).toString()), JSON.parse((await data(root, actual)).toString()), test.absolute, test.relative); }
      catch (e) { reason = String(e); }
      const check: HpcCheck = { id: randomUUID(), unitId: u.id, at: now(), actor: c.actor, stage: test.stage, caseId: test.id, fingerprint: fp, reference, actual, environment, verifier, evidence, metrics, passed: !reason && metrics.every(m => m.failures === 0), reason };
      const destination = workspace ? workspace.checks : u.checks;
      if (destination.length >= 500) throw new Error("検証履歴の上限です。新しいタスクで続行してください。");
      destination.push(check); result = check;
    } else if (action === "submit-job") {
      requireWriter(c);
      const unitId = id(request.unitId); if (!ledger.units.some(u => u.id === unitId)) throw new Error("ジョブの移行単位が未登録です。");
      const key = id(request.key), prior = ledger.jobs.find(j => j.key === key);
      // An idempotency key is consumed before any external command; uncertain
      // submission is never retried automatically after disconnect/restart.
      const reserved = cost(request.reserved), input: Record<string, string> = Object.create(null);
      const root = await ownWorkspace(c, ledger);
      const inputs = strings(request.inputs, 100, fileName).sort(); if (!inputs.length) throw new Error("コード・入力・環境を特定するファイルが必要です。");
      if (c.workspaceId) {
        const owned = ledger.workspaces.find(w=>w.id===c.workspaceId)!.files;
        if (ledger.units.find(u=>u.id===unitId)!.files.some(f=>!owned.includes(f))) throw new Error("担当外の移行単位へジョブを投入できません。");
      }
      for (const p of inputs) input[p] = await digest(root, p);
      if (prior) {
        if (prior.unitId !== unitId || JSON.stringify(prior.input) !== JSON.stringify(input) || prior.submit !== request.submit || prior.probe !== request.probe) throw new Error("同じ投入キーのコード・入力・コマンドが変わっています。既存ジョブを照合し、終了を確認してから別の試行として登録してください。");
        return { ...prior, reused: true };
      }
      if (ledger.jobs.some(j => j.unitId === unitId && !["succeeded", "failed"].includes(j.state) && JSON.stringify(j.input) === JSON.stringify(input))) throw new Error("同じ入力の未解決ジョブがあります。新しいキーで再投入せず、既存ジョブを照合してください。");
      if (ledger.budget.jobs !== undefined && ledger.jobs.length + 1 > ledger.budget.jobs) throw new Error("ジョブ数の予算上限です。");
      for (const k of ["gpuHours", "nodeHours", "storageGB"] as const) if (ledger.budget[k] !== undefined && ledger.jobs.reduce((sum, j) => sum + (j.actual ?? j.reserved)[k], 0) + reserved[k] > ledger.budget[k]!) throw new Error(`${k}の予算上限です。既存ジョブは停止せず、新規投入を保留します。`);
      if (ledger.jobs.length >= 1000) throw new Error("ジョブ台帳の上限です。");
      const jobId = randomUUID(), outputDirectory = dirname(await safePath(c.root, `.agent-harness/${c.taskId}/hpc/jobs/${jobId}/intent.json`, true));
      const job: HpcJob = { id: jobId, key, unitId, label: text(request.label, 200), input, submit: text(request.submit, 8000), probe: text(request.probe, 8000), reserved, cwd: root, outputDirectory, state: "unknown", createdAt: now(), updatedAt: now(), observations: [] };
      ledger.jobs.push(job); await save(path, ledger);
      await runJobCommand(root, job, true); result = job;
    } else if (action === "probe-job") {
      requireWriter(c);
      const job = ledger.jobs.find(j => j.id === request.jobId); if (!job) throw new Error("ジョブが見つかりません。");
      if (c.workspaceId && job.cwd !== await ownWorkspace(c, ledger)) throw new Error("別担当のジョブ照合は主担当が行ってください。");
      await runJobCommand(job.cwd, job, false); result = job;
    } else if (action === "workspace-prepare") {
      if (!c.user) throw new Error("作業場所の割当てはハーネスが管理します。");
      const key = id(request.id), files = strings(request.files, 100, fileName);
      if (!files.length) throw new Error("担当するファイルを明示してください。");
      const old = ledger.workspaces.find(w => w.id === key);
      if (old) { if (old.state !== "active") throw new Error("作業場所の準備・統合状態を確認してください。"); return old; }
      if (ledger.workspaces.some(w => ["preparing", "active"].includes(w.state) && w.files.some(f => files.includes(f) || files.some(p => p.startsWith(f + "/") || f.startsWith(p + "/"))))) throw new Error("担当範囲が他の分離作業と重なっています。");
      const root = await realpath(c.root);
      if (await realpath(await git(root, ["rev-parse", "--show-toplevel"])) !== root) throw new Error("分離実装の作業場所はGitリポジトリのルートにしてください。");
      const dirty = await git(root, ["status", "--porcelain", "--untracked-files=normal", "--", ".", ":(exclude).agent-harness"]);
      if (dirty) throw new Error("分離実装の開始前に未コミットの変更を保存・コミットしてください。自動コミットや破棄はしません。直列のprimary-workも利用できます。");
      const commit = await git(root, ["rev-parse", "HEAD"]), base: Record<string, string> = Object.create(null);
      for (const f of files) base[f] = await digest(root, f, true);
      const workspace = await safePath(c.root, `.agent-harness/${c.taskId}/hpc/workspaces/${key}`, true);
      const w: HpcWorkspace = { id: key, path: workspace, files, base, commit, state: "preparing", createdAt: now(), checks: [] }; ledger.workspaces.push(w); await save(path, ledger);
      await git(root, ["worktree", "add", "--detach", workspace, commit]); w.state = "active"; result = w;
    } else if (action === "workspace-merge") {
      if (!c.user && !(c.manage && c.write)) throw new Error("統合はハーネスまたは書込み主担当が管理します。");
      const w = ledger.workspaces.find(w => w.id === request.id); if (!w) throw new Error("分離作業場所が見つかりません。");
      if (w.state === "merged") return w;
      if (w.state !== "active" || await git(w.path, ["rev-parse", "HEAD"]) !== w.commit) throw new Error("分離作業の基準コミットが変更されています。");
      if (ledger.jobs.some(j => j.cwd === w.path && !["succeeded", "failed"].includes(j.state))) throw new Error("分離作業の計算ジョブが未完了・未照合です。統合前に状態を確認してください。");
      const relevant = ledger.units.filter(u => u.files.some(f => w.files.includes(f)));
      if (!relevant.length) throw new Error("分離担当の移行単位が未登録です。");
      for (const u of relevant) {
        const fp = await fingerprint({ ...c, root: w.path }, ledger, u);
        for (const t of u.cases.filter(t => ["reference", "replay", "unit"].includes(t.stage))) {
          const check = [...w.checks].reverse().find(x => x.unitId === u.id && x.caseId === t.id);
          if (!check?.passed || check.stale || check.fingerprint !== fp) throw new Error(`${u.id}/${t.id}: 統合前の数値検証が未完了です。分離作業場所で再検証してください。`);
          for (const [file, value] of Object.entries(check.evidence)) if (await digest(w.path, file) !== value) throw new Error("統合前に検証証拠が変更されました。");
        }
      }
      const changed = (await git(w.path, ["diff", "--name-only", "HEAD"])).split("\n").filter(Boolean);
      if (changed.some(f => !w.files.includes(f))) throw new Error(`担当外ファイルの変更があります: ${changed.filter(f => !w.files.includes(f)).join(", ")}`);
      const outputs: Array<{ file: string; bytes: Buffer; destination: string; mode: number }> = [];
      for (const f of w.files) {
        if (await digest(c.root, f, true) !== w.base[f]) throw new Error(`統合競合: ${f}。元ファイルを上書きしません。`);
        const next = await digest(w.path, f, true); if (next === w.base[f]) continue;
        if (next === "missing") throw new Error("ファイル削除は主担当が統合時に判断してください。");
        outputs.push({ file: f, bytes: await data(w.path, f), destination: await safePath(c.root, f, true), mode: (await lstat(await safePath(w.path, f))).mode & 0o777 });
      }
      // Backups and intent survive a crash. An interrupted multi-file merge is
      // detected as a conflict on retry, never silently replayed over new edits.
      const backup = dirname(await safePath(c.root, `.agent-harness/${c.taskId}/hpc/merge-backups/${w.id}/intent.json`, true));
      for (const item of outputs) if (w.base[item.file] !== "missing") await copyFile(item.destination, join(backup, hash(item.file)));
      await writeFile(join(backup, "intent.json"), JSON.stringify({ files: outputs.map(o => o.file), base: w.base }), { flag: "wx", mode: 0o600 });
      for (const item of outputs) {
        const tmp = `${item.destination}.hpc-${randomUUID()}`; await writeFile(tmp, item.bytes, { flag: "wx", mode: item.mode }); await rename(tmp, item.destination);
      }
      w.state = "merged"; w.changes = outputs.map(o => o.file); result = w;
    } else if (action === "workspace-release") {
      if (!c.user) throw new Error("割当解除はユーザーだけが操作できます。");
      const w = ledger.workspaces.find(w => w.id === request.id); if (!w || w.state === "merged") throw new Error("解除できる作業場所がありません。");
      w.state = "abandoned"; result = w;
    } else throw new Error("未対応のHPC操作です。");
    ledger.events.push({ at: now(), actor: c.actor, action }); ledger.events = ledger.events.slice(-2000);
    await refresh(c, ledger); await save(path, ledger);
    return result ?? ledger;
  });
}

async function runJobCommand(root: string, job: HpcJob, submit: boolean) {
  let output = "", error: string | undefined;
  try {
    const result = await exec("/bin/sh", ["-c", submit ? job.submit : job.probe], { cwd: root, timeout: 20000, maxBuffer: 128000,
      env: { ...process.env, HARNESS_RUN_ID: job.id, HARNESS_JOB_ID: job.schedulerId ?? "", HARNESS_OUTPUT_DIR: job.outputDirectory } });
    output = result.stdout;
    const value = JSON.parse(result.stdout.trim());
    if (!value || !["unknown", "queued", "running", "succeeded", "failed"].includes(value.state)) throw new Error("状態照合のJSONが不正です。");
    if (value.id !== undefined) {
      const schedulerId = text(value.id, 200);
      if (job.schedulerId && job.schedulerId !== schedulerId) throw new Error("ジョブIDが一致しません。");
      job.schedulerId = schedulerId;
    }
    if (!job.schedulerId && value.state !== "unknown") throw new Error("スケジューラのジョブIDが必要です。");
    if (value.state === "succeeded" && value.exitCode !== 0) throw new Error("成功には計算ジョブのexitCode:0が必要です。");
    job.state = value.state;
    if (value.actual && ["succeeded", "failed"].includes(job.state)) job.actual = cost(value.actual);
  } catch (e) { const err = e as Error & { stdout?: string; stderr?: string }; error = err.message.slice(0, 2000); output ||= err.stdout ?? ""; job.state = "unknown"; }
  job.updatedAt = now(); job.observations.push({ at: now(), output: output.slice(0, 12000), error }); job.observations = job.observations.slice(-100);
}

export const hpcInstructions = `# HPC migration management (required for this mode)
Use agent_harness hpc_manage with a request object. A read-only planner may define migration units but may not verify, submit or probe jobs. Read-only specialists/reviewers use snapshot only. A worker performs substantive work within the approved scope; this tool never changes the goal or grants system privileges.
Actions:
- snapshot: read units, latest case results, jobs, budgets and isolated workspaces. Optional unitId/jobId filters or offset pagination (50 entries/page); full history remains on disk and in the GUI. This bounds context consumption.
- define: unit={id,title,files:[relative source paths],dependsOn:[existing unit IDs],policyNote:"approved goal/tolerance basis",cases:[{id,stage,absolute,relative}]}. Stages: reference,replay,unit,integration,mpi,performance. Include at least reference/replay/unit/integration. Separate variables with different tolerances into cases. Define tolerances from the approved goal before implementation. Existing definitions/tolerances cannot be changed by agents.
- verify: unitId,caseId,reference,actual,environment,verifier (all relative files in your workspace). Numeric JSON files: {"values":{"variable":[1,2,3]}}. The harness computes abs(actual-reference) <= absolute + relative*abs(reference), checks names/lengths/finite values and fingerprints code, dependencies and evidence. Supply the environment manifest and executed verification script. This compares artifacts; it does not prove that a run happened. Keep actual command/job evidence for independent review. Baseline and actual must differ; baseline is pinned after first comparison. Run CPU reference/replay cases first. Source changes invalidate prior passes; rerun affected cases. No guessed outputs, relaxed thresholds or replacement baselines.
- submit-job: unitId,key (stable idempotency key),label,inputs:[code/input/environment files],reserved:{gpuHours,nodeHours,storageGB},submit,probe. Use the user's registered scheduler instructions; submit/probe are SHORT shell commands, not foreground computation. stdout must be only JSON {id:"scheduler job ID",state:"queued|running|succeeded|failed|unknown",exitCode:0 when succeeded,actual?:{gpuHours,nodeHours,storageGB}}. HARNESS_RUN_ID, HARNESS_JOB_ID and HARNESS_OUTPUT_DIR are environment variables. Persist run ID in the scheduler job name/metadata so the probe can recover an uncertain submission even without a scheduler ID. Do not include credentials. The tool records intent BEFORE submission. Reusing a key returns the old job, never resubmits. Unknown submission must be probed, never retried under a new key. Changed inputs need a new key after the old job is resolved.
- probe-job: jobId. Reconcile status using the saved probe, not a new submission. Only actual scheduler observations are evidence. Terminal job success is not numerical validation. Resource budgets reserve estimates before launch; unknown jobs retain reservations. Only the GUI user can set budgets.
- workspace-merge: id. Only the primary execution owner can request shared integration. The same ownership, baseline and proof gates apply. To repair incomplete worktree proofs, the primary may call verify with workspaceId and then merge again. Do not relax scientific criteria. Shared-workspace integration tests must still be run afterwards.
Isolated-work packages use harness-created Git worktrees. Write only the explicit owned files, never commit/reset or change shared workspace. Leave your tested changes and verification evidence in the worktree. The harness checks ownership and base hashes before integrating; integration still requires tests in the shared workspace. Never mark a unit integrated solely because a worktree task finished. Keep the working tree clean before requesting isolated packages; otherwise plan primary-work serial milestones.
Before declaring overall work finished, call snapshot and resolve every stale/failed/missing required case and nonterminal job. The harness rejects final primary completion when registered units are not fully verified or jobs are unresolved. A ledger is mandatory; free-text claims are not a substitute. Scientific validity, physical invariants, real MPI configurations and performance still require real experiments plus independent review.`;

// Antigravity's interactive adapter does not configure MCP. It uses exactly the
// same permission-scoped engine through this small command-line entry point.
if (require.main === module) void (async () => {
  const [configPath, payload] = process.argv.slice(2);
  if (!configPath || !payload || payload.length > 48000) throw new Error("HPC context and bounded JSON request required");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await assertHpcRunActive(dirname(configPath), config.token);
  process.stdout.write(JSON.stringify(await hpcOperation(config.context, JSON.parse(payload))) + "\n");
})().catch(e => { process.stderr.write(String(e) + "\n"); process.exitCode = 1; });
