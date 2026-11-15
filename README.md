# MyNews 無料スターター v0.2

日本語の「話題」と「重要ニュース」を毎日３回まとめる、完全無料構成の個人向けPWAです。

公開先： https://tyr-ui.github.io/mynews-free/

v0.2では、分野・媒体・並び替えをタブに変更し、初期表示を「すべて／新着順」にしました。野球はスポニチ、サンスポ、デイリー、スポーツ報知、日刊スポーツ、産経新聞、Full-Count、BASEBALL KINGをそれぞれ指定してGoogle News RSSで収集します。各社の全記事を直接取得する仕組みではなく、検索への掲載・反映時刻に左右されます。

**注意**: X全体のトレンド取得、AIの自動要約、私的認証、プッシュ通知は未実装です。現在表示される本文は配信元のRSS抜粋かBluesky投稿であり、AI要約でも検証済みの事実でもありません。Googleトレンドは検索急上昇であってXのトレンドではありません。

## 1. GitHubで公開する（一番簡単な方法）

1. https://github.com/new で `mynews-free` という新規リポジトリを作る。**Public** を選び、README追加等の初期化チェックはオフにする。
2. ダウンロードしたZIPを展開し、**中のファイルとフォルダー**（`.github`, `src`, `site`, `tests`, `README.md`, `.gitignore`）をリポジトリへアップロードする。**ZIPファイルをそのままアップロードしても動かない**。PCなら 空のリポジトリに表示される `uploading an existing file` リンクを開き、展開済みフォルダーの中身をドラッグ＆ドロップしてコミットする。既存リポジトリなら `Add file` → `Upload files` を使う。`.github`は隠しフォルダーなので、macOSのFinderでは Command+Shift+. で表示する。
3. `Settings` → `Pages` → `Build and deployment` → `Source` を **GitHub Actions** にする。
4. `Settings` → `Actions` → `General` → `Workflow permissions` で **Read and write permissions** が選べるなら有効にする（組織の制限により変更不可の場合あり）。ページ公開先の権限はワークフロー定義にも明記済み。
5. `Actions` → `MyNews - 自動収集と公開` → `Run workflow` → `Run workflow` を実行する。GitHubがワークフローを承認する必要がある場合は承認する。
6. `Actions` で実行結果が緑色になったら `Settings` → `Pages` → `Visit site` からアクセスする。通常は `https://<ユーザー名>.github.io/mynews-free/`。
7. iPhoneのSafariでページを開き、共有 → **ホーム画面に追加** を選ぶ。

初回や更新時に、外部サイトの通信エラーがあると一部の記事が欠けます。画面上の「収集元エラー」を確認してください。GitHub Actionsの `schedule` 実行は遅延・スキップされることもあります。

**料金と公開範囲**：GitHub Free の公開リポジトリおよび標準GitHub-hosted runnerを使う前提です。サイトもデータも原則公開されます。公開できない個人情報をリポジトリや `site/data/news.json` に入れないでください。

## 2. スマホだけで作業する場合

GitHubモバイルアプリよりも、Safariの「デスクトップ用Webサイトを表示」でWeb版GitHubを使うほうが手順を追いやすいです。ただしiPhoneから複数フォルダーをアップロードする操作は難しいため、**PCでファイルを一括アップロードする**か、GitHubに接続したCodex / ChatGPT WorkへこのZIPを渡し、「新規Publicリポジトリに展開して、READMEに沿ってセットアップして」と依頼する方法を推奨します。AIツール側にリポジトリ操作の権限が必要です。

## 3. 収集の仕組み

