// Buckler's Boot Camp（SF6公式サイト）に CAPCOM ID（メールアドレス＋パスワード）で
// 自動ログインし、対戦履歴を取得して output/battlelog.json に書き出す。
//
// ログインはヘッドレスブラウザ（Playwright）で実際にログインフォームへ入力して行う。
// 二段階認証やCAPTCHAが挟まる場合はこの自動ログインは失敗する（人間の操作が前提の仕組みのため）。
//
// 必要な環境変数（GitHub Secrets経由で渡す想定）:
//   CAPCOM_ID_EMAIL      … CAPCOM IDのログインメールアドレス
//   CAPCOM_ID_PASSWORD   … CAPCOM IDのログインパスワード
//   SF6_FIGHTER_ID       … 自分のCFNプレイヤーID（プロフィールページURLの数字部分）
//   SF6_LOCALE           … 省略時 "ja-jp"
//   SF6_MAX_PAGES         … 省略時 20（安全のための上限ページ数）

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const EMAIL = process.env.CAPCOM_ID_EMAIL || "";
const PASSWORD = process.env.CAPCOM_ID_PASSWORD || "";
const FIGHTER_ID = process.env.SF6_FIGHTER_ID || "";
const LOCALE = process.env.SF6_LOCALE || "ja-jp";
const MAX_PAGES = parseInt(process.env.SF6_MAX_PAGES || "20", 10);
const OUT_DIR = path.join(__dirname, "output");
const LOGIN_URL = `https://www.streetfighter.com/6/buckler/${LOCALE}/auth/loginep?redirect_url=/`;

if (!EMAIL || !PASSWORD) { console.error("CAPCOM_ID_EMAIL / CAPCOM_ID_PASSWORD が設定されていません"); process.exit(1); }
if (!FIGHTER_ID) { console.error("SF6_FIGHTER_ID が設定されていません"); process.exit(1); }

async function login(page) {
  console.log("ログインページへ移動:", LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  // CAPCOM IDのログインフォームへリダイレクトされるはず。
  // フォームの正確なセレクタが分からないため、type属性ベースで汎用的に探す。
  const emailInput = page.locator('input[type="email"], input[name*="mail" i], input[id*="mail" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  await emailInput.waitFor({ state: "visible", timeout: 30000 });
  await emailInput.fill(EMAIL);
  await passwordInput.fill(PASSWORD);

  // 送信ボタンをテキストや type=submit から緩く探す
  const submitBtn = page.locator(
    'button[type="submit"], input[type="submit"], button:has-text("ログイン"), button:has-text("Login"), button:has-text("サインイン")'
  ).first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
    submitBtn.click(),
  ]);

  // ログイン後、streetfighter.com のドメインに戻ってくるまで少し待つ
  // （リダイレクトが複数挟まる場合があるため、最終的なURLで判定する）
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (page.url().includes("streetfighter.com")) return true;
    await page.waitForTimeout(1000);
  }
  return page.url().includes("streetfighter.com");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    const ok = await login(page);
    if (!ok) {
      throw new Error(
        "ログインに失敗、またはログイン後の遷移が確認できませんでした。" +
        "二段階認証やCAPTCHAが表示されている可能性があります（自動化不可）。" +
        "その場合はCookie方式（README参照）に切り替えてください。"
      );
    }
    console.log("ログイン成功。プロフィールページへ移動して buildId を取得します。");

    await page.goto(`https://www.streetfighter.com/6/buckler/${LOCALE}/profile/${FIGHTER_ID}`, { waitUntil: "domcontentloaded" });
    const nextDataText = await page.locator("#__NEXT_DATA__").textContent();
    const buildId = JSON.parse(nextDataText).buildId;
    if (!buildId) throw new Error("buildId が取得できませんでした");
    console.log("buildId:", buildId);

    let fighterBannerInfo = null;
    const allReplays = [];

    for (let p = 1; p <= MAX_PAGES; p++) {
      const url = `https://www.streetfighter.com/6/buckler/_next/data/${buildId}/${LOCALE}/profile/${FIGHTER_ID}/battlelog.json?page=${p}&sid=${FIGHTER_ID}`;
      // ログイン済みのブラウザコンテキスト（Cookie込み）でそのままAPIを取得する
      const res = await context.request.get(url);
      if (!res.ok()) {
        console.warn(`page ${p} の取得に失敗（HTTP ${res.status()}）、打ち切ります`);
        break;
      }
      const data = await res.json();
      const pp = data.pageProps || {};
      if (!fighterBannerInfo) fighterBannerInfo = pp.fighter_banner_info;
      const list = pp.replay_list || [];
      console.log(`page ${p}: ${list.length}件 (total_page=${pp.total_page})`);
      allReplays.push(...list);
      if (!list.length || (pp.total_page && p >= pp.total_page)) break;
    }

    const output = {
      pageProps: {
        fighter_banner_info: fighterBannerInfo,
        replay_list: allReplays,
        fetched_at: new Date().toISOString(),
      },
    };
    fs.writeFileSync(path.join(OUT_DIR, "battlelog.json"), JSON.stringify(output, null, 2));
    console.log(`${allReplays.length}件を output/battlelog.json に書き出しました`);
  } catch (e) {
    // デバッグ用にログイン試行後のスクリーンショットを残しておく（Secretsは映らない）
    try {
      await page.screenshot({ path: path.join(OUT_DIR, "debug-last-page.png") });
      fs.writeFileSync(path.join(OUT_DIR, "debug-last-url.txt"), page.url());
    } catch {}
    throw e;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("失敗:", e.message);
  process.exit(1);
});
