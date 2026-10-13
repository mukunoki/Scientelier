import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {spawn} from "node:child_process";
import {messagePeers,messageOperation,MessageRelay,MESSAGE_LIMIT} from "./agent-messages";
import {validatePlanTasks} from "./plan-format";
import type {TaskRecord,WorkUnit} from "./types";

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"sc-messages-"));
  const unit=(key:string,primary=false):WorkUnit=>({id:key,title:key,primary,role:"worker",mode:"read",state:"running",planRevision:1,
    dependsOn:[],attemptedAgentIds:[],instructions:"調査",...primary?{}:{subtask:{key,title:key,instructions:"調査",deliverable:"根拠",acceptance:"照合",criterionIds:["a"],dependsOn:[],estimatedTokens:500}}});
  let task:TaskRecord={id:"task",title:"相談",prompt:"調査",cwd:root,state:"running",output:"",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{},createdAt:"",updatedAt:"",
    goal:{status:"approved",revision:1,objective:"調査",constraints:[],outOfScope:[],questions:[],deliverables:["報告"],criteria:[],updatedAt:""},workUnits:[unit("a"),unit("b"),unit("lead",true)],runs:[]};
  task.workUnits[0].subtask!.communication={with:["b"],purpose:"境界条件の確認"};
  const dirs=new Map<string,string>(),tokens=new Map<string,string>(),relay=new MessageRelay();
  for(const [index,u] of task.workUnits.entries()) {
    const dir=join(root,u.id),token=randomUUID(),runId=randomUUID();await mkdir(dir);dirs.set(u.id,dir);tokens.set(u.id,token);
    task.runs.push({id:runId,workUnitId:u.id,role:"worker",agentId:index===1?"claude":"codex",providerKey:index===1?"anthropic":"openai",state:"running",goalRevision:1,output:"",startedAt:""});
    await writeFile(join(dir,"messages-context.json"),JSON.stringify({token,self:u.id,peers:messagePeers(task,u)}));
    await writeFile(join(dir,"instructions.txt"),"相談の指示");
    relay.register({taskId:task.id,unitId:u.id,runId,token,read:async name=>JSON.parse(await readFile(join(dir,name),"utf8")),write:async(name,data)=>{await writeFile(join(dir,name),data);}});
  }
  const flush=()=>relay.flush(task.id,()=>task,async agentMessages=>{task={...task,agentMessages};});
  return {root,dirs,tokens,relay,get task(){return task;},flush,send:(from:string,to:string,text="質問",threadId?:string)=>messageOperation(dirs.get(from)!,tokens.get(from)!,"send",{to,kind:threadId?"answer":"request",text,...threadId?{threadId}:{}}),
    read:(id:string)=>messageOperation(dirs.get(id)!,tokens.get(id)!,"read"),cleanup:()=>rm(root,{recursive:true,force:true})};
}

test("bounded consultation delivers between different CLIs, saves trusted sender identity and acknowledges reads",async()=>{
  const f=await fixture();try {
    const first=await f.send("a","b","境界条件を確認してください。"),before=f.task;
    await Promise.all([f.flush(),f.flush()]);
    assert.equal(before.agentMessages,undefined);assert.equal(f.task.agentMessages!.length,1);
    assert.equal(f.task.agentMessages![0].fromAgentId,"codex");assert.equal(f.task.agentMessages![0].state,"delivered");
    const received=await f.read("b");assert.equal(received.messages[0].text,"境界条件を確認してください。");
    const delivered=f.task.agentMessages![0];await f.flush();assert.equal(f.task.agentMessages![0].state,"read");assert.equal(delivered.state,"delivered","saved snapshots are immutable");
    assert.equal((await f.read("b")).messages.length,0);
    await f.send("b","a","境界で失敗します。",first.threadId);await f.flush();assert.equal((await f.read("a")).messages.length,1);
    await f.send("a","b","修正案を確認してください。",first.threadId);await f.flush();await f.read("b");
    await f.send("b","a","修正案の独立検証が必要です。",first.threadId);await f.flush();
    await assert.rejects(f.send("a","b","もっと議論",first.threadId),/往復2回/);
    assert.equal(f.task.agentMessages!.length,4);assert.equal(f.task.agentMessages![1].fromAgentId,"claude");
  }finally{await f.cleanup();}
});

test("pending primary receives queued findings on admission; old goals expire rather than cross routing",async()=>{
  const f=await fixture();try{
    const lead=f.task.workUnits[2],run=f.task.runs[2];lead.state="pending";run.state="completed";f.relay.unregister(run.id);
    await f.send("a","lead","検証で欠陥を発見");await f.flush();assert.equal(f.task.agentMessages![0].state,"queued");
    lead.state="running";run.state="running";
    const dir=f.dirs.get("lead")!,token=f.tokens.get("lead")!;
    f.relay.register({taskId:f.task.id,unitId:lead.id,runId:run.id,token,read:async n=>JSON.parse(await readFile(join(dir,n),"utf8")),write:async(n,d)=>{await writeFile(join(dir,n),d);}});
    await f.flush();assert.equal((await f.read("lead")).messages[0].text,"検証で欠陥を発見");
    f.relay.unregister(run.id);lead.state="pending";run.state="completed";
    await f.send("a","lead","古い計画の知見");await f.flush();f.task.goal!.revision=2;await f.flush();
    assert.equal(f.task.agentMessages!.at(-1)!.state,"expired");
  }finally{await f.cleanup();}
});