- 収集：Google Trends（日本）、はてなブックマーク人気エントリー、Google News RSS（主要見出しと分野検索）、Bluesky公開検索
- 日時：毎日 07:15、12:15、20:15（Asia/Tokyo）。GitHub側のスケジュール実行は遅延することがあります。
- 重複除去：追跡パラメーターを除いた記事URL。同じ出来事でも別媒体の記事は残します。記事データは原則96時間保持（最大1,800件、1分野最大600件）。
- 検索条件：分野ごとにOR検索、野球は媒体別にも追加検索。検索RSSは直近3日を対象に、1フィード最大60〜80件を取得します。件数は配信状況次第で変動します。
- 重要度：現在は簡易なヒューリスティック評価。**客観的なSNSトレンド順位ではありません。**
- UI：分野タブに件数表示、野球の媒体タブ、すべて・注目・話題のみ・保存、新着順・おすすめ順、検索、既読、ブックマーク。注目は最大36件で、点数による一律の足切りはしません。
- 収集状況：画面内で各フィードの今回取得数・掲載中の保持数・0件・通信エラーを確認できます。複数フィードに含まれる記事があるため、フィード別件数の合計は総記事数とは一致しません。
- RSS形式：RSS 1.0（はてなの名前空間付きRDF）、RSS 2.0、Atomに対応。検索急上昇はキーワード別に保持します。
- 出典：リンクを残し、元記事を開けるようにする。記事本文・画像の無断転載は行わない。

Google News RSSの検索URLは公式APIとして保証されたものではないので、仕様変更時は取得失敗する可能性があります。はてな、Google Trends、Blueskyも外部サービスの制限に依存します。定期的に動作を確認してください。

## 4. ローカルテスト

Python 3.12 以上で：

```sh
python -m unittest discover -s tests -v
python -m src.collect
python -m http.server 8000 -d site
```

最後に http://localhost:8000/ を開きます。ブラウザーのPWA機能はHTTPS公開後に使ってください。

## 5. 収集対象の変更

`src/sources.py` の `NEWS_SEARCHES` に分野と検索語、`BASEBALL_MEDIA` に媒体指定を追加します。`BSKY_SEARCHES` はBlueskyの検索語です。話題分類やスコアは `src/collect.py` の `KEYWORDS` / `score_article` で変更できます。公開元のRSSは再配信条件が異なるため、野球各社の指定検索はGoogle Newsの見出し・リンク情報を利用しています。

2026年11月時点では、GitHub Actionsの `schedule` に `timezone: 'Asia/Tokyo'` が使えます（公式仕様を参照）。

## 6. 未実装・検証済み範囲

- ✅ Python標準ライブラリのみで収集、XMLとBluesky JSON解析、重複排除、スコアリング
- ✅ レスポンシブの日本語PWA、カテゴリーフィルター、記事検索、既読、保存
- ✅ GitHub Pages用Actionを同じワークフローから実行（`GITHUB_TOKEN` によるcommitだけではPages公開がトリガーされない問題を回避）
- ✅ 収集処理のユニットテスト（サンプルデータ）
- ✅ GitHubへの配置、GitHub Actionsによる実データ収集、Pagesでの初回公開を2026年11月15日に確認済み。
- ⚠️ Blueskyの未認証検索は本番でHTTP 403となっています。認証対応は未実装であり、取得成功を保証しません。画面にも未取得として表示します。
- ❌ X投稿の直接自動収集、AI生成要約、クラウド同期、通知、元記事の事実検証

## 7. よくある失敗

- **Actionsが出ない**：`.github/workflows/update.yml` が正しいディレクトリにあり、既定ブランチ `main` に含まれているか確認。
- **Actionsで403**：`Settings → Actions → General → Workflow permissions` の権限と組織ポリシーを確認。
- **Pagesが404**：`Settings → Pages → Source = GitHub Actions`、最初のAction完了、正しいURLを確認。
- **記事が0件**：`Actions` のログの `FETCH ERROR` を確認。接続先の変化やレート制限を想定。
- **iPhoneで古いデータ**：画面右上の更新ボタンを押す。Service Worker/ブラウザのキャッシュが残る場合がある。
- **保存した記事が消えた**：ブラウザーのデータ削除や端末移行でLocalStorageが消える場合がある。

## 8. 参照ドキュメント

- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://support.google.com/trends/answer/3076011?hl=ja
- https://endpoints.bsky.app/
