// Buckler's Boot Camp（SF6公式サイト）内部APIから対戦履歴を直接取得し、
// スト6攻略ノートアプリがそのままインポートできる形式でGistへアップロードする。
//
// 方針：
// - Playwright等のブラウザ自動化は使わない（Bot対策に検知されうるため）。
//   ログイン中のブラウザからコピーしたセッションCookieを、素のfetch()でAPIリクエストに
//   直接乗せるだけ。ブラウザ操作を一切行わないので軽量・確実。
// - replay_id を主キーとした差分取得（前回までに取得済みのreplay_idに行き当たったら
//   それ以降のページは取得を打ち切る＝無駄なリクエストをしない）。
// - HTTPステータスごとに挙動を分ける（429は待ってリトライ、401/403は即座に諦める等）。
// - 生のAPIレスポンス（raw）と、アプリ用に蓄積した結果（data）を分けてGistに保存する。
//   API仕様が変わった場合でも、rawを見れば実際に何が返ってきていたか確認できる。
//
// 必要な環境変数（GitHub Secrets経由で渡す想定）:
//   SF6_SESSION_COOKIE  … ログイン済みブラウザからコピーしたCookie文字列
//   SF6_FIGHTER_ID       … 自分のCFNプレイヤーID（プロフィールページURLの数字部分）
//   SF6_LOCALE           … 省略時 "ja-jp"
//   SF6_MAX_PAGES         … 省略時 20（安全のための上限ページ数）
//   SF6_REQUEST_DELAY_MS   … 省略時 400（各リクエストの間隔・レート制限対策）
//   GIST_TOKEN            … Gist更新用のPersonal Access Token（gistスコープ）
//   GIST_ID               … 更新先のGist ID

const fs = require("fs");
const path = require("path");

const COOKIE = process.env.SF6_SESSION_COOKIE || "";
const FIGHTER_ID = process.env.SF6_FIGHTER_ID || "";
const LOCALE = process.env.SF6_LOCALE || "ja-jp";
const MAX_PAGES = parseInt(process.env.SF6_MAX_PAGES || "20", 10);
const REQUEST_DELAY_MS = parseInt(process.env.SF6_REQUEST_DELAY_MS || "400", 10);
const OUT_DIR = path.join(__dirname, "output");

const GIST_TOKEN = process.env.GIST_TOKEN || "";
const GIST_ID = process.env.GIST_ID || "";
const GIST_FILENAME = "battlelog.json";
const GIST_RAW_FILENAME = "battlelog-raw.json";

if (!COOKIE) { console.error("SF6_SESSION_COOKIE が設定されていません"); process.exit(1); }
if (!FIGHTER_ID) { console.error("SF6_FIGHTER_ID が設定されていません"); process.exit(1); }
if (!GIST_TOKEN) { console.error("GIST_TOKEN が設定されていません"); process.exit(1); }

const HEADERS = {
  "Cookie": COOKIE,
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/html;q=0.9,*/*;q=0.8",
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// HTTPステータスに応じて処理を分ける汎用フェッチ。
// 429/5xx系はしばらく待ってリトライ（最大3回）、401/403/404は即座に諦めて呼び出し元に伝える。
async function fetchWithRetry(url, { maxRetries = 3 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.ok) return res;

    if (res.status === 401) {
      throw new Error("HTTP 401: 認証切れです。SF6_SESSION_COOKIE を取り直してSecretsを更新してください。");
    }
    if (res.status === 403) {
      throw new Error("HTTP 403: アクセス拒否されました（Bot判定等）。連続で叩き続けると悪化する可能性があるため、ここで中断します。");
    }
    if (res.status === 404) {
      throw new Error(`HTTP 404: ${url} が見つかりませんでした（URLの形式が変わった可能性があります）。`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxRetries) throw new Error(`HTTP ${res.status}: リトライ上限に達しました（${url}）`);
      const waitMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s...
      console.warn(`HTTP ${res.status} を受け取りました。${waitMs}ms待ってリトライします（${attempt + 1}/${maxRetries}）`);
      await sleep(waitMs);
      continue;
    }
    // その他の予期しないエラー
    throw new Error(`HTTP ${res.status}: 予期しないエラー（${url}）`);
  }
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
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

// Gistの複数ファイルをまとめて更新する。GIST_IDが指定されていれば既存のGistを更新し、
// なければ新規のsecret gistを作成する（その場合は次回以降のためにGIST_IDをSecretsへ
// 追加登録する必要がある旨をログに出す）。
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

    // このページの中身が全部既知のreplay_idだった＝それ以前のページも全部既知のはずなので、
    // ここで打ち切る（無駄なリクエストを避ける差分取得）
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