test("independent reviews/candidates/critics and unrelated tasks have no communication path",async()=>{
  const f=await fixture();try{
    for(const change of [{role:"reviewer"},{subtask:{...f.task.workUnits[0].subtask,requirements:{independenceGroup:"blind"}}},{subtask:{...f.task.workUnits[0].subtask,researchCritic:true}},{planPhase:true}]) {
      assert.deepEqual(messagePeers(f.task,{...f.task.workUnits[0],...change} as WorkUnit),[]);
    }
    await assert.rejects(f.send("a","unknown"),/相談先/);
    await assert.rejects(messageOperation(f.dirs.get("a")!,"other","send",{to:"b",kind:"request",text:"不正"}),/相談先|一致/);
    await assert.rejects(f.send("a","b","x".repeat(1501)),/形式/);
    await assert.rejects(f.send("a","b","偽の返信",randomUUID()),/相談ID/);
    f.task.workUnits[1].role="reviewer";await f.send("a","b","独立レビューに送信を試行");await f.flush();assert.equal(f.task.agentMessages,undefined);
    await writeFile(join(f.dirs.get("a")!,"retired.json"),JSON.stringify({token:f.tokens.get("a")}));
    await assert.rejects(f.read("a"),/終了済み/);
  }finally{await f.cleanup();}
});

test("per-run limits, fixed file validation and explicit peer graph are enforced",async()=>{
  const f=await fixture();try{
    for(let i=0;i<MESSAGE_LIMIT;i++)await f.send("a","b",`論点${i}`);
    await assert.rejects(f.send("a","b"),/上限/);
    await symlink(join(f.dirs.get("a")!,"instructions.txt"),join(f.dirs.get("a")!,"messages-inbox.json"));
    await assert.rejects(f.read("a"),/形式/);
    const base={title:"調査",instructions:"根拠を確認",deliverable:"所見",acceptance:"検証",criterionIds:["a"],dependsOn:[],estimatedTokens:500};
    const contract={criterionIds:["a"],requiredCriterionIds:["a"],maxSubtasks:3};
    const tasks=[{...base,key:"one",communication:{with:["two"],purpose:"相互相談"}},{...base,key:"two"}];
    assert.deepEqual(validatePlanTasks(tasks,contract)[0].communication,{with:["two"],purpose:"相互相談"});
    assert.throws(()=>validatePlanTasks([{...tasks[0],communication:{with:["missing"],purpose:"相談"}},tasks[1]],contract),/別担当キー/);
    assert.throws(()=>validatePlanTasks([tasks[0],{...tasks[1],requirements:{independenceGroup:"blind",modelFamilies:["openai"]}}],contract),/独立担当/);
  }finally{await f.cleanup();}
});

test("native MCP and file CLI expose only frozen consultation peers and fence retired sessions",async()=>{
  const f=await fixture();try{
    const dir=f.dirs.get("a")!,token=f.tokens.get("a")!;
    const child=spawn(process.execPath,[join(__dirname,"result-channel.js"),dir,token]);
    let stdout="",stderr="";child.stdout.on("data",d=>stdout+=d);child.stderr.on("data",d=>stderr+=d);
    child.stdin.end([
      {id:1,method:"tools/list"},
      {id:2,method:"tools/call",params:{name:"send_message",arguments:{to:"b",kind:"request",text:"指示取得前"}}},
      {id:3,method:"tools/call",params:{name:"get_instructions",arguments:{}}},
      {id:4,method:"tools/call",params:{name:"send_message",arguments:{to:"b",kind:"finding",text:"検証で差異を発見"}}}
    ].map(v=>JSON.stringify({jsonrpc:"2.0",...v})).join("\n")+"\n");
    assert.equal(await new Promise(r=>child.on("close",r)),0,stderr);
    const responses=stdout.trim().split("\n").map(s=>JSON.parse(s).result);
    assert.ok(responses[0].tools.some((t:any)=>t.name==="send_message"));assert.equal(responses[1].isError,true);assert.equal(responses[3].isError,undefined);
    await f.flush();
    const file=spawn(process.execPath,[join(__dirname,"result-channel.js"),f.dirs.get("b")!,f.tokens.get("b")!,"--messages"]);
    let reply="";file.stdout.on("data",d=>reply+=d);file.stdin.end('{"action":"read"}');
    assert.equal(await new Promise(r=>file.on("close",r)),0);assert.equal(JSON.parse(reply).messages[0].text,"検証で差異を発見");
  }finally{await f.cleanup();}
});
