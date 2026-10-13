import { writeFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseClaudeCapacityPayload } from "./claude-capacity";
import { claudeStatusIdentity } from "./runtime-identity";
import { join } from "node:path";

// Keep only quota data. Never persist prompts, transcript paths or credentials.
export function statusQuota(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;
  const limits = (payload as { rate_limits?: unknown }).rate_limits;
  try { return parseClaudeCapacityPayload(limits); } catch { return undefined; }
}
async function main() {
  const [path, token] = process.argv.slice(2);
  if (!path || !token) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 256_000) return; }
  const payload = JSON.parse(input), observation = statusQuota(payload), identity = claudeStatusIdentity(payload);
  // An exited session's temporary directory must not be recreated by a late hook.
  await stat(dirname(path));
  if (identity) {
    const target=join(dirname(path),"runtime-identity.json"),tmp=`${target}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify({token,identity}),{mode:0o600}); await rename(tmp,target);
  }
  if (!observation) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ token, observation, observedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, path);
  process.stdout.write(observation.windows!.map(w => `${w.label}: ${w.usedPercent}%`).join(" · "));
}
if (require.main === module) void main().catch(() => { /* Missing quota is unknown, never zero. */ });
