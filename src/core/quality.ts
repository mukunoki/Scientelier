import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePath, data, digest, locked, assertHpcRunActive, recoverLedgerLock } from "./hpc";

export interface QualitySpec {id:string;stage:string;title:string;guidance:string;required:boolean;allowNA:boolean;}
export interface QualityContext {root:string;taskId:string;domain:"work"|"report";contract:string;specs:QualitySpec[];actor:string;write:boolean;manage:boolean;allowedStages:string[];criterionIds:string[];user?:boolean;}
interface QualityPlan {method:"script"|"manual";procedure:string;targets:string[];dependsOn:string[];criterionIds:string[];revision:string;}
interface QualityResult {id:string;status:"pass"|"fail"|"unverified"|"not-applicable";detail:string;files:Record<string,string>;planRevision:string;contract:string;dependencies:Record<string,string>;at:string;actor:string;repairOwner?:"worker"|"reporter";}
export interface QualityCheck extends QualitySpec {plan?:QualityPlan;result?:QualityResult;history:QualityResult[];stale?:boolean;changedFiles?:string[];}
export interface QualitySnapshot {version:1;revision:number;domain:"work"|"report";checks:QualityCheck[];blockers:Array<{id:string;stage:string;title:string;reason:string;owner:"worker"|"reporter"}>;
  recheck:{reuseCheckIds:string[];requiredCheckIds:string[];changes:Array<{id:string;files:string[];dependencies:string[];contractChanged:boolean;methodChanged:boolean}>};}
interface Ledger {version:1;revision:number;checks:QualityCheck[];}
const text=(v:unknown,max=2000):string=>{if(typeof v!=="string" || !v.trim() || v.length>max || v.includes("\0"))throw new Error("空でない長さ制限内の文字列が必要です。");return v.trim();};
const id=(v:unknown):string=>{const s=text(v,100);if(!/^[a-zA-Z0-9_-]+$/.test(s))throw new Error("IDは英数字・_-で指定してください。");return s;};
function strings(v:unknown,max=40):string[]{if(!Array.isArray(v)||v.length>max)throw new Error(`配列は${max}件以内です。`);const a=v.map(s=>text(s,500));if(new Set(a).size!==a.length)throw new Error("重複項目があります。");return a;}
function pathName(v:string):string {if(v.startsWith("/")||v.includes("\\")||v.split("/").some(p=>!p||[".","..",".git",".agent-harness"].includes(p)))throw new Error("検査対象は管理領域を除く相対ファイル名にしてください。");return v;}
async function hashes(root:string,paths:string[]):Promise<Record<string,string>> {return Object.fromEntries(await Promise.all(paths.map(async p=>[p,await digest(root,pathName(p))])));}
async function changedFiles(root:string,files:Record<string,string>):Promise<string[]>{const changed:string[]=[];for(const [p,h]of Object.entries(files)){try{if(await digest(root,p)!==h)changed.push(p);}catch{changed.push(p);}}return changed;}
const sameMapping=(a:Record<string,string>,b:Record<string,string>)=>Object.keys(a).length===Object.keys(b).length && Object.entries(a).every(([k,v])=>b[k]===v);

function snapshot(c:QualityContext,l:Ledger):QualitySnapshot {
  const blockers=l.checks.filter(s=>s.required && (!s.result||s.stale||!["pass","not-applicable"].includes(s.result.status))).map(s=>({id:s.id,stage:s.stage,title:s.title,owner:s.result?.repairOwner??(c.domain==="report"?"reporter" as const:"worker" as const),reason:s.stale?"対象・検査方法・依存する証拠が変更されています。":s.result?.detail??"検査方法と結果が未登録です。"}));
  return {version:1,revision:l.revision,domain:c.domain,checks:l.checks.map(s=>({...s,history:c.user?s.history:[]})),blockers,
    recheck:{reuseCheckIds:l.checks.filter(s=>s.result&&!s.stale&&["pass","not-applicable"].includes(s.result.status)).map(s=>s.id),
      requiredCheckIds:blockers.map(b=>b.id),changes:l.checks.filter(s=>s.stale&&s.result).map(s=>({id:s.id,files:s.changedFiles??[],
        dependencies:s.plan?.dependsOn.filter(k=>{const d=l.checks.find(x=>x.id===k);return !d?.result||d.stale||s.result!.dependencies[k]!==d.result.id;})??[],
        contractChanged:s.result!.contract!==c.contract,methodChanged:s.result!.planRevision!==s.plan?.revision}))}};
}

