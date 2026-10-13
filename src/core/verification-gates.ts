// A failed/temporarily unreadable gate must not hide other repair work. Keep
// checks sequential because remote snapshots may deploy shared runtime files.
export function groupVerificationFindings(findings: Array<{label: string; reason: string}>): string[] {
  const groups = new Map<string, Set<string>>();
  for (const finding of findings) {
    const labels = groups.get(finding.reason) ?? new Set<string>();
    labels.add(finding.label); groups.set(finding.reason, labels);
  }
  return [...groups].map(([reason, labels]) => `${[...labels].join(" / ")}: ${reason}`);
}
export async function collectVerificationProblems(checks: Array<{
  label: string;
  inspect: () => Promise<string[]>;
  repair: string;
}>): Promise<string[]> {
  const problems: string[] = [];
  for (const check of checks) {
    try {
      const findings = await check.inspect();
      if (findings.length) problems.push(`${check.label}：`, ...findings, check.repair);
    } catch (error) {
      problems.push(`${check.label}：検証状態を確認できません。${error instanceof Error ? error.message : String(error)}`, check.repair);
    }
  }
  return problems;
}
