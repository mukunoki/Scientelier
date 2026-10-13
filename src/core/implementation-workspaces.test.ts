import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, copyFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { workspaceOperation as op, workspaceBlockers, type WorkspaceContext } from "./implementation-workspaces";
import { remoteOperation } from "./remote-bridge";
const exec=promisify(execFile);
const taskId="00000000-0000-4000-8000-000000000003";
async function fixture(fn:(c:WorkspaceContext)=>Promise<void>) {
  const root=await realpath(await mkdtemp(join(tmpdir(),"harness-implementation-")));
  const c:WorkspaceContext={root,taskId,actor:"owner",manage:true,harness:true,completedIds:["a","b"],settledIds:["a","b","failed"]};
  try {
    await writeFile(join(root,"a.txt"),"a before\n");await writeFile(join(root,"b.txt"),"b before\n");
    await exec("git",["-C",root,"init"]);
    await exec("git",["-C",root,"add","a.txt","b.txt"]);
    await exec("git",["-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-m","fixture"]);
    await fn(c);
  }finally{await rm(root,{recursive:true,force:true});}
}
const prepare=(c:WorkspaceContext,id="a",files=["a.txt"])=>op(c,{action:"prepare",id,files});
const inspect=(c:WorkspaceContext,id="a")=>op(c,{action:"inspect",id});
const merge=(c:WorkspaceContext,digest:string,id="a")=>op(c,{action:"merge",id,digest,reason:"Reviewed fixture diff and test evidence; shared regression remains required"});

test("general worktrees independently write then integrate explicitly without HPC numeric units",async()=>fixture(async c=>{
  const [a,b]=await Promise.all([prepare(c),prepare(c,"b",["b.txt","new/test.txt"])]);
  assert.notEqual(a.path,b.path);
  await writeFile(join(a.path,"a.txt"),"a after\n");
  await writeFile(join(b.path,"b.txt"),"b after\n");await mkdir(join(b.path,"new"));await writeFile(join(b.path,"new/test.txt"),"evidence\n");
  assert.equal(await readFile(join(c.root,"a.txt"),"utf8"),"a before\n");
  assert.equal(workspaceBlockers(await op(c,{action:"snapshot"})).length,2);
  const view=await inspect(c);assert.match(view.diff,/a after/);
  await assert.rejects(merge({...c,completedIds:[]},view.digest),/未完了/);
  await merge(c,view.digest);
  await merge(c,(await inspect(c,"b")).digest,"b");
  assert.equal(await readFile(join(c.root,"a.txt"),"utf8"),"a after\n");
  assert.equal(await readFile(join(c.root,"new/test.txt"),"utf8"),"evidence\n");
  assert.deepEqual(workspaceBlockers(await op(c,{action:"snapshot"})),[]);
  assert.equal((await merge(c,view.digest)).state,"merged");
  assert.match((await exec("git",["-C",c.root,"status","--porcelain"])).stdout,/a.txt/); // no auto-commit
}));

test("ownership, dirty roots, collisions, stale diffs, links and changed baselines fail closed",async()=>fixture(async c=>{
  await writeFile(join(c.root,"a.txt"),"user edit\n");await assert.rejects(prepare(c),/コミット/);
  await writeFile(join(c.root,"a.txt"),"a before\n");
  for(const files of [["../outside"],[".git/config"],[".GIT/config"],[".agent-harness/x"],[".AGENT-HARNESS/x"],["a\nb"],["/absolute"],["new","New"]])await assert.rejects(prepare(c,"bad",files));
  const a=await prepare(c);
  await assert.rejects(prepare(c,"b",["a.txt"]),/重複/);
  await writeFile(join(a.path,"b.txt"),"outside owner\n");await assert.rejects(inspect(c),/担当外/);
  assert.equal((await prepare(c)).path,a.path,"retry retains partial work for repair");
  await writeFile(join(a.path,"b.txt"),"b before\n");
  const first=await inspect(c);await writeFile(join(a.path,"a.txt"),"after\n");
  await assert.rejects(merge(c,first.digest),/差分が変わり/);
  await writeFile(join(c.root,"a.txt"),"user edit\n");await assert.rejects(merge(c,(await inspect(c)).digest),/元ファイル/);
  assert.equal(await readFile(join(c.root,"a.txt"),"utf8"),"user edit\n");
  await rm(join(a.path,"a.txt"));await symlink(join(c.root,"b.txt"),join(a.path,"a.txt"));
  await assert.rejects(inspect(c),/リンク/);
}));

