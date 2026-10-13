import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureGitWorkspace, gitWorkPolicy } from "./git-workspace";
import { remoteOperation } from "./remote-bridge";
import { isInternalReportEntry, copyReportFiles } from "./report-files";

const exec=promisify(execFile);
test("Git gate initializes only metadata; repeated checks reuse the repository without staging user data",async()=>{
  const root=await mkdtemp(join(tmpdir(),"harness-git-"));
  const git=async(...args:string[])=>(await exec("git",["-C",root,...args])).stdout.trim();
  try{
    await writeFile(join(root,"code.f90"),"original"); await writeFile(join(root,"private.key"),"fixture secret");
    const first=await ensureGitWorkspace(root);assert.equal(first.initialized,true);assert.equal(first.root,await realpath(root));
    assert.equal(await git("diff","--cached","--name-only"),"");
    await git("add","--","code.f90");const staged=await git("diff","--cached");
    await writeFile(join(root,"code.f90"),"user unstaged changes");await mkdir(join(root,"child"));
    const again=await ensureGitWorkspace(join(root,"child"));assert.equal(again.initialized,false);assert.equal(again.root,first.root);
    assert.equal(await git("diff","--cached"),staged);assert.equal(await readFile(join(root,"code.f90"),"utf8"),"user unstaged changes");
    await assert.rejects(git("rev-parse","--verify","HEAD"),/HEAD|revision/i,"no automatic commit");
    await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","Baseline");
    const head=await git("rev-parse","HEAD");await ensureGitWorkspace(root);assert.equal(await git("rev-parse","HEAD"),head);
    await git("worktree","add","--detach",join(root,"linked"));
    assert.equal((await ensureGitWorkspace(join(root,"linked"))).initialized,false,"linked worktrees are reused");
  } finally{await rm(root,{recursive:true,force:true});}
});
test("broken repositories are never replaced and SSH initialization is bound to the connected workspace",async()=>{
  const root=await mkdtemp(join(tmpdir(),"harness-git-remote-"));
  try{
    const result=await remoteOperation(root,{op:"git-ensure",path:"/outside"}) as {root:string;initialized:boolean};
    assert.equal(result.root,await realpath(root));assert.equal(result.initialized,true);
    const broken=join(root,"broken");await mkdir(broken);await writeFile(join(broken,".git"),"gitdir: /nonexistent-harness-fixture\n");
    await assert.rejects(ensureGitWorkspace(broken),/既存の.git/);
    assert.equal(await readFile(join(broken,".git"),"utf8"),"gitdir: /nonexistent-harness-fixture\n");
  }finally{await rm(root,{recursive:true,force:true});}
});
test("Git metadata is not copied into report snapshots; required policy preserves role and ownership boundaries",async()=>{
  const root=await mkdtemp(join(tmpdir(),"harness-report-git-"));
  try{
    const src=join(root,"source");await mkdir(src);await ensureGitWorkspace(src);await writeFile(join(src,"report.tex"),"Report");
    const report={state:"draft" as const,storageLayout:"isolated" as const,texPath:join(src,"report.tex")};
    assert.equal(isInternalReportEntry(report,".git"),true);
    assert.deepEqual(await remoteOperation(src,{op:"list",path:"."}),["report.tex"],"remote report listing must not traverse Git metadata");
    await copyReportFiles(report,join(root,"copy"));
    await assert.rejects(readFile(join(root,"copy",".git","HEAD")),/ENOENT/);
    assert.equal(await readFile(join(root,"copy","report.tex"),"utf8"),"Report");
    for(const text of ["Mandatory Git","commit ID","pre-existing user changes","No push","preserve HEAD","Read-only","separate repository"]){assert.ok(gitWorkPolicy.includes(text),text);}
  }finally{await rm(root,{recursive:true,force:true});}
});