// Re-evaluate transitively after a mutation too, not only on the next read.
function invalidateDependents(l:Ledger):void {
  for(let i=0;i<l.checks.length;i++)for(const s of l.checks)if(s.result && s.plan?.dependsOn.some(key=>{const d=l.checks.find(x=>x.id===key);return !d?.result||d.stale||!["pass","not-applicable"].includes(d.result.status)||s.result!.dependencies[key]!==d.result.id;}))s.stale=true;
}

/** Portable file-backed checks. This engine never executes agent-supplied code.
 * Script receipts establish coverage/consistency, not genuine execution; the
 * independent final reviewers still inspect raw evidence and checker logic. */
export async function qualityOperation(c:QualityContext,request:any):Promise<QualitySnapshot>{
  id(c.taskId);id(c.actor);if(!["work","report"].includes(c.domain))throw new Error("品質台帳の領域が不正です。");
  if(!request||typeof request!=="object"||JSON.stringify(request).length>24000)throw new Error("品質操作の形式・サイズが不正です。");
  const file=await safePath(c.root,`.agent-harness/${c.taskId}/quality/${c.domain}/ledger.json`,true);
  if(request.action==="recover-lock"){if(!c.user)throw new Error("ロック復旧は停止中のGUIから実行してください。");await recoverLedgerLock(dirname(file));request={action:"snapshot"};}
  return locked(dirname(file),async()=>{
    let l:Ledger={version:1,revision:0,checks:[]};
    try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>4*1024*1024)throw new Error("品質台帳が不正です。");l=JSON.parse(await readFile(file,"utf8"));if(l.version!==1||!Array.isArray(l.checks))throw new Error("品質台帳の形式が不正です。");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    // Trusted per-run specs always override disk-supplied authority fields.
    l.checks=l.checks.filter(s=>c.specs.some(p=>p.id===s.id)||s.id.startsWith("extra-"));
    for(const spec of c.specs){const found=l.checks.find(s=>s.id===spec.id);if(found)Object.assign(found,spec);else l.checks.push({...spec,history:[]});}
    for(const s of l.checks){s.changedFiles=s.result?await changedFiles(c.root,s.result.files):[];
      s.stale=!!s.result && (s.result.contract!==c.contract||s.result.planRevision!==s.plan?.revision||!!s.changedFiles.length);}
    // Definitions form a DAG, but insertion order need not be topological.
    invalidateDependents(l);
    if(request.action==="snapshot")return snapshot(c,l);
    const key=id(request.id);let check=l.checks.find(s=>s.id===key);
    if(request.action==="define"){
      if(!c.manage||check||!key.startsWith("extra-")||l.checks.length>=100||!c.allowedStages.includes(request.stage))throw new Error("追加検査は計画担当が担当工程内の一意なextra-IDで定義してください。");
      if(typeof request.required!=="boolean")throw new Error("必須/任意を明示してください。");
      check={id:key,stage:request.stage,title:text(request.title,150),guidance:text(request.guidance),required:request.required,allowNA:false,history:[]};l.checks.push(check);
    }else{
      if(!check||!c.allowedStages.includes(check.stage))throw new Error("担当範囲内の検査IDを指定してください。");
      if(request.action==="plan"){
        if(!c.manage&&!c.write)throw new Error("読み取り担当は検査計画を変更できません。");
        const p=request.plan;if(!["script","manual"].includes(p?.method))throw new Error("検査方法はscript/manualです。");
        const targets=strings(p.targets).map(pathName),deps=strings(p.dependsOn??[]).map(id),criteria=strings(p.criterionIds??[]);
        if(!targets.length||deps.some(d=>d===key||!l.checks.some(s=>s.id===d))||criteria.some(k=>!c.criterionIds.includes(k)))throw new Error("対象ファイル・依存先・承認済み条件IDを確認してください。");
        const reaches=(k:string,seen=new Set<string>()):boolean=>{if(k===key)return true;if(seen.has(k))return false;seen.add(k);return !!l.checks.find(s=>s.id===k)?.plan?.dependsOn.some(d=>reaches(d,seen));};
        if(deps.some(d=>reaches(d)))throw new Error("検査の循環依存は作れません。");
        const value={method:p.method,procedure:text(p.procedure),targets,dependsOn:deps,criterionIds:criteria};
        const old=check.plan;if(!old||JSON.stringify({...old,revision:undefined})!==JSON.stringify(value)){check.plan={...value,revision:randomUUID()};check.stale=!!check.result;}
      }else if(request.action==="record"){
        if(!c.write)throw new Error("読み取り担当は検査結果を書き込めません。既存の独立レビューで指摘してください。");
        const p=check.plan;if(!p)throw new Error("検査を実施する前にplanで対象と方法を登録してください。");
        const status=request.status;if(!["pass","fail","unverified","not-applicable"].includes(status))throw new Error("検査状態が不正です。");
        if(request.repairOwner!==undefined && !["worker","reporter"].includes(request.repairOwner))throw new Error("差し戻し先はworker/reporterです。");
        if(c.domain==="work" && request.repairOwner==="reporter")throw new Error("実作業の不備は文書担当へ委譲できません。");
        if(status==="not-applicable"&&!check.allowNA)throw new Error("この検査を対象外にはできません。必須要件は既存のゴールレビューでも確認します。");
        const dependencies:Record<string,string>={};
        for(const k of p.dependsOn){const d=l.checks.find(s=>s.id===k);if((status==="pass"||status==="not-applicable")&&(!d?.result||d.stale||!["pass","not-applicable"].includes(d.result.status)))throw new Error("前提の検査が未確認です。");if(d?.result)dependencies[k]=d.result.id;}
        const evidence=strings(request.evidence).map(pathName);if(!evidence.length)throw new Error("検証証拠ファイルが必要です。");
        if(p.method==="script"&&status==="pass"){
          const resultFile=pathName(text(request.resultFile,500));const r=JSON.parse((await data(c.root,resultFile,100000)).toString());
          if(!r||r.status!=="pass"||!Number.isSafeInteger(r.total)||r.total<=0||r.checked!==r.total||r.failed!==0||r.unverified!==0||r.positiveControl!==true||r.negativeControl!==true)throw new Error("スクリプト合格には対象数>0・全件照合・不一致/未確認0・正常/異常例の検出確認が必要です。");
          text(r.command);evidence.push(resultFile);
        }
        // Failure evidence must be recordable even when a planned output was
        // never produced. A pass/conditional exclusion still requires all targets.
        const targets:string[]=[];
        for(const target of p.targets){
          if(status==="pass"||status==="not-applicable")targets.push(target);
          else try{await data(c.root,target);targets.push(target);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
        }
        const files=await hashes(c.root,[...new Set([...targets,...evidence])]);
        const detail=text(request.detail),repairOwner=["fail","unverified"].includes(status)?request.repairOwner??(c.domain==="report"?"reporter":"worker"):undefined;
        // Re-publishing identical evidence is not a new scientific result. Keep
        // its identity so downstream checks are not invalidated by bookkeeping.
        if(check.result && !check.stale && check.result.status===status && check.result.detail===detail
          && check.result.planRevision===p.revision && check.result.contract===c.contract
          && check.result.repairOwner===repairOwner && sameMapping(check.result.files,files) && sameMapping(check.result.dependencies,dependencies))
          return snapshot(c,l);
        if(check.result)check.history=[...check.history,check.result].slice(-10);
        check.result={id:randomUUID(),status,detail,files,dependencies,planRevision:p.revision,contract:c.contract,actor:c.actor,at:new Date().toISOString(),...(repairOwner?{repairOwner}: {})};check.stale=false;check.changedFiles=[];
      }else throw new Error("未対応の品質操作です。");
    }
    invalidateDependents(l);
    l.revision++;const json=JSON.stringify(l);if(Buffer.byteLength(json)>4*1024*1024)throw new Error("品質台帳の容量上限です。");
    const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,json,{flag:"wx",mode:0o600});await rename(temp,file);
    return snapshot(c,l);
  });
}

