// Buckler's Boot Camp（SF6公式サイト）の対戦履歴を取得し、
// スト6攻略ノートアプリがそのままインポートできる形式でGistへアップロードする。
//
// ログイン画面を自動操作する方式（Playwright + CAPCOM ID自動ログイン）は、
// サイト側のBot対策（Cloudflare）にヘッドレスブラウザとして検知されブロックされたため廃止。
// 代わりに、ログイン中の自分のブラウザからコピーしたセッションCookieを、
// 素のfetch()でAPIリクエストに直接乗せる方式に戻した（これはCloudflareの検知に引っかからず、
// ブラウザ操作を一切行わないため軽量・確実）。
//
// 必要な環境変数（GitHub Secrets経由で渡す想定）:
//   SF6_SESSION_COOKIE  … ログイン済みブラウザからコピーしたCookie文字列
//   SF6_FIGHTER_ID       … 自分のCFNプレイヤーID（プロフィールページURLの数字部分）
//   SF6_LOCALE           … 省略時 "ja-jp"
//   SF6_MAX_PAGES         … 省略時 20（安全のための上限ページ数）
//   GIST_TOKEN            … Gist更新用のPersonal Access Token（gistスコープ）
//   GIST_ID               … 更新先のGist ID

const fs = require("fs");
const path = require("path");

const COOKIE = process.env.SF6_SESSION_COOKIE || "";
const FIGHTER_ID = process.env.SF6_FIGHTER_ID || "";
const LOCALE = process.env.SF6_LOCALE || "ja-jp";
const MAX_PAGES = parseInt(process.env.SF6_MAX_PAGES || "20", 10);
const OUT_DIR = path.join(__dirname, "output");

const GIST_TOKEN = process.env.GIST_TOKEN || "";
const GIST_ID = process.env.GIST_ID || "";
const GIST_FILENAME = "battlelog.json";

if (!COOKIE) { console.error("SF6_SESSION_COOKIE が設定されていません"); process.exit(1); }
if (!FIGHTER_ID) { console.error("SF6_FIGHTER_ID が設定されていません"); process.exit(1); }
if (!GIST_TOKEN) { console.error("GIST_TOKEN が設定されていません"); process.exit(1); }

const HEADERS = {
  "Cookie": COOKIE,
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/html;q=0.9,*/*;q=0.8",
};

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// プロフィールページのHTMLから __NEXT_DATA__ に埋め込まれた buildId を取り出す。
// buildIdはサイトのデプロイごとに変わるため毎回取得し直す。
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

// 既存のGistの中身（前回までに蓄積した対戦履歴）を取得する。
// これと今回の取得分を replay_id で突き合わせ、新しいものだけを追加していく
// （公式サイト側は直近100戦しか保持していないため、こちらで蓄積しないと古いデータが消えてしまう）。
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

// Gistへ battlelog.json をアップロードする。
// GIST_IDが指定されていれば既存のGistを更新し、なければ新規のsecret gistを作成する
// （その場合は次回以降のためにGIST_IDをSecretsへ追加する必要がある旨をログに出す）。
async function uploadToGist(content) {
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
      body: JSON.stringify({ files: { [GIST_FILENAME]: { content } } }),
    });
    if (!res.ok) throw new Error(`Gistの更新に失敗しました: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    console.log("Gistを更新しました:", data.html_url);
    return data;
  }
  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers,
    body: JSON.stringify({
      description: "SF6 battlelog (sf6-note用)",
      public: false,
      files: { [GIST_FILENAME]: { content } },
    }),
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

  const buildId = await getBuildId();
  console.log("buildId:", buildId);

  let fighterBannerInfo = null;
  const allReplays = [];

  for (let p = 1; p <= MAX_PAGES; p++) {
    let data;
    try {
      data = await fetchBattlelogPage(buildId, p);
    } catch (e) {
      console.warn(`page ${p} の取得に失敗、打ち切ります:`, e.message);
      break;
    }
    const pp = data.pageProps || {};
    if (!fighterBannerInfo) fighterBannerInfo = pp.fighter_banner_info;
    const list = pp.replay_list || [];
    console.log(`page ${p}: ${list.length}件 (total_page=${pp.total_page})`);
    allReplays.push(...list);
    if (!list.length || (pp.total_page && p >= pp.total_page)) break;
  }

  console.log(`今回の取得: ${allReplays.length}件`);

  // replay_idを主キーとして、既存のGistの中身とマージする
  console.log("既存のGistの中身を確認します。");
  const existingReplays = await fetchExistingReplays();
  const existingIds = new Set(existingReplays.map((r) => r.replay_id));
  const newReplays = allReplays.filter((r) => !existingIds.has(r.replay_id));
  const merged = [...existingReplays, ...newReplays]
    .sort((a, b) => (a.uploaded_at || 0) - (b.uploaded_at || 0));

  console.log(`既存: ${existingReplays.length}件 / 新規: ${newReplays.length}件 / 累計: ${merged.length}件`);

  const output = {
    pageProps: {
      fighter_banner_info: fighterBannerInfo,
      replay_list: merged,
      fetched_at: new Date().toISOString(),
    },
  };
  const outputText = JSON.stringify(output, null, 2);
  fs.writeFileSync(path.join(OUT_DIR, "battlelog.json"), outputText);
  await uploadToGist(outputText);
}

main().catch((e) => {
  console.error("失敗:", e.message);
  process.exit(1);
});
