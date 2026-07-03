# Zotero PubMed自動タグ付けアドオン 仕様書

バージョン: 0.1 (ドラフト)
対象: Zotero 7.x
作成日: 2026-07-03

---

## 1. 目的

Zoteroに文献アイテムが追加された際、PubMedからキーワードを取得し、Zoteroのタグとして自動登録する。PubMedに掲載されていない文献にはタグを付けず、その旨をユーザーに通知する。

## 2. 用語定義

| 用語 | 定義 |
|---|---|
| MeSH terms | PubMedが付与する統制語彙キーワード |
| Author Keywords | 著者が論文に付けたキーワード(PubMedレコードのOT フィールド) |
| PMID | PubMed固有の文献ID |
| E-utilities | NCBIの公開API(esearch, efetch等) |

## 3. 未確定事項(実装前に決定が必要)

以下は依頼内容から一意に決まらない。デフォルト案を示す。

| # | 項目 | 選択肢 | デフォルト案 |
|---|---|---|---|
| U1 | タグに使うキーワード種別 | (a) MeSH terms (b) Author Keywords (c) 両方 | (a) MeSH terms |
| U2 | MeSH qualifier(副標目)の扱い | 含める / 主見出しのみ | 主見出しのみ |
| U3 | 手動追加以外(インポート、同期)のアイテムも対象にするか | する / しない | 手動・翻訳者経由の新規追加のみ |
| U4 | 既存タグとの重複時 | スキップ(Zoteroは同名タグを重複登録しないため実質不要) | スキップ |
| U5 | 通知方法 | ポップアップ / タグ「no-pubmed-keywords」付与 / 両方 | ポップアップ + 専用タグ付与 |

## 4. 機能要件

### FR-1: アイテム追加の検知
- Zoteroの `Notifier` API (`item` タイプ, `add` イベント) で新規アイテム追加を検知する。
- 対象アイテムタイプ: `journalArticle`, `preprint` は対象外(PubMed未掲載が自明なため。ただしプレプリントの一部はPMIDを持つため、PMID/DOIがあれば対象に含める)。
- 添付ファイル(attachment)、ノート(note)は対象外。

### FR-2: PubMed照合
優先順で以下を試行する。

1. アイテムのExtraフィールドまたはPMIDフィールド相当にPMIDがあれば直接使用。
2. DOIがあれば `esearch` (`term={DOI}[doi]`) でPMIDを検索。
3. DOIがなければ タイトル + 第一著者 + 年 で `esearch`。ヒットが1件のときのみ採用。複数件・0件は「未掲載」扱い。

### FR-3: キーワード取得
- `efetch` (`db=pubmed`, `retmode=xml`) でレコードを取得。
- `<MeshHeading><DescriptorName>` を抽出(U1デフォルト)。
- 取得結果が空(MeSH未付与の新しい論文など)の場合は FR-5 の通知対象とする。

### FR-4: タグ登録
- 取得した各キーワードを `item.addTag(name, type=1)`(automatic tag)として登録し、`item.saveTx()` で保存。
- Zoteroの仕様上、同名タグは重複しない。

### FR-5: 未掲載・キーワードなし通知
以下の場合に通知する。
- PMIDが特定できない(PubMed非掲載と判定)。
- PMIDはあるがキーワードが0件。

通知内容:
- Zoteroのポップアップ通知(`Zotero.ProgressWindow` 相当)にアイテムタイトルと理由を表示。
- 識別用タグ `#no-pubmed-tags` を付与(U5デフォルト。後からフィルタ可能にするため)。

### FR-6: 手動再実行
- アイテム右クリックメニューに「PubMedタグを取得」を追加。選択アイテムに対しFR-2〜FR-5を再実行する。
- 自動処理の失敗(ネットワークエラー等)のリカバリ手段として必須。

## 5. 非機能要件

### NFR-1: NCBI APIレート制限
- APIキーなし: 3 req/秒。キーあり: 10 req/秒。
- 実装は直列キュー + 最低350ms間隔とする。
- 設定画面でNCBI APIキーを任意入力可能にする。

### NFR-2: エラー処理
- ネットワークエラー・API障害時: タグを付けず、エラー通知(未掲載通知と区別する)。`#no-pubmed-tags` は付けない(未掲載と誤判定させないため)。
- リトライは自動では行わない(FR-6の手動再実行に委ねる)。

### NFR-3: 対応環境
- Zotero 7.x(bootstrapped extension形式、`bootstrap.js` + `manifest.json`)。
- Zotero 6は非対応。

## 6. 設定項目

| キー | 型 | デフォルト | 説明 |
|---|---|---|---|
| `keywordSource` | enum | `mesh` | `mesh` / `authorKeywords` / `both` |
| `ncbiApiKey` | string | 空 | NCBI APIキー |
| `notifyOnMissing` | bool | true | 未掲載通知の有効/無効 |
| `missingTagName` | string | `#no-pubmed-tags` | 未掲載時に付与するタグ名 |
| `autoRunOnAdd` | bool | true | 追加時自動実行 |

## 7. 処理フロー

```
アイテム追加 (Notifier: item/add)
  └─ 対象タイプ? ─ No → 終了
       Yes
  └─ PMID特定 (PMID → DOI → タイトル検索)
       ├─ 特定不可 → 通知 + missingTag付与 → 終了
       └─ 特定
            └─ efetchでキーワード取得
                 ├─ 0件 → 通知 + missingTag付与 → 終了
                 ├─ エラー → エラー通知 → 終了
                 └─ n件 → addTag × n → saveTx → 終了
```

## 8. 検証基準(受け入れテスト)

| # | ケース | 期待結果 |
|---|---|---|
| T1 | PMID付き論文を追加 | MeSH termsがタグとして付与される |
| T2 | DOIのみの論文(PubMed掲載)を追加 | PMID解決後、タグ付与 |
| T3 | PubMed非掲載の論文を追加 | ポップアップ通知 + `#no-pubmed-tags` 付与 |
| T4 | MeSH未付与の新着PubMed論文 | T3と同じ扱い |
| T5 | 10件同時インポート | 自動タグ付けはスキップされ、手動実行を促す通知が表示される |
| T6 | ネットワーク切断状態で追加 | エラー通知、`#no-pubmed-tags` は付かない |
| T7 | 右クリック→手動実行 | 自動時と同じ結果 |
| T8 | 添付PDF追加 | 何も起きない |

## 9. スコープ外

- PubMed以外のデータベース(Scopus, Web of Science等)対応
- 既存ライブラリ全体への一括遡及タグ付け(手動再実行で代替可能だが、専用UIは対象外)
- タグの翻訳・正規化
