import type { CodexPermissions } from "./codex-permissions";

/** Run capability checks inside the assigned CLI, not just the host app:
 * host-side detection cannot prove that a sandboxed child can use a device. */
export function localExecutionPreflight(permissions: CodexPermissions | undefined, writable: boolean): string {
  return `\n\n# ローカル実行環境の事前確認
${permissions ? `このCodex起動のハーネス設定: ${permissions === "full-access" ? "Full access（OSサンドボックスなし）" : "工程別サンドボックスあり"}。これは起動設定であり、実際の利用成功を証明するものではありません。` : "この担当CLI自身の実行環境で確認してください。他CLIや通常ターミナルの成功は参考であり、このセッションの権限の証明ではありません。"}
本担当の作業に必要な機能だけを、実作業の前に最小の確認で調べてください。統括・計画だけの担当は実験を起動せず、この確認を実作業担当の最初の工程に含めてください。既存の確認結果は同じホスト・CLI権限・ツール環境で有効な場合に再利用し、権限変更後は再確認してください。
${writable ? "書き込み担当は作業リポジトリと別置きのレポートリポジトリでgit status・HEAD・.gitの書き込み制限を確認してください。OSやCLIが.gitを書き込み禁止にしている場合、ファイルの変更を延々と続けず、その制限と必要な復旧を報告してください。既存の変更・ステージ・ロックを破棄せず、検証済みの自分の変更だけを明示パスでコミットしてください。" : "読み取り担当は環境確認でもファイルを変更せず、Gitへの書き込み・コミットや新しい実験を行わないでください。"}
GPU/Metal等が必要な場合は、コンパイラやSDKの存在、コンパイル成功、対象デバイス取得、最小実行を別々に確認してください。機種名やsystem_profilerだけでGPUが利用可能とは判断しないでください。Metalデバイスnil、キャッシュ書き込みのOperation not permitted等は権限・実行条件の問題の可能性があり、「コンパイラ未導入」「GPU非搭載」と同一視しないでください。実行確認は本担当の許可された範囲に限ります。
失敗時は、失敗した最小コマンド・エラー・起動権限・未実施事項を短く日本語で報告し、同じ失敗の無意味な再試行を避けてください。権限の迂回・保護の解除・ソフトのインストールを自己判断で行わないでください。Full accessでもOS・組織の制限があり得ます。ハードウェア利用確認は対象実装の精度・性能・レビューの合格とは別です。`;
}
