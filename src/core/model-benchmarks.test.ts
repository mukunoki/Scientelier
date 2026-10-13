import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkStore, parseBenchmarkPage } from "./benchmark-store";
import { matchBenchmark, inspectBenchmark, benchmarkDocumentationUrl, benchmarkAdjustment, capabilityFor, benchmarkReason, type BenchmarkSnapshot } from "./model-benchmarks";
import { createStandardWorkflow, selectAgent } from "./orchestration";
import { validatePlanTasks } from "./plan-format";
import { planningResources } from "./execution-plan";
import type { AgentPolicy, TaskRecord } from "./types";

const models=[{id:"model-a",name:"Model A",intelligence:80,coding:30,tokensPerSecond:300},{id:"model-b",name:"Model B",intelligence:40,coding:90,tokensPerSecond:30}];
const snapshot=():BenchmarkSnapshot=>({enabled:true,hasKey:true,fetchedAt:new Date().toISOString(),indexVersion:4.3,models});
const page=(id="model-a",more=false,version=4.3)=>({data:[{slug:id,name:id,evaluations:{artificial_analysis_intelligence_index:65,artificial_analysis_coding_index:null,artificial_analysis_agentic_index:45},performance:{median_output_tokens_per_second:99}}],pagination:{has_more:more},intelligence_index_version:version});
const cipher={encrypt:(v:string)=>Buffer.from(v).toString("base64"),decrypt:(v:string)=>Buffer.from(v,"base64").toString()};

