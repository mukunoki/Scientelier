// Portable local/SSH workspace management. Numeric HPC proofs deliberately stay
// in hpc.ts: this ledger records integration, never scientific correctness.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, lstat, realpath, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { safePath, digest, data, locked, assertHpcRunActive } from "./hpc";

export interface WorkspaceContext {
  root: string; taskId: string; actor: string;
  manage: boolean; harness?: boolean;
  // Frozen for this run. The integrator cannot merge an active/failed worker.
  completedIds: string[];
  settledIds?: string[];
}
export interface ImplementationWorkspace {
  id: string; path: string; files: string[]; commit: string; base: Record<string,string>;
  state: "preparing" | "active" | "merging" | "merged" | "discarded";
  createdAt: string; decision?: string; changes?: string[];
  merge?: { digest: string; files: Array<{file:string; before:string; after:string}> };
}
interface Ledger { version: 1; revision: number; workspaces: ImplementationWorkspace[] }
const exec = promisify(execFile);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v)) throw new Error("作業場所IDが不正です。");
  return v;
};
function filename(v: unknown): string {
  if (typeof v !== "string" || v.length > 500 || /[\\\x00-\x1f\x7f]/.test(v)
    || v.split("/").some(p => !p || [".","..",".git",".agent-harness"].includes(p.toLowerCase()))) throw new Error("管理領域を除く相対ファイル名を指定してください。");
  return v;
}
async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args], {maxBuffer:8*1024*1024,timeout:30000})).stdout;
}
export function workspaceBlockers(ledger: Ledger): string[] {
  return ledger.workspaces.filter(w=>!["merged","discarded"].includes(w.state))
    .map(w=>`分離実装 ${w.id}: ${w.state === "merging" ? "統合途中・復旧が必要" : "未統合"} (${w.path})`);
}
async function inspect(c: WorkspaceContext, w: ImplementationWorkspace) {
  const expected=await safePath(c.root,`.agent-harness/${id(c.taskId)}/implementation/trees/${id(w.id)}`);
  if (w.path !== expected || await realpath(w.path) !== w.path || (await git(w.path,["rev-parse","HEAD"])).trim() !== w.commit)
    throw new Error("分離作業場所または基準コミットが変更されています。成果は保持しています。");
  w.files.forEach(filename);
  // Include untracked AND ignored files: otherwise an unexpected generated
  // source could evade ownership checks. Build scratch belongs outside the tree.
  const changed = [...new Set((await git(w.path,["diff","--name-only","-z","HEAD"])).split("\0")
    .concat((await git(w.path,["ls-files","--others","-z"])).split("\0")).filter(Boolean))];
  if (changed.some(f=>!w.files.includes(f))) throw new Error(`担当外の変更を統合しません: ${changed.filter(f=>!w.files.includes(f)).join(", ")}`);
  const files = await Promise.all(w.files.map(async file=>({file,before:await digest(c.root,file,true),after:await digest(w.path,file,true)})));
  return {id:w.id,path:w.path,files,digest:hash(JSON.stringify({commit:w.commit,files})),
    diff:await git(w.path,["diff","--no-ext-diff","--no-textconv","HEAD","--",...w.files.map(f=>`:(literal)${f}`)]),
    // New-file contents are inspected at path, not dumped as unbounded context.
    newFiles:files.filter(f=>w.base[f.file]==="missing" && f.after!=="missing").map(f=>f.file)};
}

