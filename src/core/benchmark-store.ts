import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { BenchmarkSnapshot, ModelBenchmark } from "./model-benchmarks";

interface Cipher { encrypt(value: string): string; decrypt(value: string): string; }
class BenchmarkError extends Error {}
const DAY = 86400000;
const metric = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100000 ? v : undefined;
function parseModels(items: any[]): ModelBenchmark[] {
  const models: ModelBenchmark[] = [];
  for (const item of items) {
    if (!item || typeof item.slug !== "string" || !/^[a-zA-Z0-9._-]{1,180}$/.test(item.slug)
      || typeof item.name !== "string" || !item.name.trim() || item.name.length > 240 || /[\x00-\x1f]/.test(item.name)) continue;
    // Only measured numbers and short labels enter the planner, never API prose.
    models.push({ id:item.slug, name:item.name, intelligence:metric(item.evaluations?.artificial_analysis_intelligence_index),
      coding:metric(item.evaluations?.artificial_analysis_coding_index), agentic:metric(item.evaluations?.artificial_analysis_agentic_index),
      tokensPerSecond:metric(item.performance?.median_output_tokens_per_second) });
  }
  return models;
}
export function parseBenchmarkPage(body: any): { models: ModelBenchmark[]; version: number; more: boolean } {
  if (!body || !Array.isArray(body.data) || body.data.length > 2000 || typeof body.pagination?.has_more !== "boolean"
    || typeof body.intelligence_index_version !== "number" || !Number.isFinite(body.intelligence_index_version) || body.intelligence_index_version <= 0)
    throw new BenchmarkError("能力データの形式が変更されています。保存済みデータを保持します。");
  return { models:parseModels(body.data), version:body.intelligence_index_version, more:body.pagination.has_more };
}

