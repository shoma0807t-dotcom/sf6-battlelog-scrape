// Buckler's Boot Camp（SF6公式サイト）内部APIから対戦履歴を直接取得し、
// スト6攻略ノートアプリがそのままインポートできる形式でGistへアップロードする。
//
// 方針：
// - Playwright等のブラウザ自動化は使わない（Bot対策に検知されうるため）。
//   ログインも素のHTTPリクエスト（fetch + 手作りCookie Jar）だけで行う。
//   ブラウザを一切起動しないので、Bot判定の対象になりようがない。
// - ログイン方法は2通り対応：
//   ① CAPCOM_ID_EMAIL / CAPCOM_ID_PASSWORD が設定されていれば、毎回HTTPでログインしてCookieを得る
//   ② SF6_SESSION_COOKIE が設定されていれば、それをそのまま使う（①が使えない場合の手動フォールバック）
// - replay_id を主キーとした差分取得（前回までに取得済みのreplay_idに行き当たったら
//   それ以降のページは取得を打ち切る＝無駄なリクエストをしない）。
// - HTTPステータスごとに挙動を分ける（429は待ってリトライ、401/403は即座に諦める等）。
// - 生のAPIレスポンス（raw）と、アプリ用に蓄積した結果（data）を分けてGistに保存する。
//
// 注意：httpLogin()内のフィールド名（client_id, connection, state, _csrf 等）は
// 実際にDevToolsで確認できた /usernamepassword/login への送信内容そのもの。
// ただし state/_csrf をログインページのHTMLからどう抽出するか、POST後のレスポンスが
// リダイレクトかHTML自動送信フォームかは未検証。失敗した場合は
// output/debug-login-*.html にその時点のレスポンスを保存するので、それを見て調整する。
//
// 必要な環境変数（GitHub Secrets経由で渡す想定）:
//   CAPCOM_ID_EMAIL      … CAPCOM IDのログインメールアドレス（①の方式・推奨）
//   CAPCOM_ID_PASSWORD   … CAPCOM IDのログインパスワード（①の方式・推奨）
//   SF6_SESSION_COOKIE  … ログイン済みブラウザからコピーしたCookie文字列（②の方式・フォールバック）
//   SF6_FIGHTER_ID       … 自分のCFNプレイヤーID（プロフィールページURLの数字部分）
//   SF6_LOCALE           … 省略時 "ja-jp"
//   SF6_MAX_PAGES         … 省略時 20（安全のための上限ページ数）
//   SF6_REQUEST_DELAY_MS   … 省略時 400（各リクエストの間隔・レート制限対策）
//   GIST_TOKEN            … Gist更新用のPersonal Access Token（gistスコープ）
//   GIST_ID               … 更新先のGist ID

const fs = require("fs");
const path = require("path");

const EMAIL = process.env.CAPCOM_ID_EMAIL || "";
const PASSWORD = process.env.CAPCOM_ID_PASSWORD || "";
const MANUAL_COOKIE = process.env.SF6_SESSION_COOKIE || "";
const FIGHTER_ID = process.env.SF6_FIGHTER_ID || "";
const LOCALE = process.env.SF6_LOCALE || "ja-jp";
const MAX_PAGES = parseInt(process.env.SF6_MAX_PAGES || "20", 10);
const REQUEST_DELAY_MS = parseInt(process.env.SF6_REQUEST_DELAY_MS || "400", 10);
const OUT_DIR = path.join(__dirname, "output");

const GIST_TOKEN = process.env.GIST_TOKEN || "";
const GIST_ID = process.env.GIST_ID || "";
const GIST_FILENAME = "battlelog.json";
const GIST_RAW_FILENAME = "battlelog-raw.json";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

