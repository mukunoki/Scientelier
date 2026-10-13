import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { documentCheckGuidance } from "./document-checks";
import { buildWorkUnitPrompt, createStandardWorkflow } from "./orchestration";
import { WritingRulesStore, finishingPrompt } from "./finishing-skill";
import type { TaskRecord } from "./types";

function task(): TaskRecord {
  return { id: "document-checks", title: "Report", prompt: "Write a report from experiment data", cwd: "/tmp/project",
    strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, workUnits: createStandardWorkflow(),
    runs: [], state: "paused", createdAt: "", updatedAt: "", output: "" };
}

test("document check planning reaches old tasks without changing goals or introducing submission schemas", () => {
  const t = task(), before = JSON.stringify(t);
  for (const unit of t.workUnits) assert.match(buildWorkUnitPrompt(t, unit), /文書の機械検査を先に整備/);
  const planning = documentCheckGuidance({ ...t.workUnits[1], primary: true, planPhase: true });
  assert.match(planning, /大量の本文・図表を書く前/);
  assert.match(planning, /計画中は作成せず/);
  assert.match(planning, /正常\/異常テスト/);
  assert.doesNotMatch(planning, /<document-check>|<editorial-check>/);
  assert.doesNotMatch(buildWorkUnitPrompt({ ...t, goalPreparation: true }, t.workUnits[0]), /# 文書の機械検査/);
  assert.equal(JSON.stringify(t), before);
});

test("numeric provenance, term order, coverage and stale output checks preserve review boundaries", () => {
  const t = task(), writing = documentCheckGuidance(t.workUnits[1]);
  for (const phrase of ["行/列/実験ID", "絶対/相対許容誤差", "欠損・NaN・重複", "定義箇所・説明の前提", "単なる語の出現を定義とみなさず", "pass/fail/unverified/not-applicable", "対象ゼロ・解析失敗", "意図的な数値改変", "版識別", "古い合格結果を流用しない", "実測かどうかは一致検査だけでは証明できない", "自動検査は独立レビュー/原論文照合/PDF目視を代替しない"]) assert.ok(writing.includes(phrase), phrase);
  const review = documentCheckGuidance(t.workUnits[2]);
  assert.match(review, /自身ではファイル生成・更新を行わず/);
  assert.match(review, /元データから独立に再計算/);
  assert.match(review, /既存のconcerns/);
  assert.match(documentCheckGuidance(t.workUnits[3]), /欠けた実験・データはワーカーに戻す/);
});

test("editable verification rules are distributed once for all media and final build", async () => {
  const root = await mkdtemp(join(tmpdir(), "document-check-rules-"));
  try {
    const store = new WritingRulesStore(join(process.cwd(), "assets/finishing-skills"), root);
    const common = await store.get("common"), verification = await store.get("verification"), captured = await store.capture();
    assert.ok(verification.current.rules.length < 16000);
    assert.ok(!common.current.rules.includes("## 執筆前の検証スクリプト整備"), "shared principles do not duplicate detailed checks");
    assert.equal(captured.rules.split(verification.current.rules).length, 2);
    for (const phrase of ["執筆前の検証スクリプト整備", "論文・レポート・ポスター・スライド", "元の実験データから独立に集計", "正常例だけでなく", "用語辞書", "未定義参照", "最終ビルド後", "harness-skills/document-checks/", "本文・付録には管理記録ではなく"]) {
      assert.ok(verification.current.rules.includes(phrase), phrase);
      assert.ok(finishingPrompt(task(), captured).includes(phrase), phrase);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
