---
name: report-writing-academic
description: 英語・日本語の論文や技術レポートを、科学的内容を保って自然で明確な学術文体へ推敲する。新規執筆、追記、修正と最終推敲に適用する。
---

# 学術文体の推敲（日英）

humanizer_academic v2.1.1（Kentaro Matsui）の34パターンと二段階推敲を基にした、Agent Harness向けの適応版。元リポジトリ: https://github.com/matsuikentaro1/humanizer_academic （固定commit: 0a673cba46d93db1d839547627ec73bb1b2f8196）。

論文・レポートでは共通ルールとpaperルールに追加して必ず適用する。日本語には「日本語」、英語には「English」を用い、日英の要旨・図注などが混在する場合は部分ごとに選ぶ。翻訳や別言語版の追加は依頼がある場合のみ。ポスター・スライドの短文をこのルールで長文化しない。読み取り専用の担当は指摘だけを返す。作業権限、承認済みゴール、既存の独立レビューと完了条件を変更しない。

## 内容を変えないための境界

- 目的は明瞭さと読みやすさであり、AI検出器の回避・検出スコア最適化・人間が書いたという偽装ではない。必要なAI利用開示、出典、引用文を保持する。
- 数値、単位、有効桁、数式、条件、比較対象、統計的意味、否定、限界、不確実性を保持する。相関を因果に、予備評価を実証済みの結論に変えない。冗長な留保を整理しても断定の強さは変えない。
- 原稿にない実験、根拠、効果量、信頼区間、出典、具体例を「具体的にする」ために補わない。不足は既存の証拠へ照合し、確認できなければ未確認として残す。文体改善だけを理由に重要な留保や反証を削らない。
- 同じ概念には同じ専門用語を使う。反復回避のための同義語巡回をしない。数式、コード、API名、識別子、引用キー、文献の正式タイトルと著者名は文体置換の対象外。全著者名と一次ソース二重チェックは共通ルールに従う。
- 読者、分野、投稿規定、既存原稿の自然な文体に合わせる。原典の医学著者固有の語彙・受動態・文長・結論形式は強制しない。文長の数値ノルマ、語彙ブラックリスト、無意味な文の分割・結合は使わない。

## 共通の推敲手順

1. 全文の論旨を読み、段落・節の順序、主張と根拠の対応、未定義の用語を先に確認する。語句の置換より構造を優先する。長い文は意味の切れ目で分け、細切れの文は関係が明瞭になる場合に限りつなぐ。既に主張や論点の転換を明瞭に示す短文は残す。
2. 内容を増やさない強調、宣伝調、権威づけ、空疎な評価文、定型的な「課題と展望」、同じ主張の言い換えの繰り返しを整理する。三点列挙や対比構文は論理上必要なら残し、見栄えのために三つ目の主張を作らない。実際の限界・将来課題は消さない。
3. 接続語や末尾の評価句を削るときは、対比・追加・因果・時系列の関係が失われないか確認する。必要なら接続を言い換えるか、前文の主要概念を次文の主語にして既知から新情報へつなぐ。接続詞の数を機械的に減らしたり、存在しない因果を付けたりしない。
4. 推敲後に再度全文を読み、文や段落がぶつ切りになっていないか、節の移行が自然か、用語・主張・数値・留保が保たれているかを自己監査する（二段階推敲）。不自然さが残る部分だけ再修正する。既に自然な文は無理に書き換えない。

## English

- Prefer precise claims over inflated significance: remove unsupported promotion such as “groundbreaking” or “pivotal” and empty assessments such as “This is an important finding.” Retain an evaluation when its concrete reason is supported. Do not invent numbers or citations to make it specific.
- Review repetitive openings, uniform clause structures, ornamental -ing tails, forced triples, “not only … but also …”, and “from X to Y” without a meaningful range. Edit only when they obscure or inflate the argument. Preserve concise declarative claims and the author's appropriate active/passive voice.
- Keep genuine logical markers (Although, However, Thus, In contrast) and supported attribution (“Prior studies have shown …” with the relevant citation). Remove empty attribution, not the provenance of real claims. Avoid replacing repetition with rare decorative connectives.
- Prefer simple verbs (is, has) over empty “serves as” constructions when meaning is unchanged. Review delve, comprehensive, landscape, highlight, markedly and similar wording in context, not as forbidden words. Keep functional qualifiers such as approximately, slightly and consistently. Use “significantly” for the stated statistical meaning, not unsubstantiated emphasis.
- Simplify stacked hedges but retain the warranted uncertainty. “Was associated with” is not interchangeable with “caused” or “reduced”. Context governs linked to, via, where, yield, remain and given: preserve legitimate mathematical definitions, data links, code terminology and domain-standard uses. Do not apply medical wording substitutions to computing papers indiscriminately.
- Unpack unclear noun compounds and explain compressed relationships without adding mechanisms not supported by evidence. Keep stable technical names even when repeated. A genuine explanation or definition is not redundant paraphrase.
- Prefer commas, parentheses or a separate sentence over excessive rhetorical em dashes in editable prose. Do not perform global punctuation replacement in TeX, quotations, equations, numeric ranges, hyphenated terms or bibliographic titles. Heading capitalization and quotation typography follow the publication template; TeX quotation commands remain valid.

## 日本語

- 「極めて重要な役割を果たす」「革新的な枠組み」「新たな可能性を切り拓く」など、対象・根拠のない強調は削るか、確認済みの結果・比較条件に即して具体化する。「有意」は実際の統計検定による意味と区別し、程度や近似を表す「約」「わずかに」等は情報があれば残す。
- 「〜を行うことが可能である」「〜という観点から〜において」「〜するものである」の重なり、過度な名詞化、長い連体修飾、翻訳調の直訳を整理する。誰が何を測定・比較したかを明確にする。ただし方法節を無条件に能動態にしたり、学術文を会話調にしたりしない。
- 「また」「さらに」「一方で」「すなわち」「以上より」を一律削除しない。追加・対比・説明・結論の関係が本当にあるかを確認し、近接する機械的反復だけを直す。「一方で」を単なる話題変更に使わず、「すなわち」で同じ主張を繰り返さない。必要な専門語の定義・噛み砕いた説明は残す。
- 「可能性があることが示唆されると考えられる」等の留保の重なりは意味を確認して簡潔にする。「示唆された」を「実証した」に、「関連した」を「改善した」に変えない。「必ず」「すべて」「初めて」「最適」は検証範囲を越えて付けない。
- 用語辞書に従い、和訳・カタカナ・英語名・略語と送り仮名を統一する。同じ対象を「手法」「機構」「枠組み」と理由なく呼び替えない。略語を初出で説明し、説明に必要な前提を後の節へ先送りしない。日英の要旨は主張・条件・数値・限界を対応させるが、語順を直訳で揃えない。
- 「である」調など原稿・投稿先の文体を統一する。語尾を変えるためだけの言い換えや、英語の単語数基準を日本語へ当てはめることはしない。句読点・括弧・英数字まわりの組版はTeXテンプレートに合わせる。

## 再検証と提出

編集前後の差分で科学的内容・引用対応・用語を確認し、変更に関係する既存の数値・参照・用語検査を再実行する。単なる用語の出現だけで誤りと断定する置換スクリプトは作らない。レポーターは最終組版・全ページ確認を行い、既存のeditorial-checkに変更点、対象ソース、未解決事項を記録する。管理用の推敲ログは本文・付録に入れない。独立レビューでも意味の変化、断定の強化、文献への不忠実な言い換えを確認する。後続レビュー待ちだけを理由にレポーターを止めず、未実施の確認は引き継ぐ。
