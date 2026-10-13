import { readFile, mkdir, lstat, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { JsonFileWriter } from "./json-file-writer";
import type { RateLimitObservation } from "./usage-tracker";

export function antigravityQuota(value: any, now = Date.now()): { observation: RateLimitObservation; observedAt: string } | undefined {
  if (value?.version !== 1 || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt)) || Date.parse(value.observedAt) > now + 60_000
    || !value.quota || typeof value.quota !== "object" || Array.isArray(value.quota)) return;
  const windows = Object.entries(value.quota).slice(0,100).flatMap(([id, q]: [string, any]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._():/-]{0,119}$/.test(id) || !q || typeof q.remaining_fraction !== "number" || !Number.isFinite(q.remaining_fraction) || q.remaining_fraction < 0 || q.remaining_fraction > 1) return [];
    const resetAt = typeof q.reset_time === "string" && /^\d{4}-\d\d-\d\dT/.test(q.reset_time) && Number.isFinite(Date.parse(q.reset_time)) ? new Date(q.reset_time).toISOString() : undefined;
    // The official payload can contain either model IDs or shared bucket IDs.
    // Do not invent a per-model mapping or mark the entire service exhausted.
    const label = id === "gemini-weekly" ? "Gemini · 週の共有枠" : id === "3p-weekly" ? "Claude / GPT · 週の共有枠" : id;
    return [{ id:`agy:${id}`, label, scope:"unknown" as const, usedPercent:Math.round((1-q.remaining_fraction)*10000)/100, resetAt,
      detail:`残り ${(q.remaining_fraction*100).toFixed(1)}% · CLI報告` }];
  });
  if (!windows.length) return;
  return { observedAt:value.observedAt, observation:{ limited:false, replaceQuota:true, windows,
    plan:["Free","Pro","Ultra","AI Pro","AI Ultra"].includes(value.plan) ? value.plan : undefined } };
}

export async function readAntigravityUsage(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 262144) throw new Error();
    const result = antigravityQuota(JSON.parse(await readFile(path,"utf8")));
    if (!result) throw new Error();
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Antigravity Usageの観測データを読み取れません。前回値を保持しています。");
  }
}

const quote = (value:string) => `'${value.replaceAll("'", "'\\''")}'`;
const usageCommand = (script:string, executable:string, snapshot:string) => `ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(script)} ${quote(snapshot)}`;
export interface AntigravityUsageLink {
  state: "enabled" | "not-configured" | "conflict" | "unavailable";
  detail: string;
}

/** Inspect the actual hook, not a possibly stale quota snapshot. Reading this
 * setting never installs a hook or returns authentication/configuration data. */
export async function readAntigravityUsageLink(home:string, script:string, executable:string, snapshot:string): Promise<AntigravityUsageLink> {
  const path=join(home,".gemini","antigravity-cli","settings.json");
  try {
    const info=await lstat(path);
    if (!info.isFile() || info.size>262144) throw new Error();
    const settings=JSON.parse(await readFile(path,"utf8"));
    if (!settings || typeof settings!=="object" || Array.isArray(settings)) throw new Error();
    const hook=settings.statusLine;
    if (hook && hook.command!==usageCommand(script,executable,snapshot))
      return {state:"conflict",detail:"既存の表示設定があるため、使用量の表示設定は変更しません。CLI内の /usage で残量を確認できます。"};
    if (hook?.type==="command" && hook.enabled===true)
      return {state:"enabled",detail:"使用量表示は設定済みです。CLIが報告した残量を自動で取り込みます。"};
    return {state:"not-configured",detail:"残量をこのアプリに表示する初回設定です。ログイン情報は変更しません。"};
  } catch (error) {
    return (error as NodeJS.ErrnoException).code==="ENOENT"
      ? {state:"not-configured",detail:"残量をこのアプリに表示する初回設定です。ログイン情報は変更しません。"}
      : {state:"unavailable",detail:"使用量の表示設定を読み取れません。「状態を更新」で再確認してください。"};
  }
}
export async function installAntigravityUsage(home:string, script:string, executable:string, snapshot:string) {
  const path=join(home,".gemini","antigravity-cli","settings.json");
  await mkdir(dirname(path),{recursive:true}); await mkdir(dirname(snapshot),{recursive:true});
  let original="", settings:any={};
  try {
    const info=await lstat(path);
    if (!info.isFile() || info.size>262144) throw new Error("Antigravity設定の形式を確認してください。");
    original=await readFile(path,"utf8"); settings=JSON.parse(original);
  } catch(error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  if (!settings || typeof settings!=="object" || Array.isArray(settings)) throw new Error("Antigravity設定の形式を確認してください。");
  const command=usageCommand(script,executable,snapshot);
  if (settings.statusLine && settings.statusLine.command!==command) throw new Error("既存のカスタムstatusLine設定があるため上書きしません。既存設定との統合が必要です。");
  if (original) {
    try { await copyFile(path,`${path}.before-harness-usage`,constants.COPYFILE_EXCL); }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=="EEXIST") throw error; }
    if (await readFile(path,"utf8")!==original) throw new Error("CLIが設定を更新しました。再試行してください。");
  }
  await new JsonFileWriter(path).write({...settings,statusLine:{type:"command",command,enabled:true,stack_with_default:true,padding:0}});
}
