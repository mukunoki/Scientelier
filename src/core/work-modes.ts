import { randomUUID } from "node:crypto";
import type { WorkFocus, WorkUnit } from "./types";

// Captured metadata, not ID-based migration: old tasks keep their original scope.
const scope: Record<WorkFocus, string> = {
  "paper-explainer": "論文解説教材：原論文に忠実に、ユーザー指定の前提知識から背景・従来法・提案・数式・実験・限界を積み上げて説明する。成果は読むためのBeamer TeX/PDF。発表用の枚数・時間制限は設けず、100ページ以上も許容する。新規研究やリポジトリのコード実行へ無断で広げない。",
  research: "統合研究：着想検討 → 関連研究調査 → 実装・評価 → 論文執筆。初期の着想は仮説であり、新規性や成功の証拠ではない。各段階で根拠・反例・実現可能性を確認し、必要なら着想と計画を見直す。主担当は各段階の成果・検証方法を計画し、実作業とTeXへの統合を担う。",
  idea: "着想検討に専念する。候補・仮説・期待する貢献・既知の関連研究との違い・反証条件・最小の検証案を比較する。必要な範囲の先行例確認は行うが、網羅的調査・実装・実験実行・論文執筆には自動で進まない。成果は着想検討の技術レポート（TeX/PDF）のみ。",
  literature: "関連研究調査に専念する。一次資料に基づき研究領域・手法・条件・限界・未解決の問題を比較整理する。資料確認に必要な範囲を除き実装や実験は行わず、新たな研究の遂行や論文執筆へ自動で進まない。成果は関連研究の調査技術レポート（TeX/PDF）のみ。",
  implementation: "コーディング（実装）に専念する。仕様・既存コードを確認し、実装・デバッグ・テストを行う。必要な技術資料の確認は行うが、網羅的な関連研究調査・新規研究の立案・学術論文の執筆へ自動で進まない。成果はコードと検証証拠、および設計・変更点・検証結果の技術レポート（TeX/PDF）。論文用の新規性・関連研究章は要求しない。",
  paper: "論文執筆に専念する。提供済みの研究成果・データ・コード・文献から構成・本文・図表・引用を仕上げる。引用確認や既存データの可視化は行うが、新しい実装・実験・研究全体のやり直しを自動で始めない。根拠不足は明示してユーザーに追加資料・別工程を求め、結果を創作しない。",
  poster: "承認された既存の研究成果をポスターとして構成・可視化する。新たな研究遂行に無断で範囲を広げない。"
};

export function workModePrompt(focus?: WorkFocus, ideaApproach?: "experimental"): string {
  const selected = focus === "idea" && ideaApproach === "experimental"
    ? "着想探索と実証に専念する。同じ承認済み課題に対する複数の方法・組合せを探索し、小規模な実装・実機での予備評価・反証実験で比較して最も有望な候補を絞る。書き込み禁止モードではない。主担当は承認された作業場所で試作コード・実測結果・TeXを作成できる。読取専用の計画・専門担当・レビューの権限は変更しない。本格的な製品実装・大規模評価・投稿論文へは自動で広げない。"
    : focus ? scope[focus] : "";
  return focus ? `# Selected mode scope\n${selected}\nこの作業範囲をゴール設計・計画・作業・検証・執筆の全工程に適用する。編集済みのルールやゴールと範囲が矛盾する場合はユーザーに確認し、無断で範囲を拡大しない。各専用モードでは対象外の工程がないことを欠陥扱いしない。` : "";
}

export const ideaGuidance = "You own the initial, read-only ideation phase, not the implementation plan or execution. Compare a few plausible ideas (or critically assess the user's fixed idea without replacing it). Identify the research question, testable hypothesis, possible contribution, known alternatives, feasibility, risks, rejection conditions and smallest useful verification. Inspect available evidence and a bounded set of sources; do not perform an exhaustive literature survey. Mark novelty and feasibility as provisional until verified. Respect the approved topic and constraints. Return a concise subject-focused handoff with a recommended idea, rejected alternatives/reasons and unresolved questions. The primary owner must use this handoff when planning, investigate uncertainty and request user input before executing if authority or scope is unresolved. Do not edit files, write TeX, implement, run experiments, submit jobs or start other agents. The harness saves this handoff; the primary owner incorporates verified subject content into TeX. This phase is not acceptance of the full goal. Keep it a small fraction of the total time/token estimate, preserving execution, PDF and review capacity.";

export function createIdeaPhase(): WorkUnit {
  return { id: randomUUID(), role: "planner", mode: "read", ideaPhase: true,
    title: "着想検討 · アイディアと検証方針", instructions: "研究課題に対する着想・仮説・代替案を比較し、推奨案と反証条件、最小の検証方針を主担当へ引き継ぐ。\n" + ideaGuidance,
    state: "pending", dependsOn: [], attemptedAgentIds: [] };
}
