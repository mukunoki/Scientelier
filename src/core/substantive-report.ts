/** Presentation data, NEVER acceptance evidence or permission to advance.
 * Optional so old/partial submissions cannot get stuck on another schema. */
export interface SubstantiveReport {
  proposals: string[];
  activities: string[];
  results: string[];
  interpretation: string[];
  nextSteps: string[];
  issues: string[];
}
export function readSubstantiveReport(value: unknown): SubstantiveReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const fields = ["proposals", "activities", "results", "interpretation", "nextSteps", "issues"] as const;
  const report = value as Record<string, unknown>;
  if (JSON.stringify(report).length > 24000) return;
  if (Object.keys(report).some(k => !fields.includes(k as typeof fields[number]))) return;
  const result = {} as SubstantiveReport;
  for (const key of fields) {
    const items = report[key] ?? [];
    if (!Array.isArray(items) || items.length > 12 || items.some(s => typeof s !== "string" || !s.trim() || s.length > 1600)) return;
    result[key] = items.map(s => s.trim());
  }
  return fields.some(k => result[k].length) ? result : undefined;
}

export const substantiveReportGuidance = `# Research and development reporting
Report SUBJECT-MATTER progress in Japanese, not a compliance diary. Lead with the problem, proposed hypotheses/designs and alternatives, actual implementation/experiments/analysis, observed successes/failures with conditions and evidence, interpretation, and the next concrete decision. Do not substitute skill names, checklist counts, ledger receipts, instruction adherence or model identities for scientific/engineering results. Differentiate observed facts from hypotheses; distinguish a valid negative experiment from an implementation defect or an experiment never performed. A broken implementation is a repair target, not proof that a method cannot work.
Keep requirement, citation, experimental-specification and document defects in a short issues section. Material defects invalidating results also belong beside those results; do not hide uncertainty or mark unverified work as successful. Reviewers provide concrete defects, reproduction conditions and useful improvements; primary owners synthesize findings and try promising repairs/alternatives before polishing a manuscript. Reports explain what changed and what was learned, not just whether a gate passed.
In an existing work-check you MAY add workReport={"proposals":[],"activities":[],"results":[],"interpretation":[],"nextSteps":[],"issues":[]}, with concise Japanese bullet strings and actual conditions/values/evidence references where available. This optional display field never replaces summary, remainingWork or exact evidence paths and is not a new completion requirement. Empty categories may be omitted. Specialists without a work-check use these headings in normal prose; do not invent a new submission protocol. Final primary integration should summarize the research/development findings across the team. Planning should describe proposed work, never invented completed results.
Write one coherent subject manuscript with background/introduction, methods, evidence-based results, discussion and conclusion as appropriate to the approved output. Close paragraphs with their actual result, interpretation or main point, not a repeated denial or unverified-work disclaimer (for example Japanese endings such as しない, できない, ではない or とみなさない). Put limitations beside the claims they qualify instead of repeating the same disclaimer at every paragraph end. Scientifically necessary negation, counterexamples, valid negative results and uncertainty must remain explicit; a negative conclusion is appropriate when it IS the paragraph's main finding. Do not mechanically replace negative endings with positive claims or invent success to improve the tone. Writers, final editors and independent reviewers should inspect the whole paragraph, not only its last words. Keep operational work history and policy compliance in application records, not the paper.`;