if (!EMAIL && !MANUAL_COOKIE) { console.error("CAPCOM_ID_EMAIL/CAPCOM_ID_PASSWORD か SF6_SESSION_COOKIE のいずれかが必要です"); process.exit(1); }
if (EMAIL && !PASSWORD) { console.error("CAPCOM_ID_EMAIL はあるが CAPCOM_ID_PASSWORD がありません"); process.exit(1); }
if (!FIGHTER_ID) { console.error("SF6_FIGHTER_ID が設定されていません"); process.exit(1); }
if (!GIST_TOKEN) { console.error("GIST_TOKEN が設定されていません"); process.exit(1); }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ------------------------------------------------------------------------
   簡易Cookie Jar（ブラウザなしで複数リクエストにまたがってCookieを保持する）
   ------------------------------------------------------------------------ */
class CookieJar {
  constructor() { this.map = new Map(); }
  // fetch()のResponseとgot-scrapingのResponseの両方に対応できるよう、
  // Set-Cookie配列を直接渡す形にしている
  absorbList(setCookieList) {
    (setCookieList || []).forEach((sc) => {
      const pair = sc.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > -1) this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    });
  }
  header() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
}

function extractSetCookies(res) {
  // got-scraping（Node標準のhttpヘッダー）は headers['set-cookie'] が配列
  if (res.headers && res.headers["set-cookie"]) return res.headers["set-cookie"];
  return [];
}

// リダイレクトを自前で1段ずつ辿る（Cookieを都度吸収するため followRedirect:false にしている）。
// got-scraping を使うことで、ログイン系のリクエストにも本物のブラウザに近いTLS/HTTP2の
// 指紋を持たせる。
async function fetchFollow(jar, url, opts = {}, maxHops = 10) {
  const gotScraping = await loadGotScraping();
  let current = url;
  let curOpts = opts;
  for (let i = 0; i < maxHops; i++) {
    const res = await gotScraping({
      url: current,
      method: curOpts.method || "GET",
      body: curOpts.body,
      headers: { "User-Agent": UA, Cookie: jar.header(), ...(curOpts.headers || {}) },
      followRedirect: false,
      throwHttpErrors: false,
      timeout: { request: 30000 },
    });
    jar.absorbList(extractSetCookies(res));
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers.location;
      if (!loc) return res;
      current = new URL(loc, current).toString();
      curOpts = {}; // リダイレクト先へはGETで辿る
      continue;
    }
    return res;
  }
  throw new Error("リダイレクトが多すぎます（10回超）");
}

// ネストしたオブジェクトから指定キーを再帰的に探す（Auth0の設定JSONのネスト位置が
// 分からないため、位置に依存せず値を拾えるようにしている）
function findDeep(obj, key, depth = 0) {
  if (depth > 6 || obj == null || typeof obj !== "object") return undefined;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findDeep(obj[k], key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ログインページのHTMLから state / _csrf を抽出する。
// Auth0 Lock系のページは base64エンコードしたJSON設定を window.atob(...) に埋め込むことが多いので
// まずそれを試し、ダメなら生のHTML中の "state":"..." / "_csrf":"..." を直接拾う。
function extractStateAndCsrf(html) {
  let state, csrf;
  const b64Match = html.match(/window\.atob\(['"]([^'"]+)['"]\)/);
  if (b64Match) {
    try {
      const decoded = decodeURIComponent(escape(Buffer.from(b64Match[1], "base64").toString("binary")));
      const cfg = JSON.parse(decoded);
      state = findDeep(cfg, "state");
      csrf = findDeep(cfg, "_csrf");
    } catch (e) { /* フォールバックへ */ }
  }
  if (!state) { const m = html.match(/"state"\s*:\s*"([^"]+)"/); if (m) state = m[1]; }
  if (!csrf) { const m = html.match(/"_csrf"\s*:\s*"([^"]+)"/); if (m) csrf = m[1]; }
  return { state, csrf };
}

// HTML中の最初の<form>のaction先と、hidden inputの値を抜き出す
// （/usernamepassword/login のレスポンスが「自動送信フォーム」だった場合の中継用）
function extractFirstForm(html) {
  const formMatch = html.match(/<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const action = formMatch[1];
  const body = formMatch[2];
  const inputs = {};
  const inputRe = /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(body))) inputs[m[1]] = m[2];
  return { action, inputs };
}

function saveDebugHtml(name, html) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, name), html);
    console.log(`デバッグ用に ${name} を保存しました`);
  } catch (e) { /* noop */ }
}

