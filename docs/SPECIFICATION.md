# Scientelier（旧称Agent Harness）MVP要求仕様書

- 文書版: 0.4-multi-agent-workflow-mvp
- 更新日: 2026-09-11
- 対象: macOS上で複数のAI CLIをまとめて扱う単一ユーザー向けアプリ
- 方針: 少ない構成要素で実用になるものを先に作る

## 1. 目的

Claude Code、Codex、Gemini CLI、OpenCode等を一つのGUIから起動し、作業の割当、結果の受渡し、相互レビュー、利用量確認を行う。

ローカル作業に加え、登録した遠隔システムへ一度SSHログインし、そのセッション内でAI CLI、シェル、ジョブスケジューラを利用できるようにする。

すべてのトップレベル作業について、最終的にTeXソースとPDF報告書を生成する。

## 2. MVPで優先する単純化

MVPでは次を行わない。

- 独自の汎用エージェント通信規格を作らない。
- MCP、ACP、A2Aを必須構成にしない。
- Redis、NATS等のmessage brokerを置かない。
- 遠隔ホストへAgent Harness専用workerをインストールしない。
- スパコンのジョブスケジューラをプログラムで理解・解析しない。
- 複数エージェントに同じリポジトリを同時編集させない。
- サブスクリプション残量を取得できない場合に推測値を残高として表示しない。
- アプリ終了後もローカルAIプロセスを常駐させるdaemonをMVP必須にしない。

これらは実運用で必要性が確認できたものだけを後から追加する。

## 3. 全体構成

```text
+--------------------------------------------------+
| Agent Harness desktop app                        |
|                                                  |
|  GUI                                             |
|   ├─ Dispatch / Tasks                            |
|   ├─ Resources                                   |
|   └─ task tabs: Overview / Execution / Report    |
|                                                  |
|  Main process                                    |
|   ├─ Task coordinator                            |
|   ├─ CLI adapters                                |
|   ├─ Local/SSH terminal sessions                 |
|   ├─ Local JSON store                            |
|   └─ TeX report runner                           |
+--------------------------------------------------+
          │ child process / PTY
          ├── Codex
          ├── Claude Code
          ├── Gemini CLI
          ├── OpenCode
          └── ssh ── remote shell ── optional tmux
```

MVPは一つのデスクトップアプリで構成する。GUIと制御処理はプロセス内で分かれていてよいが、独立daemonや分散サービスは作らない。

実装の単純さを優先する場合、Electron + TypeScriptを第一候補とする。GUI、CLI起動、PTY、SSH起動、ローカル保存を同じ言語で実装できる。配布サイズとメモリ消費を優先する場合はTauriを再検討する。

## 4. CLIアダプター

各CLIについて、薄いアダプターを一つずつ用意する。

```text
detect()              インストールと版を確認
start(prompt, cwd)    CLIを開始
send(text)            続きの入力を送信
stop()                中断
resume(session_id)    対応している場合だけ再開
read_events()         JSON出力またはterminal出力を読む
read_usage()          取得できる場合だけ利用量を返す
```

CLI固有のJSON/JSONL出力がある場合は使用する。ない機能は `unsupported` または `unknown` とし、複雑な画面解析で無理に補わない。

アダプターが共通化するイベントは最小限とする。

```text
started
text
tool_started
tool_finished
approval_required
usage
completed
failed
```

CLIの高度な機能をすべて共通APIへ入れず、必要になった機能だけ追加する。

## 5. タスクとエージェント間の受渡し

### 5.1 タスクとワークフロー

GUIのキューへ積む単位はCLI別ジョブではなく、ユーザーのトップレベルタスクとする。各タスクは、目的、作業ディレクトリ、運用方針、使用可能なCLI、CLI別モデル指定、WorkUnit、AgentRun、結果、利用量、報告書を持つ。

最初の実装では次の固定ワークフローを使う。

```text
Plan (read-only) -> Execute (single writer) -> Review (read-only) -> Report (write-enabled agent)
```

