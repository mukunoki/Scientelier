import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, writeFile, symlink, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { remoteOperation, prepareRemoteWorkspace } from "./remote-bridge";
import { RemoteClient, mapRemoteText, remoteReportRoot, uploadReport, downloadReport } from "./remote-client";
import { RemoteSystemStore, validateRemoteSystem } from "./remote-systems";
import { quoteShellArgument } from "./adapters";
import { captureEvidence, evidenceUnchanged } from "./autonomy";
import type { RemoteSystem, TaskRecord, GoalEvaluation } from "./types";

const profile = (cwd: string): RemoteSystem => ({ id: "cluster-a", name: "Test cluster", host: "test-cluster", cwd, nodeCommand: process.execPath, texCommand: "latexmk", startup: "", instructions: "計算はバッチで実行。投入済みジョブIDを確認する。" });

test("remote capacity uses final-host CLI over existing RPC without blocking other requests", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ah-remote-capacity-")));
  await writeFile(join(dir, "codex"), `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;
const result=r.id===2?{rateLimits:{primary:{usedPercent:37,windowDurationMins:300}}}:r.id===3?{data:[]}:{};
setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n'),r.id===2?800:0);});\n`, { mode: 0o700 });
  const client = await RemoteClient.create({ ...profile(dir), startup: `export PATH=${quoteShellArgument(dir)}:$PATH` }, __dirname,
    { command: process.execPath, prefix: [join(process.cwd(), "scripts", "fixture-ssh.cjs")] });
  try {
    await client.attach();
    let finished = false;
    const usage = client.request({ op: "service-capacity", agentId: "codex" }).then(value => { finished = true; return value; });
    assert.equal(typeof (await client.request({ op: "clock" })).now, "number");
    assert.equal(finished, false, "slow quota must not block transport");
    assert.equal((await usage).observation.usedPercent, 37);
  } finally { client.close(); await rm(dir, { recursive: true, force: true }); await rm(dirname(client.socket), { recursive: true, force: true }); }
});

