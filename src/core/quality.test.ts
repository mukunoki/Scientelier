import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualityOperation, type QualityContext } from "./quality";
import { qualityEnabled, qualitySpecs, qualityContext } from "./quality-profiles";
import type { TaskRecord, WorkUnit } from "./types";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { remoteOperation } from "./remote-bridge";

async function fixture(run:(q:QualityContext)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),"harness-quality-"));
  const q:QualityContext={root,taskId:"task",domain:"work",contract:"v1",actor:"worker",write:true,manage:true,allowedStages:["coding"],criterionIds:["a"],specs:[
    {id:"source",stage:"coding",title:"Source",guidance:"Inspect source",required:true,allowNA:false},
    {id:"dependent",stage:"coding",title:"Dependent",guidance:"Inspect dependency",required:true,allowNA:true}
  ]};
  try{await writeFile(join(root,"input.txt"),"source");await writeFile(join(root,"other.txt"),"independent");await run(q);}finally{await rm(root,{recursive:true,force:true});}
}
const plan=(q:QualityContext,id="source",extra:object={})=>qualityOperation(q,{action:"plan",id,plan:{method:"manual",procedure:"Inspect source against criteria",targets:[id==="source"?"input.txt":"other.txt"],...extra}});
const record=(q:QualityContext,id="source",extra:object={})=>qualityOperation(q,{action:"record",id,status:"pass",detail:"Inspected raw evidence and compared with expected values",evidence:[id==="source"?"input.txt":"other.txt"],...extra});

test("quality: unchanged receipts do not invalidate consumers, and recheck names only affected evidence",()=>fixture(async q=>{
  await plan(q);await record(q);await plan(q,"dependent",{dependsOn:["source"]});await record(q,"dependent");
  const clean=await qualityOperation(q,{action:"snapshot"});
  const repeat=await record(q);
  assert.equal(repeat.checks[0].result!.id,clean.checks[0].result!.id);
  assert.equal(repeat.revision,clean.revision);assert.equal(repeat.blockers.length,0);
  assert.deepEqual(repeat.recheck.reuseCheckIds,["source","dependent"]);
  await writeFile(join(q.root,"input.txt"),"changed source");
  const changed=await qualityOperation(q,{action:"snapshot"});
  assert.deepEqual(changed.recheck.requiredCheckIds,["source","dependent"]);
  assert.deepEqual(changed.recheck.changes.find(c=>c.id==="source")!.files,["input.txt"]);
  assert.deepEqual(changed.recheck.changes.find(c=>c.id==="dependent")!.dependencies,["source"]);
  assert.deepEqual(changed.recheck.changes.find(c=>c.id==="dependent")!.files,[]);
}));

test("quality: evidence reuse, changed files, transitive dependencies and plan revisions",()=>fixture(async q=>{
  assert.equal((await qualityOperation(q,{action:"snapshot"})).blockers.length,2);
  await plan(q);await record(q);await plan(q,"dependent",{dependsOn:["source"]});await record(q,"dependent");
  const clean=await qualityOperation(q,{action:"snapshot"});assert.equal(clean.blockers.length,0);
  assert.equal((await plan(q)).checks[0].result!.id,clean.checks[0].result!.id);
  await writeFile(join(q.root,"input.txt"),"changed");
  assert.equal((await qualityOperation(q,{action:"snapshot"})).blockers.length,2);
  await record(q);await record(q,"dependent");
  const changed=await plan(q,"source",{procedure:"Stricter check"});
  assert.equal(changed.blockers.length,2,"downstream invalidates immediately");
  await record(q);await record(q,"dependent");
  assert.equal((await qualityOperation({...q,contract:"new-goal"},{action:"snapshot"})).blockers.length,2);
}));

test("quality: script receipts reject empty/partial coverage and missing control tests",()=>fixture(async q=>{
  await plan(q,"source",{method:"script"});
  const good={status:"pass",total:3,checked:3,failed:0,unverified:0,positiveControl:true,negativeControl:true,command:"python check.py"};
  for(const bad of [{total:0,checked:0},{checked:2},{failed:1},{unverified:1},{negativeControl:false},{positiveControl:false}]){
    await writeFile(join(q.root,"result.json"),JSON.stringify({...good,...bad}));
    await assert.rejects(record(q,"source",{resultFile:"result.json"}),/スクリプト合格/);
  }
  await writeFile(join(q.root,"result.json"),JSON.stringify(good));
  assert.equal((await record(q,"source",{resultFile:"result.json"})).checks[0].result!.status,"pass");
  await writeFile(join(q.root,"result.json"),"{}");
  assert.equal((await qualityOperation(q,{action:"snapshot"})).checks[0].stale,true);
}));

test("quality: scoped permissions, mandatory rules, optional checks and safe paths",()=>fixture(async q=>{
  await plan(q);await assert.rejects(record({...q,write:false}),/読み取り/);
  await assert.rejects(plan({...q,write:false,manage:false}),/読み取り/);
  await assert.rejects(record(q,"source",{status:"not-applicable"}),/対象外/);
  await plan(q,"dependent");await record(q,"dependent",{status:"not-applicable"});
  await assert.rejects(record({...q,allowedStages:["paper"]}),/担当範囲/);
  await assert.rejects(plan(q,"source",{targets:["../escape"]}),/相対/);
  await symlink("input.txt",join(q.root,"link.txt"));
  await assert.rejects(record(q,"source",{evidence:["link.txt"]}));
  await assert.rejects(plan(q,"source",{criterionIds:["invented"]}),/承認済み/);
  await plan(q,"dependent",{dependsOn:["source"]});
  await assert.rejects(plan(q,"source",{dependsOn:["dependent"]}),/循環/);
  await qualityOperation(q,{action:"define",id:"extra-improvement",stage:"coding",title:"Optional",guidance:"Nice to have",required:false});
  await plan(q,"extra-improvement");await record(q,"extra-improvement",{status:"fail"});
  assert.ok(!(await qualityOperation(q,{action:"snapshot"})).blockers.some(b=>b.id==="extra-improvement"));
  await assert.rejects(qualityOperation(q,{action:"define",id:"source",stage:"coding",title:"Downgrade",guidance:"Skip",required:false}));
}));

