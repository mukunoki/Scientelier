import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { researchOperation, researchBlockers, researchInstructions, researchContextFor, type ResearchContext } from "./research-cycle";
import { remoteOperation } from "./remote-bridge";
import { validatePlanTasks } from "./plan-format";
import { buildInvocation, AGENT_PROFILES } from "./adapters";
import type { TaskRecord, WorkUnit } from "./types";

test("primary milestones retain research authority without granting it to readers, isolated work or reporters",()=>{
  const task={id:"task",researchCycle:1} as TaskRecord;
  const unit={id:"unit",role:"worker",mode:"write",primaryStep:true,subtask:{kind:"primary-work"}} as WorkUnit;
  assert.equal(researchContextFor(task,unit,"/workspace","claude")?.manage,true);
  assert.equal(researchContextFor(task,unit,"/workspace","claude")?.write,true);
  for(const changed of [{mode:"read"},{primaryStep:false},{role:"reporter"},{role:"reviewer"}]) {
    assert.equal(researchContextFor(task,{...unit,...changed} as WorkUnit,"/workspace","claude")?.manage,false);
  }
  for(const excluded of [{inputOnly:true},{localReport:true},{isolated:true}]) assert.equal(researchContextFor(task,unit,"/workspace","claude",excluded),undefined);
  assert.equal(researchContextFor({...task,goalPreparation:true},unit,"/workspace","claude"),undefined);
});

async function fixture(fn: (root:string, writer:ResearchContext, critic:ResearchContext) => Promise<void>) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"research-cycle-")));
  try { const writer={root,taskId:randomUUID(),actor:"writer",cli:"codex",write:true,manage:true,user:true};
    await writeFile(join(root,"evaluator.py"),"fixed evaluator");
    await writeFile(join(root,"protocol.json"),"fixed split, seeds and resource policy");
    await fn(root,writer,{...writer,actor:"critic",cli:"claude",write:false,manage:false,critic:true});
  } finally {await rm(root,{recursive:true,force:true});}
}
const protocol={question:"Does the mechanism improve both datasets?",files:["evaluator.py","protocol.json"],maxExperiments:20,
  metrics:[{id:"a",direction:"max",tolerance:0,subset:true},{id:"b",direction:"min",tolerance:0,subset:false}]};
const candidate={id:"h1",hypothesis:"Cache redundant computation",limitation:"Repeated work",novelty:"Provisional difference from primary source",falsifier:"No speed improvement",sources:["https://arxiv.org/abs/2609.19644 section 3"]};
async function record(c:ResearchContext,id:string,stage:string,metrics:Record<string,number>,comparedTo?:string,candidateId="h1") {
  await mkdir(join(c.root,id));
  await writeFile(join(c.root,id,"result.json"),JSON.stringify(metrics));
  await writeFile(join(c.root,id,"code.py"),`source snapshot ${id}`);
  await writeFile(join(c.root,id,"run.log"),`execution/environment/seed receipt ${id}`);
  return researchOperation(c,{action:"record",experiment:{id,stage,candidate:candidateId,purpose:`Measured ${stage}`,comparedTo,result:`${id}/result.json`,evidence:[`${id}/code.py`,`${id}/run.log`]}});
}
const judge=(c:ResearchContext,id:string,verdict="accept")=>researchOperation(c,{action:"judge",experimentId:id,verdict,reason:"Checked raw results, evaluator, execution and methodological limitations"});

