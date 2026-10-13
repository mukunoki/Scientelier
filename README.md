# Scientelier

複数AIのCLIを使う、macOS向けの研究開発ワークスペースです。強い主担当が研究・実装を継続し、他のAIへ調査、代案、分担作業、独立レビューを依頼します。サービスの使用枠を監視し、利用できなくなったCLIからの引き継ぎを支援します。

公開リポジトリ：[mukunoki/Scientelier](https://github.com/mukunoki/Scientelier)。

## 主な機能

- コーディング、研究、着想探索、関連研究調査、論文・ポスター、Beamerによる論文解説。
- Codex、Claude Code、Antigravity CLI、OpenCode（Z.AI／Ollama等）。各CLIの導入・契約・認証は別途必要です。
- CLI原画面の操作、作業計画・依存グラフ、履歴、成果と検証、PDFプレビュー。
- SSH先の作業、任意のスケジューラの使い方を記したテキスト、tmuxによる遠隔端末保持。
- 編集可能なプリセットskillsと執筆ルール。タスクは使用するルールの保存版を保持します。

使用枠やモデル情報はサービスが実際に提供する範囲で取得します。不明な残量を十分あると扱ったり、タスクの終了だけで研究結果を合格にしたりはしません。

## インストール

必要なもの：macOS、Node.js 24以上、Apple Command Line Tools。TeX/PDF制作にはMacTeX等、遠隔での制作には遠隔側のTeX環境が必要です。

ソースを取得したフォルダで実行します：

```sh
npm run setup
```

依存関係・実行コード・公式IPSJテンプレートを準備し、`~/Applications/Scientelier.app` を作成します。Finderからダブルクリックして起動できます。既存アプリの更新は `npm run setup -- --replace`（通常終了後に実行）。ソース一式の「インストール.command」も利用できます。

[詳しいインストール・更新・削除手順](docs/installation.md)を参照してください。配布版は元のソースフォルダなしで起動できますが、AIのCLI、TeX、ユーザー設定、実験データは同梱しません。現在は開発用署名で、Appleによる公証済みの配布版ではありません。

## 最初の使い方

1. 「サービス」で利用するCLI・モデルを選び、各CLIのログイン状態と使用枠を確認します。
2. 「新しいタスク」で作業ディレクトリ・モード・目的・時間の目安を指定します。
3. AIのゴール案を確認・承認して実行します。端末、担当、成果、レポートをタスク内で確認します。

遠隔で作業する場合は接続先を登録し、端末で必要な追加SSH・環境設定・移動を済ませてから接続を確定します。施設の利用規約とジョブ実行ルールを守ってください。

**権限に注意：** 標準設定にはFull accessやCLIの操作承認省略が含まれます。専用の作業ディレクトリ・最小権限のアカウントを用い、機密情報のある環境では設定を確認してください。役割の「読み取りのみ」という指示はOSの隔離と同じではありません。[安全性とデータの扱い](SECURITY.md)。

## データと公開用ソースの分離

| 保存するもの | 既定の場所 |
|---|---|
| アプリのコード・標準skills・執筆ルール | このリポジトリ／配布アプリ |
| 個人設定・タスク・使用枠・カスタムskills・診断ログ | `~/Library/Application Support/agent-harness/` |
| TeX・PDF・成果・作業ログ | `~/Documents/Agent Harness Reports/` と指定した作業場所 |
| CLIの認証・SSH鍵 | 各CLIとOSが管理するユーザー領域 |

内部データ名は旧版との互換性のため維持します。アプリの更新で既存データを移動・削除しません。`SCIENTELIER_DATA_DIR` にソース外の絶対パスを指定すると独立したプロファイルを使えます（初期のレポート保存先もその配下）。既存プロファイルの自動コピーはしません。

公開前には `npm run public:check`、履歴も確認する場合は `npm run public:check -- --history`。`npm run public:export` は許可した追跡ファイルだけを `release/source-…/` に書き出し、個人データとGit履歴を含めません。書き出しは公開・アップロードを実行しません。[公開準備と確認事項](docs/publication.md)。

## 開発・配布

```sh
npm ci
npm run build
npm test
npm run test:distribution
npm run package:mac
```

`package:mac` は現在のMacのCPU向けに単独起動版とZIPを `release/mac-…/` に作ります。`npm start` はソースから起動、`npm run app:mac` は開発フォルダを参照する従来のランチャーです。配布版と混同しないでください。

[操作・実行仕様](docs/user-guide.md) · [コード構成](docs/architecture.md) · [インストール](docs/installation.md) · [公開準備](docs/publication.md)

## ライセンス

Scientelierのオリジナルコード・著者提供プリセットは[MIT](LICENSE)。第三者由来のルールと依存ライブラリは[個別のライセンス・表示](THIRD_PARTY_NOTICES.md)に従います。IPSJ原配布は再配布許諾が明示されていないため公開用ソース・アプリから除き、インストール時に公式配布を取得します。