// CAPCOM IDのメール・パスワードでHTTPのみでログインし、Cookie文字列を返す。
async function httpLogin(email, password) {
  const gotScraping = await loadGotScraping();
  const jar = new CookieJar();

  console.log("ログイン起点へアクセス（リダイレクトを辿ります）");
  const loginPageRes = await fetchFollow(
    jar,
    `https://www.streetfighter.com/6/buckler/${LOCALE}/auth/loginep?redirect_url=/`
  );
  const loginHtml = loginPageRes.body;
  const { state, csrf } = extractStateAndCsrf(loginHtml);
  if (!state || !csrf) {
    saveDebugHtml("debug-login-page.html", loginHtml);
    throw new Error("ログインページから state/_csrf を抽出できませんでした（output/debug-login-page.html を確認してください）");
  }
  console.log("state/_csrf を取得しました");

  const body = {
    client_id: "mVxOARlAyTcJkcFAb8IZoiKYV8qGAH9a",
    connection: "Username-Password-Authentication",
    password,
    popup_options: {},
    protocol: "oauth2",
    redirect_uri: "https://cid.capcom.com/ja/loginCallback",
    response_type: "code",
    scope: "openid profile email",
    show_sing_up: "0",
    sso: true,
    state,
    tenant: "capcom",
    ui_locales: "ja",
    username: email,
    _csrf: csrf,
    _intstate: "deprecated",
  };

  console.log("ユーザー名・パスワードを送信します");
  let res = await gotScraping({
    url: "https://auth.cid.capcom.com/usernamepassword/login",
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      "Origin": "https://auth.cid.capcom.com",
      "Referer": loginPageRes.url ? String(loginPageRes.url) : "https://auth.cid.capcom.com/login",
      Cookie: jar.header(),
    },
    body: JSON.stringify(body),
    followRedirect: false,
    throwHttpErrors: false,
    timeout: { request: 30000 },
  });
  jar.absorbList(extractSetCookies(res));

  // ケースA: 素直にリダイレクトが返ってくる場合
  if (res.statusCode >= 300 && res.statusCode < 400) {
    const loc = res.headers.location;
    if (loc) {
      res = await fetchFollow(jar, new URL(loc, "https://auth.cid.capcom.com").toString());
    }
  } else if (res.statusCode >= 200 && res.statusCode < 300) {
    // ケースB: Auth0特有の「自動送信フォームを含むHTML」が返ってくる場合
    const html = res.body;
    const form = extractFirstForm(html);
    if (!form) {
      saveDebugHtml("debug-login-response.html", html);
      throw new Error("ログイン後のレスポンスを解釈できませんでした（output/debug-login-response.html を確認してください）");
    }
    const formBody = new URLSearchParams(form.inputs).toString();
    res = await fetchFollow(jar, new URL(form.action, "https://auth.cid.capcom.com").toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody,
    });
  } else {
    saveDebugHtml("debug-login-error.html", res.body || "");
    throw new Error(`ログインに失敗しました（HTTP ${res.statusCode}）。output/debug-login-error.html を確認してください。パスワードやフィールド名が変わった可能性があります。`);
  }

  // 最終的に streetfighter.com のドメインに戻ってきているか確認
  const finalUrl = res.url ? String(res.url) : "";
  if (!finalUrl.includes("streetfighter.com")) {
    saveDebugHtml("debug-login-final.html", res.body || "");
    throw new Error(`ログイン後の最終遷移先が streetfighter.com になっていません（${finalUrl}）。output/debug-login-final.html を確認してください。`);
  }

  console.log("ログイン成功。Cookieを取得しました。");
  return jar.header();
}

/* ------------------------------------------------------------------------
   ここから通常の戦績取得（既存のCookie方式ロジックはそのまま）
   ------------------------------------------------------------------------ */

