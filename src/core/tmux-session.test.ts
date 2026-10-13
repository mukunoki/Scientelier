import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startTmuxSession, inspectTmuxSession, closeTmuxSession } from "./tmux-session";
import { TerminalRunner } from "./terminal-runner";

const wait = async (check:()=>Promise<boolean>|boolean) => {
  for(let n=0;n<200;n++) { if(await check())return; await new Promise(r=>setTimeout(r,25)); }
  throw new Error("tmux test timed out");
};
test("tmux preserves native CLI/PID and raw log after disconnect, reattaches without a second launch, and retires explicitly", async t => {
  try { await promisify(execFile)("tmux",["-V"]); } catch { t.skip("tmux is not installed");return; }
  const root = await realpath(await mkdtemp(join(tmpdir(),"sc-tmux-"))), dir=join(root,randomUUID());
  await mkdir(dir); const token=randomUUID(),configPath=join(dir,"launch.json"), runner=new TerminalRunner();
  await copyFile(join(__dirname,"remote-session.js"),join(dir,"remote-session.js"));
  await writeFile(configPath,JSON.stringify({token,command:process.execPath,args:["-e",`require('fs').appendFileSync(${JSON.stringify(join(dir,"starts"))},'start\\n');console.log('READY',process.pid,process.stdin.isTTY);process.stdin.on('data',d=>console.log('INPUT',d.toString()));setInterval(()=>console.log('HEARTBEAT'),100);`],cwd:root,lock:join(dir,"active.lock"),handoff:join(dir,"handoff.json"),exitPath:join(dir,"exit.json"),retirementProtocol:1}));
  try {
    await startTmuxSession(configPath);
    await wait(async()=>{try{return (await readFile(join(dir,"terminal.raw.log"),"utf8")).includes("READY");}catch{return false;}});
    const original=JSON.parse(await readFile(join(dir,"process.json"),"utf8"));
    const spec={command:process.execPath,args:[join(__dirname,"tmux-session.js"),"--attach",configPath],cwd:root};
    const first=runner.run("first",spec,()=>{}, {path:join(dir,"local-handoff.json"),token,connectionLost:async()=>!(await inspectTmuxSession(configPath)).exited});
    await wait(()=>!!runner.snapshot("first")?.data.includes("HEARTBEAT"));
    // This models a lost SSH attachment, NOT user pause.
    runner.shutdown(); // Application quit detaches instead of requesting stop.
    assert.equal((await first).connectionLost,true);
    await assert.rejects(readFile(join(dir,"retired.json")),/ENOENT/);
    assert.equal((await inspectTmuxSession(configPath)).exited,false);
    const second=runner.run("second",spec,()=>{});
    await wait(()=>!!runner.snapshot("second")?.data.includes("HEARTBEAT"));
    runner.write("second","hello\r");
    await wait(async()=>(await readFile(join(dir,"terminal.raw.log"),"utf8")).includes("INPUT hello"));
    assert.equal(JSON.parse(await readFile(join(dir,"process.json"),"utf8")).pid,original.pid);
    assert.equal(await readFile(join(dir,"starts"),"utf8"),"start\n");
    await assert.rejects(startTmuxSession(configPath),/EEXIST/);
    await assert.rejects(closeTmuxSession(configPath),/終了/);
    await writeFile(join(dir,"stop.json"),JSON.stringify({token}));
    await second;
    await wait(async()=>(await inspectTmuxSession(configPath)).exited);
    await assert.rejects(readFile(join(dir,"active.lock","owner.json")),/ENOENT/);
    await closeTmuxSession(configPath);
    assert.equal((await inspectTmuxSession(configPath)).alive,false);
  } finally {
    await writeFile(join(dir,"stop.json"),JSON.stringify({token})).catch(()=>{});
    await wait(async()=>{try{return (await inspectTmuxSession(configPath)).exited;}catch{return true;}}).catch(()=>{});
    await closeTmuxSession(configPath).catch(()=>{}); runner.cancelAll(); await rm(root,{recursive:true,force:true});
  }
});
