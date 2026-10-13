import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("decision presentation exposes the actual question, not accomplishments or stale asks", async () => {
  const source=await readFile("dist/renderer/work-outcome.js","utf8");
  const present=runInNewContext(`${source}\ntaskUserDecision`);
  const value={status:"ask-user",summary:"Long progress report",remainingWork:"numerical_specificationの条件を改訂するか。代案は未達として残す。"};
  const unit={role:"worker",state:"completed",output:`<work-check>${JSON.stringify(value)}</work-check>`};
  const task={state:"awaiting-input",error:"ユーザ確認が必要です。Long report",workUnits:[unit]};
  assert.match(present(task).reason,/合格条件/);assert.equal(present(task).question,value.remainingWork);
  assert.equal(present({...task,state:"running"}),undefined);
  assert.equal(present({...task,error:"SSH disconnected"}),undefined);
  assert.equal(present({...task,workUnits:[unit,{...unit,output:unit.output.replace("ask-user","ready")}]}),undefined);
  const decision={reason:"Exact reason",question:"Exact question",options:["A","B"]};
  const next={...task,workUnits:[{...unit,output:`<work-check>${JSON.stringify({...value,userDecision:decision})}</work-check>`}]};
  assert.equal(JSON.stringify(present(next)),JSON.stringify(decision));
});

test("unfinished work is a completed response, not proof of transfer or resolution", async () => {
  const source = await readFile("dist/renderer/work-outcome.js", "utf8");
  const v = runInNewContext(`${source}\n({unitStatusLabel, runStatusLabel, unfinishedWorkExplanation})`);
  const unit = { id: "a", role: "worker", state: "completed", dependsOn: [], output: '<work-check>{"status":"needs-work","summary":"調査終了","remainingWork":"数値を再確認"}</work-check>' };
  const task = { workUnits: [unit], retiredWorkUnits: [] };
  assert.equal(v.unitStatusLabel(task, unit), "担当終了・未完了報告");
  assert.match(v.unfinishedWorkExplanation(task, unit), /引き継ぎ先を確認できません/);
  assert.match(v.unfinishedWorkExplanation(task, unit), /数値を再確認/);
  task.workUnits.push({ id: "b", title: "再検証", dependsOn: ["a"], assignedAgentId: "codex", state: "pending" } as any);
  assert.match(v.unfinishedWorkExplanation(task, unit), /再検証（待機・codex）/);
  assert.match(v.unfinishedWorkExplanation(task, unit), /済んだことを意味しません/);
  assert.equal(v.unfinishedWorkExplanation(task, { ...unit, state: "running" }), undefined);
  assert.equal(v.unfinishedWorkExplanation(task, { ...unit, output: unit.output.replace('needs-work', 'ready') }), undefined);
  assert.equal(v.runStatusLabel({ workUnits: [], retiredWorkUnits: [unit] }, { state: "completed", workUnitId: "a" }), "担当終了・未完了報告");
});

test("repair cards show concerns even with no unmet criteria, without changing instructions", async () => {
  const source = await readFile("dist/renderer/work-outcome.js", "utf8");
  const present = runInNewContext(`${source}\nrepairWorkPresentation`);
  const task = { goal: { criteria: [{ id: "a", description: "正しい境界値の結果" }] } };
  const instructions = (missing: string, concerns: string) => `Repair ONLY these unmet required conditions: ${missing}\nFurther required investigation within the approved goal: ${concerns}\nReviewer instructions: 境界値を検証する\n追加の根拠を確認する\nPreserve already passing behavior, scope and the approved goal. More internal instructions`;
  const unit = { role: "worker", primary: true, instructions: instructions("[]", '["境界値の追加確認が必要"]') };
  const before = JSON.stringify(unit);
  const result = present(task, unit);
  assert.match(result.work, /追加検討事項を調査/);
  assert.match(result.conditions, /未達なし/);
  assert.match(result.concerns, /境界値の追加確認が必要/);
  assert.match(result.instructions, /境界値を検証する\n追加の根拠を確認する/);
  assert.doesNotMatch(JSON.stringify(result), /Repair ONLY|Preserve already|\[\]/);
  assert.equal(JSON.stringify(unit), before);
  const failed = present(task, { ...unit, instructions: instructions('[{"criterionId":"a","detail":"負値で不一致"}]', '[]') });
  assert.match(failed.work, /未達の必須条件/); assert.match(failed.conditions, /正しい境界値の結果/); assert.match(failed.conditions, /負値で不一致/);
  const broken = present(task, { ...unit, instructions: instructions("broken", "null") });
  assert.match(broken.conditions, /詳細指示/); assert.match(broken.concerns, /詳細指示/);
  assert.equal(present(task, { ...unit, instructions: "通常の作業指示" }), undefined);
  assert.equal(present(task, { ...unit, role: "reviewer" }), undefined);
});
