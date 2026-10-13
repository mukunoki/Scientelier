import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, lstat, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ReportService } from "./report-service";
import { copyRestartReport } from "./task-restart";
import { localReportTask, publishLocalReport } from "./local-report";
import { downloadRemoteFile, downloadReport, remoteReportRoot, uploadReport, type RemoteConnection } from "./remote-client";
import { remoteOperation } from "./remote-bridge";
import type { ReportSettings, TaskRecord } from "./types";
const { reportTemplateFixture } = require("../../scripts/report-template-fixture.cjs");

test("remote evidence logs survive migration, download, local verification, review and restart without overwriting harness logs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "report-storage-")));
  try {
    const service = new ReportService(reportTemplateFixture(root));
    const settings = { outputDirectory: root } as ReportSettings;
    const id = randomUUID(), management = join(root, id), remote = join(root, "remote");
    await mkdir(join(management, "logs"), { recursive: true });
    await mkdir(join(management, "versions")); await mkdir(join(management, "paper")); await mkdir(remote);
    for (const name of ["logs/internal.log", "versions/old.tex", "all-agents.log"]) await writeFile(join(management, name), "Harness private history");
    await writeFile(join(management, "report.tex"), "\\input{paper/main.tex} Evidence: logs/test.log");
    await writeFile(join(management, "report.pdf"), "%PDF-1.7 original");
    await writeFile(join(management, "paper/main.tex"), "Original paper");
    await writeFile(join(management, "paper/main.pdf"), "%PDF-1.7 paper");
    let task = { id, title: "Report", cwd: join(root, "cache"), runs: [], remote: { resolvedCwd: remote }, report: {
      state: "ready", texPath: join(management, "report.tex"), pdfPath: join(management, "report.pdf"),
      documents: { paper: { state: "ready", texPath: join(management, "paper/main.tex"), pdfPath: join(management, "paper/main.pdf") } }
    } } as unknown as TaskRecord;
    const oldMtime = (await stat(task.report!.pdfPath!)).mtimeMs;
    task.report = await service.syncDraft(task, settings, true);
    const artifacts = dirname(task.report.texPath!);
    assert.equal(task.report.storageLayout, "isolated"); assert.equal(dirname(artifacts), management);
    assert.notEqual(artifacts, management);
    assert.equal(await readFile(task.report.texPath!, "utf8"), "\\input{paper/main.tex} Evidence: logs/test.log");
    assert.ok(Math.abs((await stat(task.report.pdfPath!)).mtimeMs - oldMtime) < 2);
    assert.equal(await readFile(task.report.documents!.paper!.texPath!, "utf8"), "Original paper");
    assert.equal((await service.syncDraft(localReportTask(task), settings, true)).texPath, task.report.texPath);
    assert.equal((await service.syncDraft(task, settings, true)).texPath, task.report.texPath);
    await assert.rejects(readFile(join(artifacts, "logs/internal.log")), { code: "ENOENT" });
    const client = { clockOffset: 0, request: (v: object) => remoteOperation(remote, v),
      put: async (path: string, data: Buffer | string, exclusive?: boolean) => { await remoteOperation(remote, { op: "put", path, data: Buffer.from(data).toString("base64"), exclusive }); }
    } as RemoteConnection;
    await uploadReport(client, task);
    const managed=".agent-harness/quality-fixture/ledger.json";
    await mkdir(dirname(join(remoteReportRoot(task),managed)),{recursive:true});
    await writeFile(join(remoteReportRoot(task),managed),"Remote private quality records");
    const evidence = ["logs/test.log", "versions/evidence.json", "all-agents.log", "paper/logs/experiment.txt"];
    for (const name of evidence) { const path = join(remoteReportRoot(task), name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `Evidence ${name}`); }
    await downloadReport(client, task);
    await assert.rejects(readFile(join(artifacts,managed)),{code:"ENOENT"});
    await mkdir(dirname(join(artifacts,managed)),{recursive:true});
    await writeFile(join(artifacts,managed),"Local private quality records");
    for (const name of evidence) assert.equal(await readFile(join(artifacts, name), "utf8"), `Evidence ${name}`);
    for (const name of ["logs/internal.log", "versions/old.tex", "all-agents.log"]) assert.equal(await readFile(join(management, name), "utf8"), "Harness private history");
    task.report = await service.verifyPdf(task, settings);
    assert.equal(task.report.state, "ready"); assert.equal(task.report.storageLayout, "isolated");
    const version = await service.snapshotVersion(task);
    assert.ok(version!.texPath!.startsWith(join(management, "versions") + "/"));
    assert.equal(await readFile(version!.documents!.paper!.texPath!, "utf8"), "Original paper");
    task.report.remoteSnapshotId = await publishLocalReport(client, task);
    for (const name of evidence) assert.equal(await readFile(join(remoteReportRoot(task), name), "utf8"), `Evidence ${name}`);
    await assert.rejects(readFile(join(remoteReportRoot(task), "logs/internal.log")), { code: "ENOENT" });
    const copy = await copyRestartReport(task.report, join(root, "carry"));
    assert.equal(copy!.storageLayout, "isolated"); assert.equal(copy!.remoteSnapshotId, undefined); assert.equal(copy!.state, "draft");
    for (const name of evidence) assert.equal(await readFile(join(root, "carry", name), "utf8"), `Evidence ${name}`);
    await assert.rejects(readFile(join(root,"carry",managed)),{code:"ENOENT"});
    const freshRemote = { ...task, id: randomUUID(), report: copy };
    await uploadReport(client, freshRemote);
    for (const name of evidence) assert.equal(await readFile(join(remoteReportRoot(freshRemote), name), "utf8"), `Evidence ${name}`);
    // Both storage layouts reject traversal. Legacy storage preflights the
    // whole manifest before any earlier file could be overwritten.
    const fake = (files: string[]) => ({ ...client, request: async (v: { op: string }) => { assert.equal(v.op, "list"); return files; } }) as RemoteConnection;
    await assert.rejects(downloadReport(fake(["../escape"]), task), /ファイル名/);
    await assert.rejects(downloadReport(fake(["report.tex", "logs/internal.log"]), { ...task, report: { ...task.report, storageLayout: undefined } }), /logs\/internal.log/);
    await symlink(management, join(artifacts, "linked"));
    await assert.rejects(downloadReport(fake(["linked/all-agents.log"]), task), /リンク/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unsafe legacy report migration leaves source and management files untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-migration-"));
  try {
    const directory = join(root, "task"); await mkdir(directory);
    await writeFile(join(directory, "report.tex"), "Keep original");
    await symlink(join(directory, "report.tex"), join(directory, "link.tex"));
    const task = { id: "task", remote: {}, runs: [], report: { state: "draft", texPath: join(directory, "report.tex") } } as unknown as TaskRecord;
    await assert.rejects(new ReportService().syncDraft(task, { outputDirectory: root } as ReportSettings, true), /リンク/);
    assert.equal(await readFile(task.report!.texPath!, "utf8"), "Keep original");
    assert.deepEqual((await readdir(directory)).sort(), ["link.tex", "report.tex"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolated remote report replaces leaf aliases atomically without touching their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-download-links-"));
  try {
    const cache = join(root, "artifacts"), outside = join(root, "outside.txt");
    await mkdir(join(cache, "preview"), { recursive: true });
    await writeFile(outside, "Keep outside data");
    await writeFile(join(cache, "preview/report-01.png"), "Keep original page");
    const aliases = { "report-1.png": "report-01.png", "external.png": outside, "missing.png": "absent.png", "directory.png": root };
    for (const [name, target] of Object.entries(aliases)) await symlink(target, join(cache, "preview", name));
    const files = Object.keys(aliases).map(name => `preview/${name}`);
    const task = { id: "fixture", remote: { resolvedCwd: "/work" }, report: { texPath: join(cache, "report.tex"), storageLayout: "isolated" } } as TaskRecord;
    const mtimeMs = Date.now() - 10000;
    const client = { clockOffset: 1000, request: async (v: { op: string }) => v.op === "list" ? files : { data: Buffer.from("Downloaded page").toString("base64"), mtimeMs } } as RemoteConnection;
    await downloadReport(client, task);
    for (const file of files) {
      assert.equal((await lstat(join(cache, file))).isSymbolicLink(), false);
      assert.equal(await readFile(join(cache, file), "utf8"), "Downloaded page");
      assert.ok(Math.abs((await stat(join(cache, file))).mtimeMs - (mtimeMs - 1000)) < 2);
    }
    assert.equal(await readFile(outside, "utf8"), "Keep outside data");
    assert.equal(await readFile(join(cache, "preview/report-01.png"), "utf8"), "Keep original page");
    await assert.rejects(lstat(join(cache, "preview/absent.png")), { code: "ENOENT" });
    assert.equal((await lstat(root)).isDirectory(), true);
    assert.equal((await readdir(join(cache, "preview"))).some(name => name.startsWith(".harness-download-")), false);
    // Retrying the download is also safe once aliases have become plain files.
    await downloadReport(client, task);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed report download preserves aliases and names the path; generic downloads stay strict", async () => {
  const root = await mkdtemp(join(tmpdir(), "report-download-failure-"));
  try {
    await writeFile(join(root, "source.png"), "Keep original");
    const destination = join(root, "page.png");
    await symlink("source.png", destination);
    const task = { id: "fixture", remote: { resolvedCwd: "/work" }, report: { texPath: join(root, "report.tex"), storageLayout: "isolated" } } as TaskRecord;
    const client = { clockOffset: 0, request: async (v: { op: string }) => { if (v.op === "list") return ["page.png"]; throw new Error("connection lost"); } } as RemoteConnection;
    await assert.rejects(downloadReport(client, task), error => error instanceof Error && error.message.includes(destination) && /connection lost/.test(error.message));
    assert.equal(await readlink(destination), "source.png");
    assert.equal(await readFile(join(root, "source.png"), "utf8"), "Keep original");
    await assert.rejects(downloadRemoteFile(client, "/work/page.png", destination, root), /通常ファイル.*page\.png/);
    await assert.rejects(downloadReport(client, { ...task, report: { ...task.report!, storageLayout: undefined } }), /通常ファイル.*page\.png/);
    // A staging failure must not remove the old alias either.
    client.request = async v => v.op === "list" ? ["page.png"] : { data: null, mtimeMs: Date.now() };
    await assert.rejects(downloadReport(client, task));
    assert.equal(await readlink(destination), "source.png");
    assert.deepEqual((await readdir(root)).sort(), ["page.png", "source.png"]);
    await mkdir(join(root, "folder"));
    client.request = async () => ["folder"];
    await assert.rejects(downloadReport(client, task), /通常ファイル.*folder/);
    assert.equal((await lstat(join(root, "folder"))).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