test("unowned untracked/ignored files, deletions and worker-side commits never sneak into integration",async()=>fixture(async c=>{
  const a=await prepare(c);
  await writeFile(join(a.path,"stray"),"unowned");await assert.rejects(inspect(c),/担当外/);await rm(join(a.path,"stray"));
  await rm(join(a.path,"a.txt"));await assert.rejects(merge(c,(await inspect(c)).digest),/削除/);
  await writeFile(join(a.path,"a.txt"),"changed");
  await exec("git",["-C",a.path,"add","a.txt"]);
  await exec("git",["-C",a.path,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-m","unexpected"]);
  await assert.rejects(inspect(c),/基準コミット/);
}));

test("read-only/worker contexts cannot prepare, merge or discard; declined failed work remains on disk",async()=>fixture(async c=>{
  const a=await prepare(c,"failed");
  for(const request of [{action:"prepare",id:"b",files:["b.txt"]},{action:"merge",id:"failed",digest:"x",reason:"x"},{action:"discard",id:"failed",reason:"x"}])
    await assert.rejects(op({...c,manage:false},request),/主担当/);
  await assert.rejects(prepare({...c,harness:false},"b",["b.txt"]),/ハーネス/);
  await assert.rejects(merge(c,(await inspect(c,"failed")).digest,"failed"),/未完了/);
  const discarded=await op(c,{action:"discard",id:"failed",reason:"Failed worker changes rejected; primary will implement the required scope"});
  assert.equal(discarded.state,"discarded");assert.equal(await readFile(join(a.path,"a.txt"),"utf8"),"a before\n");
  assert.deepEqual(workspaceBlockers(await op(c,{action:"snapshot"})),[]);
}));

test("a partial merge resumes its fixed intent and keeps the original backup",async()=>fixture(async c=>{
  const a=await prepare(c,"a",["a.txt","b.txt"]);
  await writeFile(join(a.path,"a.txt"),"a after\n");await writeFile(join(a.path,"b.txt"),"b after\n");
  const view=await inspect(c),path=join(c.root,`.agent-harness/${taskId}/implementation/ledger.json`);
  const ledger=JSON.parse(await readFile(path,"utf8"));
  ledger.workspaces[0].state="merging";ledger.workspaces[0].merge={digest:view.digest,files:view.files};await writeFile(path,JSON.stringify(ledger));
  const backup=join(c.root,`.agent-harness/${taskId}/implementation/backups/a`);await mkdir(backup,{recursive:true});
  for(const file of ["a.txt","b.txt"])await copyFile(join(c.root,file),join(backup,createHash("sha256").update(file).digest("hex")));
  await writeFile(join(c.root,"a.txt"),"a after\n"); // simulate interrupted multi-file write
  await merge(c,view.digest);
  assert.equal(await readFile(join(c.root,"b.txt"),"utf8"),"b after\n");
  assert.equal(await readFile(join(backup,createHash("sha256").update("a.txt").digest("hex")),"utf8"),"a before\n");
}));

test("the same engine runs through the remote bridge and scoped MCP denies retired sessions",async()=>fixture(async c=>{
  const dir=join(c.root,`.agent-harness/${taskId}`);await mkdir(dir,{recursive:true});
  for(const name of ["implementation-workspaces.js","hpc.js"])await copyFile(join(__dirname,name),join(dir,name));
  const a=await remoteOperation(c.root,{op:"workspace",taskId,context:c,request:{action:"prepare",id:"a",files:["a.txt"]}}) as {path:string};
  assert.ok(a.path.startsWith(c.root));
  const control=join(c.root,"control");await mkdir(control);await writeFile(join(control,"instructions.txt"),"fixture");
  await writeFile(join(control,"workspace-context.json"),JSON.stringify({token:"secret",context:{...c,manage:false,harness:false}}));
  const rpc=async(request:object)=>{
    const child=spawn(process.execPath,[join(__dirname,"result-channel.js"),control,"secret"],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});let out="";
    child.stdout.on("data",b=>out+=b);child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"workspace_manage",arguments:{request}}})+"\n");
    assert.equal(await new Promise(r=>child.on("close",r)),0);return JSON.parse(out).result;
  };
  assert.equal((await rpc({action:"snapshot"})).isError,undefined);
  assert.equal((await rpc({action:"discard",id:"a",reason:"x"})).isError,true);
  await writeFile(join(control,"retired.json"),JSON.stringify({token:"secret"}));
  assert.equal((await rpc({action:"snapshot"})).isError,true);
}));
