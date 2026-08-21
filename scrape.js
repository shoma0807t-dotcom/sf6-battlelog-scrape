// Buckler's Boot Camp（SF6公式サイト）内部APIから対戦履歴を直接取得し、
// スト6攻略ノートアプリがそのままインポートできる形式でGistへアップロードする。
//
// v6: got-scraping（HTTP-onlyのTLS/HTTP2フィンガープリント偽装）をやめ、
//     Playwright（Chromiumヘッドレス）で「実ブラウザ」として動かす方式に変更。
//     理由：Cloudflareの「JS実行を要求するインタラクティブチャレンジ」は、
//     HTTPリクエストだけでは原理的に突破できない（TLS指紋をいくら偽装しても無関係）。
//     実際にJSを実行できるブラウザで開けば、チャレンジは自動的に解決される。
//     （参考: https://github.com/alanoliveira/sfbuff もHTTPクライアントが
//      失敗した場合はSelenium+Chromiumにフォールバックしている）
//
// 流れ：
// 1. SF6_SESSION_COOKIE をパースして、Playwrightのbrowser contextにCookieとして注入
// 2. Bucklerトップページへ実際にブラウザで遷移（Cloudflareのチャレンジがあれば自動解決を待つ）
// 3. ページ内のグローバル変数 window.__NEXT_DATA__ から buildId を取得
// 4. battlelog.json（page=1〜10）を「ブラウザの中のfetch()」として叩く
//    （cf_clearance等のセッションCookieがブラウザに保持されたまま送信されるため、
//      素のHTTPリクエストより通りやすい）
// 5. 既存Gistの中身と replay_id で突き合わせ、新規分だけ追加してGistを更新
//
// 必要な環境変数（GitHub Secrets経由で渡す想定）:
//   SF6_SESSION_COOKIE   … ログイン済みブラウザからコピーしたCookie文字列（必須）
//   SF6_FIGHTER_ID       … 自分のCFNプレイヤーID（プロフィールページURLの数字部分）
//   SF6_LOCALE           … 省略時 "ja-jp"
//   SF6_REQUEST_DELAY_MS … 省略時 800（各リクエストの間隔・レート制限対策）
//   GIST_TOKEN           … Gist更新用のPersonal Access Token（gistスコープ）
//   GIST_ID              … 更新先のGist ID
//
// 事前準備（package.json の postinstall、またはCIのステップで）:
//   npx playwright install --with-deps chromium

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const COOKIE_STRING = process.env.SF6_SESSION_COOKIE || "";
const FIGHTER_ID = process.env.SF6_FIGHTER_ID || "";
const LOCALE = process.env.SF6_LOCALE || "ja-jp";
const REQUEST_DELAY_MS = parseInt(process.env.SF6_REQUEST_DELAY_MS || "800", 10);
const MAX_PAGES = 10; // page=1〜10固定
const NAV_TIMEOUT_MS = 45000;
const OUT_DIR = path.join(__dirname, "output");

const GIST_TOKEN = process.env.GIST_TOKEN || "";
const GIST_ID = process.env.GIST_ID || "";
const GIST_FILENAME = "battlelog.json";
const GIST_RAW_FILENAME = "battlelog-raw.json";

const SITE_URL = "https://www.streetfighter.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

if (!COOKIE_STRING) { console.error("SF6_SESSION_COOKIE が設定されていません"); process.exit(1); }
if (!FIGHTER_ID) { console.error("SF6_FIGHTER_ID が設定されていません"); process.exit(1); }
if (!GIST_TOKEN) { console.error("GIST_TOKEN が設定されていません"); process.exit(1); }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function saveDebugFile(name, content) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, name), content);
    console.log(`デバッグ用に ${name} を保存しました`);
  } catch (e) { /* noop */ }
}

async function saveDebugSnapshot(page, label) {
  const stamp = Date.now();
  try {
    const html = await page.content();
    saveDebugFile(`debug-${label}-${stamp}.html`, html);
  } catch (e) { /* noop */ }
  try {
    await page.screenshot({ path: path.join(OUT_DIR, `debug-${label}-${stamp}.png`), fullPage: true });
    console.log(`デバッグ用に debug-${label}-${stamp}.png を保存しました`);
  } catch (e) { /* noop */ }
}

// "name1=value1; name2=value2" 形式の文字列を Playwright の addCookies 用配列にパースする。
// README手順どおり streetfighter.com 宛リクエストの Cookie ヘッダーを丸ごとコピーした前提。
function parseCookieString(str) {
  return str
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        url: SITE_URL,
      };
    });
}

