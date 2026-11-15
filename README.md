# MyNews 無料スターター v0.1

日本語の「話題」と「重要ニュース」を毎日３回まとめる、完全無料構成の個人向けPWAです。

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
- 重複除去：URL・Bluesky post URIのハッシュ、記事データは原則96時間保持（最大350件）
- 重要度：現在は簡易なヒューリスティック評価。**客観的なSNSトレンド順位ではありません。**
- UI：全分野・話題のみ・保存、分野別、検索、既読、ブックマーク。端末ごとのLocalStorage保存。
- 出典：リンクを残し、元記事を開けるようにする。記事本文・画像の無断転載は行わない。

Google News RSSの検索URLは公式APIとして保証されたものではないので、仕様変更時は取得失敗する可能性があります。はてな、Google Trends、Blueskyも外部サービスの制限に依存します。定期的に動作を確認してください。

## 4. ローカルテスト

Python 3.12 以上で：

```sh
python -m unittest discover -s tests -v
python src/collect.py
python -m http.server 8000 -d site
```

最後に http://localhost:8000/ を開きます。ブラウザーのPWA機能はHTTPS公開後に使ってください。

## 5. 収集対象の変更

`src/collect.py` の `NEWS_SEARCHES` に分野と検索語を追加します。`BSKY_SEARCHES` にBlueskyの公開検索語を追加します。元の話題分類やスコアは同じファイルの `KEYWORDS` / `score_article` で変更できます。

2026年11月時点では、GitHub Actionsの `schedule` に `timezone: 'Asia/Tokyo'` が使えます（公式仕様を参照）。

## 6. 未実装・検証済み範囲

- ✅ Python標準ライブラリのみで収集、XMLとBluesky JSON解析、重複排除、スコアリング
- ✅ レスポンシブの日本語PWA、カテゴリーフィルター、記事検索、既読、保存
- ✅ GitHub Pages用Actionを同じワークフローから実行（`GITHUB_TOKEN` によるcommitだけではPages公開がトリガーされない問題を回避）
- ✅ 収集処理のユニットテスト（サンプルデータ）
- ⚠️ 外部サイトへの本番通信、GitHubへの配置、実データの収集、Pagesでの公開は**未実施**（この開発環境に外部通信アクセスがないため）
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