test("one output contract checks smoke results and rejects missing final evidence without recording success",async()=>fixture(async(root,w,c)=>{
  await researchOperation(w,{action:"protocol",protocol:{...protocol,outputs:[{id:"raw",format:"json",requiredKeys:["command","environment.host"],nonEmptyKeys:["records"]}]}});
  await writeFile(join(root,"raw.json"),JSON.stringify({command:"fixture",environment:{host:"fixture"},records:[]}));
  let checked=await researchOperation(c,{action:"check-outputs",outputs:{raw:"raw.json"}});
  assert.equal(checked.outputCheck!.ok,false);
  assert.match(checked.outputCheck!.checks[0].reason!,/空/);
  await mkdir(join(root,"trial"));
  await writeFile(join(root,"trial/result.json"),JSON.stringify({a:1}));
  await writeFile(join(root,"trial/code.py"),"fixture");await writeFile(join(root,"trial/run.log"),"fixture");
  const experiment={id:"baseline",stage:"baseline-subset",result:"trial/result.json",purpose:"fixture",evidence:["trial/code.py","trial/run.log"],outputs:{raw:"raw.json"}};
  await assert.rejects(researchOperation(w,{action:"record",experiment}),/必須出力/);
  assert.equal((await researchOperation(c,{action:"snapshot"})).experiments.length,0);
  await writeFile(join(root,"raw.json"),JSON.stringify({command:"fixture",environment:{host:"fixture"},records:[{value:0}]}));
  checked=await researchOperation(c,{action:"check-outputs",outputs:experiment.outputs});assert.equal(checked.outputCheck!.ok,true);
  const stored=await researchOperation(w,{action:"record",experiment});
  assert.ok(stored.experiments[0].files["raw.json"]);
  await writeFile(join(root,"raw.json"),"changed");
  assert.equal((await researchOperation(c,{action:"snapshot"})).experiments[0].stale,true);
  for(const path of ["missing.json","../outside.json","trial"]) {
    assert.equal((await researchOperation(c,{action:"check-outputs",outputs:{raw:path}})).outputCheck!.ok,false);
  }
  await symlink(join(root,"trial/result.json"),join(root,"link.json"));
  assert.equal((await researchOperation(c,{action:"check-outputs",outputs:{raw:"link.json"}})).outputCheck!.ok,false);
  assert.equal(JSON.parse(await readFile(join(root,`.agent-harness/${w.taskId}/research/ledger.json`),"utf8")).outputCheck,undefined,"checks are observations, never scientific pass records");
}));

test("output contracts reject duplicate IDs and JSON keys on opaque files",async()=>fixture(async(_root,w)=>{
  for(const outputs of [[{id:"raw",format:"file",requiredKeys:["x"]}],[{id:"raw",format:"file"},{id:"raw",format:"json"}],[]]) {
    await assert.rejects(researchOperation(w,{action:"protocol",protocol:{...protocol,outputs}}));
  }
}));

test("new harness registrations require output contracts while fixed legacy protocols remain usable",async()=>fixture(async(_root,w,c)=>{
  await assert.rejects(researchOperation({...w,requireOutputContract:true},{action:"protocol",protocol}),/protocol.outputs/);
  // A protocol saved before this feature is never silently rewritten.
  await researchOperation(w,{action:"protocol",protocol});
  const legacy=await researchOperation({...c,requireOutputContract:true},{action:"snapshot"});
  assert.equal(legacy.protocol!.outputs,undefined);
  assert.equal((await record({...w,requireOutputContract:true},"legacy","baseline-subset",{a:1})).experiments.length,1);
}));

test("research preparation precedes measurements and serial GPU use does not waive registration or independence", () => {
  assert.match(researchInstructions, /Before the FIRST implementation\/measurement milestone/);
  assert.match(researchInstructions, /single exclusive GPU.*does NOT make evaluation registration/);
  assert.match(researchInstructions, /never backdate a protocol/);
  assert.match(researchInstructions, /reuse unchanged evidence instead of rerunning GPU experiments/);
});

