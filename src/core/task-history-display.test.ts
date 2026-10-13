import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

async function display() {
  const source = await Promise.all(["work-outcome", "task-history"].map(name => readFile(`dist/renderer/${name}.js`, "utf8")));
  return runInNewContext(`${source.join("\n")}\n({historyInstructionLabel,historyUnitLabel,historyUnitTone,historicalRemainingWork,reportBulletItems})`);
}
test("saved prose becomes bullets without changing numeric values, paths, code or links",async()=>{
  const p=await display();
  assert.deepEqual(Array.from(p.reportBulletItems('実装した。検証した。\n・残課題なし')),['実装した。','検証した。','残課題なし']);
  assert.deepEqual(Array.from(p.reportBulletItems('**未検証です。合格ではありません。**次に確認。')),['**未検証です。合格ではありません。**次に確認。']);
  assert.deepEqual(Array.from(p.reportBulletItems('誤差は0.001。`echo 文。`を実行。[原典](https://example.com/a.b)を確認。')),['誤差は0.001。','`echo 文。`を実行。','[原典](https://example.com/a.b)を確認。']);
});
test("instruction revisions are not workflow phases", async () => {
  const p = await display();
  assert.equal(p.historyInstructionLabel(1), "最初の指示");
  assert.equal(p.historyInstructionLabel(2), "追加指示 1");
});
test("historical pending, running and ask-user are snapshots, never current queues or success", async () => {
  const p = await display();
  const pending = { state: "pending", role: "worker" };
  const retry = { ...pending, startedAt: "2026-09-30T01:00:00Z" };
  const waiting = { state: "completed", role: "planner", output: '<work-check>{"status":"ask-user","summary":"確認が必要"}</work-check>' };
  const before = JSON.stringify([pending, retry, waiting]);
  assert.equal(p.historyUnitLabel(pending), "未着手");
  assert.equal(p.historyUnitLabel(pending, true), "当時未着手");
  assert.equal(p.historyUnitLabel(retry), "再開待ち");
  assert.equal(p.historyUnitLabel(retry, true), "当時未完了");
  assert.equal(p.historyUnitLabel({ state: "running" }, true), "当時：実行中");
  assert.equal(p.historyUnitLabel(waiting), "確認を依頼");
  assert.equal(p.historyUnitLabel(waiting, true), "当時：確認を依頼");
  assert.equal(p.historyUnitTone(waiting), "awaiting-input");
  assert.equal(p.historyUnitTone(waiting, true), "archived");
  assert.equal(JSON.stringify([pending, retry, waiting]), before);
});
test("old unfinished reports do not infer current successors or resolution", async () => {
  const p = await display();
  const unit = { state: "completed", role: "worker", output: '<work-check>{"status":"needs-work","summary":"未完了","remainingWork":"測定を継続"}</work-check>' };
  assert.match(p.historicalRemainingWork(unit), /保存時点.*その後の対応状況を示すものではありません/s);
  assert.match(p.historicalRemainingWork(unit), /測定を継続/);
  assert.equal(p.historyUnitTone(unit), "needs-work");
  assert.equal(p.historyUnitTone(unit, true), "archived");
});
