import type { CriterionEvaluation } from "./types";

export interface ReviewContract { goalRevision: number; criterionIds: string[]; requireConcerns: boolean; }
export class ReviewFormatError extends Error {}
function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || value.length > 8000 || (!empty && !value.trim())) throw new ReviewFormatError(`レビューの${label}が不正です。`);
  return value.trim();
}

// Shared by the submission tool and the final workflow gate. No filesystem or
// Electron dependencies: the same validator also runs on the SSH destination.
export function validateReviewFormat(output: string, contract: ReviewContract) {
  const blocks = [...output.matchAll(/<goal-evaluation>([\s\S]*?)<\/goal-evaluation>/g)];
  if (blocks.length !== 1 || blocks[0][1].length > 40000) throw new Error("構造化レビューを取得できません。達成とは判定せず確認待ちにします。");
  let value: any;
  try { value = JSON.parse(blocks[0][1]); }
  catch { throw new ReviewFormatError("レビューのJSON構文を修正してください。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewFormatError("レビューはJSONオブジェクトで提出してください。");
  if (contract.requireConcerns && (!Array.isArray(value.concerns) || value.concerns.length > 20 || value.concerns.some((c: unknown) => typeof c !== "string" || !c.trim() || c.length > 2000))) throw new ReviewFormatError("レビューの追加検討事項 concerns を配列で明示してください（なしの場合は空配列）。");
  if (value.goalRevision !== contract.goalRevision || !Array.isArray(value.criteria) || value.criteria.length !== contract.criterionIds.length || !["repair", "ask-user"].includes(value.nextAction)) throw new ReviewFormatError("レビューのゴール版・条件一覧・次の動作が不正です。");
  const ids = new Set<string>();
  const criteria: CriterionEvaluation[] = value.criteria.map((item: any) => {
    if (!item || !contract.criterionIds.includes(item.criterionId) || ids.has(item.criterionId) || !["pass", "fail", "unverified"].includes(item.status) || !Array.isArray(item.evidence) || item.evidence.length > 10) throw new ReviewFormatError("レビュー条件が重複・不足または不正です。");
    ids.add(item.criterionId);
    const evidence = item.evidence.map((e: any) => ({ path: text(e?.path, "根拠ファイル"), detail: text(e?.detail, "検証内容") }));
    return { criterionId: item.criterionId, status: item.status === "pass" && !evidence.length ? "unverified" : item.status, detail: text(item.detail, "説明"), evidence };
  });
  if (new Set(criteria.flatMap(c => c.evidence.map(e => e.path))).size > 40) throw new ReviewFormatError("根拠ファイルが多すぎます。");
  const repairInstructions = text(value.repairInstructions, "修正指示", true);
  if (value.reportCorrections !== undefined && (!Array.isArray(value.reportCorrections) || value.reportCorrections.length>8
    || value.reportCorrections.some((v:unknown)=>typeof v!=="string" || !v.trim() || v.length>1000))) throw new ReviewFormatError("原稿だけの修正はreportCorrectionsに1000文字以内で8件まで指定してください。");
  return { goalRevision: value.goalRevision as number, criteria, nextAction: value.nextAction as "repair" | "ask-user",
    repairInstructions, summary: text(value.summary, "要約"),
    ...(value.reportCorrections!==undefined ? {reportCorrections:value.reportCorrections.map((v:string)=>v.trim()) as string[]} : {}),
    ...(contract.requireConcerns ? { concerns: [...new Set([...value.concerns, ...(value.reportCorrections??[]), ...(repairInstructions ? [repairInstructions] : [])])] as string[] } : {}) };
}
