// api/support.mjs
// BUILD: 2026-07-24
//
// 「申請する」を選んだ補助金について、申請の手順・必要書類・注意点をAIで生成する。
// 一度生成した内容はFirebaseにキャッシュし、同じ補助金への呼び出しは再利用する
// (Claude API呼び出しは「新規に申請サポートを見た件数」分だけ発生し、閲覧のたびには増えない)。
//
// 呼び出し方: GET /api/support?id={補助金のkey}
//
// 環境変数:
//   ANTHROPIC_API_KEY … 必須

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, get, set } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyAUH0FB780Hj2V-E2UpqjSDqDlHe8firPM",
  authDomain: "jgrants-fetch.firebaseapp.com",
  databaseURL: "https://jgrants-fetch-default-rtdb.firebaseio.com",
  projectId: "jgrants-fetch",
  storageBucket: "jgrants-fetch.firebasestorage.app",
  messagingSenderId: "97389862866",
  appId: "1:97389862866:web:d0212aa81b910b6d18720b",
};

const COMPANY_PROFILE = `
会社名: AVA株式会社（神戸・兵庫県が本社、東京都内に事務所あり）
事業内容:
- AV・映像制作、映像機材の運用・レンタル
- イベント・配信の企画運営
- 業務効率化のための自社ツール開発(Electronデスクトップアプリ、Webアプリ)
従業員規模: 中小企業
`;

async function fetchApplyUrl(subsidyId) {
  try {
    const res = await fetch(`https://api.jgrants-portal.go.jp/exp/v2/public/subsidies/id/${subsidyId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const detail = data.result?.[0];
    return detail?.front_subsidy_detail_page_url || null;
  } catch {
    return null;
  }
}

async function generateSupport(subsidy) {
  const prompt = `以下の補助金について、中小企業の担当者(自分でも申請作業を行う想定)向けに、
申請準備をサポートする情報をまとめてください。

【自社プロフィール】
${COMPANY_PROFILE}

【補助金情報】
名称: ${subsidy.title}
対象地域: ${subsidy.area || "不明"}
上限額: ${subsidy.max_limit || "不明"}
締切: ${subsidy.acceptance_end_datetime || "不明"}

以下のJSON形式のみで出力してください。前置き・説明文・Markdownのコードブロック記号は一切不要です。

{
  "overview": "この補助金がどういう制度か、2〜3文の要約",
  "steps": ["申請の大まかな流れを順番に、5〜8ステップ程度。各項目は40文字程度"],
  "documents": ["準備が必要になりやすい書類・情報の一般的なリスト。5〜8項目程度"],
  "tips": ["採択されやすくするポイントや、よくある落とし穴。3〜5項目程度"],
  "search_hint": "この補助金の公募要領(PDF)を探す時に検索エンジンに入れるとよいキーワード",
  "video_search_hint": "この補助金(または同種の制度)の申請方法を解説したYouTube動画を探す時のキーワード",
  "reference_search_hint": "申請の進め方をまとめた解説記事・ガイドを探す時のキーワード(中小企業庁やミラサポplus等の公的解説が見つかりやすいもの)"
}

注意: 一般的な補助金申請の実務知識をもとにした「準備の目安」として書いてください。
最新の公募要領・様式・締切は必ず公式サイトで確認するよう促す一文をoverviewの最後に含めてください。`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
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

export default async function handler(req, res) {
  const key = req.query?.id;
  if (!key) {
    return res.status(400).json({ error: "id パラメータが必要です" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY が設定されていません" });
  }

  try {
    const app = initializeApp(firebaseConfig, `support-${Date.now()}`);
    const auth = getAuth(app);
    await signInAnonymously(auth);
    const db = getDatabase(app);

    // キャッシュ確認
    const cacheSnap = await get(ref(db, `hojokin/support/${key}`));
    if (cacheSnap.exists()) {
      return res.status(200).json({ ...cacheSnap.val(), cached: true });
    }

    // 補助金情報を取得
    const subsidySnap = await get(ref(db, `hojokin/subsidies/${key}`));
    if (!subsidySnap.exists()) {
      return res.status(404).json({ error: "該当する補助金が見つかりません" });
    }
    const subsidy = subsidySnap.val();

    const support = await generateSupport(subsidy);
    const applyUrl = await fetchApplyUrl(subsidy.id);
    const result = {
      ...support,
      apply_url: applyUrl,
      generated_at: new Date().toISOString(),
    };

    await set(ref(db, `hojokin/support/${key}`), result);

    return res.status(200).json({ ...result, cached: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
