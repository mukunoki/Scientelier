import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importLessonPdfs, readLessonPdf, validateLesson, lessonReferences, lessonSourceData, uploadLessonSources, LESSON_SKILLS } from "./paper-lesson";
import { remoteOperation } from "./remote-bridge";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkPresetStore } from "./work-presets";
import { JsonTaskStore } from "./task-store";
import { parseGoalProposal, updateGoalContract } from "./goals";
import { ReportService } from "./report-service";
import { buildWorkUnitPrompt } from "./orchestration";
import { collectWorkSkills } from "./work-skills";
import { qualitySpecs } from "./quality-profiles";
import { restartedTask } from "./task-restart";
import type { LessonPlan, TaskRecord } from "./types";

const plan: LessonPlan = { audience: "線形代数は既知、GPUは初学者", interests: "数式の意味", language: "ja", references: ["https://example.org/repo"], topics: [
  {id:"matrix",title:"行列積",reason:"提案の入力",dependsOn:[],recommended:"recap",depth:"known"},
  {id:"parallel",title:"並列計算",reason:"アルゴリズム理解に必要",dependsOn:["matrix"],recommended:"foundation",depth:"deep"}
] };
test("lesson levels validate dependency graph and require a real user selection before approval", () => {
  assert.deepEqual(validateLesson(plan, true), plan);
  for (const topics of [[], plan.topics.map(t => ({...t,depth:"known"}))]) assert.throws(() => validateLesson({...plan,topics},true));
  assert.throws(() => validateLesson({...plan,topics:[{...plan.topics[0],dependsOn:["missing"]}]}));
  assert.throws(() => validateLesson({...plan,topics:[{...plan.topics[0],dependsOn:["parallel"]},plan.topics[1]]}));
  assert.throws(() => validateLesson({...plan,topics:[plan.topics[0],plan.topics[0]]}));
  assert.throws(() => lessonReferences(["file:///etc/passwd"]));
  assert.throws(() => lessonReferences(["https://user:secret@example.org"]));
});
test("input transfer uses the existing remote managed-path protocol, deduplicates and rejects changed copies", async () => {
  const root = await mkdtemp(join(tmpdir(),"lesson-transfer-"));
  try {
    const local=join(root,"local"), remote=join(root,"remote"); await mkdir(local);await mkdir(remote);
    const pdf=join(root,"original.pdf");await writeFile(pdf,"%PDF-1.7\nOriginal paper");
    const sources=await importLessonPdfs(local,[pdf]);
    const task={cwd:local,lessonSources:sources} as TaskRecord;
    let puts=0;
    const client={request:(v:Record<string,unknown>)=>remoteOperation(remote,v),put:async(path:string,data:Buffer,exclusive?:boolean)=>{puts++;await remoteOperation(remote,{op:"put",path,data:data.toString("base64"),exclusive});}};
    await uploadLessonSources(task,client);await uploadLessonSources(task,client);assert.equal(puts,1);
    assert.equal(await readFile(join(remote,sources[0].relativePath),"utf8"),"%PDF-1.7\nOriginal paper");
    await writeFile(join(remote,sources[0].relativePath),"%PDF-1.7\nRemote edit");
    await assert.rejects(uploadLessonSources(task,client),/自動上書きしません/);assert.equal(puts,1);
    await writeFile(join(local,sources[0].relativePath),"%PDF-1.7\nLocal edit");
    await assert.rejects(lessonSourceData(task,sources[0]),/変更されています/);
  } finally {await rm(root,{recursive:true,force:true});}
});
test("bundled structural checker accepts 120 frames and detects duplicate IDs", async()=>{
  const root=await mkdtemp(join(tmpdir(),"lesson-checker-"));
  try {
    const source=Array.from({length:120},(_,i)=>`% lesson-frame: frame-${i}\n\\begin{frame}{Example ${i}}Content\\end{frame}`).join("\n");
    await writeFile(join(root,"report.tex"),source);await writeFile(join(root,"report.log"),"No warning\n");
    const run=()=>promisify(execFile)(process.execPath,[join(__dirname,"../../assets/document-templates/beamer/check-lesson.cjs"),"report.tex"],{cwd:root});
    const result=JSON.parse((await run()).stdout);assert.equal(result.frames,120);assert.deepEqual(result.problems,[]);
    await writeFile(join(root,"report.tex"),source.replace("frame-119","frame-0"));await assert.rejects(run());
  }finally{await rm(root,{recursive:true,force:true});}
});
test("paper import preserves originals, hashes bytes, rejects links and non-PDFs, handles duplicate names", async () => {
  const root = await mkdtemp(join(tmpdir(),"lesson-import-"));
  try {
    const pdf = join(root,"paper.pdf"); await writeFile(pdf,"%PDF-1.7\nexample");
    const copies = await importLessonPdfs(root,[pdf,pdf]);
    assert.notEqual(copies[0].relativePath,copies[1].relativePath); assert.equal(copies[0].sha256,copies[1].sha256);
    assert.equal(await readFile(join(root,copies[0].relativePath),"utf8"),await readFile(pdf,"utf8"));
    await symlink(pdf,join(root,"link.pdf")); await assert.rejects(readLessonPdf(join(root,"link.pdf")));
    await writeFile(join(root,"not.pdf"),"secret"); await assert.rejects(readLessonPdf(join(root,"not.pdf")));
    await assert.rejects(importLessonPdfs(root,[]));
  } finally { await rm(root,{recursive:true,force:true}); }
});
test("lesson goal proposal, approval, role routing, Beamer source and restart preserve the reader contract", async () => {
  const root = await mkdtemp(join(tmpdir(),"lesson-flow-"));
  try {
    const presets = new WorkPresetStore(join(__dirname,"../../assets/work-presets"),join(root,"presets"));
    const preset = await presets.capture("paper-explainer");
    const store = new JsonTaskStore(join(root,"tasks.json")); await store.init();
    let task = await store.create({title:"Paper lesson",prompt:"背景から説明",cwd:root,goalMode:"ai",strategy:"balanced",allowedAgentIds:["codex","claude"],modelOverrides:{},lesson:{...plan,attachmentIds:["opaque"]}},preset);
    assert.ok(task.goalPreparation); assert.equal(task.goal!.status,"draft");
    assert.doesNotMatch(task.goal!.deliverables.join("\n"),/IPSJ/);
    assert.match(buildWorkUnitPrompt(task,task.workUnits[0]),/Read the actual attached paper/);
    const proposed = {...task.goal!,lesson:plan};
    const parsed = parseGoalProposal(`<goal-draft>${JSON.stringify(proposed)}</goal-draft>`,task.goal);
    assert.equal(parsed.lesson!.topics[0].depth,"known");
    assert.throws(() => parseGoalProposal(`<goal-draft>${JSON.stringify({...proposed,lesson:undefined})}</goal-draft>`,task.goal));
    await assert.rejects(async()=>updateGoalContract(task,proposed,1,true),/論文PDF/);
    task = await store.update(task.id,{goalPreparation:false,state:"awaiting-input",lessonSources:[{name:"paper.pdf",relativePath:"inputs/1.pdf",sha256:"a".repeat(64),bytes:12}]});
    const patch = updateGoalContract(task,parsed,1,true); assert.equal(patch.goal!.status,"approved");
    task = await store.update(task.id,patch);
    const review = {...task.workUnits[0],role:"reviewer" as const,mode:"read" as const};
    const skills = collectWorkSkills(task,review);
    assert.ok(LESSON_SKILLS.every(id=>skills.some(s=>s.id===id)));
    assert.equal(new Set(skills.map(s=>s.id)).size,skills.length);
    assert.ok(qualitySpecs(task,"work").some(s=>s.id==="paper-explainer-reader"));
    assert.match(buildWorkUnitPrompt({...task,goalPreparation:false},review),/only pages up to the page/);
    const reports = new ReportService(join(__dirname,"../../assets/ipsj-tech-report/runtime"));
    const settings = {outputDirectory:join(root,"reports"),texCommand:"latexmk",texArgs:[],plotCommand:"python3",plotCheckArgs:[]};
    const report = await reports.syncDraft(task,settings);
    assert.match(await readFile(report.texPath!,"utf8"),/documentclass.*beamer/);
    assert.equal(report.documents,undefined);
    await writeFile(report.texPath!,"User edits");
    await reports.syncDraft({...task,report},settings,true);
    assert.equal(await readFile(report.texPath!,"utf8"),"User edits");
    const next = restartedTask({...task,state:"paused"},"carry",root);
    assert.deepEqual(next.goal!.lesson,plan); assert.deepEqual(next.lessonSources,task.lessonSources);
    const copy = new JsonTaskStore(join(root,"tasks.json")); await copy.init(); assert.deepEqual(copy.get(task.id)!.goal!.lesson,plan);
    // Ordinary mode never receives teaching-only skills, even from the common catalog.
    assert.ok(!collectWorkSkills({...task,workPreset:undefined,managedSkills:skills},review).some(s=>(LESSON_SKILLS as readonly string[]).includes(s.id)));
  } finally { await rm(root,{recursive:true,force:true}); }
});
