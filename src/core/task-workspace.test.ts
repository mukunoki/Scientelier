import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskDirectory, TaskWorkspaces } from "./task-workspace";
import type { TaskRecord } from "./types";

test("workspace choice is explicit; new folders never overwrite an existing folder or file", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-directory-"));
  try {
    await assert.rejects(taskDirectory(root, undefined), /新規作成/);
    await assert.rejects(taskDirectory("", "existing"), /絶対パス/);
    await assert.rejects(taskDirectory(".", "existing"), /絶対パス/);
    assert.equal(await taskDirectory(root, "existing"), await realpath(root));
    const path = join(root,"new");
    await taskDirectory(path,"new"); await assert.rejects(stat(path), /ENOENT/);
    await taskDirectory(path,"new",true); assert.ok((await stat(path)).isDirectory());
    await assert.rejects(taskDirectory(path,"new",true), /既に/);
    await writeFile(join(root,"file"), "preserve");
    await assert.rejects(taskDirectory(join(root,"file"),"existing"), /ディレクトリでは/);
    await assert.rejects(taskDirectory(join(root,"file"),"new",true), /既に/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("independent task workspaces overlap in time, aliases and parent-child workspaces cannot", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-leases-"));
  try {
    for (const dir of ["a","b","a/child"]) await mkdir(join(root,dir));
    await symlink(join(root,"a"),join(root,"alias"));
    const t = (id: string, dir: string) => ({id,title:id,cwd:join(root,dir)}) as TaskRecord;
    const registry = new TaskWorkspaces();
    await Promise.all([registry.acquire(t("A","a")), registry.acquire(t("B","b"))]);
    await assert.rejects(registry.acquire(t("C","alias")), /重なって/);
    await assert.rejects(registry.acquire(t("C","a/child")), /重なって/);
    await assert.rejects(registry.acquire(t("C",".")), /重なって/);
    registry.release("A"); await registry.acquire(t("C","a"));
    registry.release("B"); registry.release("C");
    const simultaneous = await Promise.allSettled([registry.acquire(t("D","a")), registry.acquire(t("E","alias"))]);
    assert.equal(simultaneous.filter(r=>r.status==="fulfilled").length,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});
