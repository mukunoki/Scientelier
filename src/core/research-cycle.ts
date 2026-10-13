// Evidence-backed research state. Shares the portable, symlink-safe I/O and
// cross-process lock with HPC; never executes experiments or arbitrary commands.
import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePath, data, digest, locked, assertHpcRunActive, recoverLedgerLock } from "./hpc";
import type { TaskRecord, WorkUnit, AgentId } from "./types";

export interface ResearchContext { root: string; taskId: string; actor: string; cli: string; write: boolean; manage: boolean; blind?: boolean; critic?: boolean; user?: boolean; requireOutputContract?: boolean; }
interface Metric { id: string; direction: "min" | "max"; tolerance: number; subset: boolean; }
interface OutputRequirement { id: string; format: "file" | "json"; requiredKeys?: string[]; nonEmptyKeys?: string[]; }
interface Protocol { question: string; metrics: Metric[]; files: Record<string, string>; maxExperiments: number; outputs?: OutputRequirement[]; }
interface Candidate { id: string; parent?: string; hypothesis: string; limitation: string; novelty: string; falsifier: string; sources: string[]; }
interface Experiment {
  id: string; candidate?: string; stage: "baseline-subset" | "baseline-full" | "subset" | "full" | "ablation" | "rebuttal";
  cli: string; actor: string; at: string; purpose: string; result: string; metrics: Record<string, number>;
  files: Record<string, string>; comparedTo?: string; prerequisite?: string; decision: "baseline" | "advance" | "refine" | "analysis";
  stale?: boolean; critique?: { cli: string; actor: string; verdict: "accept" | "refine" | "reject"; reason: string };
}
export interface ResearchLedger { version: 1; revision: number; protocol?: Protocol; candidates: Candidate[]; experiments: Experiment[]; selected?: string; conclusion?: { reason: string; experimentIds: string[] }; outputCheck?: {ok:boolean;checks:Array<{id:string;path?:string;ok:boolean;reason?:string}>}; }
/** One authority mapping for native MCP and the portable SSH/file transport.
 * A saved primary-work milestone is still the owner, not a delegated reader. */
export function researchContextFor(task: TaskRecord, unit: WorkUnit, root: string, cli: AgentId,
  excluded: {localReport?: boolean; isolated?: boolean; inputOnly?: boolean} = {}): ResearchContext | undefined {
  if (!task.researchCycle || task.goalPreparation || excluded.localReport || excluded.isolated || excluded.inputOnly || unit.orchestrator) return;
  const ownerStep = unit.primaryStep && unit.mode === "write" && unit.subtask?.kind === "primary-work";
  return { root, taskId: task.id, actor: unit.id, cli,
    write: unit.mode === "write" && !unit.planPhase && unit.role !== "reporter",
    manage: unit.role !== "reporter" && unit.role !== "reviewer" && !!(unit.primary || unit.planPhase || ownerStep),
    blind: unit.role === "reviewer", critic: !!unit.subtask?.researchCritic, requireOutputContract:true };
}
function outputRequirements(value: unknown): OutputRequirement[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("実験の必須出力を1〜20件指定してください。");
  const parsed = value.map(v => {
    if (!v || !["file", "json"].includes(v.format)) throw new Error("必須出力はfileまたはjsonで指定してください。");
    const keys = (k: string) => v[k] === undefined ? undefined : list(v[k]);
    const requiredKeys = keys("requiredKeys"), nonEmptyKeys = keys("nonEmptyKeys");
    if (v.format !== "json" && (requiredKeys || nonEmptyKeys)) throw new Error("キー検査はJSON出力だけに指定できます。");
    return {id:id(v.id), format:v.format, ...(requiredKeys ? {requiredKeys} : {}), ...(nonEmptyKeys ? {nonEmptyKeys} : {})} as OutputRequirement;
  });
  if (new Set(parsed.map(v=>v.id)).size !== parsed.length) throw new Error("必須出力IDが重複しています。");
  return parsed;
}
/** Inspect real output files, never run supplied code or infer scientific truth.
 * Both a small smoke test and the final record use this identical contract. */