test("quality: independent domain roots and report repair owner",()=>fixture(async q=>{
  const report={...q,domain:"report" as const};
  await plan(report);await record(report,"source",{status:"fail",repairOwner:"worker"});
  assert.equal((await qualityOperation(report,{action:"snapshot"})).blockers[0].owner,"worker");
  assert.equal((await qualityOperation(q,{action:"snapshot"})).checks[0].result,undefined);
  await plan(q);await assert.rejects(record(q,"source",{repairOwner:"reporter"}),/委譲/);
  await plan(report,"source",{targets:["missing-output.txt"]});
  assert.equal((await record(report,"source",{status:"unverified",repairOwner:"worker"})).blockers[0].owner,"worker");
}));

test("quality: remote bridge and portable MCP use scoped context and reject ended sessions",()=>fixture(async base=>{
  const q={...base,taskId:randomUUID()}, runtime=join(q.root,".agent-harness",q.taskId);
  await mkdir(runtime,{recursive:true});
  for(const name of ["quality.js","hpc.js"])await copyFile(join(__dirname,name),join(runtime,name));
  const s:any=await remoteOperation(q.root,{op:"quality",taskId:q.taskId,context:{...q,root:"/wrong"},request:{action:"snapshot"}});
  assert.equal(s.checks.length,2);
  await assert.rejects(remoteOperation(q.root,{op:"quality",taskId:q.taskId,reportPath:"../escape",context:q,request:{action:"snapshot"}}));
  const run=join(q.root,"run");await mkdir(run);
  for(const name of ["quality.js","hpc.js","implementation-workspaces.js","research-cycle.js","result-channel.js", "agent-messages.js", "redact.js","execution-blocker.js","work-check-format.js","review-format.js","plan-format.js","channel-state.js","runtime-identity.js"])await copyFile(join(__dirname,name),join(run,name));
  await writeFile(join(run,"instructions.txt"),"Quality test instructions");
  await writeFile(join(run,"quality-context.json"),JSON.stringify({token:"token",context:{...q,write:false,manage:false}}));
  const rpc=async()=>{
    const child=spawn(process.execPath,[join(run,"result-channel.js"),run,"token"]);let out="",err="";
    child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
    child.stdin.end([{id:1,method:"tools/list"},{id:2,method:"tools/call",params:{name:"quality_manage",arguments:{request:{action:"snapshot"}}}},{id:3,method:"tools/call",params:{name:"quality_manage",arguments:{request:{action:"record",id:"source",write:true,status:"pass"}}}}].map(v=>JSON.stringify({jsonrpc:"2.0",...v})).join("\n")+"\n");
    assert.equal(await new Promise(r=>child.on("close",r)),0,err);return out.trim().split("\n").map(s=>JSON.parse(s));
  };
  let messages=await rpc();assert.ok(messages[0].result.tools.some((t:any)=>t.name==="quality_manage"));assert.equal(messages[1].result.isError,undefined);assert.equal(messages[2].result.isError,true);
  await writeFile(join(run,"handoff.json"),JSON.stringify({token:"token"}));messages=await rpc();assert.equal(messages[1].result.isError,true);
}));

test("quality: all modes have bounded profiles; composed stages and legacy tasks",()=>{
  const task={id:"task",qualityCycle:1,goal:{status:"approved",criteria:[]}} as unknown as TaskRecord;
  assert.equal(qualityEnabled(task),true);assert.equal(qualityEnabled({...task,qualityCycle:undefined}),false);
  assert.equal(qualityEnabled({...task,roundKind:"consult"}),false);
  for(const mode of ["idea","research","coding","paper","poster","hpc-refactoring"]){
    const t={...task,workPreset:{manifest:{id:mode}}} as TaskRecord;
    assert.ok(qualitySpecs(t,"work").length>0);assert.equal(qualitySpecs(t,"report").length,3);
  }
  const t={...task,workPreset:{manifest:{id:"research-project"},stages:["idea","research","coding","paper"].map(id=>({manifest:{id}}))}} as TaskRecord;
  assert.equal(qualitySpecs(t,"work").length,12);
  const c=qualityContext(t,"/tmp","work",{id:"unit",role:"worker",mode:"write",researchStage:"idea"} as WorkUnit);
  assert.deepEqual(c.allowedStages,["idea"]);assert.equal(c.write,true);
  assert.equal(qualityEnabled({...task,roundKind:"review"}),true,"read-only review cannot bypass quality gates");
  const original={...task,prompt:"initial",instruction:"approved changes",roundKind:"continue"} as TaskRecord;
  const review={...original,roundKind:"review",instruction:"Review again",history:[{kind:"continue",instruction:"approved changes"}]} as TaskRecord;
  assert.equal(qualityContext(original,"/tmp","work").contract,qualityContext(review,"/tmp","work").contract);
});

test("quality: concurrent first-use registration retains every check",()=>fixture(async q=>{
  await Promise.all(Array.from({length:8},(_,i)=>qualityOperation(q,{action:"define",id:`extra-${i}`,stage:"coding",title:`Check ${i}`,guidance:"Independent checks",required:false})));
  const s=await qualityOperation(q,{action:"snapshot"});assert.equal(s.revision,8);assert.equal(s.checks.length,10);
}));
