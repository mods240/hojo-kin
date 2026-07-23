// api/sync.js
// BUILD: 2026-07-24
//
// Vercel Cronから毎朝7:00(JST)に自動実行される関数。
// hojokin-sync_20260724.mjs と同じ処理をVercelのサーバーレス関数として動かす。
//
// 手動でテストしたい場合は、デプロイ後に以下のURLにブラウザでアクセス:
//   https://hojo-kin.vercel.app/api/sync
//
// 環境変数(Vercel Dashboard → Settings → Environment Variables で設定):
//   ANTHROPIC_API_KEY … Claude APIキー(必須)
//   CRON_SECRET        … 任意。設定するとVercel Cron以外からの実行を防げる

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyAUH0FB780Hj2V-E2UpqjSDqDlHe8firPM",
  authDomain: "jgrants-fetch.firebaseapp.com",
  databaseURL: "https://jgrants-fetch-default-rtdb.firebaseio.com",
  projectId: "jgrants-fetch",
  storageBucket: "jgrants-fetch.firebasestorage.app",
  messagingSenderId: "97389862866",
  appId: "1:97389862866:web:d0212aa81b910b6d18720b",
};

const BASE_URL = "https://api.jgrants-portal.go.jp/exp/v1/public/subsidies";

const KEYWORDS = [
  "事業", "設備", "DX", "IT導入", "デジタル",
  "業務効率化", "映像", "コンテンツ", "販路開拓", "生産性向上",
];

const TARGET_AREAS = ["東京都", "兵庫県", "大阪府"];

const COMPANY_PROFILE = `
会社名: AVA株式会社（神戸・兵庫県が本社、東京都内に事務所あり）
事業内容:
- AV・映像制作、映像機材の運用・レンタル
- イベント・配信の企画運営
- 業務効率化のための自社ツール開発(Electronデスクトップアプリ、Webアプリ)
  例: 機材管理システム、放送グラフィックス表示ソフト、動画ダイジェスト編集ソフト等
- 対象外: 個人でのソフトウェア販売(BOOTH経由)は会社の事業に含めない
従業員規模: 中小企業
`;

async function fetchSubsidies(keyword) {
  const params = new URLSearchParams({
    keyword, sort: "acceptance_end_datetime", order: "ASC", acceptance: "1",
  });
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.result || [];
}

function isTargetArea(subsidy) {
  const area = subsidy.target_area_search || "";
  return area.includes("全国") || TARGET_AREAS.some((p) => area.includes(p));
}

async function collectSubsidies() {
  const seen = new Map();
  for (const keyword of KEYWORDS) {
    const results = await fetchSubsidies(keyword);
    for (const s of results) {
      if (!seen.has(s.id) && isTargetArea(s)) seen.set(s.id, s);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return Array.from(seen.values());
}

async function scoreWithClaude(subsidies) {
  const listForPrompt = subsidies.map((s) => ({
    id: s.id, title: s.title, area: s.target_area_search,
    max_limit: s.subsidy_max_limit, deadline: s.acceptance_end_datetime,
  }));

  const prompt = `以下は自社プロフィールと、jGrantsから取得した補助金一覧です。
各補助金について、自社事業内容との関連度を 0〜100 のスコアで採点してください。
関連が薄い(農林水産・医療機関限定・エネルギープラント設備等、明らかに業種が異なるもの)は低いスコアにしてください。

【自社プロフィール】
${COMPANY_PROFILE}

【補助金一覧(JSON)】
${JSON.stringify(listForPrompt)}

出力は以下のJSON配列のみを返してください。前置きや説明文、Markdownのコードブロック記号は一切不要です。
各要素には元のtitleも必ずそのままコピーして含めてください(取り違え防止のため)。
[
  { "id": "...", "title": "...", "score": 0-100, "reason": "30文字程度の短い理由" },
  ...
]
スコア40以上のものだけを配列に含めてください。scoreの高い順に並べてください。`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

function sanitizeKey(id) {
  return id.replace(/[.#$/\[\]]/g, "_");
}

export default async function handler(req, res) {
  // Vercel Cronからの呼び出し以外を弾く(CRON_SECRETを設定した場合のみ有効)
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers["authorization"];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY が設定されていません" });
  }

  try {
    const app = initializeApp(firebaseConfig, `sync-${Date.now()}`);
    const auth = getAuth(app);
    await signInAnonymously(auth);
    const db = getDatabase(app);

    const subsidies = await collectSubsidies();
    const scored = await scoreWithClaude(subsidies);
    const subsidyMap = new Map(subsidies.map((s) => [s.id, s]));

    let written = 0;
    for (const item of scored) {
      const s = subsidyMap.get(item.id);
      if (!s) continue;

      const key = sanitizeKey(item.id);
      await set(ref(db, `hojokin/subsidies/${key}`), {
        id: s.id,
        title: s.title,
        area: s.target_area_search || null,
        max_limit: s.subsidy_max_limit || null,
        acceptance_end_datetime: s.acceptance_end_datetime || null,
        score: item.score,
        reason: item.reason,
        synced_at: new Date().toISOString(),
      });
      written++;
    }

    return res.status(200).json({
      ok: true,
      fetched: subsidies.length,
      scored: scored.length,
      written,
      synced_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