`WorkUnit` は役割と依存関係を表し、`AgentRun` は特定のCLI・モデル・契約先で行った一回の試行を表す。担当CLIはタスク作成時に固定せず、各WorkUnitの開始時に選ぶ。

タスク状態は次に限定する。

```text
queued | planning | running | reviewing | reporting | paused | blocked | completed | failed | cancelled
```

### 5.2 通信方法

エージェント同士をリアルタイムで直接接続しない。Agent Harnessがメッセージを保存し、次の入力時に相手のプロンプトへ追加する。

```text
Agent A result
      ↓
Agent Harness saves message and artifact paths
      ↓
Agent Harness builds next prompt
      ↓
Agent B receives it at the start of its next turn
```

メッセージは以下だけを持つ。

```text
from
to
task_id
text
artifact_paths
created_at
```

実行中の相手へ即時割込み配送する機能はMVPでは作らない。ユーザーが急ぎの指示を出す場合は、そのセッションを中断して新しい入力として送る。

### 5.3 用意する作業パターン

最初は固定の `Plan → Execute → Review → Report` だけを実装する。自由なエージェント会議、可変DAG、複数Writerの並列実行は行わない。可変数の読取専用WorkUnitは、この固定フローの運用を確認した後に追加する。

### 5.4 引き継ぎ

引き継ぎ時には、Agent Harnessが次を一つのテキストへまとめて次のCLIへ渡す。

- 元の目的
- 直前のエージェントの要約
- 変更ファイルまたは成果物のパス
- 実行済みの確認
- 未完了事項
- エラーまたはレート制限情報

専用の複雑なhandoff protocolは作らない。

## 6. 同時実行とファイル保護

現在のMVPでは、待機中のトップレベルタスクを作成順にアプリ全体で一件ずつ実行する。一つのタスク内のWorkUnitも直列実行する。

- `Run queue` でキューを開始する。
- 実行中タスクの `Pause workflow` は現在のCLIを停止し、現在のWorkUnitを未完了のまま保持する。`Resume workflow` で同じWorkUnitから再開し、後続工程へ自動的には進まない。
- `Stop after current` は現在のトップレベルタスクを終えてからキューを停止する。
- CLIまたはレポート生成が失敗しても失敗状態を記録し、キューは次の待機タスクへ進む。
- キュー実行中の手動タスク実行は許可しない。

将来並列化する場合も、一つのプロジェクトにつき書込可能なエージェントは一つだけとする。

- コードを書くAgent: 1つ
- 読取専用レビューAgent: 複数可
- 別ディレクトリでの調査・分析Agent: 複数可

これにより、自動worktree管理、merge queue、ファイルleaseを省略する。複数Agentによる並列実装は将来機能とする。

## 7. 利用量と負荷分散

### 7.1 表示する値

- CLIが返した入力・出力トークン
- CLIが返した費用
- CLIが返した使用率またはリセット時刻
- Agent Harness内でのセッション数と実行時間
- レート制限または認証エラー

値は次のラベル付きで表示する。

```text
reported | calculated | estimated | unknown
```

### 7.2 資源単位と単純な割当

CLIと利用資源を分離する。例えばCodexとOpenCodeが同じOpenAI契約またはAPIキーを使う場合、両者へ同じ `provider_key` を設定し、利用量と制限を一つに集約する。

初期の自動割当は次のルールだけとする。

1. インストール済み・有効・タスクで許可されたCLIだけを候補にする。
2. クールダウン中または利用不能な契約先を除外する。
3. 上限排出しきい値を超えた契約先は、他候補がある限り避ける。
4. `balanced`、`quality`、`quota-saver` の方針に応じ、優先度、使用率、累積トークンから選ぶ。
5. Reviewは、可能なら直前のExecuteと異なる契約先へ割り当てる。
6. 制限エラーが出た場合、その契約先へリセット時刻または暫定15分のクールダウンを設定し、同じWorkUnitを別候補で再試行する。

