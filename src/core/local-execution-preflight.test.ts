import test from "node:test";
import assert from "node:assert/strict";
import { localExecutionPreflight } from "./local-execution-preflight";

test("local capability checks distinguish launch permissions, device access and scientific verification", () => {
  const write = localExecutionPreflight("full-access", true);
  assert.match(write, /Full access（OSサンドボックスなし）/);
  assert.match(write, /書き込み担当は/);
  assert.match(write, /Metalデバイスnil/);
  assert.match(write, /精度・性能・レビューの合格とは別/);
  assert.match(write, /統括・計画だけの担当は実験を起動せず/);
  assert.match(write, /権限変更後は再確認/);
  const read = localExecutionPreflight("sandbox", false);
  assert.match(read, /工程別サンドボックスあり/);
  assert.match(read, /新しい実験を行わない/);
  assert.doesNotMatch(read, /書き込み担当は/);
  const other = localExecutionPreflight(undefined, true);
  assert.doesNotMatch(other, /このCodex起動/);
  assert.match(other, /他CLIや通常ターミナルの成功は参考/);
});
