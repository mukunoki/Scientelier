import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { hpcOperation, compareNumerics, assertHpcRunActive, type HpcContext, type HpcLedger } from "./hpc";
import { validatePlanFormat } from "./plan-format";
import { remoteOperation } from "./remote-bridge";
const exec = promisify(execFile);
const taskId = "00000000-0000-4000-8000-000000000001";
async function fixture(run: (c: HpcContext) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "harness-hpc-"));
  const c: HpcContext = { root, taskId, actor: "test", write: true, manage: true, user: true };
  try {
    await writeFile(join(root, "kernel.f90"), "subroutine step(a)\nreal a\na=a+1\nend\n");
    await writeFile(join(root, "reference.json"), JSON.stringify({ values: { energy: [0, 1, 2] } }));
    await writeFile(join(root, "actual.json"), JSON.stringify({ values: { energy: [0, 1, 2] } }));
    await writeFile(join(root, "environment.json"), '{"compiler":"fixture","ranks":2}');
    await writeFile(join(root, "verify.sh"), "# fixture comparator export\n");
    await run(c);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const definition = (id = "step", files = ["kernel.f90"], dependsOn: string[] = []) => ({ id, title: id, files, dependsOn, policyNote: "approved exact fixture",
  cases: ["reference", "replay", "unit", "integration"].map(stage => ({ id: stage, stage, absolute: 0, relative: 0 })) });
const verify = (c: HpcContext, unitId: string, caseId: string) => hpcOperation(c, { action: "verify", unitId, caseId, reference: "reference.json", actual: "actual.json", environment: "environment.json", verifier: "verify.sh" });
const snapshot = (c: HpcContext): Promise<HpcLedger> => hpcOperation(c, { action: "snapshot" });

test("numeric comparison rejects shape, nonfinite values, omitted variables and tolerance overflow", () => {
  const values = { values: { a: [0, 1, 2] } };
  assert.equal(compareNumerics(values, values, 0, 0)[0].failures, 0);
  assert.equal(compareNumerics(values, { values: { a: [0.1, 1, 2] } }, 0, 0)[0].failures, 1);
  assert.throws(() => compareNumerics(values, { values: { a: [0] } }, 0, 0), /配列長/);
  assert.throws(() => compareNumerics(values, { values: { a: [0, Infinity, 2] } }, 0, 0), /NaN/);
  assert.throws(() => compareNumerics(values, { values: { b: [0, 1, 2] } }, 0, 0), /変数/);
  assert.throws(() => compareNumerics(values, values, -1, 0));
  assert.equal(compareNumerics({values:{a:[1e308]}},{values:{a:[1e308]}},1e308,1e308)[0].failures,1);
});

test("real MCP exposes HPC only with run context, denies read-only mutations and rejects completed leases",async()=>fixture(async c=>{
  const control=join(c.root,"control");await mkdir(control);
  await writeFile(join(control,"instructions.txt"),"approved instructions");
  await writeFile(join(control,"hpc-context.json"),JSON.stringify({token:"lease",context:{...c,user:false,write:false,manage:false}}));
  const child=spawn(process.execPath,[join(__dirname,"result-channel.js"),control,"lease"]);
  let output="";child.stdout.on("data",d=>{output+=d;});
  const requests=[{id:1,method:"tools/list"},{id:2,method:"tools/call",params:{name:"hpc_manage",arguments:{request:{action:"snapshot"}}}},{id:3,method:"tools/call",params:{name:"hpc_manage",arguments:{request:{action:"define",unit:definition()}}}},{id:4,method:"tools/call",params:{name:"hpc_manage",arguments:{request:{action:"budget",budget:{jobs:99}}}}}];
  child.stdin.end(requests.map(r=>JSON.stringify({jsonrpc:"2.0",...r})).join("\n")+"\n");
  assert.equal(await new Promise(resolve=>child.on("close",resolve)),0);
  const answers=output.trim().split("\n").map(s=>JSON.parse(s));
  assert.ok(answers[0].result.tools.some((t:any)=>t.name === "hpc_manage"));
  assert.equal(answers[1].result.isError,undefined);assert.equal(answers[2].result.isError,true);assert.equal(answers[3].result.isError,true);
  await assertHpcRunActive(control,"lease");
  await writeFile(join(control,"handoff.json"),JSON.stringify({token:"lease",status:"completed"}));
  await assert.rejects(assertHpcRunActive(control,"lease"),/終了済み/);
}));

test("ledger gates phases and invalidates source/dependent/environment changes across reload", async () => fixture(async c => {
  await hpcOperation(c, { action: "define", unit: definition() });
  await assert.rejects(verify(c, "step", "unit"), /CPU基準/);
  for (const stage of ["reference", "replay", "unit", "integration"]) assert.equal((await verify(c, "step", stage)).passed, true);
  assert.equal((await snapshot(c)).units[0].state, "統合検証済");
  await writeFile(join(c.root,"child.cpp"),"int child;\n");
  await hpcOperation(c,{action:"define",unit:definition("child",["child.cpp"],["step"])});
  for (const stage of ["reference", "replay", "unit", "integration"]) await verify(c,"child",stage);
  await writeFile(join(c.root,"kernel.f90"),"changed source\n");
  assert.ok((await snapshot(c)).units.every(u=>u.state === "再検証待ち"));
  for (const stage of ["reference", "replay", "unit", "integration"]) await verify(c,"step",stage);
  await writeFile(join(c.root,"environment.json"),'{"compiler":"changed","ranks":4}');
  assert.equal((await snapshot(c)).units[0].state,"再検証待ち");
  await assert.rejects(hpcOperation({...c,user:false},{action:"define",unit:definition()}),/変更できません/);
  await assert.rejects(hpcOperation(c,{action:"budget",revision:0,budget:{jobs:1}}),/更新/);
}));

test("failed checks are persisted; baselines, read-only roles and evidence paths fail closed",async()=>fixture(async c=>{
  await hpcOperation(c,{action:"define",unit:definition()});
  await writeFile(join(c.root,"actual.json"),'{"values":{"energy":[0,9,2]}}');
  assert.equal((await verify(c,"step","reference")).passed,false);
  assert.equal((await snapshot(c)).units[0].state,"差戻し");
  await writeFile(join(c.root,"reference.json"),'{"values":{"energy":[0,9,2]}}');
  await assert.rejects(verify(c,"step","reference"),/基準結果/);
  await assert.rejects(verify({...c,write:false},"step","reference"),/読み取り/);
  await assert.rejects(hpcOperation({...c,user:false},{action:"budget",budget:{jobs:9}}),/ユーザー/);
  await assert.rejects(hpcOperation(c,{action:"define",unit:definition("bad",["../outside"])}),/相対/);
  await symlink(join(c.root,"reference.json"),join(c.root,"linked.json"));
  await assert.rejects(hpcOperation(c,{action:"verify",unitId:"step",caseId:"reference",reference:"linked.json",actual:"actual.json",environment:"environment.json",verifier:"verify.sh"}),/リンク/);
}));

test("job intent is persistent, uncertain submissions never retry, probes recover and budget blocks only new work",async()=>fixture(async c=>{
  await hpcOperation(c,{action:"define",unit:definition()});
  await hpcOperation(c,{action:"budget",budget:{jobs:1,gpuHours:2,nodeHours:2,storageGB:2}});
  const request={action:"submit-job",unitId:"step",key:"trial_1",label:"batch fixture",inputs:["kernel.f90","reference.json","environment.json"],reserved:{gpuHours:1,nodeHours:1,storageGB:1},
    submit:"printf 'called\\n' >> launches; printf 'unparseable reply'",probe:"printf '%s' '{\"id\":\"job-17\",\"state\":\"succeeded\",\"exitCode\":0,\"actual\":{\"gpuHours\":0.5,\"nodeHours\":0.5,\"storageGB\":1}}'"};
  const first=await hpcOperation(c,request);assert.equal(first.state,"unknown");
  const repeat=await hpcOperation(c,request);assert.equal(repeat.id,first.id);assert.equal(repeat.reused,true);
  assert.equal(await readFile(join(c.root,"launches"),"utf8"),"called\n");
  assert.equal((await snapshot(c)).jobs[0].state,"unknown");
  const recovered=await hpcOperation(c,{action:"probe-job",jobId:first.id});assert.equal(recovered.state,"succeeded");assert.equal(recovered.actual.gpuHours,0.5);
  await assert.rejects(hpcOperation(c,{...request,key:"trial_2"}),/ジョブ数/);
  await assert.rejects(hpcOperation({...c,write:false},{action:"probe-job",jobId:first.id}),/読み取り/);
}));

test("concurrent reservations are serialized and cannot overspend",async()=>fixture(async c=>{
  await hpcOperation(c,{action:"define",unit:definition()});await hpcOperation(c,{action:"budget",budget:{gpuHours:1}});
  const base={action:"submit-job",unitId:"step",label:"parallel",inputs:["reference.json"],reserved:{gpuHours:1,nodeHours:0,storageGB:0},submit:"printf '%s' '{\"id\":\"1\",\"state\":\"queued\"}'",probe:"printf '%s' '{\"id\":\"1\",\"state\":\"running\"}'"};
  const results=await Promise.allSettled([hpcOperation(c,{...base,key:"a"}),hpcOperation(c,{...base,key:"b"})]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal((await snapshot(c)).jobs.length,1);
}));

test("isolated worktrees gate merge on proofs, reject overlap/outside edits and preserve base conflicts",async()=>fixture(async c=>{
  const git=async(...args:string[])=>exec("git",["-C",c.root,...args]);
  await git("init");await git("add",".");await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","baseline");
  await hpcOperation(c,{action:"define",unit:definition()});
  const w=await hpcOperation(c,{action:"workspace-prepare",id:"writer1",files:["kernel.f90","actual.json"]});
  assert.notEqual(w.path,c.root);await writeFile(join(w.path,"kernel.f90"),"! migrated\n");
  await assert.rejects(hpcOperation(c,{action:"workspace-prepare",id:"writer2",files:["kernel.f90"]}),/重なって/);
  await assert.rejects(hpcOperation(c,{action:"workspace-merge",id:"writer1"}),/検証/);
  const child={...c,workspaceId:"writer1",user:false,manage:false};
  for(const s of ["reference","replay","unit"])await verify(child,"step",s);
  await writeFile(join(w.path,"verify.sh"),"outside ownership\n");
  await assert.rejects(hpcOperation(c,{action:"workspace-merge",id:"writer1"}),/証拠|担当外/);
  await writeFile(join(w.path,"verify.sh"),"# fixture comparator export\n");
  await writeFile(join(c.root,"kernel.f90"),"user edit\n");
  await assert.rejects(hpcOperation(c,{action:"workspace-merge",id:"writer1"}),/競合/);
  assert.equal(await readFile(join(c.root,"kernel.f90"),"utf8"),"user edit\n");
  await writeFile(join(c.root,"kernel.f90"),"subroutine step(a)\nreal a\na=a+1\nend\n");
  const merged=await hpcOperation(c,{action:"workspace-merge",id:"writer1"});assert.equal(merged.state,"merged");
  assert.equal(await readFile(join(c.root,"kernel.f90"),"utf8"),"! migrated\n");
  assert.notEqual((await snapshot(c)).units[0].state,"統合検証済","shared integration must be retested");
}));

test("remote bridge calls the same persisted engine inside its bound workspace",async()=>fixture(async c=>{
  const dir=join(c.root,".agent-harness",taskId);await mkdir(dir,{recursive:true});
  await writeFile(join(dir,"hpc-runtime.js"),await readFile(join(__dirname,"hpc.js")));
  const result:any=await remoteOperation(c.root,{op:"hpc",taskId,context:{...c,root:"/wrong"},request:{action:"define",unit:definition()}});
  assert.equal(result.units[0].id,"step");assert.equal((await snapshot(c)).units.length,1);
  await assert.rejects(remoteOperation(c.root,{op:"hpc",taskId:"../escape",request:{action:"snapshot"}}));
}));

test("isolated plans require explicit authority, disjoint paths and no path traversal",()=>{
  const v={summary:"s",reason:"r",primaryWork:"p",acceptance:"a",criterionIds:["report"],estimatedTokens:1000,estimatedMinutes:1,escalation:"e",tasks:[{kind:"isolated-work",key:"kernel",title:"k",instructions:"i",deliverable:"d",acceptance:"a",criterionIds:["report"],dependsOn:[],estimatedTokens:1000,ownedFiles:["kernel.f90"]}]};
  const contract={criterionIds:["report"],requiredCriterionIds:["report"],maxSubtasks:4};
  assert.throws(()=>validatePlanFormat(v,contract),/kind/);
  assert.equal(validatePlanFormat(v,{...contract,allowIsolatedWork:true}).tasks[0].ownedFiles![0],"kernel.f90");
  assert.throws(()=>validatePlanFormat({...v,tasks:[v.tasks[0],{...v.tasks[0],key:"other"}]},{...contract,allowIsolatedWork:true}),/重複/);
  assert.throws(()=>validatePlanFormat({...v,tasks:[{...v.tasks[0],ownedFiles:["../escape"]}]},{...contract,allowIsolatedWork:true}),/相対/);
});
