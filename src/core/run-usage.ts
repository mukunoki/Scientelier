import { readFile, readdir, stat, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { UsageRecord } from "./types";
import { transcriptIdentity, parseRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity";

const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function validRunUsage(v: any): v is UsageRecord {
  return v?.source === "reported" && count(v.inputTokens) && count(v.outputTokens)
    && (v.cachedInputTokens === undefined || count(v.cachedInputTokens));
}

// Only native session accounting, never terminal text, model claims or quotas.
// Claude messages may be repeated for streamed content blocks: count each id once.
export function transcriptUsage(provider: string, text: string, startedAt: number): UsageRecord | undefined {
  if (!Number.isFinite(startedAt)) return;
  let baseline: any, latest: any;
  const messages = new Map<string, UsageRecord>();
  for (const line of text.split("\n")) {
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) continue;
    if (provider === "codex" && e.type === "event_msg" && e.payload?.type === "token_count") {
      const v = e.payload.info?.total_token_usage;
      if (!count(v?.input_tokens) || !count(v?.output_tokens)) continue;
      if (at < startedAt) baseline = v; else latest = v;
    }
    if (provider === "claude" && at >= startedAt && e.type === "assistant" && !e.isSidechain) {
      const m = e.message, u = m?.usage;
      if (typeof m?.id !== "string" || !count(u?.input_tokens) || !count(u?.output_tokens)) continue;
      const cached = count(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0;
      const created = count(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
      const value: UsageRecord = {source:"reported",inputTokens:u.input_tokens + cached + created,outputTokens:u.output_tokens,cachedInputTokens:cached};
      const old = messages.get(m.id);
      messages.set(m.id, { ...value, inputTokens:Math.max(old?.inputTokens ?? 0,value.inputTokens!), outputTokens:Math.max(old?.outputTokens ?? 0,value.outputTokens!) });
    }
  }
  if (provider === "codex" && latest) {
    const inputTokens = latest.input_tokens - (baseline?.input_tokens ?? 0);
    const outputTokens = latest.output_tokens - (baseline?.output_tokens ?? 0);
    const cachedInputTokens = (latest.cached_input_tokens ?? 0) - (baseline?.cached_input_tokens ?? 0);
    const value = {source:"reported" as const,inputTokens,outputTokens,cachedInputTokens};
    return validRunUsage(value) ? value : undefined; // A reset is unknown, not negative consumption.
  }
  if (messages.size) return [...messages.values()].reduce((a, b) => ({source:"reported",inputTokens:a.inputTokens! + b.inputTokens!,outputTokens:a.outputTokens! + b.outputTokens!,cachedInputTokens:a.cachedInputTokens! + b.cachedInputTokens!}), {source:"reported",inputTokens:0,outputTokens:0,cachedInputTokens:0});
}

async function codexTranscript(id: unknown): Promise<string | undefined> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  let inspected = 0;
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    if (depth > 3 || inspected > 20000) return;
    const entries = (await readdir(dir, {withFileTypes:true})).sort((a,b)=>b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (++inspected > 20000) return;
      if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) return join(dir,entry.name);
      if (entry.isDirectory()) { const file = await walk(join(dir,entry.name),depth+1); if (file) return file; }
    }
  };
  return walk(join(process.env.CODEX_HOME || join(homedir(),".codex"),"sessions"),0);
}

export async function captureRunUsage(provider: string, payload: any, directory: string, token: string): Promise<void> {
  try {
    const config = JSON.parse(await readFile(join(directory,"metrics-config.json"),"utf8"));
    if (config.token !== token || !Number.isFinite(config.startedAt) || payload?.agent_id || payload?.parent_tool_use_id) return;
    let usage: UsageRecord | undefined, identity: RuntimeIdentity | undefined;
    if (provider === "opencode") {
      if (validRunUsage(payload?.usage)) usage=payload.usage;
      identity=parseRuntimeIdentity(payload?.identity);
      if (identity && Date.parse(identity.observedAt) < config.startedAt) identity=undefined;
    } else {
      const file = provider === "claude" ? payload?.transcript_path : provider === "codex" ? await codexTranscript(payload?.["thread-id"]) : undefined;
      if (typeof file !== "string") return;
      const info = await stat(file); if (!info.isFile() || info.size > 64 * 1024 * 1024) return;
      const transcript = await readFile(file,"utf8");
      usage = transcriptUsage(provider, transcript,config.startedAt);
      identity = transcriptIdentity(provider,transcript,config.startedAt,provider === "codex" ? payload["thread-id"] : payload.session_id);
    }
    if (identity) {
      const path = join(directory,"runtime-identity.json"), temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary,JSON.stringify({token,identity}),{mode:0o600}); await rename(temporary,path);
    }
    if (!usage) return;
    const path = join(directory,"usage.json"), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify({token,usage}),{mode:0o600}); await rename(temporary,path);
  } catch { /* Telemetry failures never block work or authorize completion. */ }
}
