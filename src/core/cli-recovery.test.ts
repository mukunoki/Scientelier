import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { recoverRemoteRun, legacyLaunchRejected, legacySpawnRejected, noRunProcesses, processPredates } from "./cli-recovery";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"cli-recovery-")));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const task=randomUUID(),run=randomUUID(),token=randomUUID(),dir=join(root,".agent-harness",task,"runs",run),lock=join(dir,"active.lock");
  await mkdir(lock,{recursive:true});
  const put=(name:string,value:unknown)=>writeFile(join(dir,name),JSON.stringify(value));
  await put("launch.json",{lock,token});
  return {root,task,run,token,dir,lock,put,call:(action:"inspect"|"confirm"|"auto",manual=false)=>recoverRemoteRun(root,task,run,action,manual)};
}

test("manual recovery never clears a live supervisor, child, or foreign-host lock",async t=>{
  const f=await fixture(t);
  await f.put("active.lock/owner.json",{token:f.token,host:hostname(),pid:process.pid});
  await assert.rejects(f.call("confirm",true),/旧CLIが残って/);
  await f.put("active.lock/owner.json",{token:f.token,host:"other-host",pid:process.pid});
  await assert.rejects(f.call("confirm",true),/同じホスト/);
  await rm(f.lock,{recursive:true});
  await f.put("process.json",{token:f.token,host:hostname(),pid:process.pid});
  await assert.rejects(f.call("confirm",true),/旧CLIが残って/);
  assert.equal((await f.call("inspect")).needsManualConfirmation,false);
});

test("legacy missing receipts require explicit manual confirmation, not a fabricated exit",async t=>{
  const f=await fixture(t);
  // An empty abandoned lock has no reliable PID; never infer termination from age.
  const status=await f.call("inspect");assert.equal(status.stopped,false);assert.equal(status.needsManualConfirmation,true);
  await assert.rejects(f.call("confirm"),/終了記録が欠け/);
  await f.call("confirm",true);
  await assert.rejects(stat(f.lock),{code:"ENOENT"});
  const proof=JSON.parse(await readFile(join(f.dir,"retirement-recovery.json"),"utf8"));
  assert.equal(proof.token,f.token);assert.equal(proof.method,"user-confirmed");
  await assert.rejects(stat(join(f.dir,"exit.json")),{code:"ENOENT"});
  assert.equal((await f.call("inspect")).stopped,true);
});

test("verified recovery preserves another run's lock and replaces symlinks without following them",async t=>{
  const f=await fixture(t),other={token:"another-run",host:hostname(),pid:process.pid};
  await f.put("active.lock/owner.json",other);
  await f.put("exit.json",{token:f.token,code:0});
  const outside=join(f.root,"untouched.txt");await writeFile(outside,"keep");
  await symlink(outside,join(f.dir,"retired.json"));
  assert.equal((await f.call("confirm")).stopped,true);
  assert.deepEqual(JSON.parse(await readFile(join(f.lock,"owner.json"),"utf8")),other);
  assert.equal(await readFile(outside,"utf8"),"keep");
});

test("recovery rejects mismatched receipts and symbolic-link locks",async t=>{
  const f=await fixture(t);
  await f.put("process.json",{token:"another",host:hostname(),pid:process.pid});
  await assert.rejects(f.call("inspect"),/一致しません/);
  await rm(join(f.dir,"process.json"));await rm(f.lock,{recursive:true});
  const outside=join(f.root,"outside");await mkdir(outside);
  await writeFile(join(outside,"owner.json"),JSON.stringify({token:f.token,host:hostname(),pid:process.pid}));
  await symlink(outside,f.lock);await assert.rejects(f.call("confirm",true),/リンク/);
});

test("a stopped supervisor and child release only their matching lock",async t=>{
  const f=await fixture(t),dead=spawnSync(process.execPath,["-e",""]).pid;
  assert.ok(dead>1);
  await f.put("active.lock/owner.json",{token:f.token,host:hostname(),pid:dead});
  await f.put("process.json",{token:f.token,host:hostname(),pid:dead});
  assert.equal((await f.call("confirm")).stopped,true);
  await assert.rejects(stat(f.lock),{code:"ENOENT"});
  assert.equal(JSON.parse(await readFile(join(f.dir,"retirement-recovery.json"),"utf8")).method,"process-or-exit");
});

test("automatic retirement uses evidence, never the manual override or a live PID",async t=>{
  const f=await fixture(t);
  assert.equal((await f.call("auto",true)).stopped,false,"manual=true is ignored on the automatic path");
  await f.put("active.lock/owner.json",{token:f.token,host:hostname(),pid:process.pid});
  await f.put("exit.json",{token:f.token,code:0});
  assert.equal((await f.call("auto")).stopped,false);
  await rm(f.lock,{recursive:true});
  assert.equal((await f.call("auto")).stopped,true);
  assert.equal(JSON.parse(await readFile(join(f.dir,"retirement-recovery.json"),"utf8")).method,"process-or-exit");
});