test("research requires fixed baselines, independent stage criticism, complete metrics and current ablations",async()=>fixture(async(root,w,c)=>{
  await researchOperation(w,{action:"protocol",protocol});
  await researchOperation(w,{action:"candidate",candidate});
  await assert.rejects(researchOperation(w,{action:"protocol",protocol}),/固定/);
  await record(w,"bs","baseline-subset",{a:1});
  await record(w,"bf","baseline-full",{a:1,b:10});
  await assert.rejects(record(w,"too-early","full",{a:2,b:9}),/小規模評価/);
  let l=await record(w,"s","subset",{a:2}); assert.equal(l.experiments.at(-1)!.decision,"advance");
  await assert.rejects(judge(w,"s"),/読取専用/);
  await assert.rejects(judge({...c,cli:"codex"},"s"),/別CLI/);
  await assert.rejects(judge({...c,critic:false},"s"),/researchCritic/);
  await judge(c,"s");
  await assert.rejects(record(w,"missing","full",{a:2}),/指標/);
  l=await record(w,"regression","full",{a:3,b:11}); assert.equal(l.experiments.at(-1)!.decision,"refine");
  await judge(c,"regression");
  await assert.rejects(researchOperation(w,{action:"select",experimentId:"regression"}),/改善/);
  await record(w,"f","full",{a:2,b:9}); await judge(c,"f");
  l=await researchOperation(w,{action:"select",experimentId:"f"}); assert.match(researchBlockers(l)[0],/要素比較/);
  await record(w,"ab","ablation",{a:1,b:10},"f"); await judge(c,"ab");
  l=await researchOperation(w,{action:"snapshot"}); assert.deepEqual(researchBlockers(l),[]);
  await record(w,"worse","full",{a:1.5,b:9.5}); await judge(c,"worse");
  await assert.rejects(researchOperation(w,{action:"select",experimentId:"worse"}),/最良/);
  assert.equal((await researchOperation(w,{action:"snapshot"})).selected,"f");
  const blind=await researchOperation({...c,user:false,blind:true},{action:"snapshot"});
  assert.ok(blind.experiments.every(e=>!e.critique));
  await writeFile(join(root,"s/result.json"),JSON.stringify({a:999}));
  l=await researchOperation(w,{action:"snapshot"}); assert.ok(l.experiments.find(e=>e.id==="f")!.stale);assert.ok(researchBlockers(l).length);
  await writeFile(join(root,"evaluator.py"),"changed rules");
  await assert.rejects(researchOperation(w,{action:"candidate",candidate:{...candidate,id:"h2"}}),/固定した/);
}));

test("research preserves negative findings, bounds search and forbids unsafe evidence or self-granted permissions",async()=>fixture(async(root,w,c)=>{
  await researchOperation(w,{action:"protocol",protocol:{...protocol,maxExperiments:2}});
  await researchOperation(w,{action:"candidate",candidate});
  await record(w,"base","baseline-subset",{a:1});
  await record(w,"negative","subset",{a:0.5}); await judge(c,"negative","reject");
  let l=await researchOperation(w,{action:"conclude-negative",reason:"All registered hypotheses failed the bounded pilot; report limits without claiming improvement"});
  assert.ok(l.conclusion); assert.deepEqual(researchBlockers(l),[]);
  await assert.rejects(record(w,"extra","subset",{a:2}),/予算上限/);
  await assert.rejects(researchOperation({...c,user:false},{action:"record",user:true,write:true,experiment:{}}),/書込み担当/);
  await assert.rejects(researchOperation(c,{action:"select",experimentId:"negative"}),/主担当/);
  await writeFile(join(root,"negative/run.log"),"changed evidence");
  l=await researchOperation(w,{action:"snapshot"});assert.ok(researchBlockers(l).length);
  const other={...w,taskId:randomUUID()}; await symlink(join(root,"evaluator.py"),join(root,"link.py"));
  await assert.rejects(researchOperation(other,{action:"protocol",protocol:{...protocol,files:["link.py"]}}),/リンク/);
  await assert.rejects(researchOperation(other,{action:"protocol",protocol:{...protocol,files:["../outside"]}}),/相対/);
}));

test("selection compares all verified candidates and never erases a stale historical success",async()=>fixture(async(root,w,c)=>{
  await researchOperation(w,{action:"protocol",protocol});await researchOperation(w,{action:"candidate",candidate});
  await record(w,"bs","baseline-subset",{a:1});await record(w,"bf","baseline-full",{a:1,b:10});
  await record(w,"s","subset",{a:2});await judge(c,"s");
  await record(w,"weak","full",{a:2,b:9});await judge(c,"weak");
  await researchOperation(w,{action:"select",experimentId:"weak"});
  await record(w,"ab","ablation",{a:1,b:10},"weak");await judge(c,"ab");
  await record(w,"best","full",{a:3,b:8});await judge(c,"best");
  assert.match(researchBlockers(await researchOperation(w,{action:"snapshot"}))[0],/上回る/);
  await assert.rejects(researchOperation(w,{action:"select",experimentId:"weak"}),/全候補/);
  await researchOperation(w,{action:"select",experimentId:"best"});
  const original=await readFile(join(root,"best/run.log"),"utf8");
  await writeFile(join(root,"best/run.log"),"changed");
  await assert.rejects(researchOperation(w,{action:"select",experimentId:"weak"}),/失効/);
  await assert.rejects(researchOperation(w,{action:"conclude-negative",reason:"Ignore success"}),/失効/);
  assert.match(researchBlockers(await researchOperation(w,{action:"snapshot"}))[0],/失効/);
  await writeFile(join(root,"best/run.log"),original);
  await researchOperation(w,{action:"select",experimentId:"best"});
  assert.match(researchBlockers(await researchOperation(w,{action:"snapshot"}))[0],/要素比較/);
}));