// Bucklerトップページへ遷移し、Cloudflareのチャレンジ（あれば）が解決して
// 実際のNext.jsページ（window.__NEXT_DATA__）が現れるまで待つ。
async function gotoAndWaitForNextData(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  try {
    await page.waitForFunction(() => !!window.__NEXT_DATA__, { timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    await saveDebugSnapshot(page, label);
    throw new Error(`ページの読み込みがタイムアウトしました（Cloudflareのチャレンジで止まっている、またはCookieが無効な可能性。output/debug-${label}-*.html/.png を確認してください）`);
  }
}

async function getBuildId(page) {
  console.log("Bucklerトップページを開きます。");
  await gotoAndWaitForNextData(page, `${SITE_URL}/6/buckler/${LOCALE}`, "top");
  const buildId = await page.evaluate(() => window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId);
  if (!buildId) {
    await saveDebugSnapshot(page, "top-no-buildid");
    throw new Error("buildId が取得できませんでした");
  }
  return buildId;
}

// battlelog.json をブラウザ内の fetch() として叩く（cf_clearance等のCookieがそのまま使われる）。
async function fetchBattlelogPageOnce(page, buildId, pageNum) {
  const url = `${SITE_URL}/6/buckler/_next/data/${buildId}/${LOCALE}/profile/${FIGHTER_ID}/battlelog.json?page=${pageNum}&sid=${FIGHTER_ID}`;
  const result = await page.evaluate(async (u) => {
    try {
      const res = await fetch(u, {
        headers: { "x-nextjs-data": "1", "Accept": "application/json, text/plain, */*" },
      });
      const text = await res.text();
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: true, status: res.status, text, headers };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, url);

  if (!result.ok) throw new Error(`ネットワークエラー: ${result.error}（page ${pageNum}）`);

  // エラー時に実際に何が返ってきたかを保存できるよう、常に生データを持たせておく
  const responseDump = [
    `URL: ${url}`,
    `Status: ${result.status}`,
    `cf-ray: ${result.headers["cf-ray"] || "(なし)"}`,
    `cf-mitigated: ${result.headers["cf-mitigated"] || "(なし)"}`,
    `content-type: ${result.headers["content-type"] || "(なし)"}`,
    `server: ${result.headers["server"] || "(なし)"}`,
    "",
    "----- body -----",
    result.text || "(空)",
  ].join("\n");

  if (result.status !== 200) {
    const err = { responseDump };
    if (result.status === 401) throw Object.assign(err, { retryable: false, message: `HTTP 401: 認証切れです。SF6_SESSION_COOKIE が無効になっています（page ${pageNum}）。` });
    if (result.status === 403) throw Object.assign(err, { retryable: true, message: `HTTP 403: アクセス拒否されました（page ${pageNum}）。` });
    if (result.status === 404) throw Object.assign(err, { retryable: false, message: `HTTP 404: ${url} が見つかりませんでした（page ${pageNum}）。` });
    if (result.status === 429 || result.status >= 500) throw Object.assign(err, { retryable: true, message: `HTTP ${result.status}（page ${pageNum}）。` });
    throw Object.assign(err, { retryable: false, message: `HTTP ${result.status}: 予期しないエラー（page ${pageNum}）。` });
  }

  try {
    return JSON.parse(result.text);
  } catch (e) {
    throw { retryable: true, message: `page ${pageNum}: JSONではないレスポンスが返ってきました（チャレンジ画面の可能性）。`, notJson: true, responseDump };
  }
}

async function fetchBattlelogPage(page, buildId, pageNum, { maxRetries = 3 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchBattlelogPageOnce(page, buildId, pageNum);
    } catch (e) {
      const retryable = typeof e === "object" && e !== null && "retryable" in e ? e.retryable : false;
      const message = typeof e === "object" && e !== null && "message" in e ? e.message : String(e);
      const responseDump = typeof e === "object" && e !== null ? e.responseDump : undefined;

      if (!retryable || attempt === maxRetries) {
        if (responseDump) {
          saveDebugFile(`debug-battlelog-page${pageNum}-response-${Date.now()}.txt`, responseDump);
        }
        await saveDebugSnapshot(page, `battlelog-page${pageNum}-pagestate`);
        throw new Error(`${message}（output/debug-battlelog-page${pageNum}-response-*.txt を確認してください。page-state系のhtml/pngは実際のAPIレスポンスではなく、その時点のブラウザ画面です）`);
      }
      const waitMs = 1000 * Math.pow(2, attempt);
      console.warn(`${message} ${waitMs}ms待ってリトライします（${attempt + 1}/${maxRetries}）`);
      await sleep(waitMs);
      // チャレンジで弾かれた可能性があるので、リトライ前にトップページを踏み直してセッションを温め直す
      if (e && e.notJson) {
        try { await gotoAndWaitForNextData(page, `${SITE_URL}/6/buckler/${LOCALE}`, `retry-top-page${pageNum}`); } catch (_) { /* 次のリトライへ */ }
      }
    }
  }
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

  // 差分取得のため、先に既存データ（前回までの蓄積）を取得しておく
  console.log("既存のGistの中身を確認します。");
  const existingReplays = await fetchExistingReplays();
  const existingIds = new Set(existingReplays.map((r) => r.replay_id));
  console.log(`既存: ${existingReplays.length}件`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  let allReplays = [];
  let rawPages = [];
  let fighterBannerInfo = null;

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "ja-JP",
      viewport: { width: 1280, height: 800 },
      timezoneId: "Asia/Tokyo",
    });

    // Playwright/Puppeteer等の自動操作ブラウザは navigator.webdriver = true や
    // 空の navigator.plugins など、素のChromiumには無い痕跡を残す。
    // Cloudflareのbot管理はこれをフィンガープリントの一部として見ているため、
    // ページ読み込み前にJSで上書きして「普通のブラウザ」に近づける。
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["ja-JP", "ja"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      // eslint-disable-next-line no-undef
      window.chrome = window.chrome || { runtime: {} };
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    });

    await context.addCookies(parseCookieString(COOKIE_STRING));
    const page = await context.newPage();

    const buildId = await getBuildId(page);
    console.log("buildId:", buildId);

    // 取得直前に少し待つ（トップページ表示直後に即APIを叩くのは機械的に見えるため）
    await sleep(1500);

    for (let p = 1; p <= MAX_PAGES; p++) {
      if (p > 1) await sleep(REQUEST_DELAY_MS); // レート制限対策：リクエスト間隔を空ける

      let data;
      try {
        data = await fetchBattlelogPage(page, buildId, p);
      } catch (e) {
        console.warn(`page ${p} の取得を中断します:`, e.message);
        break;
      }
      console.log(`page ${p}: JSON取得OK`);
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
  } finally {
    await browser.close();
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