サブスクリプション公式残量、CLIが報告する実行トークン、ユーザー設定のソフト上限は出所を区別する。消費速度予測、最適化アルゴリズム、学習型ルーターは作らない。

## 8. 遠隔システム

### 8.1 登録内容

ユーザーはシステムごとに次を登録する。

- 表示名
- `~/.ssh/config` に登録済みのSSH alias
- 最初に移動する作業ディレクトリ
- tmuxを使うかどうか
- システムの使い方を書いたプレーンテキスト

認証鍵、パスワード、API tokenは保存しない。

### 8.2 システム説明テキスト

説明テキストの書式は自由とする。Agent Harnessは内容を解析せず、遠隔作業を担当するAIへの指示としてそのまま渡す。

例:

```text
このシステムではPBS Proを使用する。
ログインノードではコンパイルと重い計算をしないこと。

作業開始:
  cd /work/example/project
  module purge
  module load gcc texlive

ジョブ投入:
  qsub job.sh

状態確認:
  qstat -u $USER

取消:
  qdel JOB_ID

ジョブ終了後は results/ 以下を確認すること。
```

独自スケジューラでも、ユーザーが使用方法を書けばAIがその方法に従う。Agent Harness自身はジョブIDや状態を解析せず、AIからの報告とterminal logをタスク履歴へ保存する。

### 8.3 接続方法

システムごとに一つのSSH PTYセッションを開き、以降は同じセッションへ入力する。操作ごとに新しいSSH接続を作らない。

```text
ssh login-alias
cd registered-directory
optional: tmux new-session -A -s agent-harness-project
start selected AI CLI or shell
```

Macがスリープした場合や接続が切れた場合だけ再接続する。

### 8.4 tmux

tmuxは推奨可能なオプションとする。

- SSH切断後も遠隔CLIや処理を残せる。
- ユーザーが通常のterminalから同じsessionを確認できる。
- 専用remote workerが不要になる。

ただしAgent Harnessはtmux paneの文字列からジョブ状態を自動判定しない。tmuxはプロセス保持と手動復旧だけに使用する。

施設がログインノードでのtmux常駐を禁止している場合は使用しない。長時間の計算自体はシステム説明テキストに従ってバッチジョブへ投入する。

### 8.5 成果物の取得

成果物の置き場所や取得方法もシステム説明テキストへ記載する。MVPでは独自ファイル転送プロトコルを作らない。

Git、rsync、scp、共有ストレージなど、そのシステムで認められた方法をAIまたはユーザーが使う。必要なら作業終了時に一度だけ取得処理を実行する。

## 9. GUI

### 9.1 画面

画面は次の3つに限定する。

1. `Dispatch`: タスク作成
2. `Tasks`: タスクタブ、全体ステータス、タスク内のOverview / Execution / Report
3. `Resources`: 契約先単位の使用量・制限とCLI割当設定

左サイドバーに、契約先ごとの観測トークン量とクォータ使用率を示すコンパクトなUsageサマリーを常設する。ライブの上限が取得できない項目は「—」と表示し、ローカルのソフト上限から算出した値とは区別する。詳細なResources画面へはサイドバーまたはポップアップのボタンから移動する。

プロバイダのUsageインジケータをクリックすると、モデルごとの観測トークン量、実行回数、入力・出力内訳、およびモデル専用枠または共有枠の使用率をポップアップ表示する。エージェントの完全なワークログはレポート本文・付録へ収録せず、タスクディレクトリのログファイルだけに保存する。

遠隔実装段階で `Systems` と永続terminalを追加する。

### 9.2 タスク作成

ユーザーは次を指定する。

- 作業内容
- 運用方針
- 使用を許可する複数CLIと任意のモデル上書き
- ローカルか登録済み遠隔システムか
- 報告書を作るタイミング

詳細なDAGエディター、複雑な権限画面、ルーティングルールエディターはMVPでは作らない。

### 9.3 terminal表示

