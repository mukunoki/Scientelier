import { stripVTControlCharacters } from "node:util";
import type { AgentId } from "./types";
import type { RateLimitObservation } from "./usage-tracker";

/** Recognize a native quota failure, not a prompt discussing rate limits or a
 * source file containing HTTP 429. Live detection deliberately requires the
 * Antigravity error banner + its subscription/reset text + native Error ID. */
export function terminalQuota(agent: AgentId | undefined, screen: string, observedAt = Date.now()): RateLimitObservation | undefined {
  if (agent !== "antigravity") return;
  const text = stripVTControlCharacters(screen);
  const match = text.match(/(?:^|\n)\s*⚠\s*Individual quota reached\.\s*Please upgrade your subscription to increase your limits\.\s*Resets in\s*([\d.\s dhms]+)\.\s*Error ID:\s*[a-z0-9-]+/i);
  if (!match) return;
  let delay = 0;
  for (const [, n, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    delay += Number(n) * ({ d: 86400000, h: 3600000, m: 60000, s: 1000 }[unit] ?? 0);
  }
  return { limited: true, detail: match[0].trim().replace(/\s+/g, " ").slice(0, 600),
    ...(delay > 0 && delay < 366 * 86400000 ? {resetAt: new Date(observedAt + delay).toISOString()} : {}) };
}

/** Exit-only fallback for CLIs which return an explicit provider error without
 * a handoff. Do not scan arbitrary successful responses for quota words. */
export function exitedQuota(agent: AgentId | undefined, stdout: string, stderr: string): RateLimitObservation | undefined {
  const native = terminalQuota(agent, stdout);
  if (native) return native;
  const line = stripVTControlCharacters(`${stdout}\n${stderr}`).split(/\r?\n/).find(line =>
    /^\s*(?:Error[: ]|API Error:|✕\s*\[API Error:|ERROR[: ])[^\n]*(?:quota (?:exceeded|exhausted)|resource_exhausted|rate limit (?:reached|exceeded)|429\b.*(?:too many requests|rate limit)|credit balance is too low)/i.test(line));
  return line ? {limited:true,detail:line.trim().slice(0,600)} : undefined;
}
