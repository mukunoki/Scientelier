import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SkillStore,skillStoreOperation} from "./skill-store";
import {remoteOperation} from "./remote-bridge";
const content=(id:string,body="Original instructions")=>`---\nname: ${id}\ndescription: Check specific inputs\n---\n\n${body}\n`;
test("skill registration, evidence-backed adoption, changed-body reset, external edits and version restore",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"managed-skills-"));
  try{
    const store=new SkillStore(join(dir,"harness-skills"));
    assert.deepEqual(await store.list(),{skills:[],errors:[]});
    let skill=await store.save({id:"checks",revision:"",content:content("checks"),status:"validated",evidence:""});
    assert.equal(skill.status,"experimental");
    await assert.rejects(store.save({...skill,status:"validated"}),/証拠/);
    const v1=skill.revision;
    skill=await store.save({...skill,status:"validated",evidence:"normal/failure/out-of-scope tests passed: tests/checks.txt"});
    assert.equal(skill.status,"validated");
    await assert.rejects(store.save({...skill,revision:v1}),/別の変更/);
    const adopted=skill;
    skill=await store.save({...skill,content:content("checks","Changed"),status:"validated"});
    assert.equal(skill.status,"experimental");
    assert.ok((await store.history("checks")).some(s=>s.revision===adopted.revision && s.content===adopted.content));
    await writeFile(skill.path,content("checks","External edit"));
    const changed=(await store.get("checks"))!;
    assert.equal(changed.status,"experimental");assert.notEqual(changed.revision,skill.revision);
    await assert.rejects(store.save(skill),/別の変更/);
    const restored=await store.save({...changed,content:adopted.content,status:"validated",evidence:adopted.evidence});
    assert.equal(restored.status,"experimental","restoring an old body needs revalidation");
    const results=await Promise.allSettled([store.save({...restored,status:"retired"}),store.save({...restored,status:"validated"})]);
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal((await store.get("checks"))!.status,"retired");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("bundled rules are overridden without modifying assets; imports and bad files are isolated",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"managed-builtins-"));
  try{
    const builtin=join(dir,"assets");await mkdir(join(builtin,"checks"),{recursive:true});await writeFile(join(builtin,"checks","SKILL.md"),content("checks"));
    const store=new SkillStore(join(dir,"work-skills"),builtin);
    const initial=(await store.get("checks"))!;assert.equal(initial.status,"validated");assert.equal(initial.builtin,true);
    await store.save({...initial,content:content("checks","override")});
    assert.equal(await readFile(join(builtin,"checks","SKILL.md"),"utf8"),content("checks"));
    assert.ok((await store.history("checks")).some(s=>s.revision===initial.revision));
    await mkdir(join(store.root,"imported"));await writeFile(join(store.root,"imported","SKILL.md"),content("imported"));
    assert.equal((await store.get("imported"))!.status,"experimental");
    await symlink(join(builtin,"checks"),join(store.root,"linked"));
    const list=await store.list();assert.equal(list.skills.length,2);assert.equal(list.errors.length,1);
    for(const id of ["../checks","script-reuse","writing-rules","a/b","--bad"])await assert.rejects(store.get(id));
    await assert.rejects(store.save({id:"bad",revision:"",content:content("different"),status:"experimental",evidence:""}));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("SSH skill operations use a fixed workspace root and the same store semantics",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"remote-skills-"));
  try{
    const taskId="a1111111-1111-1111-1111-111111111111";
    const runtime=join(dir,".agent-harness",taskId);await mkdir(runtime,{recursive:true});
    await writeFile(join(runtime,"skills-runtime.js"),await readFile(join(__dirname,"skill-store.js")));
    const req={op:"skills",taskId,action:"save",value:{id:"remote-check",revision:"",content:content("remote-check"),status:"experimental",evidence:""}};
    const saved=await remoteOperation(dir,req) as any;
    assert.equal(saved.status,"experimental");
    const list=await remoteOperation(dir,{op:"skills",taskId,action:"list"}) as any;
    assert.equal(list.skills[0].content,content("remote-check"));
    await assert.rejects(remoteOperation(dir,{...req,taskId:"../bad"}));
    await assert.rejects(skillStoreOperation(join(dir,"harness-skills"),"execute","command"));
  }finally{await rm(dir,{recursive:true,force:true});}
});
