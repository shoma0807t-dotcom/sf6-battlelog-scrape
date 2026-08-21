# sf6-battlelog-scraper

「スト6攻略ノート」アプリの対戦履歴を自動取り込みするための、GitHub Actions用スクレイパーです。
**Playwright（ヘッドレスブラウザ）は使いません。** ログインも対戦履歴の取得も、HTTPリクエストだけで
行います。ブラウザを一切起動しないので軽量です。結果を**GitHubのGist（非公開）**にアップロードします。

## 重要：Bot対策との攻防について、正直な現状

これまでの経緯で、Capcom側のCloudflare Bot対策には最低でも2種類の壁があることが分かっています。

1. **TLS/HTTP2フィンガープリント判定**：Node.jsの素の`fetch`は、本物のブラウザとは
   通信の "指紋" が違うため、それだけで弾かれることがある（対戦履歴取得側で発生していた403）
2. **JS実行を要求するインタラクティブチャレンジ**（"Just a moment..." 画面）：これは
   TLS指紋をいくら偽装しても回避できない、根本的に別の壁（ログイン側で発生していた）

このバージョンでは **[`got-scraping`](https://github.com/apify/got-scraping)** というライブラリを
導入し、①の対策として本物のブラウザに近いTLS/HTTP2の指紋でリクエストするようにしました。
これは②には効きません。②が起きるログイン自動化（`CAPCOM_ID_EMAIL`/`CAPCOM_ID_PASSWORD`方式）は、
このアップデートでも解決していない可能性が高いです。

**現実的な期待値：**
- 対戦履歴の取得（`SF6_SESSION_COOKIE`を使う方式）は、①の壁だったなら改善する可能性がある
- ログインの自動化（`CAPCOM_ID_EMAIL`方式）は、②の壁である以上、期待しない方がいい

なので、まずは **`SF6_SESSION_COOKIE`方式（後述のCookie取得手順）を優先して試す** ことを勧めます。

## 重要な注意点

- **これは公式のAPI・ログインではありません。** サイトが内部で使っている非公開の仕組みを利用して
  いるため、仕様変更で予告なく壊れる可能性があります。
- **Gistは「secret」＝限定公開です。** 完全非公開（認証必須）にはできません。
- **パスワードを他人と共有しないでください。** GitHubのSecrets以外の場所（コード中への直書きや、
  チャット・チケットへの貼り付けなど）には絶対に置かないでください。

## 仕組み

1. `CAPCOM_ID_EMAIL` / `CAPCOM_ID_PASSWORD` を使い、HTTPのみでCAPCOM IDにログインしてCookieを得る
   （Cookie Jarを自前で持ち、リダイレクトを手動で辿る）
2. そのCookieで対戦履歴API（battlelog.json、直近100戦分）を取得する
3. **差分取得：** 先に既存Gistの中身（前回までの蓄積）を確認し、ページの中身が全部既知の
   `replay_id`だったらそこで打ち切る（毎回100件フルで取り直さない）
4. `replay_id`を主キーとして、既存のGistの中身と突き合わせて新しい対戦だけを追加していく
5. `GIST_TOKEN` を使って、Gist（`GIST_ID`）の2つのファイルを更新する：
   - `battlelog.json` … アプリが読み込む、蓄積済みの対戦履歴（data）
   - `battlelog-raw.json` … 今回の実行で実際にAPIから返ってきた生レスポンス（raw、デバッグ用）
6. アプリ側の「マイページ」の戦績にある「🔄 戦績データを更新」（＝ここまでの1〜5を実行するだけ）と
   「⬇ 戦績を取り込む」（＝Gistの中身をアプリに取り込む）は別ボタンです。数分待ってから「取り込む」を押してください。

**エラー・レート制限への対応：**
- リクエストごとに `SF6_REQUEST_DELAY_MS`（デフォルト400ms）だけ間隔を空ける
- `429`（レート制限）・`5xx`（サーバーエラー）は指数バックオフで最大3回リトライ
- `401`（認証切れ）・`403`（アクセス拒否）・`404`（URL不正）は即座に諦める

## セットアップ手順

### 1. このフォルダの中身でリポジトリを作る
GitHubで新しい**プライベートリポジトリ**を作成し、このフォルダ一式をpushしてください。

### 2. 自分のプレイヤーID（fighter ID）を確認する
プロフィールページURL末尾の数字です（例：`1229292585`）。

### 3. Gistを1つ作っておく
1. https://gist.github.com を開く
2. ファイル名を `battlelog.json`、中身は `[]` とだけ入力
3. 右下の「Create secret gist」をクリック（**public gistではなくsecret gistを選ぶこと**）
4. 作成後のURL末尾の英数字列が **GIST_ID** です

### 4. Personal Access Tokenを作る（Gist更新用）
1. https://github.com/settings/tokens (classic) を開く
2. 「Generate new token (classic)」→ スコープは **`gist`のみ** にチェック
3. 生成されたトークンが **GIST_TOKEN** です

### 5. GitHub Secretsに登録する
リポジトリの Settings → Secrets and variables → Actions → New repository secret で、以下4つを登録：
- `CAPCOM_ID_EMAIL` … CAPCOM IDのログインメールアドレス
- `CAPCOM_ID_PASSWORD` … CAPCOM IDのログインパスワード
- `SF6_FIGHTER_ID` … 手順2のプレイヤーID
- `GIST_TOKEN` … 手順4のトークン
- `GIST_ID` … 手順3のGist ID

### 6. 実行してみる
Actionsタブから `Scrape SF6 battlelog` を手動実行（workflow_dispatch）してみてください。
失敗した場合は、実行結果の「Artifacts」から `debug-output` をダウンロードして、
`debug-login-*.html` の中身を確認してください（そのHTMLを見せてもらえれば調整できます）。

### 7. アプリに取り込む
アプリの「設定 → 対戦履歴の取り込み設定」の②に、以下の形式のURLを一度入れて取得しておくと、
以降は「マイページ」の「⬇ 戦績を取り込む」ボタンから直接取り込めるようになります：

```
https://gist.githubusercontent.com/あなたのユーザー名/GIST_ID/raw/battlelog.json
```

## Cookie方式へのフォールバック

HTTPログインがどうしても安定しない場合は、`CAPCOM_ID_EMAIL` / `CAPCOM_ID_PASSWORD` の代わりに
`SF6_SESSION_COOKIE` を設定すれば、その方式（ログイン中のブラウザからコピーしたCookieを直接使う）
で動きます。取得手順：

1. 普段使っているブラウザで `https://www.streetfighter.com/6/buckler` を開き、CAPCOM IDでログインする
2. 開発者ツール → 「Network」タブ → ページをリロード
3. `streetfighter.com` 宛のリクエストの `Cookie` ヘッダーの値を丸ごとコピー
4. `SF6_SESSION_COOKIE` としてSecretsに登録（`CAPCOM_ID_EMAIL`は登録しないでおく）

この方式はCookieがいずれ切れるので、数週間〜数ヶ月おきに手動更新が必要です。