test("remote profiles validate SSH targets and retain one directly editable text file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-remote-profile-"));
  try {
    const store = new RemoteSystemStore(dir); const value = profile("/work/project");
    assert.equal((await store.save(value)).length, 1);
    assert.equal((await store.list())[0].codexPermissions, "full-access");
    assert.equal(await readFile(join(dir, "cluster-a.txt"), "utf8"), value.instructions);
    await writeFile(join(dir, "cluster-a.txt"), "外部から編集した手順");
    assert.equal((await store.list())[0].instructions, "外部から編集した手順");
    await store.save({ ...value, instructions: "new" }); assert.equal((await store.list()).length, 1);
    assert.equal((await store.list())[0].codexPermissions, "full-access");
    for (const host of ["-oProxyCommand=bad", "host;bad", "host\nother", "", "host$(id)"]) assert.throws(() => validateRemoteSystem({ ...value, host }));
    for (const cwd of ["/", "///", "~other/project", "../project", "/work/../secret", "/work\nother", "/work/."]) assert.throws(() => validateRemoteSystem({ ...value, cwd }));
    for (const cwd of ["~", "~/projects/test", "projects/test"]) assert.equal(validateRemoteSystem({ ...value, cwd }).cwd, cwd);
    assert.equal(validateRemoteSystem({ ...value, cwd: "" }).cwd, "agent-harness");
    for (const host of ["192.0.2.10", "2001:db8::1", "login.example.jp", "olduser@my-cluster"]) assert.equal(validateRemoteSystem({ ...value, host }).host, host);
    for (const port of [0, -1, 65536, 1.5, "22"]) assert.throws(() => validateRemoteSystem({ ...value, port }));
    assert.throws(() => validateRemoteSystem({ ...value, username: "user;cmd" }));
    assert.throws(() => validateRemoteSystem({ ...value, host: "olduser@my-cluster", username: "otheruser" }));
    assert.throws(() => validateRemoteSystem({ ...value, connectionMode: "unknown" }));
    assert.throws(() => validateRemoteSystem({ ...value, codexPermissions: "invalid" }));
    assert.equal(validateRemoteSystem(value).codexPermissions, undefined);
    await store.save({ ...value, codexPermissions: "full-access" });
    assert.equal((await store.list())[0].codexPermissions, "full-access");
    for (const pythonCommand of ["", "python3\nextra", "x".repeat(513)]) assert.throws(() => validateRemoteSystem({ ...value, pythonCommand }));
    const manual = (await store.save({ ...value, connectionMode: "prepared", pythonCommand: "/opt/python3", resolvedCwd: "/unverified", preparedTarget: { hostname: "unverified" } }))[0];
    assert.equal(manual.connectionMode, "prepared"); assert.equal(manual.pythonCommand, "/opt/python3");
    assert.equal(manual.resolvedCwd, undefined); assert.equal(manual.preparedTarget, undefined);
    await rm(join(dir, "cluster-a.txt")); await assert.rejects(store.list());
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("remote permission defaults preserve legacy and explicitly sandboxed profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-remote-permissions-"));
  try {
    const store = new RemoteSystemStore(dir); const legacy = profile("/work/project");
    // Simulate an old installation without changing its stored data on read.
    await writeFile(join(dir, "systems.json"), JSON.stringify([legacy]));
    await writeFile(join(dir, "cluster-a.txt"), legacy.instructions);
    assert.equal((await store.list())[0].codexPermissions, undefined);
    assert.equal((await store.save({ ...legacy, name: "Renamed" }))[0].codexPermissions, "sandbox");
    await store.save({ ...legacy, id: "explicit", codexPermissions: "sandbox" });
    await store.save({ ...legacy, id: "explicit", name: "Still sandboxed" });
    assert.equal((await store.list()).find(p => p.id === "explicit")!.codexPermissions, "sandbox");
    await store.save({ ...legacy, id: "new-default" });
    assert.equal((await store.list()).find(p => p.id === "new-default")!.codexPermissions, "full-access");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("remote workspaces resolve against the login home and create only missing directories", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ah-remote-home-")));
  const home = join(directory, "login-home"); await mkdir(home);
  try {
    const target = await prepareRemoteWorkspace("projects/my work", home);
    assert.equal(target, join(home, "projects", "my work"));
    await writeFile(join(target, "keep.txt"), "existing work");
    assert.equal(await prepareRemoteWorkspace("~/projects/my work", home), target);
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "existing work");
    assert.equal(await prepareRemoteWorkspace("", home), join(home, "agent-harness"));
    assert.equal(await prepareRemoteWorkspace("~", home), home);
    assert.equal(await prepareRemoteWorkspace(join(directory, "shared", "new"), home), join(directory, "shared", "new"));
    await symlink(directory, join(home, "outside"));
    await assert.rejects(prepareRemoteWorkspace("outside/must-not-create", home), /ホームの外/);
    await assert.rejects(lstat(join(directory, "must-not-create")), { code: "ENOENT" });
    await assert.rejects(prepareRemoteWorkspace("projects/../escape", home));
    await assert.rejects(prepareRemoteWorkspace("~/projects/my work/keep.txt/nested", home), /通常ファイル/);
    await symlink(join(home, "projects"), join(home, "inside"));
    assert.equal(await prepareRemoteWorkspace("inside/new", home), join(home, "projects", "new"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("remote bridge confines writes, rejects symlinks, bounds reads and preserves remote edits", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ah-remote-bridge-")));
  const id = randomUUID(); const path = `.agent-harness/${id}/report/report.tex`;
  try {
    await remoteOperation(dir, { op: "put", path, data: Buffer.from("first").toString("base64") });
    await remoteOperation(dir, { op: "put", path, data: Buffer.from("overwrite").toString("base64"), exclusive: true });
    assert.equal(await readFile(join(dir, path), "utf8"), "first");
    await assert.rejects(remoteOperation(dir, { op: "put", path: "source.c", data: "" }));
    await assert.rejects(remoteOperation(dir, { op: "put", path: `.agent-harness/${id}/../escape`, data: "" }));
    await symlink("/etc/hosts", join(dir, "outside"));
    await assert.rejects(remoteOperation(dir, { op: "read", path: "outside" }));
    await assert.rejects(remoteOperation(dir, { op: "read", path, maxBytes: 1 }));
    await assert.rejects(remoteOperation(dir, { op: "hash", path, startedAt: "2000-01-01T00:00:00Z" }));
    const hash = await remoteOperation(dir, { op: "hash", path }) as { hash: string };
    assert.equal(hash.hash.length, 64);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("persistent remote transport handles reports, support files and independent evidence hashes", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ah-remote-roundtrip-")));
  const remote = join(dir, "remote 'space'"); const local = join(dir, "local"); const report = join(dir, "report");
  await Promise.all([remote, local, report].map(p => mkdir(p)));
  const client = await RemoteClient.create({ ...profile(remote), host: "192.0.2.10", username: "scientist", port: 2222 }, __dirname, { command: process.execPath, prefix: [join(process.cwd(), "scripts", "fixture-ssh.cjs")] });
  const task = { id: randomUUID(), cwd: local, remote: profile(remote), report: { texPath: join(report, "report.tex"), pdfPath: join(report, "report.pdf") }, reviewPolicy: "adversarial-pair", goal: { revision: 1 } } as TaskRecord;
  try {
    const master = client.masterSpec(); assert.ok(master.args.includes("-M")); assert.ok(!master.args.includes("StrictHostKeyChecking=no"));
    assert.equal(master.args[master.args.indexOf("-l") + 1], "scientist"); assert.equal(master.args[master.args.indexOf("-p") + 1], "2222"); assert.equal(master.args.at(-1), "192.0.2.10");
    await client.attach(); assert.equal(client.connected, true);
    const invocation = client.invocation({ command: "cli", args: ["prompt 'quoted'", "--model", "x"], cwd: remote });
    assert.ok(invocation.args.includes("-tt")); assert.ok(invocation.args.includes("ProxyCommand=false"));
    assert.equal(invocation.args[invocation.args.indexOf("-l") + 1], "scientist"); assert.equal(invocation.args[invocation.args.indexOf("-p") + 1], "2222");
    await writeFile(task.report!.texPath!, "local seed"); await writeFile(task.report!.pdfPath!, "%PDF-1.7\nseed");
    await uploadReport(client, task);
    await writeFile(join(remoteReportRoot(task), "report.tex"), "remote changes");
    await uploadReport(client, task);
    assert.equal(await readFile(join(remoteReportRoot(task), "report.tex"), "utf8"), "remote changes");
    await downloadReport(client, task);
    assert.equal(await readFile(task.report!.texPath!, "utf8"), "remote changes");
    const text = `${task.cwd}/source.c\n${task.report!.texPath}\n${task.cwd}-outside`;
    const mapped = mapRemoteText(text, task, true);
    assert.ok(mapped.includes(`${remote}/source.c`)); assert.ok(mapped.includes(`${remoteReportRoot(task)}/report.tex`)); assert.ok(mapped.includes(`${task.cwd}-outside`));
    assert.equal(mapRemoteText(mapped, task, false), text);
    const hashFile = async (path: string, value: TaskRecord, startedAt?: string, maxBytes?: number) => {
      const result = await client.request({ op: "hash", path: mapRemoteText(path, value, true), startedAt, maxBytes }); return { path: result.path, hash: result.hash };
    };
    const evaluation = await captureEvidence({ goalRevision: 1, criteria: [{ criterionId: "result", status: "pass", detail: "checked", evidence: [{ path: task.report!.texPath!, detail: "source" }] }], concerns: [] } as unknown as GoalEvaluation, task, new Date(Date.now() + 1000).toISOString(), hashFile);
    assert.equal(await evidenceUnchanged(evaluation, task, hashFile), true);
    await writeFile(join(remoteReportRoot(task), "report.tex"), "changed between reviewers");
    assert.equal(await evidenceUnchanged(evaluation, task, hashFile), false);
    // A removed remote file is not silently resurrected from the local mirror.
    await rm(join(remoteReportRoot(task), "report.tex")); await uploadReport(client, task);
    await assert.rejects(readFile(join(remoteReportRoot(task), "report.tex")));
    await assert.rejects(client.put(`.agent-harness/${task.id}/report/../../outside`, "bad"));
  } finally {
    client.close(); await rm(dir, { recursive: true, force: true });
    await rm(dirname(client.socket), { recursive: true, force: true });
  }
});

test("remote foreground session preserves native output and holds its lock until confirmed stop", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ah-remote-session-")));
  const lock = join(directory, "active.lock"); const token = randomUUID();
  const handoff = join(directory, "handoff.json"); const config = join(directory, "launch.json");
  const entry = join(__dirname, "remote-session.js");
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error("Remote session condition timed out");
  };
  await writeFile(config, JSON.stringify({ retirementProtocol:1, command: process.execPath, args: ["-e", "process.stdout.write('\\x1b[32mCLI screen\\x1b[0m\\n'); process.stdin.on('data', d => process.stdout.write(d));"], cwd: directory, lock, token, handoff, exitPath: join(directory, "exit.json") }));
  const child = spawn(process.execPath, [entry, config], { stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", d => { output += d; });
  const ended = once(child, "exit");
  try {
    await waitFor(async () => output.includes("CLI screen"));
    child.stdin.write("interactive input\n"); await waitFor(async () => output.includes("interactive input"));
    assert.match(output, /\x1b\[32mCLI screen/);
    const duplicate = spawn(process.execPath, [entry, config]); let error = ""; duplicate.stderr.on("data", d => { error += d; });
    const [code] = await once(duplicate, "exit"); assert.equal(code, 75); assert.match(error, /二重起動/);
    await writeFile(handoff, JSON.stringify({ token: "wrong", status: "completed", summary: "not this run" }));
    await new Promise(r => setTimeout(r, 300)); assert.ok(await readFile(join(lock, "owner.json")));
    await writeFile(handoff, JSON.stringify({ token, status: "completed", summary: "finished" }));
    await waitFor(async () => { try { return JSON.parse(await readFile(join(directory,"retired.json"),"utf8")).token === token; } catch { return false; } });
    assert.ok(await readFile(join(lock,"owner.json")));assert.equal(child.exitCode,null);
    await writeFile(join(directory,"stop.json"),JSON.stringify({token}));
    await ended;
    await waitFor(async () => { try { await readFile(join(lock, "owner.json")); return false; } catch { return true; } });
    assert.equal(JSON.parse(await readFile(join(directory,"exit.json"),"utf8")).token,token);
  } finally {
    child.stdin.end(); await ended; await rm(directory, { recursive: true, force: true });
  }
});

test("updated remote helper remains compatible with an unrestarted legacy desktop", async () => {
  const directory=await mkdtemp(join(tmpdir(),"remote-legacy-handoff-")),token=randomUUID();
  const lock=join(directory,"active.lock"),handoff=join(directory,"handoff.json"),config=join(directory,"launch.json");
  await writeFile(config,JSON.stringify({command:process.execPath,args:["-e","process.stdout.write('READY');process.stdin.resume();"],cwd:directory,lock,token,handoff,exitPath:join(directory,"exit.json")}));
  const child=spawn(process.execPath,[join(__dirname,"remote-session.js"),config]);
  const ended=once(child,"exit");
  try {
    await once(child.stdout,"data");
    await writeFile(handoff,JSON.stringify({token,status:"completed",summary:"Legacy result"}));
    let released=false;
    for(let i=0;i<100;i++) {
      try {await readFile(join(lock,"owner.json"));}
      catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT"){released=true;break;}throw error;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(released,true);assert.equal(child.exitCode,null);
  } finally {child.stdin.end();await ended;await rm(directory,{recursive:true,force:true});}
});
