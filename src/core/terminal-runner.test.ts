import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TerminalRunner, validateHandoff, notificationIssue, antigravitySubmissionIdle, isTerminalDeviceReply, type TerminalProcess } from "./terminal-runner";

const waitFor = async (test: () => boolean) => {
  const deadline = Date.now() + 8000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("PTY did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const shell = { command: "/bin/bash", args: ["--noprofile", "--norc", "-i"], cwd: tmpdir() };

test("live Codex capacity failure retires one CLI and preserves a non-quota failure receipt",async()=>{
  const root=await mkdtemp(join(tmpdir(),"native-capacity-"));const runner=new TerminalRunner();
  let data:(s:string)=>void=()=>{},exit:(e:{exitCode:number})=>void=()=>{},kills=0;
  const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>{kills++;exit({exitCode:143});},onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
  const result=runner.runProcess("capacity",child,()=>{},{path:join(root,"handoff.json"),token:"current",agentId:"codex"});
  try {
    data("\x1b[2J\x1b[H■ Selected model is at capacity. Please try a different model.\r\n\r\n› Ask Codex to do anything\r\n? for shortcuts");
    const completed=await result;
    assert.equal(kills,1);assert.equal(completed.handoff?.status,"blocked");assert.equal(completed.handoff?.failure?.kind,"capacity");
    assert.equal(completed.rateLimit,undefined);assert.equal(runner.snapshot("capacity")?.inputAllowed,false);
  }finally{runner.forget("capacity");await rm(root,{recursive:true,force:true});}
});

test("native failure observation is cancelled by redraw or manual input and never creates a work timeout",async()=>{
  for(const intervention of ["redraw","manual"] as const){
    const root=await mkdtemp(join(tmpdir(),"capacity-cancel-"));const runner=new TerminalRunner();
    let data:(s:string)=>void=()=>{},exit:(e:{exitCode:number})=>void=()=>{},kills=0;
    const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>{kills++;exit({exitCode:143});},onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
    const result=runner.runProcess(intervention,child,()=>{},{path:join(root,"handoff.json"),token:intervention,agentId:"codex"});
    try{
      data("\x1b[2J\x1b[H■ Selected model is at capacity. Please try a different model.\r\n\r\n› Ask Codex to do anything\r\n? for shortcuts");
      await new Promise(resolve=>setTimeout(resolve,60));
      if(intervention==="redraw")data("\x1b[2J\x1b[HWorking...\r\nesc to interrupt");else runner.write(intervention,"/model\r");
      await new Promise(resolve=>setTimeout(resolve,1150));
      assert.equal(kills,0);assert.equal(runner.snapshot(intervention)?.awaitingHandoff,true);
    }finally{runner.cancel(intervention);await result;runner.forget(intervention);await rm(root,{recursive:true,force:true});}
  }
});

test("notification diagnoses do not leak identities and idle detection never enters streaming/approval screens", () => {
  assert.match(notificationIssue({status:"ready",summary:"done"},"private-token")!,/混同/);
  assert.match(notificationIssue({token:"foreign",status:"completed",summary:"done"},"private-token")!,/識別子/);
  assert.doesNotMatch(notificationIssue({token:"foreign"},"private-token")!,/private-token|foreign/);
  assert.equal(notificationIssue({token:"run",status:"completed",summary:"done"},"run"),undefined);
  assert.equal(antigravitySubmissionIdle("結果保存済み\n>\n? for shortcuts"),true);
  for (const screen of ["Generating...\n? for shortcuts\nesc to cancel", "Allow access?\n? for shortcuts", "No known footer", "? for shortcuts\n"+"scrolling\n".repeat(6)]) assert.equal(antigravitySubmissionIdle(screen),false);
});

test("stable malformed notification is visible, repaired only while idle, bounded to two requests and never promoted", async () => {
  const directory=await mkdtemp(join(tmpdir(),"invalid-notification-")),path=join(directory,"handoff.json");
  const runner=new TerminalRunner(),writes:string[]=[],events:string[]=[];
  let data:(s:string)=>void=()=>{},exit:(e:{exitCode:number})=>void=()=>{},settled=false;
  const child:TerminalProcess={cols:100,rows:30,write:s=>{writes.push(s);},resize:()=>{},kill:()=>exit({exitCode:143}),onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
  const completion=runner.runProcess("repair",child,e=>events.push(e.text),{path,token:"run",agentId:"antigravity",notificationRepairPrompt:"提出形式だけ修正。既存の未確認事項は保持してください。"});
  void completion.then(()=>{settled=true;});
  try {
    data("\x1b[2J\x1b[HGenerating...\r\nesc to cancel\r\n");
    await writeFile(path,JSON.stringify({status:"ready",summary:"既存成果を保存"}));
    await waitFor(()=>!!runner.snapshot("repair")?.notificationIssue);
    assert.equal(writes.length,0);assert.equal(settled,false);
    assert.ok(events.some(e=>e.includes("作業結果と完了通知が混同")));
    data("\x1b[2J\x1b[H結果保存済み\r\n>\r\n? for shortcuts\r\n");
    await waitFor(()=>writes.length===1);
    assert.match(writes[0],/^\x1b\[200~提出形式だけ修正/);assert.match(writes[0],/\x1b\[201~\r$/);
    await writeFile(path,JSON.stringify({status:"ready",summary:"二度目の不正提出"}));
    await waitFor(()=>writes.length===2);
    await writeFile(path,JSON.stringify({status:"ready",summary:"三度目の不正提出"}));
    await waitFor(()=>!!runner.snapshot("repair")?.notificationIssue?.includes("上限"));
    assert.equal(writes.length,2);assert.equal(settled,false);assert.equal(runner.snapshot("repair")?.alive,true);
    await writeFile(path,JSON.stringify({token:"run",status:"completed",summary:"形式のみ修正。未確認事項を保持"}));
    assert.equal((await completion).handoff?.summary,"形式のみ修正。未確認事項を保持");
    assert.equal(runner.snapshot("repair")?.inputAllowed,false);
  } finally {runner.forget("repair");await completion;await rm(directory,{recursive:true,force:true});}
});

test("manual intervention disables notification input automation; a partial write gets no warning", async () => {
  const directory=await mkdtemp(join(tmpdir(),"notification-manual-")),path=join(directory,"handoff.json");
  const runner=new TerminalRunner(),writes:string[]=[],events:string[]=[];
  let data:(s:string)=>void=()=>{},exit:(e:{exitCode:number})=>void=()=>{};
  const child:TerminalProcess={cols:100,rows:30,write:s=>{writes.push(s);},resize:()=>{},kill:()=>exit({exitCode:143}),onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
  const completion=runner.runProcess("manual",child,e=>events.push(e.text),{path,token:"run",agentId:"antigravity",notificationRepairPrompt:"自動修正"});
  try {
    data("\x1b[2J\x1b[H>\r\n? for shortcuts\r\n");
    runner.write("manual","ユーザーの入力");
    await writeFile(path,"{partial");
    await new Promise(resolve=>setTimeout(resolve,650));
    assert.equal(events.filter(e=>e.startsWith("Terminal notification:")).length,0);
    await writeFile(path,JSON.stringify({status:"ready",summary:"done"}));
    await waitFor(()=>!!runner.snapshot("manual")?.notificationIssue);
    assert.deepEqual(writes,["ユーザーの入力"]);assert.equal(runner.snapshot("manual")?.awaitingHandoff,true);
  } finally {runner.cancel("manual");await completion;runner.forget("manual");await rm(directory,{recursive:true,force:true});}
});

test("identical remote copies do not reset invalid notification detection", async () => {
  const directory=await mkdtemp(join(tmpdir(),"notification-copies-")),path=join(directory,"handoff.json");
  const runner=new TerminalRunner(),events:string[]=[];
  let exit:(e:{exitCode:number})=>void=()=>{};
  const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>exit({exitCode:143}),onData:()=>{},onExit:fn=>{exit=fn;}};
  const completion=runner.runProcess("copies",child,e=>events.push(e.text),{path,token:"run"});
  const draft=JSON.stringify({status:"ready",summary:"unchanged remote draft"});
  await writeFile(path,draft);
  let copying:Promise<void>|undefined;
  const timer=setInterval(()=>{if(!copying)copying=writeFile(path,draft).finally(()=>{copying=undefined;});},750);
  try {
    await waitFor(()=>!!runner.snapshot("copies")?.notificationIssue);
    assert.equal(runner.snapshot("copies")?.awaitingHandoff,true);
    assert.equal(events.filter(e=>e.startsWith("Terminal notification:")).length,1);
  } finally {clearInterval(timer);await copying;runner.cancel("copies");await completion;runner.forget("copies");await rm(directory,{recursive:true,force:true});}
});

test("result validation failure explains the wait; cancellation wins over late validation", async () => {
  const directory=await mkdtemp(join(tmpdir(),"notification-validation-")),path=join(directory,"handoff.json");
  const runner=new TerminalRunner();let exit:(e:{exitCode:number})=>void=()=>{},release:()=>void=()=>{},checking=false;
  const delayed=new Promise<void>(resolve=>{release=resolve;});
  const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>exit({exitCode:143}),onData:()=>{},onExit:fn=>{exit=fn;}};
  let delay=false;
  const completion=runner.runProcess("validate",child,()=>{},{path,token:"run",validateNotification:async()=>{
    if(delay){checking=true;await delayed;}else throw new Error("work-check が未提出です。");
  }});
  try {
    await writeFile(path,JSON.stringify({token:"run",status:"completed",summary:"done"}));
    await waitFor(()=>!!runner.snapshot("validate")?.notificationIssue?.includes("work-check"));
    assert.equal(runner.snapshot("validate")?.awaitingHandoff,true);
    delay=true;await waitFor(()=>checking);runner.cancel("validate");release();
    const result=await completion;assert.equal(result.signal,"SIGTERM");assert.equal(result.handoff,undefined);
  } finally {release();runner.forget("validate");await rm(directory,{recursive:true,force:true});}
});

test("verified launch failure is retained instead of generic missing completion; retirement is still required", async () => {
  const directory = await mkdtemp(join(tmpdir(), "launch-receipt-"));
  const runner = new TerminalRunner(); let exit: (e: { exitCode: number }) => void = () => {}; let confirmed = false;
  const child: TerminalProcess = { cols: 100, rows: 30, write() {}, resize() {}, kill() {}, onData() {}, onExit(fn) { exit = fn; } };
  try {
    const completion = runner.runProcess("locked", child, () => {}, { path: join(directory, "handoff.json"), token: "run",
      exitFailure: async () => "遠隔の実行ロックが競合したため、CLIを起動できませんでした。",
      stopForHandoff: async () => { confirmed = true; } });
    exit({ exitCode: 75 });
    const result = await completion;
    assert.equal(result.handoff?.status, "blocked"); assert.match(result.handoff!.summary, /実行ロックが競合/);
    assert.equal(confirmed, true); assert.notEqual(result.stopUnconfirmed, true);
  } finally { runner.forget("locked"); await rm(directory, { recursive: true, force: true }); }
});

test("every managed handoff fences input immediately and waits for confirmed retirement", async () => {
  for(const status of ["completed","blocked","rate-limited"] as const) {
    const directory=await mkdtemp(join(tmpdir(),"retire-managed-"));
    const runner=new TerminalRunner();let exit:(e:{exitCode:number})=>void=()=>{},killed=false,settled=false;
    const child:TerminalProcess={cols:100,rows:30,write:()=>{throw new Error("Retired input reached child");},resize:()=>{},kill:()=>{killed=true;},onData:()=>{},onExit:fn=>{exit=fn;}};
    const completion=runner.runProcess(status,child,()=>{},{path:join(directory,"handoff.json"),token:status});
    void completion.then(()=>{settled=true;});
    try {
      runner.complete(status,{status,summary:status==="blocked"?"authentication_failed":"Result received"});
      assert.equal(runner.snapshot(status)?.inputAllowed,false);
      assert.throws(()=>runner.write(status,"/login\r"),/ログイン管理/);
      await waitFor(()=>killed);assert.equal(settled,false);
      exit({exitCode:143});assert.equal((await completion).handoff?.status,status);
      assert.equal(runner.snapshot(status)?.alive,false);
      assert.throws(()=>runner.complete(status,{status:"completed",summary:"late old reply"}),/引継ぎ待ち/);
    } finally {runner.forget(status);await rm(directory,{recursive:true,force:true});}
  }
});

test("remote PTY disconnection cannot certify the old remote writer stopped", async () => {
  const directory=await mkdtemp(join(tmpdir(),"retire-disconnected-"));
  const runner=new TerminalRunner();let exit:(e:{exitCode:number})=>void=()=>{};
  const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:fn=>{exit=fn;}};
  try {
    const completion=runner.runProcess("remote",child,()=>{},{path:join(directory,"handoff.json"),token:"remote",stopForHandoff:async()=>{throw new Error("SSH disconnected");}});
    exit({exitCode:255});
    const result=await completion;assert.equal(result.stopUnconfirmed,true);assert.equal(result.handoff?.status,"blocked");
    assert.equal(runner.snapshot("remote")?.inputAllowed,false);
  } finally {runner.forget("remote");await rm(directory,{recursive:true,force:true});}
});

test("PTY exit flushes a committed remote completion before deciding that its notification is missing", async () => {
  const directory=await mkdtemp(join(tmpdir(),"retire-exit-race-")),path=join(directory,"handoff.json");
  const runner=new TerminalRunner();let exit:(e:{exitCode:number})=>void=()=>{},confirmed=false;
  const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>{},onData:()=>{},onExit:fn=>{exit=fn;}};
  try {
    const completion=runner.runProcess("exited",child,()=>{},{path,token:"remote",syncHandoff:async()=>{
      await writeFile(path,JSON.stringify({token:"remote",status:"completed",summary:"Committed result"}));
    },stopForHandoff:async()=>{confirmed=true;}});
    exit({exitCode:0});
    assert.equal((await completion).handoff?.status,"completed");assert.equal(confirmed,true);
  } finally {runner.forget("exited");await rm(directory,{recursive:true,force:true});}
});

test("quota banner stops only the failed PTY, waits for remote acknowledgement, and never reports success", async () => {
  for (const mode of ["local","remote","failed-ack","cancel"] as const) {
    const directory=await mkdtemp(join(tmpdir(),"quota-handoff-"));
    const runner=new TerminalRunner();let data:(s:string)=>void=()=>{},exit:(e:{exitCode:number})=>void=()=>{};
    let killed=0, acknowledge:()=>void=()=>{}, rejectAck:(e:Error)=>void=()=>{};
    const ack=new Promise<void>((resolve,reject)=>{acknowledge=resolve;rejectAck=reject;});
    const child:TerminalProcess={cols:100,rows:30,write:()=>{},resize:()=>{},kill:()=>{killed++;exit({exitCode:143});},onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
    let settled=false,stopping=false;
    const result=runner.runProcess(mode,child,()=>{}, {path:join(directory,"handoff.json"),token:mode,agentId:"antigravity",
      ...(mode!=="local"?{stopForHandoff:async()=>{stopping=true;await ack;}}:{})});
    void result.then(()=>{settled=true;});
    data("\x1b[2J\x1b[HIf a provider limit prevents completion, use status=rate-limited.\r\n");
    await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal(killed,0);
    // Split chunks and terminal redraws must be interpreted as a screen.
    data("\x1b[2J\x1b[H⚠ Individual quota rea");
    data("ched. Please upgrade your subscription to increase your limits. Resets in\r\n95h24m18s.\r\nError ID: 1234-abcd\r\n");
    if(mode!=="local") {
      await waitFor(()=>stopping);assert.equal(settled,false);assert.equal(killed,0);
      if(mode==="failed-ack")rejectAck(new Error("SSH disconnected"));
      else {if(mode==="cancel")runner.cancel(mode);else exit({exitCode:143});acknowledge();}
    }
    const done=await result;
    assert.equal(done.handoff?.status,mode==="cancel"?undefined:mode==="failed-ack"?"blocked":"rate-limited");
    assert.equal(done.signal,mode==="cancel"?"SIGTERM":null);
    assert.equal(!!done.stopUnconfirmed,mode==="failed-ack");
    assert.equal(runner.snapshot(mode)?.inputAllowed,false);
    assert.throws(()=>runner.write(mode,"/login\r"),/終了|引き継ぎ/);
    if(mode==="local")assert.equal(killed,1);
    runner.forget(mode);
    await rm(directory,{recursive:true,force:true});
  }
});

test("startup automation is opt-in and stops on manual input or instruction receipt", async () => {
  for (const mode of ["not-claude","manual","instructions"] as const) {
    const runner = new TerminalRunner(); const writes:string[]=[];
    let data:(value:string)=>void=()=>{}; let exit:(value:{exitCode:number})=>void=()=>{};
    const child:TerminalProcess={cols:100,rows:30,write:v=>{writes.push(v);},resize:()=>{},kill:()=>exit({exitCode:0}),
      onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
    const finished=runner.runProcess(mode,child,()=>{},{path:join(tmpdir(),"unused-trust-handoff"),token:mode,
      ...(mode!=="not-claude"?{workspaceTrust:{agent:"claude" as const,directory:"/tmp/project"}}:{})});
    try {
      if(mode==="manual") runner.write(mode,"x");
      if(mode==="instructions") runner.disableStartupApproval(mode);
      data("Accessing workspace:\r\n/tmp/project\r\nQuick safety check: Is this a project you created or one you trust?\r\nClaude Code'll be able to read, edit, and execute files here.\r\nNo, exit\r\n❯ Yes, I trust this folder\r\nEnter to confirm · Esc to cancel");
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual(writes,mode==="manual"?["x"]:[]);
    } finally {runner.forget(mode);await finished;}
  }
});

test("startup folder trust drives a real PTY once, preserves its screen/log and never completes work", async () => {
  const root = await mkdtemp(join(tmpdir(),"claude-trust-"));
  const runner = new TerminalRunner(); let output = "";
  const screen = (yes:boolean) => `\x1b[2J\x1b[HAccessing workspace:\r\n\r\n${root}\r\n\r\nQuick safety check: Is this a project you created or one you trust?\r\nClaude Code'll be able to read, edit, and execute files here.\r\n\r\n${yes?"":"❯ "}No, exit\r\n${yes?"❯ ":""}Yes, I trust this folder\r\n\r\nEnter to confirm · Esc to cancel\r\n`;
  const script = `process.stdin.setRawMode(true);process.stdin.resume();const no=${JSON.stringify(screen(false))},yes=${JSON.stringify(screen(true))};process.stdout.write(no.slice(0,100));setTimeout(()=>process.stdout.write(no.slice(100)),30);process.stdin.on('data',d=>{if(d.toString()==='\\x1b[B')process.stdout.write(yes);else if(d.toString()==='\\r')process.stdout.write('\\x1b[2J\\x1b[HCLI_WORK_STARTED\\r\\n');});`;
  const promise = runner.run("trust",{command:process.execPath,args:["-e",script],cwd:root},e=>{output+=e.text;},
    {path:join(root,"handoff.json"),token:"trust-fixture",workspaceTrust:{agent:"claude",directory:root}});
  try {
    await waitFor(()=>output.includes("CLI_WORK_STARTED"));
    assert.match(output,/自動承認/);
    assert.equal(runner.snapshot("trust")?.awaitingHandoff,true);
    assert.match(runner.snapshot("trust")!.data, /Accessing workspace:/);
    runner.complete("trust",{status:"completed",summary:"Fixture work actually finished"});
    await promise;
  } finally {runner.cancelAll();await waitFor(()=>!runner.snapshot("trust")?.alive);await rm(root,{recursive:true,force:true});}
});

test("startup approval waits through the native input guard and cancels when the current screen changes", async () => {
  for (const mode of ['guarded', 'manual', 'redraw', 'receipt', 'different-folder', 'write-error'] as const) {
    const runner = new TerminalRunner(), writes: string[] = [];
    let data: (s: string) => void = () => {}, exit: (e: {exitCode:number}) => void = () => {}, appeared = Date.now();
    const dialog = (yes: boolean, path = '/tmp/approved') => `\x1b[2J\x1b[HAccessing workspace:\r\n\r\n${path}\r\n\r\nQuick safety check: Is this a project you created or one you trust?\r\nClaude Code'll be able to read, edit, and execute files here.\r\nNo, exit\r\n${yes ? '❯ ' : ''}Yes, I trust this folder\r\nEnter to confirm · Esc to cancel\r\n`.replace('No, exit', yes ? 'No, exit' : '❯ No, exit');
    const child: TerminalProcess = {cols:100,rows:30,write:s=>{
      writes.push(s);
      if (mode==='write-error') throw new Error('PTY disconnected');
      if (Date.now() - appeared < 750) return; // native CLI would ignore this
      if (s === '\x1b[B') { appeared = Date.now(); data(dialog(true)); }
      if (s === '\r') data('\x1b[2J\x1b[HClaude Code v2.1.287\r\nWORK_STARTED');
    },resize:()=>{},kill:()=>exit({exitCode:143}),onData:fn=>{data=fn;},onExit:fn=>{exit=fn;}};
    const promise = runner.runProcess(mode,child,()=>{},{path:join(tmpdir(),'unused-startup-notification'),token:mode,workspaceTrust:{agent:'claude',directory:'/tmp/approved'}});
    try {
      data(dialog(false,mode==='different-folder'?'/tmp/other':'/tmp/approved'));
      await new Promise(resolve=>setTimeout(resolve,40));
      assert.equal(writes.length,0);
      if (mode==='manual') runner.write(mode,'x');
      if (mode==='redraw') data('\x1b[2J\x1b[HLogin required\r\n');
      if (mode==='receipt') runner.disableStartupApproval(mode);
      if (mode==='guarded') {
        await waitFor(()=>writes.includes('\r'));
        assert.deepEqual(writes,['\x1b[B','\r']);
        assert.match(runner.snapshot(mode)!.data,/WORK_STARTED/);
        assert.equal(runner.snapshot(mode)!.startupIssue,undefined);
      } else {
        await new Promise(resolve=>setTimeout(resolve,1250));
        assert.deepEqual(writes,mode==='manual'?['x']:mode==='write-error'?['\x1b[B']:[]);
        if(mode==='different-folder') {
          assert.match(runner.snapshot(mode)!.startupIssue!,/このCLI端末で回答/);
          assert.equal(runner.snapshot(mode)!.inputAllowed,true);
          assert.equal(runner.snapshot(mode)!.alive,true);
        }
        if(mode==='write-error') {
          assert.match(runner.snapshot(mode)!.startupIssue!,/自動入力に失敗/);
          assert.equal(runner.snapshot(mode)!.awaitingHandoff,true);
        }
      }
    } finally {runner.forget(mode);await promise;}
  }
});

test("Antigravity trust uses a real PTY, widens a hard-wrapped path and restores the user's small pane", async () => {
  const root = await mkdtemp(join(tmpdir(), "antigravity-trust-"));
  const runner = new TerminalRunner(); let output = "";
  // Reproduce the native path hard wrap rather than rely on a raw log string.
  // This is a local fixture, not a live provider or the user's remote session.
  const script = `const root=${JSON.stringify(root)};let working=false;process.stdin.setRawMode(true);process.stdin.resume();
    const render=()=>process.stdout.write('\\x1b[2J\\x1b[H'+(working?'FIXTURE_WORK_STARTED\\r\\n? for shortcuts':
      'Accessing workspace:\\r\\n\\r\\n'+(process.stdout.columns<180?root.slice(0,12)+'\\r\\n'+root.slice(12):root)+
      '\\r\\n\\r\\nDo you trust the contents of this project?\\r\\n\\r\\nAntigravity CLI requires permission to read, edit, and execute files here.\\r\\n\\r\\n> Yes, I trust this folder\\r\\n  No, exit\\r\\n\\r\\n  ↑/↓ Navigate · enter Confirm\\r\\n'));
    process.stdout.on('resize',render);process.stdin.on('data',d=>{if(d.toString()==='\\r'){working=true;render();}});render();`;
  const finished = runner.run("agy-trust", { command: process.execPath, args: ["-e", script], cwd: root }, e => { output += e.text; },
    { path: join(root, "handoff.json"), token: "agy-fixture", agentId: "antigravity", workspaceTrust: { agent: "antigravity", directory: root } });
  try {
    // Startup recognition must survive a GUI pane too short to show the dialog.
    runner.resize("agy-trust", 45, 8);
    await waitFor(() => runner.snapshot("agy-trust")!.cols >= 180);
    // A user changes the window during the wide redraw: restore the new size.
    runner.resize("agy-trust", 55, 10);
    await waitFor(() => output.includes("FIXTURE_WORK_STARTED")).catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify(runner.snapshot("agy-trust"))}`);
    });
    await waitFor(() => runner.snapshot("agy-trust")!.cols === 55 && runner.snapshot("agy-trust")!.rows === 10);
    assert.match(output, /Antigravity CLI起動フォルダの信頼確認を自動承認/);
    assert.equal(output.match(/起動フォルダの信頼確認を自動承認/g)?.length, 1);
    assert.equal(runner.snapshot("agy-trust")!.awaitingHandoff, true, "trust is NOT work completion");
    assert.equal(runner.snapshot("agy-trust")!.inputAllowed, true);
    runner.complete("agy-trust", { status: "completed", summary: "Fixture actually completed" });
    await finished;
  } finally { runner.cancelAll(); await finished; runner.forget("agy-trust"); await rm(root, { recursive: true, force: true }); }
});

test("terminal protocol classification accepts only whole known replies, never keys or unrelated OSC", () => {
  const replies = ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[12;30R", "\x1b[?12;30R", "\x1b[I", "\x1b[O",
    "\x1b[0n", "\x1b[?2026;2$y", "\x1b[8;40;120t", "\x1b]10;rgb:e0e0/e4e4/eded\x1b\\",
    "\x1b]11;rgb:0b0b/0d0d/1212\x1b\\", "\x1b]12;rgb:fff/fff/fff\x07", "\x1b]4;255;rgb:ff/00/00\x1b\\"];
  for (const reply of [...replies, replies.join("")]) {
    assert.equal(isTerminalDeviceReply(reply), true, JSON.stringify(reply));
    for (const key of ["x", "\r", "\x1b[A", "\x1b[C", "\x1b[200~yes\x1b[201~"]) {
      assert.equal(isTerminalDeviceReply(reply + key), false);
      assert.equal(isTerminalDeviceReply(key + reply), false);
    }
  }
  for (const value of ["", "\r", "\x1b[A", "\x1b[C", "\x1b[1;5C", "\x1b]11;?\x1b\\", "\x1b]11;rgb:f/f/f",
    "\x1b]11;rgb:g/f/f\x1b\\", "\x1b]11;rgb:fffff/f/f\x1b\\", "\x1b]52;c;clipboard\x07",
    "\x1b]4;256;rgb:f/f/f\x07", "\x1b]0;window-title\x07", "\x1bP>|arbitrary\x1b\\"])
    assert.equal(isTerminalDeviceReply(value), false, JSON.stringify(value));
});

test("terminal device/color/focus replies preserve startup approval, but mixed human keys cancel it", async () => {
  const replies = "\x1b[?1;2c\x1b[>0;276;0c\x1b[12;30R\x1b[?12;30R\x1b[I\x1b[O"
    + "\x1b]10;rgb:e0e0/e4e4/eded\x1b\\\x1b]11;rgb:0b0b/0d0d/1212\x1b\\";
  for (const input of [replies, replies + "x", "\x1b[I\r", "\x1b[A"]) {
    const runner = new TerminalRunner(), writes: string[] = [];
    let data: (s: string) => void = () => {}, exit: (e: { exitCode: number }) => void = () => {};
    const child: TerminalProcess = { cols: 100, rows: 30, write: s => { writes.push(s); }, resize: () => {},
      kill: () => exit({ exitCode: 143 }), onData: fn => { data = fn; }, onExit: fn => { exit = fn; } };
    const finished = runner.runProcess("replies", child, () => {}, {
      path: join(tmpdir(), "unused-reply-notification"), token: "replies",
      workspaceTrust: { agent: "antigravity", directory: "/tmp/project" }
    });
    try {
      data("Accessing workspace:\r\n/tmp/project\r\nDo you trust the contents of this project?\r\nAntigravity CLI requires permission to read, edit, and execute files here.\r\n> Yes, I trust this folder\r\nNo, exit\r\n↑/↓ Navigate · enter Confirm");
      await new Promise(resolve => setTimeout(resolve, 40));
      runner.write("replies", input);
      await new Promise(resolve => setTimeout(resolve, 1150));
      assert.deepEqual(writes, input === replies ? [input, "\r"] : [input]);
    } finally { runner.forget("replies"); await finished; }
  }
});

test("both native trust dialogs survive startup color replies and clear notices only on real intervention", async () => {
  for (const agent of ["antigravity", "claude"] as const) {
    const runner = new TerminalRunner(), writes: string[] = [], events: string[] = [];
    let data: (s: string) => void = () => {}, exit: (e: { exitCode: number }) => void = () => {};
    const child: TerminalProcess = { cols: 100, rows: 30, write: s => { writes.push(s); }, resize: () => {},
      kill: () => exit({ exitCode: 143 }), onData: fn => { data = fn; }, onExit: fn => { exit = fn; } };
    const finished = runner.runProcess(agent, child, e => events.push(e.text), {
      path: join(tmpdir(), "unused-color-notification"), token: agent, agentId: agent,
      workspaceTrust: { agent, directory: "/tmp/project" }
    });
    const dialog = (folder: string) => `\x1b[2J\x1b[HAccessing workspace:\r\n${folder}\r\n${agent === "claude"
      ? "Quick safety check: Is this a project you created or one you trust?\r\nClaude Code'll be able to read, edit, and execute files here.\r\nNo, exit\r\n❯ Yes, I trust this folder\r\nEnter to confirm · Esc to cancel"
      : "Do you trust the contents of this project?\r\nAntigravity CLI requires permission to read, edit, and execute files here.\r\n> Yes, I trust this folder\r\nNo, exit\r\n↑/↓ Navigate · enter Confirm\r\naccept-edits · Gemini 3.8 Flash · high"}`;
    const color = "\x1b]11;rgb:0b0b/0d0d/1212\x1b\\";
    try {
      // These replies arrive through the same IPC as keys, before the dialog.
      runner.write(agent, color);
      data(dialog("/tmp/project"));
      await waitFor(() => writes.includes("\r"));
      assert.deepEqual(writes, [color, "\r"]);
      assert.equal(events.filter(e => e.includes("自動承認")).length, 1);
      assert.equal(runner.snapshot(agent)!.awaitingHandoff, true);
    } finally { runner.forget(agent); await finished; }

    const manual = new TerminalRunner(); writes.length = 0; events.length = 0;
    const held = manual.runProcess(agent, child, e => events.push(e.text), {
      path: join(tmpdir(), "unused-manual-color-notification"), token: agent, agentId: agent,
      workspaceTrust: { agent, directory: "/tmp/project" }
    });
    try {
      data(dialog("/tmp/other"));
      await waitFor(() => !!manual.snapshot(agent)?.startupIssue);
      manual.write(agent, color);
      assert.ok(manual.snapshot(agent)?.startupIssue, "automatic replies never dismiss manual instructions");
      assert.ok(!events.includes("Terminal startup: "));
      manual.write(agent, "\r");
      assert.equal(manual.snapshot(agent)?.startupIssue, undefined);
      assert.equal(events.filter(e => e === "Terminal startup: ").length, 1);
      assert.deepEqual(writes, [color, "\r"], "only the user's Enter reached the mismatched folder");
    } finally { manual.forget(agent); await held; }
  }
});

test("resizing cancels a captured startup frame until a fresh redraw", async () => {
  const runner = new TerminalRunner(), writes: string[] = [];
  let data: (s: string) => void = () => {}, exit: (e: { exitCode: number }) => void = () => {};
  const child: TerminalProcess = { cols: 100, rows: 30, write: s => { writes.push(s); }, resize: (cols, rows) => {
    child.cols = cols; child.rows = rows;
  }, kill: () => exit({ exitCode: 143 }), onData: fn => { data = fn; }, onExit: fn => { exit = fn; } };
  const finished = runner.runProcess("resize-trust", child, () => {}, {
    path: join(tmpdir(), "unused-resize-notification"), token: "resize-trust",
    workspaceTrust: { agent: "antigravity", directory: "/tmp/project" }
  });
  const dialog = "\x1b[2J\x1b[HAccessing workspace:\r\n/tmp/project\r\nDo you trust the contents of this project?\r\nAntigravity CLI requires permission to read, edit, and execute files here.\r\n> Yes, I trust this folder\r\nNo, exit\r\n↑/↓ Navigate · enter Confirm";
  try {
    data(dialog);
    await new Promise(resolve => setTimeout(resolve, 40));
    runner.resize("resize-trust", 120, 40);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(writes, [], "a pre-resize frame must never receive Enter");
    data(dialog);
    await new Promise(resolve => setTimeout(resolve, 40));
    runner.resize("resize-trust", 120, 40);
    await waitFor(() => writes.length > 0);
    assert.deepEqual(writes, ["\r"], "same-size events do not cancel a fresh stable frame");
  } finally { runner.forget("resize-trust"); await finished; }
});

test("startup redraw is bounded, cancellable and scoped to the correct CLI", async () => {
  for (const mode of ["mismatch", "unknown-dialog", "manual", "instructions", "wrong-cli", "no-control"] as const) {
    const root = await mkdtemp(join(tmpdir(), "startup-redraw-")), runner = new TerminalRunner();
    const writes: string[] = [], sizes: Array<[number, number]> = [];
    let data: (s: string) => void = () => {}, exit: (e: { exitCode: number }) => void = () => {};
    const dialog = (path: string) => `\x1b[2J\x1b[HAccessing workspace:\r\n\r\n${path}\r\n\r\nDo you trust the contents of this project?\r\nAntigravity CLI requires permission to read, edit, and execute files here.\r\n> Yes, I trust this folder\r\nNo, exit\r\n↑/↓ Navigate · enter Confirm`;
    const child: TerminalProcess = { cols: 100, rows: 30, write: s => { writes.push(s); }, resize: (cols, rows) => {
      child.cols = cols; child.rows = rows; sizes.push([cols, rows]);
      if (cols >= 180 && mode === "mismatch") data(dialog(root + "/other"));
    }, kill: () => exit({ exitCode: 143 }), onData: fn => { data = fn; }, onExit: fn => { exit = fn; } };
    const finished = runner.runProcess(mode, child, () => {}, mode === "no-control" ? undefined : {
      path: join(root, "handoff.json"), token: mode, agentId: mode === "wrong-cli" ? "codex" : "antigravity",
      workspaceTrust: { agent: "antigravity", directory: root }
    });
    try {
      runner.resize(mode, 52, 9);
      data(dialog(root.slice(0, 12) + "\r\n" + root.slice(12))
        + (mode === "unknown-dialog" ? "\r\nAllow additional folders?" : ""));
      if (mode === "manual" || mode === "instructions") {
        await waitFor(() => child.cols >= 180);
        if (mode === "manual") runner.write(mode, "x"); else runner.disableStartupApproval(mode);
        assert.deepEqual([child.cols, child.rows], [52, 9]);
        data(dialog(root));
      }
      if (mode === "mismatch") await waitFor(() => child.cols === 52 && child.rows === 9);
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.deepEqual(writes, mode === "manual" ? ["x"] : []);
      assert.ok(sizes.filter(([cols]) => cols >= 180).length <= 1, "no widening/retry loop");
      assert.equal(runner.snapshot(mode)!.alive, true);
      assert.equal(runner.snapshot(mode)!.awaitingHandoff, true);
      if (mode === "mismatch" || mode === "unknown-dialog") assert.deepEqual([child.cols, child.rows], [52, 9]);
      if (mode === "wrong-cli" || mode === "no-control") assert.deepEqual([child.cols, child.rows], [52, 9]);
    } finally { runner.forget(mode); await finished; await rm(root, { recursive: true, force: true }); }
  }
});

test("real PTY accepts input, resizes and remains interactive after a workflow handoff", async () => {
  const runner = new TerminalRunner();
  let output = "";
  const completion = runner.run("terminal", shell, (event) => { output += event.text; });
  try {
    runner.write("terminal", "test -t 0 && printf '\\033[31mTTY_READY\\033[0m\\n'\r");
    await waitFor(() => output.includes("\x1b[31mTTY_READY\x1b[0m"));
    runner.resize("terminal", 112, 37);
    runner.write("terminal", "stty size\r");
    await waitFor(() => output.includes("37 112"));
    assert.equal(runner.snapshot("terminal")?.awaitingHandoff, true);
    runner.complete("terminal", { status: "completed", summary: "Verified real terminal" });
    assert.equal((await completion).handoff?.summary, "Verified real terminal");
    assert.equal(runner.snapshot("terminal")?.alive, true);
    assert.equal(runner.snapshot("terminal")?.awaitingHandoff, false);
    runner.write("terminal", "printf 'STILL_%s\\n' INTERACTIVE\r");
    await waitFor(() => output.includes("STILL_INTERACTIVE"));
    assert.throws(() => runner.resize("terminal", -1, 10));
    assert.throws(() => runner.write("terminal", "x".repeat(64001)));
    assert.throws(() => runner.complete("terminal", { status: "completed", summary: "duplicate" }));
  } finally { runner.cancelAll(); await waitFor(() => !runner.snapshot("terminal")?.alive); }
});

test("exiting or cancelling the TUI cannot accidentally advance a workflow", async () => {
  const runner = new TerminalRunner();
  const exited = await runner.run("exit", { ...shell, args: ["-c", "printf 'welcome'; exit 0"] }, () => {});
  assert.equal(exited.exitCode, 0); assert.equal(exited.handoff, undefined);
  const pending = runner.run("cancel", shell, () => {});
  assert.equal(runner.cancel("cancel"), true);
  const cancelled = await pending;
  assert.equal(cancelled.signal, "SIGTERM"); assert.equal(cancelled.handoff, undefined);
});

test("blocked native handoff retires the old CLI and rejects manual login instead of resurrecting its work", async () => {
  const runner = new TerminalRunner();
  const directory=await mkdtemp(join(tmpdir(),"blocked-handoff-"));
  const completion = runner.run("blocked",{command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:directory},()=>{},
    {path:join(directory,"handoff.json"),token:"blocked"});
  try {
    runner.complete("blocked",{status:"blocked",summary:"MCP instructions unavailable"});
    assert.equal((await completion).handoff?.status,"blocked");
    assert.equal(runner.snapshot("blocked")?.alive,false);
    assert.equal(runner.snapshot("blocked")?.awaitingHandoff,false);
    assert.equal(runner.snapshot("blocked")?.inputAllowed,false);
    assert.throws(()=>runner.write("blocked","/login\r"),/ログイン管理/);
  } finally {runner.cancelAll(); await waitFor(()=>!runner.snapshot("blocked")?.alive);await rm(directory,{recursive:true,force:true});}
});

test("handoff notifications require this run's token, valid status and a nonempty summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-terminal-test-"));
  const path = join(directory, "handoff.json");
  const runner = new TerminalRunner();
  let settled = false;
  const completion = runner.run("file", {command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:directory}, () => {}, { path, token: "unique-run-token" });
  void completion.then(() => { settled = true; });
  try {
    await writeFile(path, JSON.stringify({ token: "stale-run-token", status: "completed", summary: "stale" }));
    await new Promise((resolve) => setTimeout(resolve, 650)); assert.equal(settled, false);
    await writeFile(path, JSON.stringify({ token: "unique-run-token", status: "rate-limited", summary: "Partial findings" }));
    await waitFor(() => settled);
    assert.equal((await completion).handoff?.status, "rate-limited");
    assert.throws(() => validateHandoff({ status: "completed", summary: " " }));
    assert.throws(() => validateHandoff({ status: "unrecognized", summary: "hi" }));
  } finally { runner.cancelAll(); await waitFor(() => !runner.snapshot("file")?.alive); await rm(directory, { recursive: true, force: true }); }
});

test("parallel terminals have isolated streams and cancellation", async () => {
  const runner = new TerminalRunner();
  const a = runner.run("a", shell, () => {});
  const b = runner.run("b", shell, () => {});
  try {
    runner.write("a", "printf 'AGENT_%s\\n' ALPHA\r");
    runner.write("b", "printf 'AGENT_%s\\n' BETA\r");
    await waitFor(() => Boolean(runner.snapshot("a")?.data.includes("AGENT_ALPHA") && runner.snapshot("b")?.data.includes("AGENT_BETA")));
    assert.ok(!runner.snapshot("a")?.data.includes("AGENT_BETA"));
    runner.cancel("a"); await a;
    assert.equal(runner.snapshot("b")?.alive, true);
  } finally { runner.cancelAll(); await b; }
});
