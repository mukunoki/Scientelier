import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkUnitPrompt, createStandardWorkflow } from "./orchestration";
import { relatedResearchGuidance } from "./related-research";
import type { TaskRecord } from "./types";

function task(): TaskRecord {
  return { id: "research-review", title: "Related work", prompt: "Write an accurate related-work section", cwd: "/tmp/project",
    strategy: "balanced", allowedAgentIds: ["codex", "claude"], modelOverrides: {}, workUnits: createStandardWorkflow(),
    runs: [], state: "paused", createdAt: "", updatedAt: "", output: "", reviewPolicy: "adversarial-pair",
    goal: { revision: 1, status: "approved", updatedAt: "", objective: "Correct related work", deliverables: ["Report"],
      criteria: [{ id: "report", description: "Accurate report", verification: "Primary sources", required: true }], constraints: [], outOfScope: [], questions: [] }
  };
}

test("planning, writing and finishing require semantic source checks even without new preset snapshots", () => {
  const t = task();
  for (const u of t.workUnits) {
    const prompt = buildWorkUnitPrompt(t, u);
    assert.match(prompt, /関連研究の内容忠実性チェック/);
    assert.match(prompt, /書誌情報とは別/);
    assert.match(prompt, /原論文本文・図表・数式・実験設定・補足資料/);
    assert.match(prompt, /本文未取得や曖昧さは未確認/);
    assert.match(prompt, /紹介した研究がない場合は対象なし/);
  }
  assert.match(relatedResearchGuidance(t.workUnits[0]), /計画：/);
  assert.match(relatedResearchGuidance(t.workUnits[1]), /紹介文を書く前と修正後/);
  assert.match(relatedResearchGuidance(t.workUnits[3]), /後続レビューの未実施だけを理由に待機しない/);
});

test("both sequential and cross-service review waves independently check claims and return concrete concerns", () => {
  const t = task(), reviewer = t.workUnits[2];
  for (const crossReview of [undefined, { wave: 1 as const, providerKey: "openai", sourceUnitIds: [] }, { wave: 2 as const, providerKey: "anthropic", sourceUnitIds: [] }]) {
    const prompt = buildWorkUnitPrompt(t, { ...reviewer, crossReview });
    for (const expected of ["敵対レビュー：", "全主要主張を照合", "自ら原論文", "concerns", "fail/unverified", "nextAction=repair", "読み取り専用を守り", "条件の異なる性能値の単純比較", "限定的結果の一般化", "提案と実証の混同"]) assert.ok(prompt.includes(expected), expected);
    assert.match(prompt, /Mandatory independent review/);
  }
});
