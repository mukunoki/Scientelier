import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { localReportTask, localReportUnit, publishLocalReport } from "./local-report";
import { remoteOperation } from "./remote-bridge";
import { mapRemoteText, remoteReportRoot, uploadReport, type RemoteConnection } from "./remote-client";
import type { TaskRecord, WorkUnit, ReportSettings } from "./types";

test("remote tasks use local report workspace without changing goal, CLI permission or worker location", () => {
  const task = { cwd: '/local/cache', remote: {codexPermissions:'full-access'}, report: {texPath:'/local/reports/report.tex'}, goal:{objective:'Keep goal'} } as TaskRecord;
  const reporter = {role:'reporter'} as WorkUnit;
  assert.equal(localReportUnit(task, reporter, {} as ReportSettings), false);
  assert.equal(localReportUnit(task, reporter, {remoteExecution:'local'} as ReportSettings), true, 'explicit legacy transport remains readable');
  assert.equal(localReportUnit(task, reporter, {remoteExecution:'remote'} as ReportSettings), false);
  assert.equal(localReportUnit(task, {role:'worker'} as WorkUnit, {} as ReportSettings), false);
  assert.equal(localReportUnit(task, {role:'reviewer'} as WorkUnit, {} as ReportSettings), false);
  const local = localReportTask(task); assert.equal(local.cwd, '/local/reports'); assert.equal(local.remote, undefined);
  assert.deepEqual(local.goal, task.goal); assert.equal(task.remote?.codexPermissions, 'full-access');
});

test("local report publication preserves previous remote content and publishes exact portable assets for review", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-report-')));
  try {
    const remote = join(root, 'remote'), local = join(root, 'report'); await mkdir(remote); await mkdir(local);
    const task = {id:randomUUID(),cwd:join(root,'cache'),remote:{resolvedCwd:remote},report:{state:'ready',texPath:join(local,'report.tex'),pdfPath:join(local,'report.pdf')}} as TaskRecord;
    const client = {clockOffset:0, request: (v: object) => remoteOperation(remote, v),
      put: async (path: string, data: string | Buffer, exclusive?: boolean) => { await remoteOperation(remote, {op:'put',path,data:Buffer.from(data).toString('base64'),exclusive}); }
    } as RemoteConnection;
    await writeFile(task.report!.texPath!, 'Original'); await writeFile(task.report!.pdfPath!, '%PDF-old');
    await uploadReport(client, task); const old = remoteReportRoot(task);
    await mkdir(join(local,'preview')); await mkdir(join(local,'logs'));
    await writeFile(join(local,'logs','private.log'), 'Do not upload');
    await writeFile(join(local,'preview','page-1.png'), 'Rendered page');
    await writeFile(task.report!.texPath!, 'Locally finished'); await writeFile(task.report!.pdfPath!, '%PDF-new');
    const id = await publishLocalReport(client,task); assert.equal(task.report!.remoteSnapshotId,undefined);
    const published = {...task,report:{...task.report!,remoteSnapshotId:id}};
    const path = remoteReportRoot(published);
    assert.notEqual(path,old); assert.equal(await readFile(join(old,'report.tex'),'utf8'),'Original');
    assert.equal(await readFile(join(path,'report.tex'),'utf8'),'Locally finished');
    assert.equal(await readFile(join(path,'report.pdf'),'utf8'),'%PDF-new');
    assert.equal(await readFile(join(path,'preview','page-1.png'),'utf8'),'Rendered page');
    await assert.rejects(readFile(join(path,'logs','private.log')));
    const mapped = mapRemoteText(task.report!.pdfPath!,published,true); assert.equal(mapped,join(path,'report.pdf'));
    assert.equal(mapRemoteText(mapped,published,false),task.report!.pdfPath);
    await writeFile(join(path,'report.tex'),'Remote correction'); await uploadReport(client,published);
    assert.equal(await readFile(join(path,'report.tex'),'utf8'),'Remote correction');
    let writes = 0;
    await assert.rejects(publishLocalReport({...client,put:async()=>{if(++writes===2) throw new Error('disconnect');}} as RemoteConnection,published),/disconnect/);
    assert.equal(published.report.remoteSnapshotId,id);
    assert.equal(await readFile(task.report!.texPath!,'utf8'),'Locally finished');
    await symlink(task.report!.texPath!,join(local,'link.tex'));
    await assert.rejects(publishLocalReport(client,published),/リンク/);
    assert.throws(()=>remoteReportRoot({...task,report:{...task.report!,remoteSnapshotId:'../../outside'}}),/版が不正/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
