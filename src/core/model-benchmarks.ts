import type { TaskRecord, WorkUnit } from "./types";

export type Capability = "reasoning" | "coding" | "agentic" | "speed";
export type BenchmarkMetric = "intelligence" | "coding" | "agentic" | "tokensPerSecond";
export interface BenchmarkReference {
  kind: "variants" | "alias";
  model: string;
  evaluationIds: string[];
  ranges: Partial<Record<BenchmarkMetric, [number, number]>>;
  note: string;
}
export interface ModelBenchmark {
  id: string;
  name: string;
  intelligence?: number;
  coding?: number;
  agentic?: number;
  tokensPerSecond?: number;
  /** Derived in memory, never an assertion of the CLI's actual evaluation settings. */
  reference?: BenchmarkReference;
}
export interface BenchmarkSnapshot {
  enabled: boolean;
  hasKey: boolean;
  fetchedAt?: string;
  indexVersion?: number;
  error?: string;
  retryAt?: string;
  retryBlocked?: boolean;
  models: ModelBenchmark[];
}
export const BENCHMARK_SOURCE = "https://artificialanalysis.ai/";
export const BENCHMARK_MAX_AGE = 7 * 24 * 60 * 60_000;
export function benchmarkDocumentationUrl(value:string):boolean {
  try { const url=new URL(value);return url.origin===BENCHMARK_SOURCE.slice(0,-1)&&!url.username&&!url.password&&(url.pathname==="/data-api"||url.pathname.startsWith("/data-api/")); } catch {return false;}
}
export interface BenchmarkMatch {
  status: "missing" | "stale" | "default" | "unmatched" | "matched";
  enabled: boolean;
  record?: ModelBenchmark;
}

const metrics: BenchmarkMetric[] = ["intelligence", "coding", "agentic", "tokensPerSecond"];
function modelKey(value: string): string {
  return value.toLowerCase().replace(/(\d)[._-](?=\d)/g, "$1~").replace(/[\s._()-]/g, "")
    // Anthropic uses both claude-sonnet-4-5 and Claude 4.5 Sonnet.
    .replace(/^claude(fable|opus|sonnet|haiku)(\d+(?:~\d+)*)$/, "claude$2$1");
}
function evaluationBase(name: string): string {
  // Only strip known evaluation conditions. Dates, previews and architecture
  // labels are part of model identity, not interchangeable reasoning settings.
  const groups = [...name.matchAll(/\(([^)]+)\)/g)];
  const condition = /^(?:(?:adaptive )?reasoning|non[- ]reasoning|(?:minimal|low|medium|high|xhigh|max|none)(?: effort)?|(?:default|opus \d+(?:\.\d+)*) fallback)$/i;
  return groups.length && groups.every(g => g[1].split(/,\s*/).every(s => condition.test(s.trim())))
    ? name.replace(/\s*\([^)]*\)/g, "").trim() : name;
}
function referenceMatch(records: ModelBenchmark[], base: string, kind: BenchmarkReference["kind"]): ModelBenchmark {
  const reference: BenchmarkReference = {
    kind, model: base, evaluationIds: records.map(m => m.id).sort(), ranges: {},
    note: kind === "alias"
      ? "別名の参考値：取得データ内の最新掲載版。実際のCLIの版・評価条件との一致は未確認。"
      : "同じモデルの評価条件別の参考値。CLIの推論設定・フォールバック条件との一致は未確認。"
  };
  const result: ModelBenchmark = {id: `reference:${modelKey(base)}`, name: base, reference};
  for (const metric of metrics) {
    const values = records.map(m => m[metric]).filter((n): n is number => n !== undefined && Number.isFinite(n)).sort((a,b) => a-b);
    if (!values.length) continue;
    const middle = Math.floor(values.length/2);
    result[metric] = values.length%2 ? values[middle] : (values[middle-1]+values[middle])/2;
    reference.ranges[metric] = [values[0], values[values.length-1]];
  }
  return result;
}

/** UI and routing share exact identities; uncertain conditions use labeled
 *  medians/ranges rather than silently assigning the highest-scoring variant. */