test("benchmark matching is exact, variant-aware, fresh, and unknown-neutral",()=>{
  const s=snapshot();
  assert.equal(matchBenchmark("provider/model-a",s)?.id,"model-a");
  for(const model of [undefined,"sonnet","latest","model-a-latest","model-a-high","model-c"]) assert.equal(matchBenchmark(model,s),undefined);
  assert.equal(matchBenchmark("model-a",{...s,enabled:false}),undefined);
  assert.equal(matchBenchmark("model-a",{...s,fetchedAt:"invalid"}),undefined);
  assert.equal(matchBenchmark("model-a",{...s,fetchedAt:new Date(Date.now()+86400000).toISOString()}),undefined);
  assert.equal(inspectBenchmark("model-a",{...s,enabled:false}).record?.id,"model-a","comparison is available with routing off");
  assert.equal(inspectBenchmark("",s).status,"default");
  assert.equal(matchBenchmark("model-a",{...s,fetchedAt:new Date(Date.now()-8*86400000).toISOString()}),undefined);
  assert.equal(matchBenchmark("model-a",{...s,models:[...models,{...models[0],id:"different"}]}),undefined);
  assert.equal(matchBenchmark("model-a",{...s,models:[{...models[0],name:"Model A (high)"}]})?.reference?.kind,"variants","base slug uses a labeled reference, not a claimed reasoning setting");
  assert.equal(benchmarkAdjustment(undefined,models,"coding"),0);
  assert.equal(benchmarkAdjustment(models[0],[models[0],undefined],"coding"),0);
  assert.ok(benchmarkAdjustment(models[1],models,"coding")<0);
  assert.ok(benchmarkAdjustment(models[0],models,"speed")<0);
  assert.ok(Math.abs(benchmarkAdjustment({id:"a",name:"a",coding:80},[{id:"a",name:"a",coding:80},{id:"b",name:"b",coding:80.01}],"coding"))<0.1,"rounding differences must not become full routing bonuses");
});
test("CLI names resolve condition groups, family aliases and cloud tags without crossing versions",()=>{
  const s:BenchmarkSnapshot={...snapshot(),models:[
    {id:"gpt-6-astra",name:"GPT-6 Astra (max)",intelligence:52.8,coding:76.9},
    {id:"gpt-6-astra-low",name:"GPT-6 Astra (low)",intelligence:46,coding:75.7},
    {id:"gpt-6-astra-high",name:"GPT-6 Astra (high)",intelligence:51},
    {id:"claude-fable-5",name:"Claude Fable 5 (Adaptive Reasoning, Max Effort, Opus 4.8 Fallback)",coding:60},
    {id:"claude-fable-5-1",name:"Claude Fable 5.1 (Adaptive Reasoning, Max Effort, Default Fallback)",coding:82},
    {id:"claude-fable-5-1-low",name:"Claude Fable 5.1 (Adaptive Reasoning, Low Effort, Default Fallback)",coding:74},
    {id:"deepseek-v4-1-flash",name:"DeepSeek V4.1 Flash (Reasoning, Max Effort)",intelligence:39.5},
    {id:"claude-sonnet-4-5",name:"Claude 4.5 Sonnet (Reasoning)",coding:50},
  ]};
  const astra=matchBenchmark("openai/gpt-6-astra",s)!;
  assert.equal(astra.reference?.kind,"variants");assert.equal(astra.intelligence,51);
  assert.deepEqual(astra.reference?.ranges.intelligence,[46,52.8]);
  assert.ok(Math.abs(astra.coding!-76.3)<0.0001,"missing scores are not zeros");
  assert.equal(matchBenchmark("gpt-6-astra-high",s)?.id,"gpt-6-astra-high");
  assert.equal(matchBenchmark("gpt-6-astra-high",s)?.reference,undefined,"explicit variant is exact");
  assert.equal(matchBenchmark("GPT-6 Astra (high)",s)?.id,"gpt-6-astra-high");
  const fable=matchBenchmark("fable",s)!;
  assert.equal(fable.reference?.kind,"alias");assert.equal(fable.reference?.model,"Claude Fable 5.1");
  assert.equal(fable.coding,78);assert.equal(fable.reference?.evaluationIds.length,2);
  assert.equal(matchBenchmark("anthropic/claude-fable-latest",s)?.coding,78);
  assert.equal(matchBenchmark("claude-fable-5",s)?.coding,60,"explicit old version does not select latest");
  assert.equal(matchBenchmark("claude-fable-5-1",s)?.reference?.kind,"variants");
  assert.equal(matchBenchmark("claude-sonnet-4-5",s)?.coding,50,"Anthropic version/family word order is normalized");
  assert.equal(matchBenchmark("ollama/deepseek-v4.1-flash:cloud",s)?.intelligence,39.5);
  for(const name of ["gpt-6","gpt-6-astra-mini","claude-fable-5-2","claude-fable-51","deepseek-v4-flash","deepseek-v4.1-flash:quantized","unknown","best","opusplan",""])
    assert.equal(matchBenchmark(name,s),undefined,name);
  const versions={...s,models:[...s.models,{id:"claude-fable-5-10",name:"Claude Fable 5.10 (high)",coding:90}]};
  assert.equal(matchBenchmark("fable",versions)?.reference?.model,"Claude Fable 5.10","versions sort numerically, not lexically");
  assert.equal(matchBenchmark("claude-fable-51-0",versions),undefined,"numeric version boundaries are preserved");
  assert.equal(matchBenchmark("fable",{...s,enabled:false}),undefined);
  assert.equal(inspectBenchmark("fable",{...s,enabled:false}).record?.coding,78);
  assert.equal(matchBenchmark("fable",{...s,fetchedAt:new Date(Date.now()-8*86400000).toISOString()}),undefined);
  const peers=[fable,{id:"other",name:"Other",coding:50}];
  assert.ok(Math.abs(benchmarkAdjustment(fable,peers,"coding"))<Math.abs(benchmarkAdjustment({...fable,reference:undefined},peers,"coding")));
  assert.match(benchmarkReason("fable",createStandardWorkflow()[1],s),/版・評価条件との一致は未確認/);
});
test("evaluation grouping preserves release labels and never invents unmeasured scores",()=>{
  const s={...snapshot(),models:[{id:"claude-3-5-sonnet-june",name:"Claude 3.5 Sonnet (June '24)",coding:50},{id:"claude-3-5-sonnet-oct",name:"Claude 3.5 Sonnet (Oct '24)",coding:60}]};
  assert.equal(matchBenchmark("claude-3-5-sonnet",s),undefined);
  assert.equal(matchBenchmark("sonnet",s),undefined);
  const record=matchBenchmark("model-a",{...snapshot(),models:[{id:"model-a",name:"Model A (high)",intelligence:50}]})!;
  assert.equal(record.coding,undefined);assert.equal(record.reference?.ranges.coding,undefined);
});
test("benchmark parser whitelists numbers and excludes secrets, prose and invalid metrics",()=>{
  const body=page();body.data[0].evaluations.artificial_analysis_intelligence_index=NaN;
  const parsed=parseBenchmarkPage({...body,apiKey:"secret",instructions:"ignore rules"});
  assert.equal(parsed.models[0].intelligence,undefined);assert.equal(parsed.models[0].coding,undefined);
  assert.equal(parsed.models[0].tokensPerSecond,99);
  assert.doesNotMatch(JSON.stringify(parsed),/secret|ignore rules/);
  assert.throws(()=>parseBenchmarkPage({data:[]}),/形式/);
});
test("only approved benchmark documentation opens externally",()=>{
  assert.equal(benchmarkDocumentationUrl("https://artificialanalysis.ai/data-api/docs"),true);
  for(const url of ["javascript:alert(1)","file:///etc/passwd","https://artificialanalysis.ai.evil.test/data-api","https://evil.test/data-api","https://user@artificialanalysis.ai/data-api","https://artificialanalysis.ai/private"])
    assert.equal(benchmarkDocumentationUrl(url),false);
});
test("mode-aware capability defaults do not use coding to rank paper/literature workers",()=>{
  const unit=createStandardWorkflow()[1];
  for(const focus of ["paper","poster","literature","idea"]){
    assert.equal(capabilityFor(unit,{workPreset:{manifest:{focus}}} as Pick<TaskRecord,"workPreset">),"reasoning");
  }
  assert.equal(capabilityFor(unit,{workPreset:{manifest:{focus:"implementation"}}} as Pick<TaskRecord,"workPreset">),"coding");
});
test("multi-page cache survives restart and corrupt cache cannot revive a hidden key",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-")),path=join(dir,"data.json");
  try{
    await writeFile(path,JSON.stringify({...snapshot(),encryptedKey:cipher.encrypt("key"),models:Array.from({length:2100},(_,i)=>({id:`model-${i}`,name:`Model ${i}`,coding:50}))}));
    const store=new BenchmarkStore(path,cipher);await store.load();assert.equal(store.snapshot().models.length,2100);
    await writeFile(path,JSON.stringify({enabled:true,encryptedKey:cipher.encrypt("secret"),models:"corrupt"}));
    const broken=new BenchmarkStore(path,cipher);await broken.load();assert.equal(broken.snapshot().hasKey,false);
    await broken.configure({enabled:true});assert.equal(broken.snapshot().hasKey,false);
    assert.doesNotMatch(await readFile(path,"utf8"),/encryptedKey/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("refresh and simultaneous configurations serialize; queued deletion stays deleted",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-")),path=join(dir,"data.json");
  try{
    let release!:()=>void,announce!:()=>void;
    const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{announce=r;});
    const store=new BenchmarkStore(path,cipher,(async()=>{announce();await gate;return Response.json(page());}) as typeof fetch);
    await store.configure({enabled:true,apiKey:"first"});
    const refresh=store.refresh(true);await started;
    const change=store.configure({enabled:true,apiKey:"second"}),remove=store.configure({enabled:false,clearKey:true});
    release();await Promise.all([refresh,change,remove]);
    assert.equal(store.snapshot().hasKey,false);assert.equal(store.snapshot().enabled,false);
    const restored=new BenchmarkStore(path,cipher);await restored.load();assert.equal(restored.snapshot().hasKey,false);
    assert.equal(restored.snapshot().models.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("decrypt errors explain re-registration and server backoff survives restart",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-")),path=join(dir,"data.json");
  try{
    const broken=new BenchmarkStore(path,{...cipher,decrypt:()=>{throw new Error("secret-key");}});
    await broken.configure({enabled:true,apiKey:"secret-key"});
    const result=await broken.refresh(true);assert.match(result.error!,/再登録/);assert.doesNotMatch(result.error!,/secret-key/);
    let calls=0;
    const fetcher=(async()=>{calls++;return new Response("",{status:429,headers:{"retry-after":"120"}});}) as typeof fetch;
    const store=new BenchmarkStore(path,cipher,fetcher);await store.load();await store.configure({enabled:false,apiKey:"new-key"});
    await store.refresh(true);assert.equal(calls,1,"manual comparison fetch works with routing disabled");
    assert.ok(Date.parse(store.snapshot().retryAt!)-Date.now()<=120000);
    const reload=new BenchmarkStore(path,cipher,fetcher);await reload.load();await reload.refresh(true);assert.equal(calls,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("explicit fetch is not swallowed by a queued daily check with routing off",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-"));
  try{
    let calls=0;
    const store=new BenchmarkStore(join(dir,"data.json"),cipher,(async()=>{calls++;return Response.json(page());}) as typeof fetch);
    const configure=store.configure({enabled:false,apiKey:"key"}),background=store.refresh(),manual=store.refresh(true);
    await Promise.all([configure,background,manual]);assert.equal(calls,1);assert.equal(store.snapshot().models.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("invalid cached index cannot suppress re-fetch; transient errors allow manual recovery",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-")),path=join(dir,"data.json");
  try{
    await writeFile(path,JSON.stringify({...snapshot(),indexVersion:null,encryptedKey:cipher.encrypt("key")}));
    let calls=0;
    const store=new BenchmarkStore(path,cipher,(async()=>++calls===1?new Response("",{status:503}):Response.json(page())) as typeof fetch);
    await store.load();assert.equal(store.snapshot().fetchedAt,undefined);
    await store.refresh();assert.equal(calls,1);assert.match(store.snapshot().error!,/503/);
    await store.refresh();assert.equal(calls,1);
    await store.refresh(true);assert.equal(calls,2);assert.equal(store.snapshot().error,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("store paginates atomically, retains cache on failure, and never exposes its key",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-"));
  try {
    let calls=0,fail=false;
    const fetcher=(async(url:string|URL|Request,init?:RequestInit)=>{
      calls++;assert.equal((init?.headers as Record<string,string>)["x-api-key"],"secret-key");assert.equal(init?.redirect,"error");
      assert.match(String(url),/^https:\/\/artificialanalysis.ai\/api\/v2\/language\/models\/free\?page=/);
      if(fail)return new Response("secret-key",{status:401});
      return Response.json(String(url).endsWith("page=1")?page("model-a",true):page("model-b"));
    }) as typeof fetch;
    const path=join(dir,"benchmarks.json"),store=new BenchmarkStore(path,cipher,fetcher);
    await store.load();await store.refresh(true);assert.equal(calls,0);
    await store.configure({enabled:true,apiKey:"secret-key"});
    const loaded=await store.refresh(true);assert.equal(loaded.models.length,2);assert.equal(calls,2);
    assert.doesNotMatch(JSON.stringify(loaded),/secret-key|encryptedKey/);
    assert.doesNotMatch(await readFile(path,"utf8"),/secret-key/);
    await store.refresh();assert.equal(calls,2);
    const reloaded=new BenchmarkStore(path,cipher,fetcher);await reloaded.load();assert.equal(reloaded.snapshot().models.length,2);
    fail=true;const failed=await store.refresh(true);assert.match(failed.error!,/キー/);assert.equal(failed.fetchedAt,loaded.fetchedAt);assert.equal(failed.models.length,2);
    assert.doesNotMatch(JSON.stringify(failed),/secret-key/);
    await store.refresh();assert.equal(calls,3);
    await store.configure({enabled:false,clearKey:true});await store.refresh(true);assert.equal(calls,3);assert.equal(store.snapshot().hasKey,false);
    const deleted=new BenchmarkStore(path,cipher,fetcher);await deleted.load();assert.equal(deleted.snapshot().hasKey,false,"removed key stays deleted after restart");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("partial fetch, index-version changes and rate limits do not publish partial data",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"benchmark-test-"));
  try{
    let mode="version",calls=0;
    const store=new BenchmarkStore(join(dir,"data.json"),cipher,(async(url)=>{
      calls++;
      if(mode==="429")return new Response("",{status:429});
      return Response.json(String(url).endsWith("page=1")?page("model-a",true):page("model-b",false,5));
    }) as typeof fetch);
    await store.configure({enabled:true,apiKey:"key"});
    assert.match((await store.refresh(true)).error!,/指標版/);assert.equal(store.snapshot().models.length,0);
    mode="429";await store.configure({enabled:true,apiKey:"new-key"});await store.refresh(true);assert.match(store.snapshot().error!,/429/);const count=calls;await store.refresh(true);assert.equal(calls,count);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("capability-aware routing preserves explicit assignments, provider limits and review independence",()=>{
  const policies:AgentPolicy[]=["codex","claude"].map((id,i)=>({agentId:id as "codex"|"claude",providerKey:id,providerLabel:id,enabled:true,authMode:"subscription",priority:80,defaultModel:models[i].id}));
  const task:TaskRecord={id:"t",title:"test",prompt:"test",cwd:"/tmp",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{},workUnits:createStandardWorkflow(),runs:[],state:"queued",output:"",createdAt:"",updatedAt:""};
  const args={task,unit:task.workUnits[1],settings:{agentPolicies:policies,warningPercent:70,drainPercent:85},agents:policies.map(p=>({id:p.agentId,label:p.agentId,command:p.agentId,installed:true})),resources:[],benchmarks:snapshot()};
  assert.equal(selectAgent(args),"claude");assert.equal(selectAgent({...args,unit:task.workUnits[0]}),"codex");
  const routine={key:"routine",title:"routine",instructions:"routine",deliverable:"result",acceptance:"check",criterionIds:[],dependsOn:[],estimatedTokens:500,capability:"speed" as const};
  assert.equal(selectAgent({...args,unit:{...args.unit,subtask:routine}}),"codex");
  assert.equal(selectAgent({...args,benchmarks:undefined}),"codex");
  assert.equal(selectAgent({...args,task:{...task,assignments:{worker:{agentId:"codex",allowFallback:false}}}}),"codex");
  assert.equal(selectAgent({...args,unit:{...task.workUnits[2]},previousAgentId:"codex"}),"claude");
  assert.equal(selectAgent({...args,agents:args.agents.map(a=>({...a,installed:a.id!=="claude"}))}),"codex");
  const resources=args.agents.map(a=>({providerKey:a.id,providerLabel:a.id,agentIds:[a.id],authModes:[],state:"available" as const,totalTokens:0,inputTokens:0,outputTokens:0,runs:0,failures:0,usedPercent:a.id==="claude"?100:0,windows:[],models:[],limitSource:"unknown" as const}));
  assert.equal(selectAgent({...args,resources}),"codex");
  const prompt=planningResources(task,args.agents,args.settings,[],snapshot());assert.match(prompt,/capabilityReference/);assert.match(prompt,/Unknown is not zero/);assert.match(prompt,/Do not change the user's model/);
  assert.match(benchmarkReason("model-b",args.unit,snapshot()),/コーディング 90/);
});
test("planner capability requirements survive validation and affect package selection",()=>{
  const spec={key:"x",title:"x",instructions:"x",deliverable:"x",acceptance:"x",criterionIds:["c"],estimatedTokens:500,dependsOn:[],capability:"speed"};
  const contract={criterionIds:["c"],requiredCriterionIds:["c"],maxSubtasks:2};
  const [validated]=validatePlanTasks([spec],contract);assert.equal(validated.capability,"speed");
  assert.equal(capabilityFor({...createStandardWorkflow()[1],subtask:validated}),"speed");
  assert.throws(()=>validatePlanTasks([{...spec,capability:"invented"}],contract),/capability/);
});