export async function workspaceOperation(c: WorkspaceContext, request: any): Promise<any> {
  id(c.taskId); id(c.actor);
  const root = await realpath(c.root);
  c = {...c,root};
  const ledgerPath = await safePath(root,`.agent-harness/${c.taskId}/implementation/ledger.json`,true);
  return locked(dirname(ledgerPath),async()=>{
    let ledger: Ledger;
    try {
      const info=await lstat(ledgerPath);
      if(!info.isFile() || info.isSymbolicLink() || info.size>8*1024*1024)throw new Error("分離実装台帳が不正です。");
      ledger=JSON.parse(await readFile(ledgerPath,"utf8"));
      if(ledger.version!==1 || !Array.isArray(ledger.workspaces))throw new Error("分離実装台帳が不正です。");
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;ledger={version:1,revision:0,workspaces:[]};}
    const save=async()=>{ledger.revision++;const tmp=`${ledgerPath}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(ledger),{flag:"wx",mode:0o600});await rename(tmp,ledgerPath);};
    if(!request || typeof request!=="object" || Array.isArray(request))throw new Error("操作を指定してください。");
    if(request.action==="snapshot")return ledger;
    if(!c.manage)throw new Error("分離実装の統合は書込み主担当だけが操作できます。");
    if(request.action==="prepare") {
      if(!c.harness)throw new Error("作業場所はハーネスが割り当てます。");
      const key=id(request.id);
      if(!Array.isArray(request.files)||!request.files.length||request.files.length>100)throw new Error("担当ファイルを1〜100件指定してください。");
      const files=request.files.map(filename) as string[];
      const folded=files.map(f=>f.normalize("NFC").toLowerCase());
      if(new Set(folded).size!==files.length)throw new Error("担当ファイルが重複しています。");
      const old=ledger.workspaces.find(w=>w.id===key);
      if(old) {
        if(old.state!=="active"||JSON.stringify(old.files)!==JSON.stringify(files))throw new Error("保存済み作業場所の状態・担当範囲を確認してください。");
        if(old.path!==await safePath(root,`.agent-harness/${c.taskId}/implementation/trees/${key}`) || await realpath(old.path)!==old.path || (await git(old.path,["rev-parse","HEAD"])).trim()!==old.commit)throw new Error("基準コミットが変更されています。");
        return old; // Preserve partial/out-of-scope edits so the worker can repair them.
      }
      if(ledger.workspaces.some(w=>!["merged","discarded"].includes(w.state)&&w.files.map(f=>f.normalize("NFC").toLowerCase()).some(f=>folded.some(p=>p===f||p.startsWith(f+"/")||f.startsWith(p+"/")))))throw new Error("未統合の担当範囲が重複しています。先に主担当が統合してください。");
      if(await realpath((await git(root,["rev-parse","--show-toplevel"])).trim())!==root)throw new Error("分離実装にはGitリポジトリのルートが必要です。直列のprimary-workを使用できます。");
      if((await git(root,["ls-files","--",".agent-harness"])).trim())throw new Error("管理領域をGit追跡したリポジトリは分離実装に使用できません。");
      if((await git(root,["status","--porcelain","--untracked-files=all","--",".",":(exclude).agent-harness"])).trim())throw new Error("分離実装の開始にはコミット済みの作業場所が必要です。未保存の変更は破棄しません。主担当が整理するかprimary-workで直列実行してください。");
      const commit=(await git(root,["rev-parse","HEAD"])).trim(), base:Record<string,string>=Object.create(null);
      for(const f of files)base[f]=await digest(root,f,true);
      const path=await safePath(root,`.agent-harness/${c.taskId}/implementation/trees/${key}`,true);
      const w:ImplementationWorkspace={id:key,path,files,commit,base,state:"preparing",createdAt:new Date().toISOString()};
      ledger.workspaces.push(w);await save();
      await git(root,["worktree","add","--detach",path,commit]);w.state="active";await save();return w;
    }
    const w=ledger.workspaces.find(w=>w.id===id(request.id));if(!w)throw new Error("分離実装が見つかりません。");
    if(request.action==="inspect")return inspect(c,w);
    if(!(request.action==="discard" ? c.settledIds ?? c.completedIds : c.completedIds).includes(w.id))throw new Error("実行中または未完了の担当は統合・除外できません。終了確認後に主担当から操作してください。");
    if(typeof request.reason!=="string" || !request.reason.trim() || request.reason.length>2000)throw new Error("差分確認・検証結果と統合判断の理由を指定してください。");
    if(request.action==="discard") {
      if(w.state==="merging"||w.state==="merged")throw new Error("統合途中・統合済みの作業は除外できません。");
      w.state="discarded";w.decision=request.reason;await save();return w;
    }
    if(request.action!=="merge")throw new Error("未対応の分離実装操作です。");
    if(w.state==="merged")return w;
    if(w.state!=="active"&&w.state!=="merging")throw new Error("統合できる状態ではありません。");
    const view=await inspect(c,w);
    // A retry of a partially completed merge uses the persisted intent. Never
    // overwrite subsequent user edits; verify every source and destination first.
    let changes = view.files.filter(f=>f.after!==w.base[f.file]);
    if(w.state==="merging") {
      if(!w.merge || request.digest!==w.merge.digest)throw new Error("統合途中です。保存済みのmerge.digestで再試行してください。");
      changes=w.merge.files;
      if(changes.some(f=>!view.files.some(v=>v.file===f.file&&v.after===f.after&&(v.before===f.before||v.before===f.after))))throw new Error("統合途中にファイルが変更されました。バックアップと分離作業を保持し、上書きはしません。");
    } else {
      if(request.digest!==view.digest)throw new Error("確認後に差分が変わりました。inspectから再確認してください。");
      if(view.files.some(f=>f.before!==w.base[f.file]))throw new Error("元ファイルが変更されています。競合を自動上書きしません。");
      if(changes.some(f=>f.after==="missing"))throw new Error("削除は自動統合しません。主担当が検証して判断してください。");
    }
    const outputs=await Promise.all(changes.map(async f=>({...f,bytes:await data(w.path,f.file),destination:await safePath(root,f.file,true),mode:(await lstat(await safePath(w.path,f.file))).mode&0o777})));
    if(w.state==="active") {
      w.merge={digest:view.digest,files:changes};w.state="merging";await save();
    }
    const backup=dirname(await safePath(root,`.agent-harness/${c.taskId}/implementation/backups/${w.id}/intent.json`,true));
    // Save all backups before any destination writes; retries never replace a
    // backup. The ledger intent is persisted first, making every crash resumable.
    for(const f of outputs) {
      const bytesHash=createHash("sha256").update(Buffer.concat([Buffer.from(`${f.mode&0o111}:`),f.bytes])).digest("hex");
      if(bytesHash!==f.after)throw new Error("検査後に分離側ファイルが変更されました。再確認してください。");
      const current=await digest(root,f.file,true);
      if(current!==f.before&&current!==f.after)throw new Error("統合直前に競合を検出しました。元ファイルは上書きしません。");
      if(f.before!=="missing") {
        const dest=join(backup,hash(f.file));
        try {await copyFile(f.destination,dest,constants.COPYFILE_EXCL);}
        catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
        if(await digest(backup,hash(f.file))!==f.before)throw new Error("統合バックアップが基準と一致しません。上書きしません。");
      }
    }
    for(const f of outputs) {
      const current=await digest(root,f.file,true);
      if(current===f.after)continue;
      if(current!==f.before)throw new Error("統合中に競合を検出しました。保存済みの統合記録から復旧してください。");
      const tmp=`${f.destination}.harness-${randomUUID()}`;
      await writeFile(tmp,f.bytes,{flag:"wx",mode:f.mode});await rename(tmp,f.destination);
    }
    w.state="merged";w.changes=changes.map(f=>f.file);w.decision=request.reason;await save();return w;
  });
}

export const workspaceInstructions = `# General isolated implementation and integration
Only use isolated-work when real independent implementation reduces elapsed time or gives a useful independent alternative. This is a Git worktree, NOT a security sandbox or a separate CPU/GPU. Shared databases, ports, GPUs, external services and jobs are still shared: no parallel benchmarks/jobs or external side effects through this feature. Plan serial primary-work for such work, shared files, uncertain ownership or a dirty/uncommitted repository. Workers must not commit/reset, change Git metadata, shared reports, shared files or another worktree. Write only ownedFiles. Keep build scratch outside the worktree in a task-specific temporary directory; retain relevant test evidence among ownedFiles. Never change goal or tolerance to pass a test.
Main owner: call workspace_manage with request={action:"snapshot"}. Completed workers do NOT mean integrated or verified. For each completed workspace call {action:"inspect",id}, read the actual diff/newFiles under the returned path, inspect test evidence and verify as appropriate. Accept via {action:"merge",id,digest:"exact inspected digest",reason:"what you checked and why acceptable"}. This copies only owned regular files with unchanged shared baselines. It does not certify test correctness: run integration/regression tests in the shared workspace afterwards. To decline changes use {action:"discard",id,reason}; files remain for recovery and the original goal still must be met. Never copy around a rejected merge or edit the ledger directly. A partial merge is retried with its saved merge.digest; never erase conflicts.
Dependent work does not see a predecessor's unmerged tree. Insert a primary-work integration milestone before any downstream package needing those files. Commit deliberately only after integration/testing if another isolated wave needs a clean baseline; no automatic commit or reset. Keep the final report and independent reviews in the app-owned stages.`;

if (require.main===module) (async()=>{
  const [path,value]=process.argv.slice(2), config=JSON.parse(await readFile(path,"utf8"));
  await assertHpcRunActive(dirname(path),config.token);
  process.stdout.write(JSON.stringify(await workspaceOperation(config.context,JSON.parse(value)))+"\n");
})().catch(e=>{process.stderr.write(String(e)+"\n");process.exitCode=1;});
