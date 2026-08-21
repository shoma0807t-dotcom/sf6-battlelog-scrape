// Buckler's Boot Camp（SF6公式サイト）内部APIから対戦履歴を直接取得し、
// スト6攻略ノートアプリがそのままインポートできる形式でGistへアップロードする。
//
// v7: ブラウザ自動操作をPlaywrightからSelenium WebDriverに置き換え。
//     流れは3段階：
//       1. SF6_SESSION_COOKIE を注入して battlelog.json を試す
//       2. ダメだった場合、CAPCOM_ID_EMAIL/PASSWORD があればログインフォームへの
//          入力・送信を試す（※ログインページにCloudflare Turnstileのチェック
//          ボックスが出た場合、それを自動で解く処理は一切実装しない。検知したら
//          即座にエラーとして報告し、そこで止まる）
//       3. ログインが成功していれば（streetfighter.comに戻ってきていれば）、
//          そのセッションのCookieを取得し直して 1. をもう一度試す
//
// 必要な環境変数（GitHub Secrets経由で渡す想定）:
//   SF6_SESSION_COOKIE   … ログイン済みブラウザからコピーしたCookie文字列
//   CAPCOM_ID_EMAIL      … CAPCOM IDのログインメールアドレス（任意）
//   CAPCOM_ID_PASSWORD   … CAPCOM IDのログインパスワード（EMAILとセットで使用）
//   SF6_FIGHTER_ID       … 自分のCFNプレイヤーID（プロフィールページURLの数字部分）
//   SF6_LOCALE           … 省略時 "ja-jp"
//   SF6_REQUEST_DELAY_MS … 省略時 800（各リクエストの間隔・レート制限対策）
//   GIST_TOKEN           … Gist更新用のPersonal Access Token（gistスコープ）
//   GIST_ID              … 更新先のGist ID
//
// 事前準備（CIのステップで）:
//   Chrome本体とバージョンの合ったchromedriverをPATHに用意しておくこと
//   （scrape.yml では browser-actions/setup-chrome + nanasess/setup-chromedriver を使用）

const fs = require("fs");
const path = require("path");
const { Builder, By } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const COOKIE_STRING = process.env.SF6_SESSION_COOKIE || "";
const EMAIL = process.env.CAPCOM_ID_EMAIL || "";
const PASSWORD = process.env.CAPCOM_ID_PASSWORD || "";
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
const SITE_HOST = "www.streetfighter.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

if (!COOKIE_STRING && !EMAIL) { console.error("SF6_SESSION_COOKIE か CAPCOM_ID_EMAIL のいずれかが必要です"); process.exit(1); }
if (EMAIL && !PASSWORD) { console.error("CAPCOM_ID_EMAIL はあるが CAPCOM_ID_PASSWORD がありません"); process.exit(1); }
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

async function saveDebugSnapshot(driver, label) {
  const stamp = Date.now();
  try {
    const html = await driver.getPageSource();
    saveDebugFile(`debug-${label}-${stamp}.html`, html);
  } catch (e) { /* noop */ }
  try {
    const png = await driver.takeScreenshot();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, `debug-${label}-${stamp}.png`), png, "base64");
    console.log(`デバッグ用に debug-${label}-${stamp}.png を保存しました`);
  } catch (e) { /* noop */ }
}

// "name1=value1; name2=value2" 形式の文字列をパースする。
function parseCookieString(str) {
  return str
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    });
}

async function buildDriver() {
  const options = new chrome.Options();
  options.addArguments(
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1280,800",
    `--user-agent=${UA}`,
    "--lang=ja-JP",
    "--disable-blink-features=AutomationControlled"
  );
  options.excludeSwitches("enable-automation");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(options).build();
  await driver.manage().setTimeouts({ script: 30000, pageLoad: NAV_TIMEOUT_MS });
  return driver;
}

// Cookie文字列をブラウザに注入する。Seleniumは「今開いているページと同じドメイン」の
// Cookieしか追加できないため、先に対象ドメインへ一度アクセスしてから注入する。
async function injectCookies(driver, cookieString) {
  await driver.get(`${SITE_URL}/6/buckler/${LOCALE}`);
  for (const c of parseCookieString(cookieString)) {
    try {
      await driver.manage().addCookie({ name: c.name, value: c.value, domain: SITE_HOST, path: "/" });
    } catch (e) {
      console.warn(`Cookie "${c.name}" の追加に失敗しました: ${e.message}`);
    }
  }
}

