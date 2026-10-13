# macOSへのインストール

## 必要な環境

- Node.js 24以上とnpm（[Node.js公式](https://nodejs.org/)）。
- Apple Command Line Tools：未導入なら `xcode-select --install`。ソース取得にはGitも必要です。
- 使うAI CLIをあらかじめ導入・認証。ScientelierはCLIを同梱せず、契約も代行しません。
- TeX制作にはMacTeX等（`latexmk`, `platex`, `dvipdfmx`；Beamer教材はLuaLaTeX）。作図にはPython等、PDF描画検査には必要に応じてPoppler。遠隔制作なら遠隔にも必要です。

ElectronのOS要件は固定された依存バージョンに従います。CPUがApple SiliconかIntelかに合わせ、そのCPUのMac上でビルドしてください。自動のクロスコンパイル／Universal appは提供しません。

## ソースからインストール

リポジトリをclone、または公開用ソースを展開し、そのフォルダで：

```sh
npm run setup
```

`npm ci` → 型チェック・ビルド → IPSJ公式テンプレートの個人領域への取得 → 単独起動アプリの作成 → `~/Applications/Scientelier.app` への配置を行います。管理者権限は通常不要です。「インストール.command」のダブルクリックも同じ処理です。

既存アプリを更新する場合は、実行中作業・未保存入力を保護してScientelierを通常終了し、`npm run setup -- --replace`。同名の別アプリ、リンク、起動中のインストール先は上書きしません。以前のScientelierは `~/Applications/.scientelier-install-…/previous-Scientelier.app` に退避します。保存済み設定・タスク・CLI認証は触りません。

セットアップはモデルの呼出し、タスク実行、SSH接続、Gitへのpushを行いません。ネット接続はnpm/Electron依存の取得とIPSJ公式ダウンロードに使います。

## IPSJテンプレートとオフライン環境

IPSJ v4.1のUTF-8版を公式ZIPから取得し、SHA-256を検証して必要な9ファイルだけを個人データ領域の `templates/ipsj/` へ保存します。ZIP全体を一般公開しません。上流のZIPが変わった場合は安全のため停止し、URL・ハッシュの更新を確認します。

```sh
npm run build
npm run templates:ipsj
```

別途公式ZIPを入手済みなら：

```sh
npm run templates:ipsj -- --archive /absolute/path/ipsj_v4-1.zip
# または初回セットアップ時
npm run setup -- --ipsj-archive /absolute/path/ipsj_v4-1.zip
```

`--skip-ipsj` はテンプレート準備を後で行う場合だけ使用してください。未取得ならIPSJレポート作成時に取得手順を案内するエラーになります。Beamer・独自論文テンプレート・プリセットskillsは同梱されます。MacTeX等のインストール自体は別途必要です。

配布ZIPからアプリだけをコピーした場合もIPSJテンプレートは含まれません。ソースの `templates:ipsj` で準備してください（この制限は再配布条件未確認のため）。

## ソース起動と配布版の違い

- `npm start`：開発ソースから起動。先に `npm run build` が必要。
- `npm run app:mac -- --install-desktop`：開発フォルダを参照する従来のアイコン。開発フォルダを移動すると使えなくなります。
- `npm run package:mac`：Electron・実行コード・本番依存・標準ルールを含む単独起動版とZIPを `release/mac-…/` に作成。元の開発フォルダを移動しても使えます。
- `npm run install:mac`：依存導入済みのソースからビルド・テンプレート取得・単独起動版の配置。

配布版は開発用署名のみでApple公証は行っていません。Gatekeeperに拒否された場合は信頼できる取得元か確認し、macOSの通常の開く許可手順を使ってください。セキュリティ全体の無効化やquarantineの一括削除をインストーラは行いません。広くバイナリ配布する際はDeveloper ID署名・公証を別途準備してください。

## データ・削除・復旧

アプリの削除はScientelier.appだけを対象にします。個人データ領域、レポート、指定作業フォルダは自動削除しません。全データを消す操作は提供しません。バックアップする場合はアプリを通常終了し、個人データ領域と成果フォルダを別途保護してください。認証データの暗号化はMacのキーチェーンにも依存し、別Macへコピーしただけで復号できる保証はありません。

テスト用に `SCIENTELIER_DATA_DIR=/absolute/path/to/isolated-profile` を指定できます。ソースやアプリ内部の保存先は拒否します。新しいプロファイルは既存タスク・設定を読みません。CLIはOS側のログインを使用するので、プロファイル分離はCLI認証の隔離ではありません。