async function checkOutputs(root: string, specs: OutputRequirement[], outputs: unknown) {
  const checks: Array<{id:string;path?:string;ok:boolean;reason?:string}> = [];
  for (const spec of specs) {
    let path: string | undefined;
    try {
      path = text((outputs as Record<string,unknown> | undefined)?.[spec.id],500);
      const resolved = await safePath(root,path);
      const stat = await lstat(resolved);
      const maxBytes=(spec.format==="json" ? 4 : 32)*1024*1024;
      if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > maxBytes) throw new Error(`通常の空でない${maxBytes/1024/1024}MiB以下のファイルに分割してください。`);
      if (spec.format === "json") {
        const value = JSON.parse(await readFile(resolved,"utf8"));
        for (const key of [...(spec.requiredKeys??[]),...(spec.nonEmptyKeys??[])]) {
          const parts = key.split(".");
          let item = value;
          for (const part of parts) item = item && typeof item === "object" && Object.hasOwn(item,part) ? item[part] : undefined;
          if (item === undefined || item === null) throw new Error(`必須キー ${key} がありません。`);
          if (spec.nonEmptyKeys?.includes(key) && (typeof item === "string" ? !item.trim() : Array.isArray(item) ? !item.length : typeof item === "object" ? !Object.keys(item).length : false)) throw new Error(`必須キー ${key} が空です。`);
        }
      }
      checks.push({id:spec.id,path,ok:true});
    } catch (e) { checks.push({id:spec.id,path,ok:false,reason:e instanceof Error ? e.message : String(e)}); }
  }
  return {ok:checks.every(c=>c.ok),checks};
}
function text(v: unknown, max = 2000): string { if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("空でない長さ制限内の文字列を指定してください。"); return v.trim(); }
function id(v: unknown): string { const s = text(v, 100); if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("IDは英数字・_-を使用してください。"); return s; }
function list(v: unknown, max = 30): string[] { if (!Array.isArray(v) || !v.length || v.length > max) throw new Error("空でない上限内の配列が必要です。"); const a = v.map(x => text(x, 500)); if (new Set(a).size !== a.length) throw new Error("重複項目があります。"); return a; }
const fresh = (): ResearchLedger => ({ version: 1, revision: 0, candidates: [], experiments: [] });
async function fingerprints(root: string, files: string[]): Promise<Record<string,string>> { return Object.fromEntries(await Promise.all(files.map(async f => [f, await digest(root, f)]))); }
async function unchanged(root: string, files: Record<string,string>): Promise<boolean> {
  for (const [f, h] of Object.entries(files)) { try { if (await digest(root, f) !== h) return false; } catch { return false; } } return true;
}
function accepted(e?: Experiment): e is Experiment { return !!e && !e.stale && e.decision === "advance" && e.critique?.verdict === "accept"; }
// A changed file invalidates verification; it must not erase a prior success.
function historicalSuccess(e: Experiment): boolean { return e.stage === "full" && e.decision === "advance" && e.critique?.verdict === "accept"; }
function compare(metrics: Metric[], values: Record<string, number>, baseline: Record<string, number>): boolean {
  return metrics.every(m => (values[m.id] - baseline[m.id]) * (m.direction === "max" ? 1 : -1) >= -m.tolerance)
    && metrics.some(m => (values[m.id] - baseline[m.id]) * (m.direction === "max" ? 1 : -1) > m.tolerance);
}
export function researchBlockers(ledger: ResearchLedger): string[] {
  if (!ledger.protocol) return ["研究の評価条件が未登録です。"];
  if (ledger.experiments.some(e=>historicalSuccess(e) && e.stale)) return ["過去に合格した全体評価の証拠が失効しています。保存した証拠を復元して再検証するまで、劣る候補への置換や否定的結果の総括はできません。"];
  if (ledger.conclusion && ledger.conclusion.experimentIds.every(id=>ledger.experiments.some(e=>e.id===id && !e.stale && e.critique))) return [];
  const selected = ledger.experiments.find(e => e.id === ledger.selected);
  if (!accepted(selected) || selected.stage !== "full") return ["全体評価と独立批評を通過した採用候補がありません。否定的結果は保持し、改善成功を捏造しないでください。"];
  if (ledger.experiments.some(e=>e.id!==selected.id && historicalSuccess(e) && accepted(e) && compare(ledger.protocol!.metrics,e.metrics,selected.metrics))) return ["採用候補を上回る検証済み全体評価があります。全候補を比較して採用と要素比較を更新してください。"];
  if (!ledger.experiments.some(e => e.stage === "ablation" && e.comparedTo === selected.id && !e.stale && e.critique?.verdict === "accept")) return ["採用候補の要素比較・独立批評が未完了です。"];
  return [];
}