// ページ内のグローバル変数 window.__NEXT_DATA__ が現れるまで待つ
// （＝Next.jsアプリとして正常にレンダリングされた状態）。
async function waitForNextData(driver, label, timeoutMs = NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const has = await driver.executeScript("return !!window.__NEXT_DATA__;").catch(() => false);
    if (has) return true;
    await sleep(500);
  }
  await saveDebugSnapshot(driver, label);
  return false;
}

async function getBuildId(driver) {
  console.log("Bucklerトップページを開きます。");
  await driver.get(`${SITE_URL}/6/buckler/${LOCALE}`);
  const ok = await waitForNextData(driver, "top-timeout");
  if (!ok) throw new Error("ページの読み込みがタイムアウトしました（output/debug-top-timeout-*.html/.png を確認してください）");
  const buildId = await driver.executeScript("return window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId;");
  if (!buildId) {
    await saveDebugSnapshot(driver, "top-no-buildid");
    throw new Error("buildId が取得できませんでした");
  }
  return buildId;
}

// 現在のページがCloudflare Turnstile等のチャレンジ画面かどうかを判定する。
// 突破は一切試みない。検知したらそのまま呼び出し元にエラーを返すためだけの関数。
async function isChallengePage(driver) {
  try {
    const title = await driver.getTitle();
    if (/just a moment/i.test(title)) return true;
    const html = await driver.getPageSource();
    if (/challenges\.cloudflare\.com/i.test(html) || /cf-turnstile/i.test(html) || /cType:\s*'managed'/i.test(html)) return true;
  } catch (e) { /* noop */ }
  return false;
}

const USERNAME_SELECTORS = [
  'input[name="username"]', 'input[name="email"]',
  "input#username", "input#email",
  'input[type="email"]', 'input[autocomplete="username"]',
];
const PASSWORD_SELECTORS = [
  'input[name="password"]', "input#password",
  'input[type="password"]', 'input[autocomplete="current-password"]',
];
const SUBMIT_SELECTORS = [
  'button[type="submit"]', 'button[name="action"]', 'input[type="submit"]',
];

async function findFirstVisible(driver, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = await driver.findElement(By.css(sel));
        if (await el.isDisplayed()) return el;
      } catch (e) { /* この候補は無し、次へ */ }
    }
    await sleep(300);
  }
  return null;
}

// CAPCOM IDへのログインを試みる。Turnstile等のチャレンジが出た場合は
// 突破を試みず、その場で検知してエラーにする。
async function loginWithCredentials(driver) {
  console.log("CAPCOM IDでログインを試みます。");
  await driver.get(`${SITE_URL}/6/buckler/${LOCALE}/auth/loginep?redirect_url=/6/buckler/${LOCALE}`);
  await saveDebugSnapshot(driver, "login-step1-loaded");

  if (await isChallengePage(driver)) {
    throw new Error("ログインページでCloudflare Turnstile等のチャレンジが検出されました。自動では突破しません。手動でCookieを取得する方式に切り替えてください（output/debug-login-step1-loaded-*.html/.png を確認してください）。");
  }

  const usernameField = await findFirstVisible(driver, USERNAME_SELECTORS);
  if (!usernameField) {
    await saveDebugSnapshot(driver, "login-no-username-field");
    throw new Error("ログインフォームのメール/ユーザー名欄が見つかりませんでした（output/debug-login-*.html/.png を確認してください）");
  }
  await usernameField.sendKeys(EMAIL);

  let passwordField = await findFirstVisible(driver, PASSWORD_SELECTORS, 1500);
  if (!passwordField) {
    const nextButton = await findFirstVisible(driver, SUBMIT_SELECTORS);
    if (!nextButton) {
      await saveDebugSnapshot(driver, "login-no-next-button");
      throw new Error("メール入力後の「次へ」ボタンが見つかりませんでした（output/debug-login-*.html/.png を確認してください）");
    }
    await nextButton.click();
    await saveDebugSnapshot(driver, "login-step2-after-username-submit");

    if (await isChallengePage(driver)) {
      throw new Error("メール送信後にCloudflare Turnstile等のチャレンジが検出されました。自動では突破しません（output/debug-login-step2-*.html/.png を確認してください）。");
    }
    passwordField = await findFirstVisible(driver, PASSWORD_SELECTORS);
  }
  if (!passwordField) {
    await saveDebugSnapshot(driver, "login-no-password-field");
    throw new Error("ログインフォームのパスワード欄が見つかりませんでした（output/debug-login-*.html/.png を確認してください）");
  }
  await passwordField.sendKeys(PASSWORD);

  const loginButton = await findFirstVisible(driver, SUBMIT_SELECTORS);
  if (!loginButton) {
    await saveDebugSnapshot(driver, "login-no-submit-button");
    throw new Error("ログインボタンが見つかりませんでした（output/debug-login-*.html/.png を確認してください）");
  }
  await loginButton.click();
  await sleep(2000);
  await saveDebugSnapshot(driver, "login-result");

  if (await isChallengePage(driver)) {
    throw new Error("ログイン送信後にCloudflare Turnstile等のチャレンジが検出されました。自動では突破しません（output/debug-login-result-*.html/.png を確認してください）。");
  }

  const url = await driver.getCurrentUrl();
  if (!url.includes(SITE_HOST)) {
    throw new Error(`ログイン後にstreetfighter.comへ戻ってきませんでした（現在のURL: ${url}）。メールアドレス/パスワードが誤っている可能性があります（output/debug-login-result-*.html/.png を確認してください）。`);
  }
  console.log("ログインに成功したとみられます。streetfighter.com に戻りました。");
}

