import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureEditorialSnapshot, editorialSnapshotMatches, reusableEditorialRun, editorialReusePrompt, editorialFreshness } from "./editorial-reuse";
import type { TaskRecord, FinishingCheck } from "./types";

test("editorial reuse requires identical recorded inputs, PDFs, scope and rules, not a previous scientific pass",async()=>{
  const root=await mkdtemp(join(tmpdir(),"harness-editorial-reuse-"));
  try {
    const work=join(root,"work"),report=join(root,"report");await mkdir(work);await mkdir(report);
    const tex=join(report,"report.tex"),pdf=join(report,"report.pdf"),fig=join(report,"figure.png"),bib=join(report,"refs.bib"),fls=join(report,"report.fls");
    await writeFile(tex,"Subject\\bibliography{refs}");await writeFile(pdf,"%PDF-1.7 fixture");await writeFile(fig,"figure");await writeFile(bib,"reference");
    await writeFile(fls,`PWD ${report}\nINPUT report.tex\nINPUT figure.png\n`);
    const t={cwd:work,goal:{revision:1},roundNumber:2,report:{texPath:tex,pdfPath:pdf},runs:[]} as unknown as TaskRecord;
    const check:FinishingCheck={revision:"rules",status:"completed",summary:"All pages checked",sources:[tex],concerns:[],prerequisites:["Original publisher source unavailable"]};
    const originalBuildCutoff="2026-10-03T01:00:00.000Z";
    const snapshot=(await captureEditorialSnapshot(t,check,originalBuildCutoff))!;assert.ok(snapshot);
    assert.equal(await editorialSnapshotMatches(t,snapshot,"rules"),true);
    assert.ok(snapshot.files.some(f=>f.path===bib),"bibliography included even when TeX recorder omits it");
    const run={id:"previous",role:"reporter",goalRevision:1,finishingCheck:check,editorialSnapshot:snapshot} as any;
    t.runs=[run];assert.equal((await reusableEditorialRun(t,"rules"))?.id,"previous");
    assert.equal(editorialFreshness({...run,startedAt:"2026-10-03T02:00:00.000Z"}),originalBuildCutoff,"repeated reuse does not advance the PDF freshness cutoff");
    assert.match(editorialReusePrompt(run),/NOT scientific acceptance/);
    assert.match(editorialReusePrompt(run),/prerequisite/);
    assert.equal(await editorialSnapshotMatches({...t,roundNumber:3},snapshot,"rules"),false);
    assert.equal(await editorialSnapshotMatches({...t,goal:{...t.goal!,revision:2}},snapshot,"rules"),false);
    assert.equal(await editorialSnapshotMatches(t,snapshot,"changed"),false);
    for(const path of [tex,pdf,fig,bib]) {
      const original=path===tex?"Subject\\bibliography{refs}":path===pdf?"%PDF-1.7 fixture":path===fig?"figure":"reference";
      await writeFile(path,"changed");assert.equal(await editorialSnapshotMatches(t,snapshot,"rules"),false);
      await writeFile(path,original);
    }
    assert.equal(await captureEditorialSnapshot(t,{...check,status:"blocked"}),undefined);
    assert.equal(await captureEditorialSnapshot(t,{...check,concerns:["layout defect"]}),undefined);
    assert.equal(await captureEditorialSnapshot({...t,remote:{} as any},check),undefined);
    const extra=join(work,"other-slides.tex");await writeFile(extra,"Other document");
    assert.equal(await captureEditorialSnapshot(t,{...check,sources:[tex,extra]}),undefined,"unregistered standalone PDFs are not covered by the recorder");
    await rm(fig);await symlink(bib,fig);
    assert.equal(await editorialSnapshotMatches(t,snapshot,"rules"),false,"changed symlink cannot reuse previous figure evidence");
    await rm(fls);assert.equal(await captureEditorialSnapshot(t,check),undefined,"no recorder means fresh checks, not guessed dependencies");
  } finally {await rm(root,{recursive:true,force:true});}
});
