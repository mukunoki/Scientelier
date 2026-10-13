import type { ExecutionPlan, TaskRecord, WorkUnit } from "./types";

/** A teaching-only lesson already has its own reader/storyboard skills. Final
 * reviewers stay blind, and reporters never acquire missing substantive work. */
export function usesContentRefinement(task: TaskRecord, unit: WorkUnit): boolean {
  return !task.goalPreparation && !unit.orchestrator && !["reporter", "reviewer"].includes(unit.role)
    && !["consult", "review", "report"].includes(task.roundKind ?? "initial")
    && (unit.researchStage ?? task.workPreset?.manifest.id) !== "paper-explainer";
}

export function refinementPlanningGuidance(): string {
  return `# Early substantive refinement
Standard finishing flow in NEW autonomous primary plans: after a useful initial artifact/draft exists and before reporter handoff, the harness schedules ONE bounded content check (another eligible service when possible), then a response by this same lead within the SAME goal/round. Reserve a small realistic share for this feedback/response in the estimate; no new manager or extra acceptance requirement is introduced. Do not wait for a user followup to explain your method, test a worthwhile alternative or investigate an observed bottleneck already within scope. Final acceptance reviews remain separate. An unavailable advisory peer falls back to lead self-check, never a fake independent pass. Required evidence, permissions and retry limits remain binding.
For substantive work with meaningful uncertainty, normally plan an early content-improvement pass BEFORE polished report production. Specialists should contribute alternatives, mechanisms, bottleneck analysis, counterexamples and concrete improvements, not only source gathering or final correctness checks. Prefer different available model families/services when useful; do not force diversity or create unavailable launch requirements. Simple deterministic repairs, already verified work, limited remaining time or subscription headroom or no useful peer contribution may use direct work; explain that choice briefly.
Use ordinary tasks/dependencies: a bounded initial implementation or proposal -> stable-version peer suggestions/criticism -> primary-work that tries and evaluates useful suggestions -> final integration. Independent idea generation may come first; share those proposals only in a later synthesis/criticism package. Existing comparison groups keep their first proposals blind. Each peer needs a distinct substantive output, not a duplicate report audit. A single coupled problem can use this pattern without splitting production files. Isolated implementations remain subject to the existing worktree and resource rules.
Do not require an initial implementation when neutral problem text already supports useful reasoning. Start bounded alternative generation and adversarial counterexample analysis together with minimal environment preparation using the supported inputScope/allowTaskOnlyPeers extension. Then have the owner compare their findings and actually try promising suggestions. If only one peer is worthwhile, explain the concrete cost/benefit; a later bibliography pair is not a substitute for early substantive peer work. When captured scope permits small experimental idea prototypes, isolated-work may be used for independent candidates after a clean baseline, with exclusive final comparative measurements. Scope and feasibility always win over filling concurrency slots.
Keep useful independent work available during later owner milestones, not only initial brainstorming. Supply neutral compact immutable results directly in assignment text for inputScope=assignment analysis/counterexamples; do not let peers read changing files or certify execution from supplied claims. If authoritative source/file inspection is needed, schedule a workspace reader at a stable boundary instead. Start primary-source/closest-related-work checks early where available and distinguish metadata checks from full-text/edition verification. Shared-GPU measurements remain exclusive; a slow run is not permission to overlap experiments. Estimate concrete speed/quality/quota-distribution benefit, then integrate findings once; do not create extra managers, duplicate audits or mandatory maximum parallelism.
Optional supported field: refinement={"objective":"specific approved content to improve and how to assess it","proposalKeys":["alternative","challenge"],"applicationKey":"try_and_measure","stopWhen":"required work complete; no promising in-scope improvement remains"}. proposalKeys reference ordinary read-only investigation or permitted isolated-work tasks; applicationKey is a primary-work task depending transitively on ALL of them. Omit applicationKey to use the final primary integration. Use proposalKeys:[] for justified direct work. Existing plans without refinement remain valid.
Count every proposal, discussion and application in existing token/minute estimates and package limits. Reserve most effort for substantive creation, comparison and actual improvement, not merely documentation. The owner must test adopted suggestions where authorized, retain a valid baseline and report adopt/reject/defer with evidence. Neither extra candidates nor optimization/new experiments are mandatory outside the approved goal. stopWhen ends optional exploration only; it cannot waive required evidence, independent review or an unmet criterion. No new receipt or management document is required.`;
}

function savedRefinement(task: TaskRecord, unit: WorkUnit): ExecutionPlan | undefined {
  return [...(task.executionPlans ?? [])].reverse().find(p => p.revision === unit.planRevision
    && p.round === (task.roundNumber ?? 1) && p.goalRevision === task.goal?.revision && p.refinement);
}

/** Role bindings come from the validated saved graph, not keyword guesses in
 * a title. No peer verdict/content is disclosed to final or blind reviewers. */
export function contentRefinementContext(task: TaskRecord, unit: WorkUnit): string {
  if (!usesContentRefinement(task, unit) || unit.planPhase) return "";
  const plan = savedRefinement(task, unit), refinement = plan?.refinement;
  if (!plan || !refinement) return "";
  const key = unit.subtask?.key;
  if (key && refinement.proposalKeys.includes(key)) {
    return `# 内容改善の検討（最終合否レビューとは別）
対象：${refinement.objective}
担当した観点から、現状より良い方法・弱点を解消する変更・反例と対策を具体的に提案してください。既存案の誤り検査や文献一覧だけで終えず、改善理由、根拠、最小の試し方、費用とリスクを日本語の箇条書きで返します。変更不要という結論も根拠付きで可能です。採否は主担当が判断します。
読み取り専用なら編集・実験を行わず、分離実装なら許可されたownedFilesだけを使います。独立比較案の中立入力・他候補を見ない制約、指定された担当範囲を維持します。新しいゴール・必須基準・権限を追加しません。`;
  }
  // A same-step repair gets a new unit ID but retains the saved plan revision.
  // Bind final integration by role/revision so resumption retains the guidance.
  const application = refinement.applicationKey ? key === refinement.applicationKey : !!unit.primary;
  if (!application) return "";
  const peers = refinement.proposalKeys.map(k => {
    const peer = task.workUnits.find(u => u.id === plan.taskUnitIds[k]);
    return { key: k, title: peer?.title, state: peer?.state, cli: peer?.assignedAgentId };
  });
  return `# 内容改善の採否・実作業への反映
対象：${refinement.objective}
提案担当（結果は通常の引き継ぎで取得）：${JSON.stringify(peers)}
各提案を根拠で比較し、採用／不採用／保留と理由を既存の作業報告へ残してください。採用した提案は承認範囲内で実装・試作・解析・必要な評価へ反映し、改善前後と副作用を確認します。提案を並べてTeXへ転記するだけで済ませません。改善が確認できなければ有効な既存案を保持し、失敗・未実施と理由を明示します。主担当だけで行う場合も有望な代案と弱点を点検します。
探索を終える目安：${refinement.stopWhen}
目安は任意の追加探索を区切るためのものです。必須要件の未達を合格にせず、必要な修復は既存のneeds-workと具体的な残作業に返します。最終PDF・独立レビューは別工程です。新しい提出形式は不要です。`;
}