// battlelog.json をブラウザ内の fetch() として叩く。
async function fetchBattlelogPageOnce(driver, buildId, pageNum) {
  const url = `${SITE_URL}/6/buckler/_next/data/${buildId}/${LOCALE}/profile/${FIGHTER_ID}/battlelog.json?page=${pageNum}&sid=${FIGHTER_ID}`;
  const result = await driver.executeAsyncScript(function (u, callback) {
    fetch(u, { headers: { "x-nextjs-data": "1", "Accept": "application/json, text/plain, */*" } })
      .then(function (res) {
        res.text().then(function (text) {
          var headers = {};
          res.headers.forEach(function (v, k) { headers[k] = v; });
          callback({ ok: true, status: res.status, text: text, headers: headers });
        });
      })
      .catch(function (e) { callback({ ok: false, error: String(e) }); });
  }, url);

  if (!result.ok) throw new Error(`ネットワークエラー: ${result.error}（page ${pageNum}）`);

  const responseDump = [
    `URL: ${url}`,
    `Status: ${result.status}`,
    `cf-ray: ${result.headers["cf-ray"] || "(なし)"}`,
    `cf-mitigated: ${result.headers["cf-mitigated"] || "(なし)"}`,
    `content-type: ${result.headers["content-type"] || "(なし)"}`,
    "",
    "----- body -----",
    result.text || "(空)",
  ].join("\n");

  if (result.status !== 200) {
    const err = { responseDump };
    if (result.status === 401) throw Object.assign(err, { authFailed: true, retryable: false, message: `HTTP 401（page ${pageNum}）。` });
    if (result.status === 403) throw Object.assign(err, { authFailed: true, retryable: true, message: `HTTP 403（page ${pageNum}）。` });
    if (result.status === 404) throw Object.assign(err, { retryable: false, message: `HTTP 404: ${url}（page ${pageNum}）。` });
    if (result.status === 429 || result.status >= 500) throw Object.assign(err, { retryable: true, message: `HTTP ${result.status}（page ${pageNum}）。` });
    throw Object.assign(err, { retryable: false, message: `HTTP ${result.status}（page ${pageNum}）。` });
  }
  try {
    return JSON.parse(result.text);
  } catch (e) {
    throw { retryable: true, authFailed: true, message: `page ${pageNum}: JSONではないレスポンス。`, notJson: true, responseDump };
  }
}

async function fetchBattlelogPage(driver, buildId, pageNum, { maxRetries = 2 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchBattlelogPageOnce(driver, buildId, pageNum);
    } catch (e) {
      const retryable = e && e.retryable;
      const message = (e && e.message) || String(e);
      if (!retryable || attempt === maxRetries) {
        if (e && e.responseDump) saveDebugFile(`debug-battlelog-page${pageNum}-response-${Date.now()}.txt`, e.responseDump);
        const err = new Error(message);
        err.authFailed = !!(e && e.authFailed);
        throw err;
      }
      const waitMs = 1000 * Math.pow(2, attempt);
      console.warn(`${message} ${waitMs}ms待ってリトライします（${attempt + 1}/${maxRetries}）`);
      await sleep(waitMs);
    }
  }
}