test("legacy rejection evidence must be the exact native startup failure for this lock",()=>{
  const lock="/workspace/.agent-harness/task/active.lock";
  const output=`同じタスクの遠隔CLIが動作中、または終了を確認できません。二重起動を防いでいます。接続先で ${lock}/owner.json のPIDとホストを確認してください。残存CLIがないことを確認した場合に限り、このロックを手動で取り除いてください。\r\nTerminal exited (75).Terminal retiring: 確認中`;
  assert.equal(legacyLaunchRejected(output,lock),true);
  assert.equal(legacyLaunchRejected("Model commentary: "+output,lock),false);
  assert.equal(legacyLaunchRejected(output,lock+"-other"),false);
  assert.equal(legacyLaunchRejected(output.replace("(75)","(0)"),lock),false);
});

test("large legacy launch records stay remote and modern control metadata avoids the prompt",async t=>{
  const f=await fixture(t);
  await f.put("launch.json",{token:f.token,lock:f.lock,args:["very long instructions".repeat(30000)]});
  const status=await f.call("inspect");
  assert.deepEqual(status.control,{token:f.token,lock:f.lock});
  assert.ok(JSON.stringify(status).length<1500);
  assert.equal(status.stopped,false,"a readable launch file is not proof of exit");
  await f.put("session-control.json",{token:f.token,lock:f.lock});
  await writeFile(join(f.dir,"launch.json"),"intentionally unreadable legacy body");
  assert.deepEqual((await f.call("inspect")).control,status.control);
  await f.put("session-control.json",{token:f.token,lock:"/outside/lock"});
  await assert.rejects(f.call("auto"),/起動記録/);
});

test("legacy E2BIG recognition requires the native non-start signature and never overrides a live owner",async t=>{
  const output="spawn E2BIG\r\nTerminal exited (75).Terminal retiring: waiting";
  assert.equal(legacySpawnRejected(output),true);
  for(const text of ["model says: "+output,output.replace("(75)","(0)"),"spawn ENOENT\nTerminal exited (75).", "spawn E2BIG"]) assert.equal(legacySpawnRejected(text),false);
  const f=await fixture(t);
  await f.put("active.lock/owner.json",{token:f.token,host:hostname(),pid:process.pid,configPath:join(f.dir,"launch.json")});
  const status=await recoverRemoteRun(f.root,f.task,f.run,"auto",false,{output,expectedHost:hostname()});
  assert.equal(status.stopped,false);
  assert.equal((await stat(f.lock)).isDirectory(),true);
});

test("legacy process scan checks both arguments and environment without returning secrets",async t=>{
  const f=await fixture(t),proc=join(f.root,"proc"),pid=join(proc,"123456789");await mkdir(pid,{recursive:true});
  await writeFile(join(pid,"cmdline"),"opencode\0");await writeFile(join(pid,"environ"),"OTHER=value\0");
  assert.equal(await noRunProcesses(proc,f.dir,f.token),true);
  await writeFile(join(pid,"environ"),`OPENCODE_CONFIG_CONTENT=${f.dir}\0`);
  assert.equal(await noRunProcesses(proc,f.dir,f.token),false);
  await writeFile(join(pid,"environ"),"");await writeFile(join(pid,"cmdline"),`node\0${f.token}\0`);
  assert.equal(await noRunProcesses(proc,f.dir,f.token),false);
  assert.equal(await noRunProcesses(join(proc,"missing"),f.dir,f.token),false);
});

test("only processes clearly predating a launch can be excluded from its recovery scan",()=>{
  const fields=Array(20).fill("0");fields[0]="S";fields[19]="1000";
  const value=`42 (process (with spaces)) ${fields.join(" ")}`;
  assert.equal(processPredates(value,100,100,120000),true);
  assert.equal(processPredates(value,100,100,110000),false);
  assert.equal(processPredates(value,100,100,100000),false);
  assert.equal(processPredates(value,100,NaN,120000),false);
  assert.equal(processPredates("bad stat",100,100,120000),false);
});

test("the recovery control transport is excluded, but its sibling CLI is still detected",async t=>{
  const f=await fixture(t),proc=join(f.root,"proc"),parent=123456788,sibling=123456789;
  const statLine=(pid:number,ppid:number)=>`${pid} (transport) S ${ppid} 0 0`;
  for(const pid of [process.pid,parent,sibling])await mkdir(join(proc,String(pid)),{recursive:true});
  await writeFile(join(proc,String(process.pid),"stat"),statLine(process.pid,parent));
  await writeFile(join(proc,String(parent),"stat"),statLine(parent,0));
  // No readable environ for the SSH ancestor; it cannot be this run's child.
  await writeFile(join(proc,String(sibling),"cmdline"),`node\0${f.dir}\0`);
  await writeFile(join(proc,String(sibling),"environ"),"");
  assert.equal(await noRunProcesses(proc,f.dir,f.token),false);
  await rm(join(proc,String(sibling)),{recursive:true});
  assert.equal(await noRunProcesses(proc,f.dir,f.token),true);
});