let COOKIE = MANUAL_COOKIE;

function authHeaders() {
  return {
    "Cookie": COOKIE,
    "User-Agent": UA,
    "Accept": "application/json, text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": `https://www.streetfighter.com/6/buckler/${LOCALE}/`,
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

// HTTPステータスに応じて処理を分ける汎用フェッチ。
// 429/5xx系はしばらく待ってリトライ（最大3回）、401/403/404は即座に諦めて呼び出し元に伝える。
// got-scraping はESM専用パッケージなので動的importで読み込む（初回のみ）
let _gotScraping = null;
async function loadGotScraping() {
  if (!_gotScraping) {
    const mod = await import("got-scraping");
    _gotScraping = mod.gotScraping;
  }
  return _gotScraping;
}

async function fetchWithRetry(url, { maxRetries = 3 } = {}) {
  const gotScraping = await loadGotScraping();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await gotScraping({
        url,
        headers: authHeaders(),
        throwHttpErrors: false,
        timeout: { request: 30000 },
        // ヘッダーは自前で全部指定するので、got-scraping側の自動生成で上書きさせない
        headerGeneratorOptions: undefined,
      });
    } catch (e) {
      if (attempt === maxRetries) throw new Error(`ネットワークエラー: ${e.message}（${url}）`);
      const waitMs = 1000 * Math.pow(2, attempt);
      console.warn(`通信エラー（${e.message}）。${waitMs}ms待ってリトライします（${attempt + 1}/${maxRetries}）`);
      await sleep(waitMs);
      continue;
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return res;

    if (res.statusCode === 401) {
      throw new Error("HTTP 401: 認証切れです。Cookieが無効になっています。");
    }
    if (res.statusCode === 403) {
      throw new Error("HTTP 403: アクセス拒否されました（Bot判定等）。連続で叩き続けると悪化する可能性があるため、ここで中断します。");
    }
    if (res.statusCode === 404) {
      throw new Error(`HTTP 404: ${url} が見つかりませんでした（URLの形式が変わった可能性があります）。`);
    }
    if (res.statusCode === 429 || res.statusCode >= 500) {
      if (attempt === maxRetries) throw new Error(`HTTP ${res.statusCode}: リトライ上限に達しました（${url}）`);
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
      console.warn(`HTTP ${res.statusCode} を受け取りました。${waitMs}ms待ってリトライします（${attempt + 1}/${maxRetries}）`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`HTTP ${res.statusCode}: 予期しないエラー（${url}）`);
  }
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  return res.body;
}

// プロフィールページのHTMLから __NEXT_DATA__ に埋め込まれた buildId を取り出す。
async function getBuildId() {
  const html = await fetchText(`https://www.streetfighter.com/6/buckler/${LOCALE}/profile/${FIGHTER_ID}`);
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("__NEXT_DATA__ が見つかりませんでした（ページ構造が変わった、またはCookieが無効な可能性があります）");
  const data = JSON.parse(m[1]);
  if (!data.buildId) throw new Error("buildId が取得できませんでした");
  return data.buildId;
}

async function fetchBattlelogPage(buildId, page) {
  const url = `https://www.streetfighter.com/6/buckler/_next/data/${buildId}/${LOCALE}/profile/${FIGHTER_ID}/battlelog.json?page=${page}&sid=${FIGHTER_ID}`;
  const text = await fetchText(url);
  return JSON.parse(text);
}

// 既存Gistの中身（前回までに蓄積した対戦履歴・data側）を取得する。
async function fetchExistingReplays() {
  if (!GIST_ID) return [];
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      "Authorization": `Bearer ${GIST_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    console.warn(`既存Gistの取得に失敗しました（HTTP ${res.status}）。新規扱いとして続行します。`);
    return [];
  }
  const gist = await res.json();
  const file = gist.files && gist.files[GIST_FILENAME];
  if (!file || !file.content) return [];
  try {
    const parsed = JSON.parse(file.content);
    const pp = parsed.pageProps || parsed;
    return pp.replay_list || [];
  } catch (e) {
    console.warn("既存Gistの中身のパースに失敗しました。新規扱いとして続行します。");
    return [];
  }
}

// Gistの複数ファイルをまとめて更新する。
async function uploadToGist(files) {
  const headers = {
    "Authorization": `Bearer ${GIST_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  if (GIST_ID) {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ files }),
    });
    if (!res.ok) throw new Error(`Gistの更新に失敗しました: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    console.log("Gistを更新しました:", data.html_url);
    return data;
  }
  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers,
    body: JSON.stringify({ description: "SF6 battlelog (sf6-note用)", public: false, files }),
  });
  if (!res.ok) throw new Error(`Gistの作成に失敗しました: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log("=====================================================");
  console.log("新しいGistを作成しました。次回以降も同じGistを更新するために、");
  console.log("リポジトリのSecretsに GIST_ID を以下の値で追加登録してください：");
  console.log("GIST_ID =", data.id);
  console.log("Gist URL:", data.html_url);
  console.log("=====================================================");
  return data;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (EMAIL) {
    COOKIE = await httpLogin(EMAIL, PASSWORD);
  } else {
    console.log("SF6_SESSION_COOKIE（手動Cookie）を使用します。");
  }

  // 差分取得のため、先に既存データ（前回までの蓄積）を取得しておく
  console.log("既存のGistの中身を確認します。");
  const existingReplays = await fetchExistingReplays();
  const existingIds = new Set(existingReplays.map((r) => r.replay_id));
  console.log(`既存: ${existingReplays.length}件`);

  const buildId = await getBuildId();
  console.log("buildId:", buildId);

  let fighterBannerInfo = null;
  const allReplays = [];
  const rawPages = [];

  for (let p = 1; p <= MAX_PAGES; p++) {
    if (p > 1) await sleep(REQUEST_DELAY_MS); // レート制限対策：リクエスト間隔を空ける

    let data;
    try {
      data = await fetchBattlelogPage(buildId, p);
    } catch (e) {
      console.warn(`page ${p} の取得を中断します:`, e.message);
      break;
    }
    rawPages.push({ page: p, fetched_at: new Date().toISOString(), data });

    const pp = data.pageProps || {};
    if (!fighterBannerInfo) fighterBannerInfo = pp.fighter_banner_info;
    const list = pp.replay_list || [];
    console.log(`page ${p}: ${list.length}件 (total_page=${pp.total_page})`);
    allReplays.push(...list);

    const allKnown = list.length > 0 && list.every((r) => existingIds.has(r.replay_id));
    if (allKnown) {
      console.log(`page ${p} は既知のデータのみでした。これ以降の取得を打ち切ります。`);
      break;
    }
    if (!list.length || (pp.total_page && p >= pp.total_page)) break;
  }

  console.log(`今回の取得: ${allReplays.length}件`);

  const newReplays = allReplays.filter((r) => !existingIds.has(r.replay_id));
  const merged = [...existingReplays, ...newReplays]
    .sort((a, b) => (a.uploaded_at || 0) - (b.uploaded_at || 0));

  console.log(`新規: ${newReplays.length}件 / 累計: ${merged.length}件`);

  const dataOutput = {
    pageProps: {
      fighter_banner_info: fighterBannerInfo,
      replay_list: merged,
      fetched_at: new Date().toISOString(),
    },
  };
  const dataText = JSON.stringify(dataOutput, null, 2);
  const rawText = JSON.stringify({ fetched_at: new Date().toISOString(), pages: rawPages }, null, 2);

  fs.writeFileSync(path.join(OUT_DIR, GIST_FILENAME), dataText);
  fs.writeFileSync(path.join(OUT_DIR, GIST_RAW_FILENAME), rawText);

  await uploadToGist({
    [GIST_FILENAME]: { content: dataText },
    [GIST_RAW_FILENAME]: { content: rawText },
  });
}

main().catch((e) => {
  console.error("失敗:", e.message);
  process.exit(1);
});
