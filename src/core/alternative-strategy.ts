import type { SubtaskSpec } from "./types";

// These contracts accompany saved work units, not only the initial planner
// prompt, so a restarted/fallback integrator still receives the comparison rule.
export function alternativeCandidateInstructions(task: SubtaskSpec): string {
  if (!task.comparison) return "";
  return `\n# 独立比較案：${task.requirements!.independenceGroup} / ${task.key}
中立な固定入力：${task.comparison.input}
共通の評価・採否基準：${task.comparison.evaluation}
今回の解法・観点：${task.comparison.approach}
他候補の出力・作業ツリー・会話・結論を参照せず、この入力から独立に作業してください。${task.inputScope === "assignment" ? "今回の入力は指示本文だけです。パスやハッシュの記載をファイル参照の許可と解釈せず、入力不足は仮定・未確認として明示します。" : "入力の版・ハッシュを確認し、取得不能や不一致を明記してください。"}自分を勝者と判定せず、成果、根拠、検査結果、弱点、未確認事項を日本語の箇条書きで提出します。比較のための許容値・必須条件の変更は禁止です。
${task.kind === "isolated-work" ? "書き込みはハーネスが用意した自分の作業ツリーのownedFilesだけです。共通コードへ反映せず、検査可能な独立案として残します。CPU/GPUやジョブの共有競合がある性能比較は、主担当が後で同じ条件で測定します。" : "読み取り専用です。解法・設計・文章案は応答で提出し、ファイル編集・実験実行は行いません。"}`;
}

export function alternativeSelectionInstructions(tasks: SubtaskSpec[]): string {
  const groups = [...new Set(tasks.filter(t => t.comparison).map(t => t.requirements!.independenceGroup!))];
  if (!groups.length) return "";
  return `\n# 独立案の比較・選択（主担当の必須統合作業）
${groups.map(group => {
    const peers = tasks.filter(t => t.comparison && t.requirements?.independenceGroup === group);
    return `比較群 ${group}：候補 ${peers.map(t => t.key).join(" / ")}\n固定入力：${peers[0].comparison!.input}\n共通評価：${peers[0].comparison!.evaluation}`;
  }).join("\n")}
全候補が揃ってから、同じ入力版・条件で成果と証拠を比較してください。完了速度・文章の自信・自己申告の点数だけで採用しません。まず必須条件を満たすか確認し、その後品質・性能・説明の明瞭さ・保守性等の計画済み基準で採否を決めます。数値比較は可能な限り共通スクリプトで再確認し、実行環境やサンプル数の差を開示します。
作業報告に比較表（候補、検査結果、長所、欠点、採用/不採用/未確認、理由、証拠）を残してください。採用、良い部分の統合、全案不採用のいずれも可能です。同点・根拠不足は明示し、不適合案を無理に採用しません。統合案は新しい成果として再検証します。既存の比較・採否記録が有効なら再利用してください。
分離実装では各diffと証拠を確認してからworkspace_manageで採用案をmergeし、不採用案は理由付きdiscardとして記録します（ファイルは保持）。競合・所有範囲・検査ゲートを迂回しないでください。案ごとの異なるファイル名から本体への反映は主担当の排他的な工程で行い、共通の回帰検査を実行します。
候補の失敗・利用枠不足・時間不足を隠さず、代替や対象を絞った比較が承認済み条件内で可能か判断してください。競争のためだけに残りの候補を強制終了しません。比較は最終独立レビューの代わりではありません。管理上の採否表を論文へ機械的に転載せず、本文には主題に必要な方法・結果・制約だけを反映します。`;
}

export function alternativePlanningGuidance(): string {
  return `# Independent alternatives / compare-and-select
Consider both division of labor and independent solutions to the SAME bounded problem (or just its uncertain part). Use competing proposals, derivations, explanations, algorithms or isolated prototypes when solution uncertainty and quality gains justify the extra tokens. Usually choose 2 candidates, at most 3; do not duplicate the whole task by default. Explain the expected benefit versus one strong agent, startup/context cost, comparison/integration time and report/review reserve. Respect actual subscription limits and the soft time target; total tokens are not a ceiling. Do not promise a wall-time gain when capacity forces serial execution.
Schema per candidate: comparison={"input":"same neutral versioned input paths/commit/hash and bounded problem","evaluation":"same predeclared required checks, quality criteria, tie/invalid-result handling","approach":"this candidate's distinct hypothesis/method/viewpoint"}, requirements={"independenceGroup":"choose_solution","modelFamilies":["openai"]}, purpose="explore", estimatedMinutes:5. A second candidate uses the SAME input/evaluation/group/criterionIds/dependsOn but a different approach and disjoint available modelFamilies, e.g. ["anthropic"]. Use only task-enabled models; if no suitable diverse pair exists, use one agent or ordinary sequential work, never invent availability or weaken launch constraints. Do not add peer dependencies or independentFrom. Create a primary-work comparison milestone depending on ALL candidates before downstream consumers, or use the mandatory final primary integration. That integration compares evidence and adopts the best valid result or verified combination; it may reject all candidates. Estimate every candidate once PLUS comparison/integration, not only the winner.
Read-only investigation candidates work in fresh blind contexts and return their alternatives without file edits. Only when allowAlternativeWork=true may candidates be isolated-work prototypes in harness-created worktrees; list disjoint ownedFiles including candidate-specific source/tests/evidence paths (for example variants/a/... versus variants/b/...). Same baseline, separate trees, no shared edits or parallel shared-resource performance measurements. This does NOT permit multiple candidates to overwrite the same production path. HPC modes currently use read-only alternative design first, then the existing verified implementation pipeline. Comparison output and rejected candidates are preserved; no automatic destructive cleanup. The final independent review remains separate.`;
}
