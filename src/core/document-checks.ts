import type { WorkUnit } from "./types";

// Task-specific scripts remain project artifacts, not a universal TeX/PDF parser.
// Keep this requirement outside saved presets so continued tasks receive it too.
// Results use the existing evidence/concern protocol, without a new receipt gate.
export function documentCheckGuidance(unit: WorkUnit, sharedWritingRevision?: string): string {
  const boundary = unit.planPhase || unit.role === "planner" || unit.checkpointFor
    ? "計画：大量の本文・図表を書く前に、対象文書に有効な機械検査と人が意味を判断すべき項目を分ける。既存ツールを調べ、必要な小さなPython等のスクリプト、入力データ・用語辞書・検査対象、実装担当、正常/異常テスト、実行時点を既存の計画欄に含める。検査の整備・実行費用も見積もる。計画中は作成せず、許可された書き込み工程の早い段階に割り当てる。"
    : unit.role === "reviewer" || unit.mode === "read"
      ? "読み取り専用・敵対レビュー：検査コード、設定、対象一覧、データと文書の版、正常/異常テストと結果を確認する。自身ではファイル生成・更新を行わず、副作用のある検査は書き込み担当に戻す。スクリプトの合格を鵜呑みにせず、代表的な数値を元データから独立に再計算し、検査の対象外・許容誤差・読み飛ばしを点検する。不一致や重要な未確認は既存のconcernsと該当条件のfail/unverifiedへ残して修正に戻す。"
      : "実作業・執筆・仕上げ：文書に必要な検査を執筆の早い段階で整備し、既存スクリプトを優先して再利用する。データ/図表/用語/本文の変更後と最終ビルド後に影響する検査を再実行する。レポーターは文書ローカルの検査のみを補修し、欠けた実験・データはワーカーに戻す。担当範囲・所有ファイルを守り、検査のために新たな実験や権限を追加しない。";
  const heading = "# 文書の機械検査を先に整備（該当文書がある場合）";
  const incremental = "差分検証：quality_manage snapshotのrecheckで変更ファイル・依存検査と再利用可能な合格記録を確認し、影響する検査だけを再実行する。実験データ・主張・出典・検査方法の変更は必ず再確認するが、管理メタデータの不足だけで実験や全文献照合を繰り返さない。文献キー・対象データ・期待する科学的条件を小さな設定/マニフェストへ分離し、現在の文献数やPDFページ数は実ファイルから取得する。以前のページ数・文献数を検査コードに埋め込んで文書更新のたびにコードを作り直さない。PDF目視・独立レビューは引き続き必要。";
  // The caller verifies that the exact canonical checks are in the delivered
  // writing snapshot. Legacy/custom snapshots still receive the full fallback.
  if (sharedWritingRevision) return [heading, boundary, incremental,
    `検査対象・数値対応・用語辞書・異常対照・証跡・再実行の詳細は、同じ実行のwriting-rules（版 ${sharedWritingRevision}）の「数値・文献の検証」を読む。省略ではなく共通本文への参照であり、取得できなければ未確認として報告する。`
  ].join("\n");
  return [heading, boundary, incremental,
    "検査候補：①元の実験データから集計を再計算し、表のセル・図の系列/点・本文の数値・スライドを行/列/実験IDで対応づける。単位換算、丸め、有効桁、絶対/相対許容誤差を事前に明示し、欠損・NaN・重複・条件違い・未対応セルを検出する。数値がどこかに出現するだけでは一致にしない。②キーワード辞書に正規表記・許容別名・略語・定義箇所・説明の前提・明示的例外を登録し、表記揺れと定義前の使用を検出する。単なる語の出現を定義とみなさず、TeXの実際の読順と要旨/図注等の例外を扱う。③未定義/重複の図表・数式・引用ラベル、未引用図表、欠けた画像/データ、単位/百分率/速度向上率の計算、本文と図表や媒体間の矛盾、更新されていない図表を必要に応じて検査する。",
    "構成：harness-skills/document-checks/等に再利用用SKILL.md、検査スクリプト、必要なJSON/CSV設定を置く（既存の適切な場所も可）。設定には元データ・生成処理・実験条件/版・対象文書とセル/系列等の対応を記す。元データから図表を生成して手転記を減らすだけでなく、生成処理の誤りも独立に検査する。元データや期待値を文書の誤った数値に合わせて変更しない。元データが実測かどうかは一致検査だけでは証明できないため、取得条件・実行ログ・来歴も確認する。",
    "検査の信頼性：小さな既知の正常例と意図的な数値改変・定義前使用等の異常例で、検査が本当に失敗を検出するか確認する。各検査はpass/fail/unverified/not-applicableを区別し、対象件数/照合件数/除外/未検証を出す。対象ゼロ・解析失敗・画像中の数値や独自マクロ等の未対応を合格にせず、根拠付きの対象なしまたは要確認にする。曖昧な語義・説明の十分さ・ストーリー・出典の意味は機械判定で確定せず独立レビューへ渡す。許容誤差拡大や無断の除外で通さない。",
    "証跡と節約：入力データ・原稿・検査コード/設定・生成物のハッシュ等の版識別、コマンド、結果、未検証範囲を小さな検証記録へ残す。変更後に古い合格結果を流用しない。遠隔実験→ローカル組版でも実際に転送したデータ/原稿/図表の版を確認する。長いデータやログを毎回LLMへ渡さず、要約・差分・エラー箇所・ファイルパスを引き継ぐ。最終TeXだけでなく生成PDF等の反映・表示も確認する。自動検査は独立レビュー/原論文照合/PDF目視を代替しない。管理記録は主題の本文・付録に混ぜない。"
  ].join("\n");
}