// 既存Gistの中身（前回までに蓄積した対戦履歴・data側）を取得する。
async function fetchExistingReplays() {
  if (!GIST_ID) return [];
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { "Authorization": `Bearer ${GIST_TOKEN}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) { console.warn(`既存Gistの取得に失敗しました（HTTP ${res.status}）。新規扱いとして続行します。`); return []; }
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

async function uploadToGist(files) {
  const headers = { "Authorization": `Bearer ${GIST_TOKEN}`, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
  if (GIST_ID) {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { method: "PATCH", headers, body: JSON.stringify({ files }) });
    if (!res.ok) throw new Error(`Gistの更新に失敗しました: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    console.log("Gistを更新しました:", data.html_url);
    return data;
  }
  const res = await fetch("https://api.github.com/gists", { method: "POST", headers, body: JSON.stringify({ description: "SF6 battlelog (sf6-note用)", public: false, files }) });
  if (!res.ok) throw new Error(`Gistの作成に失敗しました: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  console.log("新しいGistを作成しました。GIST_ID =", data.id, data.html_url);
  return data;
}

// buildIdの取得〜battlelog全ページ取得までを1セットとして実行する。
// 認証エラー（authFailed）で1ページ目から失敗した場合は null を返し、呼び出し元に
// 「セッションが無効だった」と伝える（＝呼び出し元がログインを試す判断材料にする）。
async function tryScrapeAllPages(driver, existingIds) {
  const buildId = await getBuildId(driver);
  console.log("buildId:", buildId);
  await sleep(1000);

  const allReplays = [];
  const rawPages = [];
  let fighterBannerInfo = null;

  for (let p = 1; p <= MAX_PAGES; p++) {
    if (p > 1) await sleep(REQUEST_DELAY_MS);
    let data;
    try {
      data = await fetchBattlelogPage(driver, buildId, p);
    } catch (e) {
      if (p === 1 && e.authFailed) {
        console.warn(`page 1 で認証エラー: ${e.message}`);
        return { sessionInvalid: true };
      }
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
    if (allKnown) { console.log(`page ${p} は既知のデータのみでした。打ち切ります。`); break; }
    if (!list.length || (pp.total_page && p >= pp.total_page)) break;
  }
  return { sessionInvalid: false, allReplays, rawPages, fighterBannerInfo };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("既存のGistの中身を確認します。");
  const existingReplays = await fetchExistingReplays();
  const existingIds = new Set(existingReplays.map((r) => r.replay_id));
  console.log(`既存: ${existingReplays.length}件`);

  const driver = await buildDriver();
  let result;

  try {
    // 1. Cookie を試す
    if (COOKIE_STRING) {
      console.log("① Cookieでの取得を試します。");
      await injectCookies(driver, COOKIE_STRING);
      result = await tryScrapeAllPages(driver, existingIds);
    } else {
      result = { sessionInvalid: true };
    }

    // 2. ダメならログインを試す（Turnstile等が出たらそこで例外が飛んで終了する）
    if (result.sessionInvalid) {
      if (!EMAIL) {
        throw new Error("Cookieが無効で、CAPCOM_ID_EMAILも未設定のため終了します。SF6_SESSION_COOKIEを手動で更新してください。");
      }
      console.log("② Cookieが無効だったため、ログインを試します。");
      await loginWithCredentials(driver); // ここでTurnstile検知時は例外を投げて終了する

      // 3. ログイン成功後のCookieで、もう一度 1 を試す
      console.log("③ ログイン後のセッションで再度取得を試します。");
      result = await tryScrapeAllPages(driver, existingIds);
      if (result.sessionInvalid) {
        throw new Error("ログイン後もbattlelog.jsonの取得に失敗しました。");
      }
    }
  } finally {
    await driver.quit();
  }

  const { allReplays, rawPages, fighterBannerInfo } = result;
  console.log(`今回の取得: ${allReplays.length}件`);

  const newReplays = allReplays.filter((r) => !existingIds.has(r.replay_id));
  const merged = [...existingReplays, ...newReplays].sort((a, b) => (a.uploaded_at || 0) - (b.uploaded_at || 0));
  console.log(`新規: ${newReplays.length}件 / 累計: ${merged.length}件`);

  const dataOutput = { pageProps: { fighter_banner_info: fighterBannerInfo, replay_list: merged, fetched_at: new Date().toISOString() } };
  const dataText = JSON.stringify(dataOutput, null, 2);
  const rawText = JSON.stringify({ fetched_at: new Date().toISOString(), pages: rawPages }, null, 2);

  fs.writeFileSync(path.join(OUT_DIR, GIST_FILENAME), dataText);
  fs.writeFileSync(path.join(OUT_DIR, GIST_RAW_FILENAME), rawText);

  await uploadToGist({ [GIST_FILENAME]: { content: dataText }, [GIST_RAW_FILENAME]: { content: rawText } });
}

main().catch((e) => {
  console.error("失敗:", e.message);
  process.exit(1);
});