ローカルMVPではAgentRunごとに独立したターミナル風モニターを並べ、複数エージェントの履歴と実行中出力を同時に確認できるようにする。既定表示ではCLIのJSON/JSONLを、本文、思考中、コマンド、ツール、結果、使用量へ正規化する。各モニターの `Raw` 切替では、マスク処理後の元ストリームを確認できるようにする。

この段階では非対話CLIの構造化ストリームを利用し、CLI本来の対話TUIをPTYで再描画しない。遠隔実装段階で、入力、再接続、tmux attachを伴うPTY terminalを追加する。

## 10. TeX/PDF報告

現在のMVPでは保存済みの指示、結果、terminal log、利用量を共通テンプレートへ入れて `report.tex` を用意し、Report AgentがTeXビルドとエラー修正を担当する。

Agent Harnessは以下だけを行う。

1. 共通TeXテンプレートへタスク履歴を入れる。
2. `report.tex` と `run.log` を保存する。
3. Report AgentがGUIで設定したTeXコマンドを実行する。
4. `report.pdf` とビルドログをタスクへ添付する。
5. コンパイルに失敗した場合、Report Agentがログを確認してソースを修正し、PDF生成まで再試行する。

Tasks画面のReport環境設定では次を設定・確認できる。

- TeXビルドコマンドと引数
- 作図コマンドと環境確認用引数
- PDF保存先
- 両コマンドの動作確認結果
- 生成済みPDFのアプリ内プレビュー

複数Agentによる章断片、manifest、PDF視覚検査の完全自動化は将来機能とする。ただし、TeXとPDFを残す要件はMVPでも維持する。

標準報告書は次の節だけでよい。

1. 目的
2. 実施内容
3. 結果
4. 検証・レビュー
5. 未解決事項
6. 利用したCLI・モデル・実行時間

## 11. 保存データ

最初の動作確認ではJSON一ファイルと成果物ディレクトリだけを使用する。

```text
tasks.json
systems/*.md
artifacts/<task-id>/
```

検索量や同時更新が増えてJSON保存が問題になった時点でSQLiteへ移行する。完全なevent sourcing、分散transaction、外部databaseは使用しない。terminal logと会話を保存し、秘密らしい文字列は表示・保存前にマスクする。

## 12. MVP受入条件

1. 4種類のCLIを検出し、タスクで使用可能な候補として選択できる。
2. 一つのタスクをPlan、Execute、Review、Reportの複数工程で処理できる。
3. Agent Aの結果をAgent Bの次の入力へ渡せる。
4. 模擬レート制限後に別契約先のCLIへ同じWorkUnitを再割当できる。
5. 一つのプロジェクトで複数の書込Agentが同時実行されない。
6. GUIへ利用量または `unknown` が表示される。
7. システム説明テキストを登録し、遠隔Agentへ渡せる。
8. 一つのSSHセッション内で複数回の遠隔操作ができる。
9. 任意でtmuxを使用し、切断後にsessionへ再接続できる。
10. タスク終了後に `report.tex` と `report.pdf` が生成される。

## 13. 将来必要になった場合だけ追加する機能

- 独立headless daemon
- remote worker
- MCPによるAgent Harness tools
- ACP対応アダプター
- A2A互換通信
- リアルタイムのエージェント間push通信
- ユーザー定義スケジューラparser/plugin
- 自動ジョブ状態ダッシュボード
- Git worktreeによる複数書込Agent
- 高度な負荷予測
- チーム・複数ユーザー対応

旧版の詳細構想は [SPECIFICATION_EXTENDED_DRAFT.md](./SPECIFICATION_EXTENDED_DRAFT.md) に残す。

## 14. 残る判断事項

1. 遠隔CLIは、原則としてtmux内で起動するか、tmuxはシステムごとの任意設定にするか。
2. システム説明テキストはアプリ内入力だけでよいか、プロジェクト内の `SYSTEM.md` も自動読込するか。
3. Plannerが出力する可変WorkUnitの最小スキーマをどうするか。
4. 公式残量取得用コネクターを、CLIごとの薄い補助コマンドにするか、手動入力を先にするか。
