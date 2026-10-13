import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { stopRemoteForHandoff } from "./remote-quota-stop";
import type { RemoteConnection } from "./remote-client";
import { runRemoteSession } from "./remote-session";
import { hostname } from "node:os";

test("remote handoff keeps its lock until token-bound stop and confirmed child exit",async()=>{
  for(const nativeHandoff of [false,true]) {
    const root=await mkdtemp(join(tmpdir(),"remote-quota-")),token="test-token",lock=join(root,"active.lock");
    const directory=join(root,".agent-harness",randomUUID(),"runs",randomUUID());await mkdir(directory,{recursive:true});
    const config=join(directory,"launch.json"),handoff=join(directory,"handoff.json");
    await writeFile(config,JSON.stringify({retirementProtocol:1,command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:root,lock,token,handoff,exitPath:join(directory,"exit.json")}));
    const child=spawn(process.execPath,[join(__dirname,"remote-session.js"),config],{stdio:"ignore"});
    const ended=new Promise<void>(resolve=>child.on("exit",()=>resolve()));
    const client={resolvedCwd:root,put:async(p:string,d:string|Buffer)=>{assert.ok(p.startsWith(".agent-harness/"));await writeFile(join(root,p),d);},request:async(r:any)=>({data:(await readFile(r.path)).toString("base64")})} as RemoteConnection;
    try {
      const deadline=Date.now()+4000;
      while(true){try{await stat(join(lock,"owner.json"));break;}catch{if(Date.now()>deadline)throw new Error("supervisor not ready");await new Promise(r=>setTimeout(r,20));}}
      await writeFile(join(directory,"stop.json"),JSON.stringify({token:"stale"}));
      await new Promise(r=>setTimeout(r,400));assert.equal(child.exitCode,null);
      if(nativeHandoff){await writeFile(handoff,JSON.stringify({token,status:"blocked",summary:"authentication_failed"}));await new Promise(r=>setTimeout(r,400));}
      assert.equal(child.exitCode,null);
      assert.equal(JSON.parse(await readFile(join(lock,"owner.json"),"utf8")).token,token);
      await stopRemoteForHandoff(client,directory,lock,token);await ended;
      assert.equal(JSON.parse(await readFile(join(directory,"exit.json"),"utf8")).token,token);
      await assert.rejects(()=>stat(lock),{code:"ENOENT"});
    } finally {if(child.exitCode===null)child.kill();await ended;await rm(root,{recursive:true,force:true});}
  }
});

test("disconnection and wrong-token exit records cannot release another writer",async()=>{
  const directory=`/workspace/.agent-harness/${randomUUID()}/runs/${randomUUID()}`;
  const client={resolvedCwd:"/workspace",put:async()=>{},request:async()=>({data:Buffer.from(JSON.stringify({token:"another"})).toString("base64")})} as unknown as RemoteConnection;
  await assert.rejects(()=>stopRemoteForHandoff(client,directory,"/workspace/lock","expected"),/一致/);
  client.request=async()=>{throw new Error("SSH disconnected");};
  await assert.rejects(()=>stopRemoteForHandoff(client,directory,"/workspace/lock","expected"),/SSH/);
  await assert.rejects(()=>stopRemoteForHandoff(client,"/outside","/workspace/lock","expected"),/パス/);
});

test("a rejected launch writes a no-child receipt and does not retire the other lock owner",async t=>{
  const root=await mkdtemp(join(tmpdir(),"remote-rejected-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,".agent-harness",randomUUID(),"runs",randomUUID()),lock=join(root,"active.lock"),token=randomUUID();
  await mkdir(directory,{recursive:true});await mkdir(lock);
  const owner={token:"other-run",host:hostname(),pid:process.pid};await writeFile(join(lock,"owner.json"),JSON.stringify(owner));
  const config=join(directory,"launch.json");
  await writeFile(config,JSON.stringify({command:process.execPath,args:["-e","throw new Error('must not spawn')"],cwd:root,lock,token,exitPath:join(directory,"exit.json")}));
  await assert.rejects(runRemoteSession(config),/同じタスク/);
  const exit=JSON.parse(await readFile(join(directory,"exit.json"),"utf8"));assert.equal(exit.notStarted,true);assert.equal(exit.token,token);
  let recovered=false;
  const client={resolvedCwd:root,put:async(p:string,d:string|Buffer)=>{await writeFile(join(root,p),d);},request:async(r:any)=>({data:(await readFile(r.path)).toString("base64")})} as RemoteConnection;
  await stopRemoteForHandoff(client,directory,lock,token,{recover:async()=>{recovered=true;throw new Error("should not be needed");}});
  assert.equal(recovered,false);assert.deepEqual(JSON.parse(await readFile(join(lock,"owner.json"),"utf8")),owner);
});

test("timeout automatically checks retirement once across parallel waiters and fails closed",async()=>{
  const dir=`/workspace/.agent-harness/${randomUUID()}/runs/${randomUUID()}`;
  let attempts=0;
  const client={resolvedCwd:"/workspace",put:async()=>{},request:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"});}} as unknown as RemoteConnection;
  const options={timeoutMs:0,recover:async()=>{attempts++;return {stopped:true,detail:"終了を確認"};}};
  await Promise.all([stopRemoteForHandoff(client,dir,"/workspace/lock","token",options),stopRemoteForHandoff(client,dir,"/workspace/lock","token",options)]);
  assert.equal(attempts,1);
  await assert.rejects(stopRemoteForHandoff(client,dir,"/workspace/lock","token",{timeoutMs:0,recover:async()=>({stopped:false,detail:"旧CLIが残っています"})}),/旧CLIが残って/);
});

test("synchronous E2BIG and asynchronous spawn failures persist non-start and release the owned lock",async t=>{
  const root=await mkdtemp(join(tmpdir(),"remote-spawn-failure-"));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const kind of ["E2BIG","ENOENT"]) {
    const directory=join(root,kind),lock=join(directory,"active.lock"),token=randomUUID();await mkdir(directory);
    const config=join(directory,"launch.json"),exitPath=join(directory,"exit.json");
    await writeFile(config,JSON.stringify({command:kind==="E2BIG"?process.execPath:join(root,"no-such-cli"),args:kind==="E2BIG"?["-e","x".repeat(2*1024*1024)]:[],cwd:root,lock,token,exitPath}));
    await assert.rejects(promisify(execFile)(process.execPath,[join(__dirname,"remote-session.js"),config]));
    const receipt=JSON.parse(await readFile(exitPath,"utf8"));
    assert.equal(receipt.token,token);assert.equal(receipt.notStarted,true);assert.equal(receipt.spawnError,kind);assert.equal(receipt.host,hostname());
    await assert.rejects(stat(lock),{code:"ENOENT"});
    await assert.rejects(stat(join(directory,"process.json")),{code:"ENOENT"});
  }
});
