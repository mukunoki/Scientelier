import { readFile, writeFile, appendFile, rename, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export interface SkillRead { id: string; revision: string; bytes: number; calls: number; }
export interface SkillUsage { source: "mcp"; reads: SkillRead[]; estimatedTokens: number; truncated: boolean; }
export const SKILL_LOG_LIMIT = 256000;

// Small append-only events avoid read/modify/write races between MCP processes.
// This is observation, not an authorization or completion receipt. No bodies.
export async function recordSkillRead(directory: string, token: string, id: string, content: string): Promise<void> {
  try {
    const path = join(directory, "skill-reads.jsonl");
    const info = await lstat(path).catch(() => undefined);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size >= SKILL_LOG_LIMIT)) return;
    await appendFile(path, JSON.stringify({ token, id, revision: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content, "utf8") }) + "\n", { mode: 0o600 });
  } catch { /* Telemetry failure must not prevent skill retrieval. */ }
}

export async function readSkillUsage(directory: string, token: string): Promise<SkillUsage | undefined> {
  try {
    const path = join(directory, "skill-reads.jsonl"), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > SKILL_LOG_LIMIT + 16000) return;
    const reads = new Map<string, SkillRead>();
    let estimatedTokens = 0;
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      let v; try { v = JSON.parse(line); } catch { continue; }
      if (!v || typeof v !== "object" || v.token !== token || typeof v.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(v.id)
        || typeof v.revision !== "string" || !/^[a-f0-9]{64}$/.test(v.revision)
        || !Number.isSafeInteger(v.bytes) || v.bytes < 1 || v.bytes > 400000) continue;
      const key = `${v.id}:${v.revision}`;
      if (!reads.has(key) && reads.size >= 48) continue;
      const entry = reads.get(key) ?? { id: v.id, revision: v.revision, bytes: v.bytes, calls: 0 };
      entry.calls++; reads.set(key, entry);
      estimatedTokens += Math.ceil(v.bytes / 3); // Same heuristic as tokenEstimate, not billing.
    }
    return { source: "mcp", reads: [...reads.values()], estimatedTokens, truncated: info.size >= SKILL_LOG_LIMIT };
  } catch { return; }
}

export interface ChannelState { token: string; phase: "connected" | "instructions-read"; at: string; }
export async function recordChannelState(directory: string, token: string, phase: ChannelState["phase"]): Promise<void> {
  const path = join(directory, "channel-state.json");
  const previous = await readChannelState(directory, token);
  // Re-initializing the same server must not erase a successful instruction read.
  if (previous?.phase === "instructions-read") return;
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ token, phase, at: new Date().toISOString() }), { mode: 0o600 });
  await rename(temp, path);
}
export async function readChannelState(directory: string, token: string): Promise<ChannelState | undefined> {
  try {
    const path = join(directory, "channel-state.json");
    if ((await stat(path)).size > 4096) return;
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.token === token && ["connected", "instructions-read"].includes(value.phase) && typeof value.at === "string") return value;
  } catch { /* Missing or corrupt diagnostics do not certify a connection. */ }
}
