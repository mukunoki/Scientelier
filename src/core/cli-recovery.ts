// Invoked by desktop retirement/recovery, never exposed as an agent MCP tool.
// No process killing or batch-job cancellation: inspect and retire one run only.
import { readFile, realpath, lstat, writeFile, unlink, rmdir, rename, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

async function json(path: string, maxBytes = 256000): Promise<any> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(`復旧記録の形式またはサイズが不正です：${path}（上限 ${maxBytes} bytes）`);
    return JSON.parse(await readFile(path,"utf8"));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) < 2) throw new Error("プロセス番号が不正です。");
  try { process.kill(pid as number,0);return true; }
  catch(e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
}
async function record(path: string, value: unknown): Promise<void> {
  // Replace the directory entry, never follow an existing result-file symlink.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}
export function legacyLaunchRejected(output: string, lock: string): boolean {
  const message=`同じタスクの遠隔CLIが動作中、または終了を確認できません。二重起動を防いでいます。接続先で ${lock}/owner.json のPIDとホストを確認してください。残存CLIがないことを確認した場合に限り、このロックを手動で取り除いてください。`;
  return output.replace(/\r\n/g,"\n").startsWith(`${message}\nTerminal exited (75).`);
}

export function legacySpawnRejected(output: string): boolean {
  // A native supervisor error at the very beginning, never model commentary.
  return output.replace(/\r\n/g,"\n").startsWith("spawn E2BIG\nTerminal exited (75).");
}

/** Legacy supervisors had no startup-failure receipt. Require the exact native
 * rejection plus a complete same-user /proc scan; absence of a file alone is
 * never evidence of exit. Environment contents stay here, never returned/logged. */
export function processPredates(statText:string,bootSeconds:number,ticksPerSecond:number,startedAt:number): boolean {
  // comm may contain spaces/parentheses; field 22 follows the final closing ).
  const close=statText.lastIndexOf(")"),fields=statText.slice(close+1).trim().split(/\s+/);
  const ticks=Number(fields[19]);
  if(close<0||!Number.isFinite(ticks)||ticks<0||!Number.isFinite(bootSeconds)||bootSeconds<=0||!Number.isFinite(ticksPerSecond)||ticksPerSecond<=0)return false;
  return (bootSeconds+ticks/ticksPerSecond)*1000 < startedAt-2000;
}

export async function noRunProcesses(procRoot: string, directory: string, token: string, startedAt?: number, diagnostic?: (reason:string)=>void): Promise<boolean> {
  const fail=(reason:string)=>{diagnostic?.(reason);return false;};
  if (!process.getuid) return false;
  const deadline=Date.now()+5000,uid=process.getuid();
  try {
    // The authenticated control bridge and its SSH ancestors are not children
    // of the assignment. A reconnection can make them newer than the failed run.
    const ancestors=new Set<number>();let ancestor=process.pid;
    while(ancestor>0&&!ancestors.has(ancestor)) {
      ancestors.add(ancestor);
      try {const text=await readFile(join(procRoot,String(ancestor),"stat"),"utf8");ancestor=Number(text.slice(text.lastIndexOf(")")+1).trim().split(/\s+/)[1]);}
      catch {break;}
    }
    let boot=NaN,hz=NaN;
    if(Number.isFinite(startedAt)) {
      boot=Number((await readFile(join(procRoot,"stat"),"utf8")).match(/^btime (\d+)$/m)?.[1]);
      const clock=await promisify(execFile)("getconf",["CLK_TCK"],{timeout:1000,maxBuffer:1024});hz=Number(clock.stdout.trim());
    }
    const entries=(await readdir(procRoot)).filter(id=>/^\d+$/.test(id));
    if(entries.length>30000)return fail("process count limit");
    for(const id of entries) {
      if(Date.now()>deadline)return fail("process scan timeout");
      if(ancestors.has(Number(id)))continue;
      try {
        const path=join(procRoot,id);
        if((await stat(path)).uid!==uid)continue;
        // A supervisor spawns a NEW process; systemd/sshd predating this launch
        // cannot be its CLI or descendants. Do not read their protected env.
        if(Number.isFinite(startedAt)&&processPredates(await readFile(join(path,"stat"),"utf8"),boot,hz,startedAt!))continue;
        for(const name of ["cmdline","environ"]) {
          const data=await readFile(join(path,name));
          if(data.length>2*1024*1024 || data.includes(directory) || data.includes(token))return fail(`PID ${id}: matching or oversized ${name}`);
        }
      } catch(e) {if(!["ENOENT","ESRCH"].includes((e as NodeJS.ErrnoException).code??""))return fail(`PID ${id}: ${(e as NodeJS.ErrnoException).code??"unreadable"}`);}
    }
    return true;
  } catch(e) {return fail(`process inventory: ${(e as NodeJS.ErrnoException).code??"unavailable"}`);}
}

export async function recoverRemoteRun(root: string, taskId: string, runId: string, action: "inspect"|"confirm"|"auto", manual = false,
  legacy?: {output?:string;expectedHost?:string;startedAt?:string}) {
  if (![taskId,runId].every(id=>/^[0-9a-f-]{36}$/.test(id)) || !["inspect","confirm","auto"].includes(action)) throw new Error("復旧対象が不正です。");
  const base=join(await realpath(root),".agent-harness",taskId),dir=join(base,"runs",runId);
  if (await realpath(dir)!==dir) throw new Error("復旧対象がリンクを含みます。");
  // New runs separate small control metadata from CLI arguments. Read older
  // launch records locally with a bounded allowance; never return their args.
  const launch=await json(join(dir,"session-control.json"),16000) ?? await json(join(dir,"launch.json"),8*1024*1024);
  if (typeof launch?.token!=="string" || !launch.token || ![join(base,"active.lock"),join(dir,"active.lock")].includes(launch.lock)) throw new Error("起動記録を確認できません。");
  const token=launch.token,host=hostname(),owner=await json(join(launch.lock,"owner.json"));
  const lockPath=await realpath(launch.lock).catch(e=>{if(e.code==="ENOENT")return undefined;throw e;});
  if (lockPath && lockPath!==launch.lock) throw new Error("実行ロックがリンクを含みます。");
  const child=await json(join(dir,"process.json")),exit=await json(join(dir,"exit.json"));
  const proof=await json(join(dir,"retirement-recovery.json"));
  if ((exit && exit.token!==token) || (proof && proof.token!==token)) throw new Error("CLIの終了・復旧記録が一致しません。");
  const own=owner?.token===token;
  if (child && child.token!==token) throw new Error("CLIのプロセス記録が一致しません。");
  const wrongHost=(own && owner.host!==host) || (child && child.host!==host) || (exit?.host && exit.host!==host);
  const supervisorAlive=!wrongHost && own ? alive(owner.pid) : false;
  const cliAlive=!wrongHost && child ? alive(child.pid) : false;
  const rejected=action==="auto" && !supervisorAlive && !cliAlive && !wrongHost && !child && !exit && legacy?.expectedHost===host
    && typeof legacy.output==="string" && legacy.output.length<8000
    && ((!lockPath && legacyLaunchRejected(legacy.output,launch.lock))
      || (own && owner.configPath===join(dir,"launch.json") && legacySpawnRejected(legacy.output)))
    && process.platform==="linux" && await noRunProcesses("/proc",dir,token,legacy.startedAt?Date.parse(legacy.startedAt):undefined);
  const proven=exit?.token===token || (proof?.token===token && proof.host===host && proof.confirmedAt && ["process-or-exit","user-confirmed","launch-rejected"].includes(proof.method)) || (!!child && !cliAlive && !supervisorAlive) || rejected;
  const stopped=!wrongHost && !supervisorAlive && !cliAlive && (proven || (action!=="auto" && manual===true));
  const detail=wrongHost ? "記録と同じホストに接続してください。別ホストからロックは解除しません。"
    : supervisorAlive || cliAlive ? `旧CLIが残っています。管理PID ${own?owner.pid:"不明"} / CLI PID ${child?.pid??"記録なし"}。旧CLIを終了して再確認してください。`
    : proven ? "前の担当の終了を確認しました。"
    : "終了記録が欠けています。復旧端末で旧CLIと子処理が残っていないことを確認し、手動確認チェックを入れてください。";
  if (action==="confirm" || (action==="auto" && stopped)) {
    if (!stopped) throw new Error(detail);
    // Re-read before changing only this token's lock. Never delete another run's lock.
    const current=await json(join(launch.lock,"owner.json"));
    if (JSON.stringify(current)!==JSON.stringify(owner)) throw new Error("実行状態が変わりました。再確認してください。");
    if (lockPath && !owner && launch.lock!==join(dir,"active.lock")) throw new Error("共有ロックの所有者記録がありません。復旧端末で他の担当が動いていないことと共有ロックを確認してください。");
    await record(join(dir,"retired.json"),{token});
    if (own) { await unlink(join(launch.lock,"owner.json"));await rmdir(launch.lock); }
    else if (lockPath && !owner) await rmdir(launch.lock); // Only this run's empty lock; never recursive removal.
    await record(join(dir,"retirement-recovery.json"),{token,host,method:rejected?"launch-rejected":proven?"process-or-exit":"user-confirmed",confirmedAt:new Date().toISOString()});
  }
  return {stopped,needsManualConfirmation:!wrongHost&&!supervisorAlive&&!cliAlive&&!proven,detail,directory:dir,supervisorPid:own?owner.pid:undefined,cliPid:child?.pid,control:{token,lock:launch.lock}};
}