export async function researchOperation(c: ResearchContext, request: any): Promise<ResearchLedger> {
  id(c.taskId); id(c.actor);
  if (!request || typeof request !== "object" || JSON.stringify(request).length > 24000) throw new Error("研究操作の形式・サイズが不正です。");
  const path = await safePath(c.root, `.agent-harness/${c.taskId}/research/ledger.json`, true);
  if (request.action === "recover-lock") {
    if (!c.user) throw new Error("ロック復旧は停止中のGUIから実行してください。");
    await recoverLedgerLock(dirname(path)); request={action:"snapshot"};
  }
  const present = (v: ResearchLedger): ResearchLedger => {
    if (c.user) return v;
    const offset=Number.isSafeInteger(request.offset) && request.offset>=0 ? request.offset : 0;
    return {...v, candidates:v.candidates.filter(h=>!request.candidateId || h.id===request.candidateId).slice(offset,offset+10),
      experiments:v.experiments.filter(e=>!request.experimentId || e.id===request.experimentId).slice(offset,offset+10).map(e=>c.blind ? {...e,critique:undefined} : e)};
  };
  return locked(dirname(path), async () => {
    let ledger = fresh();
    try {
      const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.size > 4 * 1024 * 1024) throw new Error("研究台帳が不正です。");
      ledger = JSON.parse(await readFile(path, "utf8"));
      if (ledger.version !== 1 || !Array.isArray(ledger.experiments) || !Array.isArray(ledger.candidates)) throw new Error("研究台帳の形式が不正です。");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const protocolValid = !ledger.protocol || await unchanged(c.root, ledger.protocol.files);
    for (const e of ledger.experiments) e.stale = !protocolValid || !(await unchanged(c.root, e.files));
    // Changes to a prerequisite also invalidate downstream promotion.
    for (const e of ledger.experiments) if ([e.comparedTo,e.prerequisite].some(id=>id && ledger.experiments.find(b=>b.id===id)?.stale)) e.stale = true;
    if (request.action === "snapshot") return present(ledger);
    if (!protocolValid) throw new Error("固定した評価器・データ定義が変更されています。元の条件を復元して検証してください。評価条件の無断変更はできません。");
    if (request.action === "check-outputs") {
      if (!ledger.protocol?.outputs?.length) throw new Error("先にprotocol.outputsで必須出力を登録してください。");
      return {...present(ledger),outputCheck:await checkOutputs(c.root,ledger.protocol.outputs,request.outputs)};
    }
    if (request.action === "protocol") {
      if (!c.manage) throw new Error("評価条件の登録は主担当・計画担当だけです。");
      if (ledger.protocol) throw new Error("評価条件は登録済みで固定されています。snapshotを確認してください。");
      const v = request.protocol;
      const outputs = outputRequirements(v?.outputs);
      if (c.requireOutputContract && !outputs) throw new Error("新しい評価条件にはprotocol.outputsで必須出力を指定してください。小規模試行のJSON・生ログ・必要な履歴を本測定前に確認します。");
      if (!Array.isArray(v?.metrics) || !v.metrics.length || v.metrics.length > 40) throw new Error("比較するデータセット・指標を1〜40件指定してください。");
      const metrics: Metric[] = v.metrics.map((m: any) => {
        if (!["min", "max"].includes(m.direction) || typeof m.tolerance !== "number" || !Number.isFinite(m.tolerance) || m.tolerance < 0 || typeof m.subset !== "boolean") throw new Error("指標の向き・絶対許容差・subsetが不正です。");
        return { id: id(m.id), direction: m.direction, tolerance: m.tolerance, subset: m.subset };
      });
      if (new Set(metrics.map(m=>m.id)).size !== metrics.length || !metrics.some(m=>m.subset)) throw new Error("重複しない指標と小規模評価用の指標が必要です。");
      if (!Number.isInteger(v.maxExperiments) || v.maxExperiments < 1 || v.maxExperiments > 100) throw new Error("実験記録の上限は1〜100です。既存のトークン予算・承認範囲内で計画してください。");
      ledger.protocol = { question: text(v.question), metrics, maxExperiments: v.maxExperiments, files: await fingerprints(c.root, list(v.files)), ...(outputs ? {outputs} : {}) };
    } else if (request.action === "candidate") {
      if (!c.manage && !c.write) throw new Error("読み取り専用担当は候補を登録できません。");
      const v = request.candidate, key = id(v?.id);
      if (ledger.candidates.length >= 30 || ledger.candidates.some(h=>h.id===key)) throw new Error("候補は一意のIDで30件までです。既存候補は変更せず派生候補を登録してください。");
      const parent = v.parent === undefined ? undefined : id(v.parent);
      if (parent && !ledger.candidates.some(h=>h.id===parent)) throw new Error("親候補がありません。");
      ledger.candidates.push({id:key,parent,hypothesis:text(v.hypothesis),limitation:text(v.limitation),novelty:text(v.novelty),falsifier:text(v.falsifier),sources:list(v.sources,10)});
    } else if (request.action === "record") {
      if (!c.write) throw new Error("実験記録は書込み担当だけです。");
      const p = ledger.protocol, v = request.experiment;
      if (!p) throw new Error("実験前に評価条件を登録してください。");
      if (ledger.experiments.length >= p.maxExperiments) throw new Error("実験記録の予算上限です。既存成果を保持して終了方針を報告してください。");
      const key=id(v?.id), stage=v.stage as Experiment["stage"];
      if (ledger.experiments.some(e=>e.id===key)) throw new Error("記録済みの実験IDです。snapshotを確認し、再投入しないでください。");
      if (!["baseline-subset","baseline-full","subset","full","ablation","rebuttal"].includes(stage)) throw new Error("実験段階が不正です。");
      const baseline = stage.startsWith("baseline-");
      const candidate=baseline ? undefined : id(v.candidate);
      if (candidate && !ledger.candidates.some(h=>h.id===candidate)) throw new Error("候補が未登録です。");
      if (baseline && ledger.experiments.some(e=>e.stage===stage)) throw new Error("基準実験は固定されており差し替えられません。");
      const prerequisite = stage === "full" ? [...ledger.experiments].reverse().find(e=>e.candidate===candidate && e.stage==="subset" && accepted(e)) : undefined;
      if (stage === "full" && !prerequisite) throw new Error("全体評価の前に小規模評価の改善と別CLIの批評合格が必要です。");
      const metrics = stage.includes("subset") ? p.metrics.filter(m=>m.subset) : p.metrics;
      const result=text(v.result,500), raw=JSON.parse((await data(c.root,result,100000)).toString());
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== metrics.length || metrics.some(m=>typeof raw[m.id]!=="number" || !Number.isFinite(raw[m.id]))) throw new Error("実測結果JSONは該当段階の指標IDと有限数の対応だけにしてください。指標の欠落・追加はできません。");
      const outputCheck = p.outputs ? await checkOutputs(c.root,p.outputs,v.outputs) : undefined;
      if (outputCheck && !outputCheck.ok) throw new Error(`実験の必須出力が不足しています。小規模試行で確認してください：${outputCheck.checks.filter(c=>!c.ok).map(c=>`${c.id}: ${c.reason}`).join(" / ")}`);
      const files = [...new Set([result, ...list(v.evidence), ...(outputCheck?.checks.map(c=>c.path!)??[])])];
      if (files.length < 3) throw new Error("結果の他に実行コード・環境/コマンド/生ログの証拠が必要です。");
      const baseStage=stage==="subset" ? "baseline-subset" : "baseline-full";
      const base=baseline ? undefined : ledger.experiments.find(e=>e.stage===baseStage && !e.stale);
      if (!baseline && !base) throw new Error("同じ評価条件の有効な基準実験が必要です。");
      const analysis=stage==="ablation" || stage==="rebuttal";
      const target=analysis ? ledger.experiments.find(e=>e.id===v.comparedTo && e.candidate===candidate && e.stage==="full" && accepted(e)) : base;
      if (analysis && !target) throw new Error("追加実験の対象となる批評済み全体評価を指定してください。");
      ledger.experiments.push({id:key,candidate,stage,cli:c.cli,actor:c.actor,at:new Date().toISOString(),purpose:text(v.purpose),result,metrics:raw,
        files:await fingerprints(c.root,files),comparedTo:target?.id,prerequisite:prerequisite?.id,decision:baseline ? "baseline" : analysis ? "analysis" : compare(metrics,raw,base!.metrics) ? "advance" : "refine"});
    } else if (request.action === "judge") {
      if (!c.critic || c.blind || c.write || c.manage) throw new Error("批評はresearchCritic:trueの読取専用の独立した専門担当へ割り当ててください。");
      const e=ledger.experiments.find(e=>e.id===request.experimentId);
      if (!e || e.stale || e.cli===c.cli || e.actor===c.actor || e.stage.startsWith("baseline-")) throw new Error("別CLIで有効な候補実験を独立検証してください。");
      if (!["accept","refine","reject"].includes(request.verdict)) throw new Error("批評判定が不正です。");
      if (e.critique) throw new Error("批評は保存済みです。追加検証は新しい実験IDへ記録してください。");
      e.critique={cli:c.cli,actor:c.actor,verdict:request.verdict,reason:text(request.reason)};
    } else if (request.action === "conclude-negative") {
      if (!c.manage || !c.write) throw new Error("否定的結果の総括は書込み主担当だけです。");
      if (ledger.experiments.some(e=>historicalSuccess(e) && e.stale)) throw new Error("過去の成功候補が失効しています。証拠を復元して再検証してください。成功履歴を無視できません。");
      const trials=ledger.experiments.filter(e=>e.candidate && ["subset","full"].includes(e.stage) && !e.stale && e.critique);
      if (!trials.length || ledger.candidates.some(h=>!trials.some(e=>e.candidate===h.id)) || ledger.experiments.some(e=>e.stage==="full" && accepted(e))) throw new Error("全候補の有効な実験・独立批評を確認してください。成功候補を隠して否定的結果にできません。");
      ledger.conclusion={reason:text(request.reason),experimentIds:trials.map(e=>e.id)};
      ledger.selected=undefined;
    } else if (request.action === "select") {
      if (!c.manage || !c.write) throw new Error("採用候補の選定は書込み主担当だけです。");
      const e=ledger.experiments.find(e=>e.id===request.experimentId);
      if (!accepted(e) || e.stage!=="full") throw new Error("全体評価の改善と独立批評が必要です。");
      if (ledger.experiments.some(other=>historicalSuccess(other) && other.stale)) throw new Error("過去の成功候補が失効しています。証拠を復元して再検証してください。最良成果を失効で消すことはできません。");
      if (ledger.experiments.some(other=>other.id!==e.id && historicalSuccess(other) && accepted(other) && compare(ledger.protocol!.metrics,other.metrics,e.metrics))) throw new Error("他の検証済み全体評価がこの候補を上回ります。全候補から最良成果を選定してください。");
      const previous=ledger.experiments.find(e=>e.id===ledger.selected);
      if (previous && previous.id!==e.id && !previous.stale && !compare(ledger.protocol!.metrics,e.metrics,previous.metrics)) throw new Error("既存最良候補より改善していません。最良成果を上書きしません。");
      ledger.selected=e.id;
    } else throw new Error("未対応の研究操作です。");
    if (request.action !== "conclude-negative") ledger.conclusion=undefined;
    ledger.revision++;
    const json=JSON.stringify(ledger); if (Buffer.byteLength(json)>4*1024*1024) throw new Error("研究台帳の容量上限です。");
    const temp=`${path}.${randomUUID()}.tmp`; await writeFile(temp,json,{flag:"wx",mode:0o600}); await rename(temp,path);
    return present(ledger);
  });
}

