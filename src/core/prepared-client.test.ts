import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PreparedRemoteClient } from "./prepared-client";
import { TerminalRunner } from "./terminal-runner";
import { quoteShellArgument as q } from "./adapters";

test("prepared shell hands the FINAL cwd and environment to file RPC and independent real PTYs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ah-prepared-test-")));
  const landing = join(root, "first-host"); const final = join(root, "final host");
  await mkdir(landing); await mkdir(final);
  const client = await PreparedRemoteClient.create({ id: "manual", name: "Manual route", host: "not-a-network-host", connectionMode: "prepared", cwd: "ignored", nodeCommand: process.execPath, pythonCommand: "python3", startup: "", instructions: "No jobs", texCommand: "latexmk" }, __dirname,
    { command: "/bin/bash", args: ["--noprofile", "--norc", "-i"], cwd: landing });
  const runner = new TerminalRunner(); let display = "";
  const preparation = runner.runProcess("prepare", client.preparation, e => { display += e.text; });
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`Timed out; stage=${client.stage} error=${client.lastError} display=${display.slice(-1500)}`);
  };
  try {
    // Nested shells stand in for nested SSH here: the captured current shell,
    // not a separately reopened login shell, supplies cwd and exported modules.
    runner.write("prepare", `cd ${q(final)}; export HARNESS_PREPARED_TEST=final; /bin/bash --noprofile --norc -i\r`);
    runner.write("prepare", "printf '\\nFINAL_SHELL_READY\\n'\r");
    await wait(() => display.includes("\r\nFINAL_SHELL_READY\r\n"));
    await client.attach();
    assert.equal(client.resolvedCwd, final); assert.equal(client.stage, "ready");
    assert.equal(client.target?.nodeExecutable, process.execPath);
    assert.throws(() => runner.write("prepare", "pwd\r"), /連携専用/);
    const managed = `.agent-harness/${randomUUID()}/report/report.tex`;
    await client.put(managed, "final source");
    assert.equal(await readFile(join(final, managed), "utf8"), "final source");
    await assert.rejects(readFile(join(landing, managed)));
    const large = "αβ".repeat(200000);
    await client.put(managed, large);
    assert.equal(Buffer.from((await client.request({ op: "read", path: managed })).data, "base64").toString(), large);
    await assert.rejects(client.request({ op: "read", path: join(landing, "no") }));
    const start = (id: string) => runner.runProcess(id, client.createTerminal({ command: process.execPath, args: ["-e", "process.stdout.on('resize',()=>console.log('SIZE',process.stdout.columns,process.stdout.rows));process.stdin.on('data',d=>console.log('INPUT',d.toString()));console.log('READY',process.cwd(),process.env.HARNESS_PREPARED_TEST,process.stdin.isTTY);process.stdout.write('\\x1b[32mCOLOR\\x1b[0m\\n');"], cwd: final }), () => {});
    const one = start("one"); const two = start("two");
    await wait(() => !!runner.snapshot("one")?.data.includes("COLOR") && !!runner.snapshot("two")?.data.includes("COLOR"));
    assert.match(runner.snapshot("one")!.data, /final true/); assert.match(runner.snapshot("one")!.data, /\x1b\[32m/);
    runner.resize("one", 123, 41);
    await wait(() => !!runner.snapshot("one")?.data.includes("SIZE 123 41"));
    runner.write("one", "typed input\r");
    await wait(() => !!runner.snapshot("one")?.data.includes("INPUT typed input"));
    assert.doesNotMatch(runner.snapshot("two")!.data, /SIZE 123/);
    runner.complete("one", { status: "completed", summary: "handoff" });
    assert.equal((await one).handoff?.summary, "handoff"); assert.equal(runner.snapshot("one")!.alive, true);
    assert.doesNotMatch(display, /"op"|terminal:start|AH_[a-f0-9]+:/);
    runner.cancel("two"); assert.equal((await two).handoff, undefined);
    client.close(); await preparation;
    await wait(() => !runner.snapshot("one")?.alive);
    await assert.rejects(client.request({ op: "clock" }), /確定/);
  } finally { client.close(); runner.cancelAll(); await preparation; await rm(root, { recursive: true, force: true }); }
});

for (const missing of ["node", "python"] as const) test(`prepared setup with missing ${missing} returns to the same usable shell without exposing the protocol`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ah-prepared-missing-")));
  const client = await PreparedRemoteClient.create({ id: "missing", name: "Missing tool", host: "not-a-network-host", connectionMode: "prepared", cwd: "ignored", nodeCommand: missing === "node" ? "harness-no-such-node" : process.execPath, pythonCommand: missing === "python" ? "harness-no-such-python" : "python3", startup: "", instructions: "", texCommand: "latexmk" }, __dirname,
    { command: "/bin/bash", args: ["--noprofile", "--norc", "-i"], cwd: root });
  const runner = new TerminalRunner(); let display = "";
  const preparation = runner.runProcess("prepare", client.preparation, e => { display += e.text; });
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`Setup recovery timed out: ${client.stage} ${client.lastError}`);
  };
  try {
    runner.write("prepare", "printf '\\nINITIAL_SHELL_READY\\n'\r");
    await wait(() => display.includes("\r\nINITIAL_SHELL_READY\r\n"));
    await assert.rejects(client.attach(), /Node.js|Python|harness-no-such-python/);
    await wait(() => client.stage === "shell"); assert.equal(client.connected, false);
    runner.write("prepare", "printf '\\nRECOVERED_SHELL_READY\\n'\r");
    await wait(() => display.includes("\r\nRECOVERED_SHELL_READY\r\n"));
    assert.doesNotMatch(display, /AH_[a-f0-9]+:|"event":|Bootstrap too large/);
  } finally { client.close(); await preparation; await rm(root, { recursive: true, force: true }); }
});
