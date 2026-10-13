import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcriptIdentity,claudeStatusIdentity,runtimeEvidence,parseRuntimeIdentity } from "./runtime-identity";
import { captureRunUsage } from "./run-usage";
import { recordChannelState } from "./channel-state";
import { readRunEvidence } from "./result-channel";
import type { TaskRecord,WorkUnit } from "./types";
const line=(type:string,payload:object,at=1000)=>JSON.stringify({type,payload,timestamp:new Date(at).toISOString()});
test("native identity excludes old/forked turns and keeps model switching explicit",()=>{
  const text=[line("session_meta",{id:"current",model_provider:"openai"}),line("turn_context",{model:"old"},500),
    line("turn_context",{model:"gpt-test"},2000),line("turn_context",{model:"gpt-other"},3000)].join("\n");
  assert.deepEqual(transcriptIdentity("codex",text,1000,"current")?.models,["gpt-test","gpt-other"]);
  assert.equal(transcriptIdentity("codex",text,1000,"foreign"),undefined);
  assert.equal(transcriptIdentity("codex","Requested model gpt-test",0,"current"),undefined);
  const claude=JSON.stringify({type:"assistant",sessionId:"current",timestamp:new Date(2000).toISOString(),message:{model:"claude-test"}});
  assert.equal(transcriptIdentity("claude",claude,1000,"current")?.models[0],"claude-test");
  assert.equal(transcriptIdentity("claude",claude,1000,"foreign"),undefined);
  assert.equal(claudeStatusIdentity({session_id:"current",model:{id:"claude-test"}})?.source,"native-status");
});
test("metadata handoff is bounded and does not expose blind peer verdicts or transcripts",()=>{
  const t={goal:{revision:1},runs:[{id:"source",workUnitId:"source",goalRevision:1,output:"SECRET VERDICT",logPath:"/private/log"},
    {id:"peer",workUnitId:"peer",goalRevision:1,output:"PEER VERDICT"}]} as unknown as TaskRecord;
  const unit={id:"current",role:"worker",dependsOn:["source"],subtask:{requirements:{independenceGroup:"blind"}}} as WorkUnit;
  const evidence=runtimeEvidence(t,unit);
  assert.equal(evidence.length,1);assert.doesNotMatch(JSON.stringify(evidence),/SECRET|PEER|private/);
  const native={source:"native-session",sessionId:"current",models:["gpt-test"],observedAt:new Date().toISOString(),output:"SECRET"};
  assert.doesNotMatch(JSON.stringify(parseRuntimeIdentity(native)),/SECRET/);
  const big={goal:{revision:1},runs:Array.from({length:24},(_,i)=>({id:`run-${i}`,goalRevision:1,runtimeIdentity:native,
    skillUsage:{reads:Array.from({length:24},(_,j)=>({id:`skill-${j}`,revision:"a".repeat(64)}))}}))} as unknown as TaskRecord;
  const bounded=runtimeEvidence(big,{id:"work",role:"worker",dependsOn:[]} as unknown as WorkUnit);
  assert.ok(bounded.length>0 && bounded.length<24);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=24000);
  assert.doesNotMatch(JSON.stringify(bounded),/SECRET/);
});
test("identity is captured even without token accounting, and run evidence cannot cross run tokens",async()=>{
  const root=await mkdtemp(join(tmpdir(),"harness-identity-"));
  try {
    const transcript=join(root,"native.jsonl");
    await writeFile(transcript,JSON.stringify({type:"assistant",sessionId:"current",timestamp:new Date(2000).toISOString(),message:{model:"claude-test"}}));
    await writeFile(join(root,"metrics-config.json"),JSON.stringify({token:"run",startedAt:1000}));
    await captureRunUsage("claude",{session_id:"current",transcript_path:transcript},root,"run");
    await writeFile(join(root,"run-evidence.json"),JSON.stringify({token:"run",current:{requestedModel:"opus"},previous:[]}));
    await recordChannelState(root,"run","instructions-read");
    const value=await readRunEvidence(root,"run");
    assert.equal(value.current.requestedModel,"opus");assert.deepEqual(value.current.observed.models,["claude-test"]);
    await assert.rejects(readRunEvidence(root,"wrong"));await assert.rejects(readRunEvidence(root,"run",{path:"/private"}));
    await captureRunUsage("opencode",{identity:{source:"native-session",sessionId:"opencode-current",models:["ollama/deepseek-test"],observedAt:new Date(3000).toISOString()}},root,"run");
    assert.deepEqual((await readRunEvidence(root,"run")).current.observed.models,["ollama/deepseek-test"]);
  }finally{await rm(root,{recursive:true,force:true});}
});
