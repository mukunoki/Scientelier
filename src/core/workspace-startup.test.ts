import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteOperation } from "./remote-bridge";
import { TerminalScreen } from "./terminal-screen";
import { WorkspaceTrust } from "./workspace-trust";

test("remote startup resolves actual isolated cwd but never trusts outside the registered root", async () => {
  const root=await mkdtemp(join(tmpdir(),"trust-root-")), outside=await mkdtemp(join(tmpdir(),"trust-outside-"));
  try {
    const isolated=join(root,"isolated"); await mkdir(isolated);
    await symlink(isolated,join(root,"alias")); await symlink(outside,join(root,"escape"));
    await writeFile(join(root,"file"),"not a directory");
    assert.deepEqual(await remoteOperation(root,{op:"workspace-directory",path:"alias"}),{cwd:await realpath(isolated)});
    await assert.rejects(remoteOperation(root,{op:"workspace-directory",path:"escape"}),/outside/);
    await assert.rejects(remoteOperation(root,{op:"workspace-directory",path:"file"}),/ディレクトリ/);
  } finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test("trust screen unwraps only terminal wraps, including long Unicode paths", async () => {
  const path="/work/"+"日本語の作業場所 ".repeat(20)+"project";
  const guard=new WorkspaceTrust("claude",path);
  let approve:()=>void=()=>{};
  const approved=new Promise<void>(resolve=>{approve=resolve;});
  const screen=new TerminalScreen(text=>{if(guard.inspect(text)==="\r")approve();},true);
  try {
    screen.resize(65,45);
    screen.write(`Accessing workspace:\r\n\r\n${path}\r\n\r\nQuick safety check: Is this a project you created or one you trust?\r\nClaude Code'll be able to read, edit, and execute files here.\r\nNo, exit\r\n❯ Yes, I trust this folder\r\nEnter to confirm · Esc to cancel`);
    await Promise.race([approved,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error("not approved")),1000);timer.unref();})]);
  } finally {screen.dispose();}
});