test("remote bridge and standalone MCP expose the same research engine and reject ended runs",async()=>fixture(async(root,w)=>{
  const runtime=join(root,".agent-harness",w.taskId);await mkdir(runtime,{recursive:true});
  for(const file of ["research-cycle.js","hpc.js"])await copyFile(join(__dirname,file),join(runtime,file));
  const l:any=await remoteOperation(root,{op:"research",taskId:w.taskId,context:{...w,root:"/wrong"},request:{action:"protocol",protocol}});
  assert.equal(l.protocol.question,protocol.question);
  const runDir=join(root,"run");await mkdir(runDir);await writeFile(join(runDir,"instructions.txt"),"Fixture research instructions");
  await writeFile(join(runDir,"research-context.json"),JSON.stringify({token:"token",context:{...w,user:false,write:false,manage:false}}));
  for(const file of ["research-cycle.js","hpc.js","quality.js","implementation-workspaces.js","result-channel.js", "agent-messages.js", "redact.js","execution-blocker.js","work-check-format.js","review-format.js","plan-format.js","channel-state.js","runtime-identity.js"])await copyFile(join(__dirname,file),join(runDir,file));
  const rpc=async()=>{
    const child=spawn(process.execPath,[join(runDir,"result-channel.js"),runDir,"token"]);let out="",err="";
    child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
    child.stdin.end([{id:1,method:"tools/list"},{id:2,method:"tools/call",params:{name:"research_manage",arguments:{request:{action:"snapshot"}}}},{id:3,method:"tools/call",params:{name:"research_manage",arguments:{request:{action:"candidate",candidate}}}}].map(v=>JSON.stringify({jsonrpc:"2.0",...v})).join("\n")+"\n");
    assert.equal(await new Promise(r=>child.on("close",r)),0,err);return out.trim().split("\n").map(s=>JSON.parse(s));
  };
  let messages=await rpc();assert.ok(messages[0].result.tools.some((t:any)=>t.name==="research_manage"));assert.equal(messages[1].result.isError,undefined);assert.equal(messages[2].result.isError,true);
  await writeFile(join(runDir,"handoff.json"),JSON.stringify({token:"token"}));messages=await rpc();assert.equal(messages[1].result.isError,true);
  assert.equal(JSON.parse(await readFile(join(runtime,"research/ledger.json"),"utf8")).revision,1);
}));

test("research critic contract and CLI tool configuration are explicit, scoped and non-writable",()=>{
  const spec={key:"critic",title:"Critic",instructions:"Verify subset",deliverable:"Critique",acceptance:"Inspect artifacts",criterionIds:["a"],estimatedTokens:500,dependsOn:[],researchCritic:true};
  const contract={criterionIds:["a"],requiredCriterionIds:["a"],maxSubtasks:2,allowResearchCritic:true};
  assert.equal(validatePlanTasks([spec],contract)[0].researchCritic,true);
  assert.throws(()=>validatePlanTasks([spec],{...contract,allowResearchCritic:false}),/researchCritic/);
  assert.throws(()=>validatePlanTasks([{...spec,kind:"primary-work"}],{...contract,allowPrimarySteps:true}),/researchCritic/);
  for(const id of ["codex","claude"] as const){const profile=AGENT_PROFILES.find(p=>p.id===id)!;const args=buildInvocation({...profile,installed:true,executable:id},{prompt:"p",cwd:"/tmp",mode:"read",resultCommand:["node","result.js"],research:true}).args.join(" ");assert.match(args,/research_manage/);}
});
