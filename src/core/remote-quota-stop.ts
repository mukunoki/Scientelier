import type { RemoteConnection } from "./remote-client";
import { posix } from "node:path";

interface RetirementOptions {
  recover?: () => Promise<{stopped:boolean;detail:string}>;
  timeoutMs?: number; // Short bounded waits for offline tests; desktop uses the default.
}
// Parallel reviewers can encounter the same historical barrier. Share one
// handshake/recovery instead of racing to remove the same lock twice.
const pending = new WeakMap<RemoteConnection,Map<string,Promise<void>>>();

/** An SSH/PTY disconnect alone cannot certify that a remote writer stopped.
 * Ask only this token's supervisor; wait for exit and lock release. */
export function stopRemoteForHandoff(client: RemoteConnection, directory: string, lock: string, token: string, options: RetirementOptions = {}): Promise<void> {
  let checks=pending.get(client);if(!checks){checks=new Map();pending.set(client,checks);}
  const key=JSON.stringify([directory,lock,token]),previous=checks.get(key);
  if(previous)return previous;
  const result=stopAndRecover(client,directory,lock,token,options).finally(()=>checks!.delete(key));
  checks.set(key,result);return result;
}

async function stopAndRecover(client: RemoteConnection, directory: string, lock: string, token: string, options: RetirementOptions): Promise<void> {
  const root = client.resolvedCwd;
  if (!root || !posix.isAbsolute(root)) throw new Error("遠隔作業フォルダが未確定です。");
  // Reads accept absolute paths, but the bridge restricts writes to relative
  // managed paths. Do not relax that boundary for termination requests.
  const managed = posix.relative(root,directory);
  if (!/^\.agent-harness\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/.test(managed)) throw new Error("遠隔担当の管理パスが不正です。");
  try {
    const saved=await client.request({op:"read",path:`${directory}/retirement-recovery.json`,maxBytes:4096});
    const proof=JSON.parse(Buffer.from(saved.data,"base64").toString("utf8"));
    if (proof.token===token && proof.confirmedAt && ["process-or-exit","user-confirmed","launch-rejected"].includes(proof.method)) return;
  } catch(e) {if ((e as NodeJS.ErrnoException).code!=="ENOENT") throw e;}
  await client.put(`${managed}/retired.json`, JSON.stringify({token}));
  await client.put(`${managed}/stop.json`, JSON.stringify({token}));
  await client.put(`${managed}/quota-stop.json`, JSON.stringify({token})); // Pre-handshake supervisor compatibility.
  const deadline = Date.now() + (options.timeoutMs ?? 15000);
  while (Date.now() < deadline) {
    try {
      const file = await client.request({op:"read",path:`${directory}/exit.json`,maxBytes:4096});
      const exit = JSON.parse(Buffer.from(file.data,"base64").toString("utf8"));
      if (exit.token !== token) throw new Error("遠隔CLIの終了記録が今回の担当と一致しません。");
      try {
        const response=await client.request({op:"read",path:`${lock}/owner.json`,maxBytes:16000});
        if (JSON.parse(Buffer.from(response.data,"base64").toString("utf8")).token!==token) return;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise(resolve => setTimeout(resolve,250));
  }
  if(options.recover) {
    const status=await options.recover();
    if(status.stopped)return;
    throw new Error(`遠隔CLIの終了を自動確認できません。${status.detail}`);
  }
  throw new Error("遠隔CLIの終了・実行ロック解除を確認できません。接続・実行環境の復旧で確認してください。");
}
