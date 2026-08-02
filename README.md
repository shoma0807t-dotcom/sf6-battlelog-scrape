# sf6-battlelog-scraper

「スト6攻略ノート」アプリの対戦履歴を自動取り込みするための、GitHub Actions用スクレイパーです。
CAPCOM IDの**メールアドレス・パスワード**でヘッドレスブラウザ（Playwright）から自動ログインし、
対戦履歴を取得して**GitHubのGist（非公開）**にアップロードします。

## 重要：これは実験的な仕組みです

- **二段階認証やCAPTCHAが表示される場合、この自動ログインは動きません。**
- **サイトのログインフォームの構造が変わると壊れます。**
- **これは公式のAPIでもログインでもありません。** 非公式な自動化なので、Capcom側の利用規約に
  抵触する可能性があります。自己責任で利用してください。
- 失敗した場合、`output/debug-last-page.png`（最後に表示されていた画面のスクショ）と
  `output/debug-last-url.txt`（最後のURL）がActionsのアーティファクトとして残ります。
- **Gistは「secret」＝限定公開です。** 完全非公開（認証必須）にはできません。
  URL（GistのID）を知っていれば誰でも中身を見られる、という扱いです。検索や一覧には出ませんが、
  URLが漏れないよう扱ってください。

## 仕組み

1. GitHub Actionsが `CAPCOM_ID_EMAIL` / `CAPCOM_ID_PASSWORD` を使い、Playwrightで実際に
   ログイン画面を操作してログインする
2. ログイン済みのブラウザセッションのまま、対戦履歴API（battlelog.json、直近100戦分）を取得する
3. **`replay_id`（対戦ごとのユニークID）を主キーとして、既存のGistの中身と突き合わせる。**
   公式サイト側は直近100戦しか保持していないため、これをやらないと古いデータが消えてしまう。
   すでにGistにある対戦はそのまま残し、新しい対戦だけを追加していく（＝Gistの中身がどんどん蓄積される）
4. `GIST_TOKEN` を使って、指定したGist（`GIST_ID`）の `battlelog.json` を更新する
5. アプリ側の「マイページ」の戦績にある「🔄 戦績データを更新」（＝ここまでの1〜4を実行するだけ）と
   「⬇ 戦績を取り込む」（＝Gistの中身をアプリのIndexedDBに取り込む）は別ボタンです。
   更新しただけではアプリには反映されません。数分待ってから「取り込む」を押してください。

> **SQLiteではなくJSONを使っている理由：** GitHub ActionsはCookieやDBファイルを永続化できる場所を
> 持たない（毎回まっさらな仮想マシン）ので、状態はどこかに外部保存する必要があります。今回はGistに
> 保存する設計にしたため、バイナリのSQLiteファイルより素直にテキストとして扱えるJSONの方が
> 相性が良く、`replay_id`を主キーにする発想自体はJSONでもそのまま実現できます。またアプリ本体
> （スト6攻略ノート）側もIndexedDB（ブラウザ内蔵のDB）を使っていてSQLiteではないため、
> 経由するデータもJSONに揃えた方が変換の手間が増えずシンプルです。

## セットアップ手順

### 1. このフォルダの中身でリポジトリを作る
GitHubで新しい**プライベートリポジトリ**を作成し、このフォルダ一式をpushしてください。

### 2. 自分のプレイヤーID（fighter ID）を確認する
プロフィールページURL末尾の数字です（例：`1229292585`）。

### 3. Gistを1つ作っておく
1. https://gist.github.com を開く
2. ファイル名を `battlelog.json`、中身は `[]` とだけ入力
3. 右下の「Create secret gist」をクリック（**public gistではなくsecret gistを選ぶこと**）
4. 作成後のURL（`https://gist.github.com/あなたのユーザー名/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`）の
   末尾の英数字列が **GIST_ID** です。控えておいてください。

### 4. Personal Access Tokenを作る（Gist更新用）
1. https://github.com/settings/tokens (classic) を開く
2. 「Generate new token (classic)」
3. スコープは **`gist`** のみにチェック
4. 生成されたトークンをコピー（これが **GIST_TOKEN** です。一度しか表示されないので注意）

### 5. GitHub Secretsに登録する
リポジトリの Settings → Secrets and variables → Actions → New repository secret で、以下5つを登録：
- `CAPCOM_ID_EMAIL` … CAPCOM IDのログインメールアドレス
- `CAPCOM_ID_PASSWORD` … CAPCOM IDのログインパスワード
- `SF6_FIGHTER_ID` … 手順2のプレイヤーID
- `GIST_TOKEN` … 手順4のトークン
- `GIST_ID` … 手順3のGist ID

### 6. 実行してみる
Actionsタブから `Scrape SF6 battlelog` を手動実行（workflow_dispatch）してみてください。
成功すると、手順3で作ったGistの `battlelog.json` が更新されます。

### 7. アプリに取り込む
アプリの「設定 → 対戦履歴の取り込み設定」の②に、以下の形式のURLを入れてください：

```
https://gist.githubusercontent.com/あなたのユーザー名/GIST_ID/raw/battlelog.json
```

（GistページでURLを確認する場合は「Raw」ボタンを右クリック→リンクをコピー、が確実です）

## うまくいかない場合

自動ログインが安定しない場合は、無理せず前のバージョンの方式（ログイン中のブラウザから
Cookieをコピーして使う方式）に戻すこともできます。必要であれば伝えてください。