export class BenchmarkStore {
  private state: BenchmarkSnapshot = { enabled:false, hasKey:false, models:[] };
  private encryptedKey?: string;
  private pending?: Promise<BenchmarkSnapshot>;
  private pendingForce = false;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private path: string, private cipher: Cipher, private fetcher: typeof fetch = fetch) {}
  snapshot(): BenchmarkSnapshot { return structuredClone(this.state); }

  // One transaction queue covers both settings and network refresh. Memory is
  // published only after the atomic file replacement succeeds.
  private exclusive<T>(operation:()=>Promise<T>):Promise<T> {
    const next = this.operations.then(operation);
    this.operations = next.catch(()=>{});
    return next;
  }
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path,"utf8"));
      if (!Array.isArray(saved.models) || saved.models.length > 40000) throw new Error("Invalid cache");
      const models = parseModels(saved.models.map((m:any)=>({slug:m?.id,name:m?.name,
        evaluations:{artificial_analysis_intelligence_index:m?.intelligence,artificial_analysis_coding_index:m?.coding,artificial_analysis_agentic_index:m?.agentic},
        performance:{median_output_tokens_per_second:m?.tokensPerSecond}})));
      if (new Set(models.map(m=>m.id)).size !== models.length) throw new Error("Duplicate cache models");
      const version = typeof saved.indexVersion === "number" && Number.isFinite(saved.indexVersion) && saved.indexVersion > 0 ? saved.indexVersion : undefined;
      const encryptedKey = typeof saved.encryptedKey === "string" ? saved.encryptedKey : undefined;
      this.state = { enabled:saved.enabled === true, hasKey:!!encryptedKey, models:version ? models : [], indexVersion:version,
        fetchedAt:version && models.length && typeof saved.fetchedAt === "string" && Number.isFinite(Date.parse(saved.fetchedAt)) && Date.parse(saved.fetchedAt)<=Date.now()+300000 ? saved.fetchedAt : undefined,
        retryAt:typeof saved.retryAt === "string" && Number.isFinite(Date.parse(saved.retryAt)) ? saved.retryAt : undefined, retryBlocked:saved.retryBlocked===true };
      this.encryptedKey = encryptedKey;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.state.error = "能力データの保存情報を読めません。設定を確認してください。"; }
  }
  private async persist(state:BenchmarkSnapshot, encryptedKey:string|undefined): Promise<void> {
    await mkdir(dirname(this.path),{recursive:true});
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary,JSON.stringify({...state,encryptedKey}),{mode:0o600});
      await rename(temporary,this.path);
    } finally { await rm(temporary,{force:true}).catch(()=>{}); }
  }
  configure(value: { enabled:boolean; apiKey?:string; clearKey?:boolean }): Promise<BenchmarkSnapshot> {
    if (!value || typeof value.enabled !== "boolean" || (value.clearKey !== undefined && typeof value.clearKey !== "boolean")
      || (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 1000 || /[\r\n]/.test(value.apiKey)))) return Promise.reject(new Error("能力データ設定が不正です。"));
    return this.exclusive(async()=>{
      const encryptedKey = value.clearKey ? undefined : value.apiKey?.trim() ? this.cipher.encrypt(value.apiKey.trim()) : this.encryptedKey;
      const next = {...this.state,enabled:value.enabled,hasKey:!!encryptedKey,error:undefined,
        retryAt:value.clearKey || value.apiKey?.trim() ? undefined : this.state.retryAt,
        retryBlocked:value.clearKey || value.apiKey?.trim() ? false : this.state.retryBlocked};
      await this.persist(next,encryptedKey);
      this.encryptedKey=encryptedKey; this.state=next;
      return this.snapshot();
    });
  }
  refresh(force=false): Promise<BenchmarkSnapshot> {
    if (this.pending) {
      // A queued daily check may legitimately skip fetching. It cannot satisfy
      // the user's explicit refresh (notably while automatic routing is OFF).
      if(force&&!this.pendingForce)return this.pending.then(()=>this.refresh(true));
      return this.pending;
    }
    this.pendingForce=force;
    this.pending = this.exclusive(async()=>{
      // Manual refresh permits comparison with routing disabled, but cannot
      // defeat server rate limits. Replacing the API key clears the backoff.
      if (!this.encryptedKey || ((!force || this.state.retryBlocked) && Date.parse(this.state.retryAt ?? "") > Date.now())
        || (!force && (!this.state.enabled || (this.state.fetchedAt && Date.now()-Date.parse(this.state.fetchedAt)<DAY)))) return this.snapshot();
      return this.fetchData();
    }).finally(()=>{ this.pending=undefined;this.pendingForce=false; });
    return this.pending;
  }
  private async fetchData(): Promise<BenchmarkSnapshot> {
    let retryMs = 3600000;
    let retryBlocked = false;
    try {
      let key:string;
      try {key=this.cipher.decrypt(this.encryptedKey!);} catch {throw new BenchmarkError("保存済みAPIキーを復号できません。APIキーを再登録してください。");}
      const models: ModelBenchmark[] = [], ids = new Set<string>();
      let version: number | undefined;
      const signal = AbortSignal.timeout(30000);
      for(let page=1;page<=20;page++) {
        const response = await this.fetcher(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`,{headers:{"x-api-key":key},signal,redirect:"error"});
        if(!response.ok) {
          if(response.status===429) {
            retryBlocked=true;
            const raw=response.headers.get("retry-after"), seconds=raw?.trim() ? Number(raw) : NaN;
            const delay=Number.isFinite(seconds) ? seconds*1000 : Date.parse(raw ?? "")-Date.now();
            retryMs=Number.isFinite(delay)&&delay>0 ? Math.min(Math.max(delay,60000),7*DAY) : DAY;
          }
          throw new BenchmarkError(response.status===401||response.status===403 ? "Artificial AnalysisのAPIキー・利用権限を確認してください。" : `能力データを取得できません（HTTP ${response.status}）。保存済みデータを保持します。`);
        }
        if(!response.body) throw new BenchmarkError("能力データが空です。");
        const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
        while(true) {
          const {done,value}=await reader.read(); if(done) break;
          size+=value.length;
          if(size>4_000_000){await reader.cancel();throw new BenchmarkError("能力データが大きすぎます。");}
          chunks.push(value);
        }
        const parsed=parseBenchmarkPage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if(version!==undefined && version!==parsed.version) throw new BenchmarkError("取得中に指標版が変わりました。再取得してください。");
        version=parsed.version;
        for(const model of parsed.models) {
          if(ids.has(model.id)) throw new BenchmarkError("能力データに重複したモデルがあります。");
          ids.add(model.id);models.push(model);
        }
        if(!parsed.more) {
          if(!models.length) throw new BenchmarkError("照合できるモデル情報がありません。");
          const next={...this.state,models,indexVersion:version,fetchedAt:new Date().toISOString(),error:undefined,retryAt:undefined,retryBlocked:false};
          await this.persist(next,this.encryptedKey); this.state=next;
          return this.snapshot();
        }
      }
      throw new BenchmarkError("能力データのページ数が上限を超えました。");
    } catch(error) {
      this.state={...this.state,retryAt:new Date(Date.now()+retryMs).toISOString(),retryBlocked,
        error:error instanceof BenchmarkError ? error.message : "能力データの取得・保存に失敗しました。接続を確認してください。作業は継続できます。"};
      await this.persist(this.state,this.encryptedKey).catch(()=>{});
      return this.snapshot();
    }
  }
}
