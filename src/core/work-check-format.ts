// Shared by progress validation and early negative-result detection. Keep this
// dependency-free: remote CLI result helpers receive this same implementation.
export const WORK_CHECK_ENVELOPE_LIMIT = 48_000;
export const WORK_CHECK_CORE_LIMIT = 16_000;
export interface ContentDecision {decision:"finish"|"continue";explanation:string;improvement:string;}
/** Short closing decision inside the existing receipt, not a new result type.
 * Authority/environment questions always retain their existing escape path. */
export function readContentDecision(value:unknown):ContentDecision|undefined {
  if(value===undefined)return;
  const v=value as ContentDecision;
  if(!v || typeof v!=="object" || Array.isArray(v) || Object.keys(v).some(k=>!["decision","explanation","improvement"].includes(k))
    || !["finish","continue"].includes(v.decision) || [v.explanation,v.improvement].some(s=>typeof s!=="string" || !s.trim() || s.length>1500))
    throw new Error("contentDecisionにはdecision=finish/continue、説明不足の確認explanation、改善案の採否improvementを短い日本語で記載してください。");
  return {decision:v.decision,explanation:v.explanation.trim(),improvement:v.improvement.trim()};
}
export function validateContentWorkCheck(value:any,required=false) {
  if(["ask-user","environment-blocked"].includes(value?.status))return;
  const decision=readContentDecision(value?.contentDecision);
  if(required && !decision)throw new Error("仕上げ前の終了判断contentDecisionをwork-checkへ追加してください。既存の結果を保持し、explanationとimprovementを確認してfinish/continueを選んでください。");
  if(decision?.decision==="continue" && (value.status!=="needs-work" || typeof value.remainingWork!=="string" || !value.remainingWork.trim()))
    throw new Error("追加作業を選ぶ場合はneeds-workと具体的なremainingWorkを指定してください。権限や基準を勝手に変更しないでください。");
  return decision;
}

/** Bound presentation separately from authoritative fields. This parses only
 * the envelope; it does not certify evidence, completion, or a blocker. */
export function readWorkCheckEnvelope(body: string) {
  if (body.length > WORK_CHECK_ENVELOPE_LIMIT) throw new Error("進捗確認は48,000文字以下のwork-checkブロックを1つだけ提出してください。");
  const value = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("進捗確認のJSON本体はオブジェクトにしてください。");
  const { workReport: _display, ...core } = value;
  if (JSON.stringify(core).length > WORK_CHECK_CORE_LIMIT) throw new Error("進捗確認の本体は16,000文字以下にしてください。作業内容の詳細は成果物に保存してください。");
  return value;
}
