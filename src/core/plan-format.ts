import type { ExecutionPlan, SubtaskSpec, WorkRequirements } from "./types";

// No runtime dependencies: the same validator runs in the desktop and remote MCP helper.
export interface PlanContract {
  criterionIds: string[];
  requiredCriterionIds: string[];
  maxSubtasks: number;
  allowPrimarySteps?: boolean;
  allowIsolatedWork?: boolean;
  allowAlternativeWork?: boolean;
  allowResearchCritic?: boolean;
}
export class PlanFormatError extends Error {}
export const modelFamilies = ["openai", "anthropic", "gemini", "deepseek", "glm"] as const;
// Portable validation is shared by the desktop and remote result-channel.
export function validateWorkRequirements(value: unknown): WorkRequirements | undefined {
  if (value === undefined) return;
  const v = value as WorkRequirements;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k=>!["modelFamilies","independentFrom","independenceGroup","skills"].includes(k))) throw new PlanFormatError("requirements は modelFamilies / independentFrom / independenceGroup / skills だけを指定してください。");
  const strings = (a: unknown, max: number): a is string[] => Array.isArray(a) && a.length > 0 && a.length <= max && a.every(x=>typeof x === "string" && /^[a-zA-Z0-9_-]+$/.test(x) && x.length <= 100) && new Set(a).size === a.length;
  if (v.modelFamilies !== undefined && (!strings(v.modelFamilies,5) || v.modelFamilies.some(x=>!(modelFamilies as readonly string[]).includes(x)))) throw new PlanFormatError("requirements.modelFamilies は openai / anthropic / gemini / deepseek / glm の重複しない配列です。");
  if (v.independentFrom !== undefined && !strings(v.independentFrom,8)) throw new PlanFormatError("requirements.independentFrom は比較対象の計画キーの配列です。");
  if(v.independenceGroup!==undefined && (!strings([v.independenceGroup],1)||!v.modelFamilies?.length))throw new PlanFormatError("independenceGroup にはグループ名と明示的な modelFamilies が必要です。");
  if (v.skills !== undefined && (!Array.isArray(v.skills) || !v.skills.length || v.skills.length > 20 || v.skills.some(s=>!s || typeof s !== "object" || Object.keys(s).some(k=>!["id","revision"].includes(k)) || !strings([s.id],1) || (s.revision !== undefined && (typeof s.revision !== "string" || !/^[a-f0-9]{64}$/.test(s.revision)))) || new Set(v.skills.map(s=>s.id)).size!==v.skills.length)) throw new PlanFormatError("requirements.skills は {id, revision?:SHA256} の重複しない配列です。");
  return {...(v.independenceGroup?{independenceGroup:v.independenceGroup}:{}),...(v.modelFamilies?{modelFamilies:[...v.modelFamilies]}:{}),...(v.independentFrom?{independentFrom:[...v.independentFrom]}:{}),...(v.skills?{skills:v.skills.map(s=>({...s}))}:{})};
}
export type PlanInput = Pick<ExecutionPlan, "summary" | "reason" | "primaryWork" | "acceptance" | "criterionIds" | "estimatedTokens" | "estimatedMinutes" | "escalation" | "tasks" | "coordination" | "refinement">;
const fail = (path: string, rule: string): never => { throw new PlanFormatError(`実行計画の ${path}: ${rule}`); };
function text(value: unknown, path: string, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(path, `空でない文字列（${max}文字以内）が必要です。`);
}
function criteria(value: unknown, path: string, contract: PlanContract): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20 || value.some(id => !contract.criterionIds.includes(id)))
    fail(path, `承認済みIDの配列（1〜20件）が必要です。使用可能: ${contract.criterionIds.join(", ")}`);
}
function tokens(value: unknown, path: string): asserts value is number {
  // Estimates are not context limits. Large multi-step work can exceed 100k.
  if (!Number.isSafeInteger(value) || (value as number) < 500) fail(path, "500以上の安全な整数を数値型で指定してください。これは記録用の目安で、起動制限や契約の残量ではありません。");
}
export function validatePlanTasks(value: unknown, contract: PlanContract): SubtaskSpec[] {
  if (!Array.isArray(value) || value.length > contract.maxSubtasks) fail("tasks", `配列が必要です。分担は最大${contract.maxSubtasks}件、分担しない場合は []。`);
  const keys = new Set<string>();
  const tasks = (value as any[]).map((v, i) => {
    const path = `tasks[${i}]`;
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(path, "オブジェクトが必要です。");
    if (Object.keys(v).some(k=>!["key","title","instructions","deliverable","acceptance","criterionIds","dependsOn","estimatedTokens","kind","ownedFiles","estimatedMinutes","mode","capability","researchCritic","requirements","purpose","comparison","inputScope","allowTaskOnlyPeers","communication"].includes(k))) fail(path,"未対応の項目があります。割当・必須スキルの条件は requirements に記載してください。");
    if (v.purpose !== undefined && !["speed", "balance", "verify", "explore"].includes(v.purpose)) fail(`${path}.purpose`, "speed / balance / verify / explore のいずれかを指定してください。");
    text(v.key, `${path}.key`, 40);
    if (!/^[a-zA-Z0-9_-]+$/.test(v.key) || keys.has(v.key)) fail(`${path}.key`, "重複しない英数字・_・-のキーが必要です。");
    keys.add(v.key);
    const requirements = validateWorkRequirements(v.requirements);
    if(v.communication!==undefined){
      const c=v.communication;
      if(!c||typeof c!=="object"||Array.isArray(c)||Object.keys(c).some(k=>!["with","purpose"].includes(k))
        ||!Array.isArray(c.with)||!c.with.length||c.with.length>8||new Set(c.with).size!==c.with.length
        ||c.with.some((s:unknown)=>typeof s!=="string"||!/^[a-zA-Z0-9_-]{1,40}$/.test(s)))fail(`${path}.communication`,"with（相談先キーまたはlead）とpurposeを指定してください。");
      text(c.purpose,`${path}.communication.purpose`,1000);
      if(requirements?.independenceGroup||requirements?.independentFrom?.length||v.comparison||v.researchCritic)fail(`${path}.communication`,"独立案・独立照合には相談を追加できません。");
    }
    let comparison: SubtaskSpec["comparison"];
    if (v.comparison !== undefined) {
      if (!v.comparison || typeof v.comparison !== "object" || Array.isArray(v.comparison) || Object.keys(v.comparison).some(k => !["input", "evaluation", "approach"].includes(k))) fail(`${path}.comparison`, "input / evaluation / approach を指定してください。");
      for (const field of ["input", "evaluation", "approach"] as const) text(v.comparison[field], `${path}.comparison.${field}`, 2000);
      if (!requirements?.independenceGroup || requirements.independentFrom?.length) fail(`${path}.comparison`, "独立案には independenceGroup を指定し、independentFrom は付けないでください。");
      if (v.kind && v.kind !== "investigation" && !(v.kind === "isolated-work" && contract.allowAlternativeWork)) fail(`${path}.comparison`, "独立案は読み取り専用、または許可された一般実装の分離環境に限ります。HPCではまず読み取り専用で案を比較してください。");
      if (!(v.estimatedMinutes > 0)) fail(`${path}.estimatedMinutes`, "比較案ごとの正の所要時間見積もりが必要です。");
      comparison = { input: v.comparison.input, evaluation: v.comparison.evaluation, approach: v.comparison.approach };
    }
    for (const [field, max] of [["title", 150], ["instructions", 6000], ["deliverable", 1000], ["acceptance", 1000]] as const) text(v[field], `${path}.${field}`, max);
    criteria(v.criterionIds, `${path}.criterionIds`, contract);
    const estimatedTokens = v.estimatedTokens ?? (v.kind === "primary-work" ? 8000 : 3000);
    tokens(estimatedTokens, `${path}.estimatedTokens`);
    if (v.kind !== undefined && v.kind !== "investigation" && !(v.kind === "primary-work" && contract.allowPrimarySteps) && !(v.kind === "isolated-work" && contract.allowIsolatedWork)) fail(`${path}.kind`, "investigation または許可された primary-work / isolated-work を指定してください。");
    if (v.kind === "isolated-work" && (!Array.isArray(v.ownedFiles) || !v.ownedFiles.length || v.ownedFiles.length > 100 || v.ownedFiles.some((p: unknown) => typeof p !== "string" || p.length > 500 || /[\\\x00-\x1f\x7f]/.test(p) || p.split("/").some(s => !s || [".", "..", ".git", ".agent-harness"].includes(s.toLowerCase()))))) fail(`${path}.ownedFiles`, "分離実装には管理領域を除く相対ファイル名を1〜100件指定してください。");
    if (v.ownedFiles !== undefined && v.kind !== "isolated-work") fail(`${path}.ownedFiles`, "isolated-workだけに指定できます。");
    if (v.estimatedMinutes !== undefined && (!Number.isFinite(v.estimatedMinutes) || v.estimatedMinutes < 0 || v.estimatedMinutes > 10080)) fail(`${path}.estimatedMinutes`, "0〜10080の数値（分）が必要です。");
    if (v.mode !== undefined && v.mode !== "read") fail(`${path}.mode`, "分担は読み取り専用です。書き込み権限を追加できません。");
    if (v.inputScope !== undefined && (v.inputScope !== "assignment" || v.kind && v.kind !== "investigation" || v.researchCritic)) fail(`${path}.inputScope`, "通常の読み取り専用investigationだけにassignmentを指定できます。入力文だけで検討し、作業ファイル・実機・実験を参照しません。");
    if (v.allowTaskOnlyPeers !== undefined && (typeof v.allowTaskOnlyPeers !== "boolean" || v.kind !== "primary-work")) fail(`${path}.allowTaskOnlyPeers`, "primary-workだけに真偽値を指定できます。性能測定・ジョブ・資源排他が必要な工程では省略してください。");
    if (!Array.isArray(v.dependsOn) || v.dependsOn.length > 8 || v.dependsOn.some((id: unknown) => typeof id !== "string")) fail(`${path}.dependsOn`, "同じ計画内のキーの配列（最大8件）が必要です。依存なしは []。");
    if (v.capability !== undefined && !["reasoning", "coding", "agentic", "speed"].includes(v.capability)) fail(`${path}.capability`, "reasoning / coding / agentic / speed のいずれかを指定してください。");
    if (v.researchCritic !== undefined && (v.researchCritic !== true || !contract.allowResearchCritic || (v.kind && v.kind !== "investigation"))) fail(`${path}.researchCritic`, "研究モードの読取専用investigationだけにtrueを指定できます。");
    return { ...(v.communication?{communication:{with:[...v.communication.with],purpose:v.communication.purpose}}:{}), ...(comparison ? { comparison } : {}), ...(v.purpose ? { purpose: v.purpose } : {}), ...(requirements ? { requirements } : {}), ...(v.researchCritic ? { researchCritic: true } : {}), ...(v.capability ? { capability: v.capability } : {}), key: v.key, title: v.title, instructions: v.instructions, deliverable: v.deliverable, acceptance: v.acceptance,
      criterionIds: [...new Set<string>(v.criterionIds)], dependsOn: [...new Set<string>(v.dependsOn)], estimatedTokens,
      ...(v.kind ? { kind: v.kind } : {}), ...(v.inputScope ? { inputScope: v.inputScope } : {}), ...(v.allowTaskOnlyPeers === undefined ? {} : { allowTaskOnlyPeers: v.allowTaskOnlyPeers }), ...(v.kind === "isolated-work" ? { ownedFiles: [...new Set<string>(v.ownedFiles)] } : {}), ...(v.estimatedMinutes === undefined ? {} : { estimatedMinutes: v.estimatedMinutes }) } as SubtaskSpec;
  });
  const done = new Set<string>();
  for(const task of tasks)for(const peer of task.communication?.with??[]) {
    if(peer===task.key||peer!=="lead"&&!tasks.some(t=>t.key===peer))fail("communication.with","同じ計画の別担当キーかleadを指定してください。");
    const target=tasks.find(t=>t.key===peer);
    if(target&&(target.requirements?.independenceGroup||target.requirements?.independentFrom?.length||target.comparison||target.researchCritic))fail("communication.with","独立担当へ相談を配信できません。");
  }
  // Diversity is a launch constraint, not a data dependency. Disjoint allowed
  // families are enforced by existing routing even across retries/fallbacks.
  for(const name of new Set(tasks.map(t=>t.requirements?.independenceGroup).filter(Boolean))) {
    const peers=tasks.filter(t=>t.requirements?.independenceGroup===name);
    const comparing = peers.some(t => t.comparison);
    if(peers.length<2||peers.some(t=>t.kind&&t.kind!=="investigation"&&!(comparing&&t.comparison&&t.kind==="isolated-work")))fail("requirements.independenceGroup","2件以上の独立照合、または比較案が必要です。");
    if (comparing) {
      const first = peers[0];
      const sorted = (values: string[]) => [...values].sort().join("\n");
      if (peers.length > 3 || peers.some(t => !t.comparison || t.comparison.input !== first.comparison?.input || t.comparison.evaluation !== first.comparison?.evaluation || sorted(t.dependsOn) !== sorted(first.dependsOn) || sorted(t.criterionIds) !== sorted(first.criterionIds))) fail("comparison", "2〜3案で同じinput・evaluation・達成条件・前提工程を共有してください。");
      if (peers.some(t => t.dependsOn.some(k => peers.some(p => p.key === k)))) fail("comparison", "候補同士を依存先にせず、同じ中立な入力から独立に実行してください。");
      if (new Set(peers.map(t => t.comparison!.approach.trim())).size !== peers.length) fail("comparison.approach", "各案の異なる解法・仮説・観点を明示してください。");
      // A downstream milestone must not select an early finisher without seeing
      // its rivals. Final primary integration already waits for every candidate.
      for (const consumer of tasks.filter(t => t.dependsOn.some(k => peers.some(p => p.key === k)))) {
        if (consumer.kind !== "primary-work" || peers.some(p => !consumer.dependsOn.includes(p.key))) fail("comparison", "比較案の後続は全候補に依存するprimary-workの比較・選択工程にしてください。");
      }
    }
    const families=peers.flatMap(t=>t.requirements!.modelFamilies!);
    if(new Set(families).size!==families.length)fail("requirements.independenceGroup","同じグループの modelFamilies は互いに重複しないように指定してください。");
  }
  for (const task of tasks) for (const key of task.requirements?.independentFrom ?? []) {
    if (key === task.key || !keys.has(key) || !task.dependsOn.includes(key)) fail("requirements.independentFrom", "同じ計画内の直接依存先キーを指定してください。比較対象を先に完了させます。");
  }
  const owned = tasks.filter(t => t.kind === "isolated-work").flatMap(t => t.ownedFiles!).map(p=>p.normalize("NFC").toLowerCase());
  if (new Set(owned).size !== owned.length || owned.some(p => owned.some(q => p !== q && q.startsWith(p + "/")))) fail("tasks.ownedFiles", "分離担当間のファイル範囲が重複しています。");
  // A dependency edge alone cannot expose an unmerged worktree to another
  // reader/writer. An explicit shared integration milestone must intervene.
  for (const task of tasks) if (task.kind !== "primary-work" && task.dependsOn.some(key => tasks.find(t=>t.key===key)?.kind === "isolated-work"))
    fail("tasks.dependsOn", "分離実装の成果を使う前にprimary-workの統合工程を挟んでください。");
  while (done.size < tasks.length) {
    const ready = tasks.filter(t => !done.has(t.key) && t.dependsOn.every(key => done.has(key)));
    if (!ready.length) fail("tasks.dependsOn", "循環・自己依存・存在しない依存先があります。");
    ready.forEach(t => done.add(t.key));
  }
  return tasks;
}
export function validatePlanFormat(v: any, contract: PlanContract): PlanInput {
  const allowed = ["summary", "reason", "primaryWork", "acceptance", "criterionIds", "estimatedTokens", "estimatedMinutes", "escalation", "tasks", "coordination", "refinement"];
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) fail("項目", "未対応の項目があります。ゴール・予算・権限は計画から変更できません。");
  for (const key of ["summary", "reason", "primaryWork", "acceptance", "escalation"]) text(v[key], key, 4000);
  criteria(v.criterionIds, "criterionIds", contract);
  const estimatedTokens = v.estimatedTokens ?? 8000;
  tokens(estimatedTokens, "estimatedTokens");
  if (!Number.isFinite(v.estimatedMinutes) || v.estimatedMinutes < 0 || v.estimatedMinutes > 10080) fail("estimatedMinutes", "0〜10080の数値（分）が必要です。目安であり強制終了時刻ではありません。");
  const tasks = validatePlanTasks(v.tasks, contract);
  let refinement: ExecutionPlan["refinement"];
  if (v.refinement !== undefined) {
    const r = v.refinement;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(k => !["objective", "proposalKeys", "applicationKey", "stopWhen"].includes(k))) fail("refinement", "objective / proposalKeys / applicationKey / stopWhen だけを指定してください。");
    text(r.objective, "refinement.objective", 1500); text(r.stopWhen, "refinement.stopWhen", 1500);
    if (!Array.isArray(r.proposalKeys) || r.proposalKeys.length > contract.maxSubtasks
      || new Set(r.proposalKeys).size !== r.proposalKeys.length
      || r.proposalKeys.some((key: unknown) => typeof key !== "string" || !tasks.some(t => t.key === key && (t.kind === undefined || t.kind === "investigation" || t.kind === "isolated-work"))))
      fail("refinement.proposalKeys", "同じ計画の検討担当キーを重複なく指定してください。単独で進める場合は []。");
    if (r.applicationKey !== undefined) {
      text(r.applicationKey, "refinement.applicationKey", 40);
      const application = tasks.find(t => t.key === r.applicationKey);
      if (!application || application.kind !== "primary-work") fail("refinement.applicationKey", "提案を反映する主担当のprimary-workキーを指定するか、省略して最終統合へ渡してください。");
      // The application cannot race its suggestions. Follow the validated DAG,
      // allowing an intermediate synthesis/discussion before actual changes.
      const ancestors = new Set<string>();
      const visit = (key: string) => { for (const dep of tasks.find(t => t.key === key)!.dependsOn) if (!ancestors.has(dep)) { ancestors.add(dep); visit(dep); } };
      visit(application!.key);
      if (r.proposalKeys.some((key: string) => !ancestors.has(key))) fail("refinement.applicationKey", "反映工程はすべての検討担当に直接または間接に依存させてください。");
    }
    refinement = { objective: r.objective, proposalKeys: [...r.proposalKeys], stopWhen: r.stopWhen, ...(r.applicationKey === undefined ? {} : { applicationKey: r.applicationKey }) };
  }
  let coordination: ExecutionPlan["coordination"];
  if (v.coordination !== undefined) {
    if (!v.coordination || typeof v.coordination !== "object" || Array.isArray(v.coordination)) fail("coordination", "作業効率の方針をオブジェクトで指定してください。");
    const keys = ["criticalPath", "parallelBenefit", "contextPlan", "resourcePlan"] as const;
    if (Object.keys(v.coordination).some(k => !(keys as readonly string[]).includes(k))) fail("coordination", "未対応の項目があります。");
    for (const key of keys) text(v.coordination[key], `coordination.${key}`, 2000);
    coordination = Object.fromEntries(keys.map(k => [k, v.coordination[k]])) as ExecutionPlan["coordination"];
  }
  const covered = new Set([...v.criterionIds, ...tasks.flatMap(t => t.criterionIds)]);
  const missing = contract.requiredCriterionIds.filter(id => !covered.has(id));
  if (missing.length) fail("criterionIds", `担当のない必須達成条件があります: ${missing.join(", ")}`);
  const total = estimatedTokens + tasks.reduce((sum, t) => sum + t.estimatedTokens, 0);
  if (!Number.isSafeInteger(total)) fail("estimatedTokens", "合計見積もりが安全な整数範囲を超えています。");
  return { summary: v.summary, reason: v.reason, primaryWork: v.primaryWork, acceptance: v.acceptance,
    escalation: v.escalation, criterionIds: [...new Set<string>(v.criterionIds)], estimatedTokens, estimatedMinutes: v.estimatedMinutes, tasks, ...(coordination ? { coordination } : {}), ...(refinement ? { refinement } : {}) };
}