export const qualityInstructions=`# Common quality checks (quality_manage)
This task uses evidence-backed quality checks. Inspect snapshot first. Its fixed mode-specific checks and any additional checks form your quality plan; do not duplicate research_manage/hpc_manage records. Existing approved goal, editable mode/writing rules and relevant work skills govern scope and detailed methods. Script repeatable checks early, test the checker on known good AND intentionally bad fixtures, and reserve repair/report/review capacity. Scientific improvement is NOT a universal coding or writing requirement.
Use quality_manage({request:{action,...}}). Paths are relative to the stated quality root. Never edit the ledger directly. Immutable evidence, source/checker/config/input/output files and their hashes identify what was checked; do not point only to a summary. Recheck changed dependencies; reuse unchanged checks. This is evidence integrity, not proof of actual execution. A script pass is not an independent review.
snapshot.recheck lists reusable IDs, required unresolved checks and changed files/dependencies/contracts/methods. Repair only the affected checks and their transitive consumers, not every experiment/citation because the PDF layout changed. Scientific checks must still bind their actual source/data/checker inputs; never omit a real dependency or infer semantic equivalence from formatting. Identical record submissions preserve result identity; changed evidence still invalidates dependents. Use a task-specific data/document manifest for reference keys, expected data coverage and formats. Do not hard-code today's reference count or PDF page count in a reusable checker; derive layout counts from actual current outputs, keeping approved scientific expectations explicit in the manifest.
- snapshot: list checks, plans, current results and blockers. Scope is work or report; remote work and local PDF checks have separate roots, combined by the GUI. Do not pretend to operate the other root.
- plan: id, plan={method:"script|manual",procedure,targets:[source/data/checker/config/output relative files],dependsOn:[other check IDs],criterionIds:[approved IDs]}. Plan before running. Files may not exist yet. A changed plan invalidates its old result and downstream checks; repeated identical plans preserve results. Choose actual semantic dependencies, not all workspace files.
- define: id:"extra-...",stage:one of current allowed stages,title,guidance,required:boolean. Planning owners may add bounded goal-relevant checks. Mandatory defects are required; speculative improvements are optional. Fixed checks cannot be removed or downgraded. Optional failures are visible but do not create endless repair work.
- record: id,status:"pass|fail|unverified|not-applicable",detail,evidence:[saved evidence files]. For a script pass also supply resultFile, whose JSON is {status:"pass",total:positiveInteger,checked:sameTotal,failed:0,unverified:0,positiveControl:true,negativeControl:true,command:"actual invocation"}. These fields must reflect actual testing. Zero coverage, parsing failure, unsupported formats and missing execution are unverified, never pass. Manual checks require actual evidence and meaningful reasoning. Conditional not-applicable requires the responsible writer, evidence and a reason; never waive a required goal condition. Read-only reviewers use the existing goal-evaluation concerns, never write results here.
Work checks belong to workers; report checks belong to reporters and apply to ALL required documents, including poster/slide layouts when present. Reporters cannot repair missing experiments. For a failed/unverified report check, set repairOwner:"worker" when missing implementation/data must be repaired, otherwise repairOwner:"reporter". Resolve ordinary defects autonomously within scope/budget. Preserve good artifacts. Ask the user only for changed scope, authority or exhausted limits. Existing independent review verifies target coverage, receipts, primary sources and all conditional exclusions; checklists do not replace judgment. Operational records must not appear in the scientific report.`;

if(require.main===module)void(async()=>{const [configPath,payload]=process.argv.slice(2);if(!configPath||!payload||payload.length>24000)throw new Error("品質操作の設定とJSONが必要です。");const config=JSON.parse(await readFile(configPath,"utf8"));await assertHpcRunActive(dirname(configPath),config.token);await lstat(join(dirname(configPath),"instructions.txt"));process.stdout.write(JSON.stringify(await qualityOperation(config.context,JSON.parse(payload)))+"\n");})().catch(e=>{process.stderr.write(String(e)+"\n");process.exitCode=1;});
