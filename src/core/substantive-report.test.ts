import test from "node:test";
import assert from "node:assert/strict";
import { readSubstantiveReport, substantiveReportGuidance } from "./substantive-report";
import { parseWorkCheck } from "./work-guidance";
import { createExecutionWorkflow, buildWorkUnitPrompt } from "./orchestration";
import type { TaskRecord } from "./types";
test("subject report validates bounded findings without claiming acceptance",()=>{
  const report=readSubstantiveReport({proposals:["方式AとBを比較"],activities:["固定条件で測定"],results:["Aは小規模で高速"],interpretation:["大規模では転送が支配的"],nextSteps:["転送を削減"],issues:["大規模条件は未確認"]});
  assert.equal(report?.results[0],"Aは小規模で高速");
  for(const bad of [null,[],{results:[false]},{results:Array(13).fill("x")},{results:["x".repeat(1601)]},{passed:true}])assert.equal(readSubstantiveReport(bad),undefined);
  assert.match(substantiveReportGuidance,/implementation defect/);
});
test("optional report cannot block legacy results or replace valid work evidence",async()=>{
  const task:TaskRecord={id:"t",title:"研究",prompt:"研究",cwd:"/tmp",strategy:"balanced",allowedAgentIds:["codex"],modelOverrides:{},workUnits:createExecutionWorkflow({}),runs:[],state:"running",createdAt:"",updatedAt:"",output:""};
  const check={status:"needs-work",summary:"実装を検証した",remainingWork:"境界条件を修正",estimatedRemainingMinutes:10,evidence:[]};
  const parse=(v:unknown)=>parseWorkCheck(`<work-check>${JSON.stringify(v)}</work-check>`,task);
  assert.equal((await parse(check)).workReport,undefined);
  assert.equal((await parse({...check,workReport:{results:["境界条件で失敗"]}})).workReport?.results[0],"境界条件で失敗");
  assert.equal((await parse({...check,workReport:{results:123}})).workReport,undefined);
  const longReport={activities:Array(12).fill("測定".repeat(700))};
  assert.ok(JSON.stringify(longReport).length>16000);
  assert.equal((await parse({...check,workReport:longReport})).workReport?.activities.length,12);
  assert.equal((await parse({...check,workReport:{results:["x".repeat(20000)]}})).workReport,undefined);
  await assert.rejects(parse({...check,summary:"x".repeat(16000)}),/本体/);
  await assert.rejects(parse({...check,status:"ready",remainingWork:"",workReport:{results:["成功を主張"]}}),/成果物/);
  assert.match(buildWorkUnitPrompt(task,task.workUnits[0]),/not a compliance diary/);
});
