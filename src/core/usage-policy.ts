import type { AgentPolicy, OrchestrationSettings } from "./types";

/** A quota belongs to a service/account, not to a terminal. If multiple enabled
 * CLIs share it, use the most conservative configured threshold consistently. */
export function serviceUsageLimit(settings: OrchestrationSettings, policy: AgentPolicy): number {
  const members = settings.agentPolicies.filter(p => p.enabled && p.providerKey === policy.providerKey);
  return Math.min(...(members.length ? members : [policy]).map(p => p.usageLimitPercent ?? settings.drainPercent));
}