export const researchInstructions = `# Evidence-backed research cycle (research_manage)
Within the approved scope, first establish the scientific question, primary-source limitations, several alternative hypotheses and falsifiers. Novelty is provisional, never a self-awarded score. Balance untried ideas with refinements of promising and failed trials; keep failures. Plan useful experiments and actual subscription headroom before coding, reserve finishing time; total tokens are telemetry, not an experiment limit, use scripts for repeated comparisons. Do not reproduce an expensive published schedule by default.
Use research_manage({request:{action:..., ...}}). The ledger survives restarts; inspect snapshot before retrying. No direct ledger edits. Paths are relative to the research workspace, not the report folder. Keep per-experiment evidence immutable in distinct folders (source snapshots, environment, command, raw output, seeds/splits and metrics). Hashes verify files, not scientific truth or actual execution. Never fabricate data or move test data into training. Fixed manifests must include evaluator, data/split definitions, metric and resource/fairness settings. Multi-dataset IDs such as dataset_accuracy make every required dimension explicit.
Before the FIRST implementation/measurement milestone, the primary must inspect snapshot, prepare the fixed evaluator/condition manifests and register protocol. Put this small prerequisite before experiments in the execution plan; a read-only planner does not create files or run measurements. A single exclusive GPU, serial implementation or an exceeded soft time target does NOT make evaluation registration or independent criticism inapplicable: schedule read-only criticism between serial measurement milestones. On recovery, reuse unchanged evidence instead of rerunning GPU experiments to fix bookkeeping. If experiments already ran without registration, disclose the actual chronology and missing prior registration; never backdate a protocol, claim retroactive pre-registration, change approved tolerances, or self-certify acceptance. Future measurements can have newly fixed conditions, but historical claims remain unverified until independently checked.
- protocol: protocol={question,files:[evaluation script and protocol/data manifests],metrics:[{id,direction:"min|max",tolerance:0,subset:true}],maxExperiments:12,outputs?:[{id:"raw",format:"json",requiredKeys:["command","environment"],nonEmptyKeys:["records"]}]}. Freeze before experiments; choose tolerance and budget from approved requirements, not observed outcomes. Can be registered by planner/primary (including saved primary-work milestones) but cannot be replaced. For non-empirical or incompatible goals, report the applicability conflict rather than invent numeric experiments. For NEW empirical protocols, derive outputs from required deliverables (raw results, progress/iteration history if required, seeds, environment and commands), and include this short contract. Old protocols without outputs stay readable; do not rewrite fixed historical conditions.
- check-outputs: outputs={declaredOutputID:"smoke/raw.json",...}. Run a MINIMAL valid case FIRST, then call this read-only check before large measurements. It checks actual regular files and declared JSON keys (dot-separated nested keys), including non-empty arrays/strings/objects; outputCheck.ok=false lists missing outputs without recording an experiment. Reuse the same validated collection script and outputs mapping for record; record rejects missing declared outputs and fingerprints them. This structural check is not a correctness/performance verdict. Independently test checker failure cases and data precision; do not create empty placeholder files to pass it.
- candidate: candidate={id,parent?:existingID,hypothesis,limitation,novelty,falsifier,sources:[primary-source URLs and precise locations]}. At most 30 immutable candidates; new parent-linked IDs for evolved ideas.
- record: experiment={id,stage:"baseline-subset|baseline-full|subset|full|ablation|rebuttal",candidate:required except baseline,result:"trial/metrics.json",evidence:[code snapshot,execution log/environment files],outputs?:{raw:"trial/raw.json"},purpose,comparedTo:fullExperimentID for ablation/rebuttal}. Metrics JSON is {metricID:finiteNumber}; subset contains exactly subset-marked metrics, other stages contain ALL metrics. Subset/full need matching reproduced baselines. Numeric advance means no dimension regresses beyond its predeclared tolerance and at least one improves; it is NOT significance or success proof. Full recording requires an accepted subset. No reusing experiment IDs or replacing baselines. Record failures too.
- judge: experimentId,verdict:"accept|refine|reject",reason. Plan a read-only specialist from a DIFFERENT CLI than the experimental writer after each relevant milestone; only this specialist records scientific criticism. It checks actual execution, fair comparisons, novelty against sources, leakage, uncertainty/repeats and mechanistic interpretation. It may record only this review metadata, never edit artifacts or run new experiments. Primary cannot self-certify. Unsupported improvements need refine/reject; numeric advance alone is insufficient.
- select: experimentId of independently accepted full evaluation. Compare ALL accepted full evaluations; reject a candidate dominated by another. Preserve the previous best unless a new one improves without regressions. Stale historical successes must be restored and reverified, never erased by selecting a weaker candidate or concluding negative. If original evidence cannot be restored, retain the unresolved history; a new task is required for a new protocol. Ablate selected components (or test claimed mechanism with appropriate controls); record purpose and link to that full experiment; another CLI judges the analysis. New selected full results require new ablations.
- snapshot: inspect candidates, experiments, stale evidence and selected result. Results are paginated (10 candidates/experiments); use offset, candidateId or experimentId to inspect more. Full history remains on disk and GUI. Final reviewers receive no intermediate critic verdicts. They must independently verify sources and artifacts, missing baselines, score reproduction, specification compliance and method-code alignment.
- conclude-negative: reason. If bounded exploration yields no accepted full improvement, record this honestly after ALL registered candidates have experimental evidence and independent criticism. This permits reporting negative findings, not claiming the goal achieved; normal final goal review still applies. Do not invent success or endlessly tune to please a reviewer.
For a critic package in the execution-plan, set researchCritic:true on kind:investigation and depend explicitly on the experimental primary-work package. The router excludes the nearest experimental writer on each dependency path, not writers in unrelated earlier stages; judge also checks the recorded writer for each experiment. Plan the subset critic BEFORE the full experiment, and the full critic BEFORE ablation/selection; use justified bounded replans rather than exceeding maxSubtasks. Record every stage before requesting the next one. A completed critic terminal without accepted judge metadata is NOT a scientific approval. Inspect snapshot and explicitly repair missing criticism in the plan.
Existing scheduler handles dependencies and scope: plan serial primary-work experiment milestones interleaved with useful independent investigation/criticism. Do not claim independent review from another same-CLI session. No automatic GPU jobs, privilege changes or arbitrary agents are launched by this tool. It gates recorded promotion, not commands run outside the tool. If only one CLI is usable, preserve work and report the unresolved independent check.
Review concerns must lead to a concrete rebuttal experiment or source/code verification, then updated claims/TeX and the normal independent cross-review. Reports must trace each number/claim to evidence and distinguish negative results, untested claims and scientific limitations. Meta-review uses existing goal criteria and unresolved concerns, never an AI score threshold or majority vote. Respect configured retry counts and actual subscription limits; when exhausted preserve best outputs and unresolved issues, never declare success. Keep operational ledger out of the report body.`;

if (require.main===module) void (async()=>{
  const [configPath,payload]=process.argv.slice(2); if (!configPath || !payload || payload.length>24000) throw new Error("研究操作の設定とJSONが必要です。");
  const config=JSON.parse(await readFile(configPath,"utf8")); await assertHpcRunActive(dirname(configPath),config.token);
  await lstat(join(dirname(configPath),"instructions.txt"));
  process.stdout.write(JSON.stringify(await researchOperation(config.context,JSON.parse(payload)))+"\n");
})().catch(e=>{process.stderr.write(String(e)+"\n");process.exitCode=1;});