export function inspectBenchmark(model: string | undefined, snapshot?: BenchmarkSnapshot): BenchmarkMatch {
  const enabled = snapshot?.enabled ?? false;
  const fetched = Date.parse(snapshot?.fetchedAt ?? "");
  if (!snapshot?.models.length || !Number.isFinite(fetched)) return { status:"missing", enabled };
  if (Date.now()-fetched > BENCHMARK_MAX_AGE || fetched-Date.now() > 300000) return { status:"stale", enabled };
  const name = (model?.split("/").at(-1) ?? "").replace(/:cloud$/i, "");
  const alias = name.match(/^(?:claude[-_])?(fable|opus|sonnet|haiku)(?:[-_]latest)?$/i)?.[1].toLowerCase();
  if (alias) {
    const versions = new Map<string, {base:string; version:number[]; records:ModelBenchmark[]}>();
    for (const record of snapshot.models) {
      const base = evaluationBase(record.name);
      const modern = base.match(/^Claude (Fable|Opus|Sonnet|Haiku) (\d+(?:\.\d+)*)$/i);
      const legacy = base.match(/^Claude (\d+(?:\.\d+)*) (Fable|Opus|Sonnet|Haiku)$/i);
      const family = modern?.[1] ?? legacy?.[2], version = modern?.[2] ?? legacy?.[1];
      if (family?.toLowerCase() !== alias || !version) continue;
      const entry = versions.get(version) ?? {base, version:version.split(".").map(Number), records:[]};
      entry.records.push(record); versions.set(version, entry);
    }
    const latest = [...versions.values()].sort((a,b) => {
      for(let i=0;i<Math.max(a.version.length,b.version.length);i++) {
        const difference=(b.version[i]??0)-(a.version[i]??0); if(difference)return difference;
      }
      return 0;
    })[0];
    return latest ? {status:"matched", enabled, record:referenceMatch(latest.records,latest.base,"alias")} : {status:"default", enabled};
  }
  if (!name || /^(default|auto|latest|best|opusplan)$/i.test(name) || /(?:^|[-_])latest$/i.test(name)) return { status:"default", enabled };
  const key = modelKey(name);
  const bases = snapshot.models.filter(m => modelKey(evaluationBase(m.name)) === key);
  if (bases.some(m => evaluationBase(m.name) !== m.name)) {
    return {status:"matched", enabled, record:referenceMatch(bases,evaluationBase(bases[0].name),"variants")};
  }
  const found = snapshot.models.filter(m => modelKey(m.id) === key || modelKey(m.name) === key);
  return found.length === 1 ? { status:"matched", enabled, record:found[0] } : { status:"unmatched", enabled };
}

// No edit-distance or substring matching across model versions. References carry
// their uncertainty into planner prompts and receive reduced routing weight.
export function matchBenchmark(model: string | undefined, snapshot?: BenchmarkSnapshot): ModelBenchmark | undefined {
  return snapshot?.enabled ? inspectBenchmark(model,snapshot).record : undefined;
}
export function capabilityFor(unit: WorkUnit, task?:Pick<TaskRecord,"workPreset">): Capability {
  if(unit.subtask?.capability)return unit.subtask.capability;
  if(unit.planPhase||unit.orchestrator||unit.role!=="worker")return "reasoning";
  const focus=(task?.workPreset?.stages?.find(s=>s.manifest.id===unit.researchStage)??task?.workPreset)?.manifest.focus;
  return focus && focus!=="implementation" ? "reasoning" : "coding";
}
export function capabilityValue(model: ModelBenchmark | undefined, capability: Capability): number | undefined {
  return model?.[capability === "reasoning" ? "intelligence" : capability === "speed" ? "tokensPerSecond" : capability];
}
export function benchmarkAdjustment(model: ModelBenchmark | undefined, peers: Array<ModelBenchmark | undefined>, capability: Capability): number {
  const value = capabilityValue(model, capability);
  const values = peers.map(p => capabilityValue(p, capability)).filter((v): v is number => v !== undefined);
  // Unknown is neutral, never zero ability. With only one measured candidate
  // there is no relative comparison. Limit the effect to preserve load balancing.
  if (value === undefined || values.length < 2) return 0;
  const min = Math.min(...values), max = Math.max(...values);
  if (min === max) return 0;
  // A tiny score gap is not a meaningful rank gap. Avoid amplifying rounding
  // noise to the full routing weight, especially with only two candidates.
  const scale = Math.max(max-min, capability === "speed" ? max : 20);
  const confidence = model?.reference?.kind === "alias" ? 0.25 : model?.reference ? 0.5 : 1;
  return -25 * confidence * (value - values.reduce((a,b)=>a+b,0) / values.length) / scale;
}
export function benchmarkReason(model: string | undefined, unit: WorkUnit, snapshot?: BenchmarkSnapshot, task?:Pick<TaskRecord,"workPreset">): string {
  if (!snapshot?.enabled) return "";
  const record = matchBenchmark(model, snapshot), capability = capabilityFor(unit,task);
  const labels: Record<Capability,string> = { reasoning: "総合・推論の参考指標", coding: "コーディング", agentic: "エージェント能力", speed: "出力速度" };
  const value = capabilityValue(record, capability);
  return value === undefined ? "モデル能力は未照合／未測定／期限切れのため加点なし。"
    : `能力参考：${record!.name} の${labels[capability]} ${value}${capability === "speed" ? " tokens/s" : ""}（Artificial Analysis、${snapshot.fetchedAt?.slice(0,10)}取得、指標版${snapshot.indexVersion}）。${record?.reference ? `${record.reference.note}条件別データの中央値を低い重みで使用。` : ""}固定担当・継続性・使用枠の条件を優先。`;
}
