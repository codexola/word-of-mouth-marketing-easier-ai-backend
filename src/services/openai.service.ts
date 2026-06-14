import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { env } from "../config/env.js";
import { getSettings } from "./settings.service.js";

const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

export type RegenerateTone =
  | "default"
  | "short"
  | "long"
  | "sales"
  | "professional"
  | "review"
  | "seo";

export interface ImageAnalysisResult {
  work_type?: string;
  summary?: string;
  location?: string;
}

interface GenerationInput {
  region?: string | null;
  serviceType?: string | null;
  workDescription?: string | null;
  memo?: string | null;
  imageUrls?: string[];
  imageAnalysis?: ImageAnalysisResult | null;
}

export interface GenerationResult {
  title: string;
  body: string;
  shortBody: string;
  politeBody: string;
  regionalBody: string;
  serviceKeywords: string[];
  cautions: string;
  reviewRequestText: string;
  prompt: string;
  rawResponse: unknown;
}

const TONE_INSTRUCTIONS: Record<RegenerateTone, string> = {
  default: "標準的な長さとトーンで、地域密着の自然な文章にしてください。",
  short: "本文は100文字前後の短い投稿文にしてください。要点のみ簡潔に。",
  long: "本文は350〜500文字の詳細な投稿文にしてください。作業内容を具体的に。",
  sales: "お客様の不安解消と依頼意欲を促す、営業寄り（押し売り感は抑えめ）の文章にしてください。",
  professional: "専門用語を適度に使い、技術的な信頼感のある専門的な文章にしてください。",
  review: "口コミ投稿を自然に促す一文を本文に含め、顧客満足と信頼を伝える文章にしてください。",
  seo: "地域名・サービス名・キーワードを自然に多く含め、検索されやすいSEO重視の文章にしてください。",
};

function buildPrompt(
  input: GenerationInput,
  settings: Awaited<ReturnType<typeof getSettings>>,
  tone: RegenerateTone = "default",
  extraInstruction?: string
) {
  const services = Array.isArray(settings.services) ? (settings.services as { name: string; keywords?: string[] }[]) : [];
  const samples = Array.isArray(settings.samplePosts)
    ? (settings.samplePosts as { title?: string; body?: string }[])
    : [];

  const analysisBlock = input.imageAnalysis
    ? `\n## AI画像解析結果\n${JSON.stringify(input.imageAnalysis, null, 2)}\n`
    : "";

  const instructionBlock = extraInstruction
    ? `\n## 再生成指示（ユーザー）\n${extraInstruction}\n`
    : "";

  return `あなたは建築・リフォーム業者のGoogleビジネスプロフィール投稿文を作成する専門ライターです。

## 文章の方向性
${settings.toneDescription}

## 今回のトーン指定
${TONE_INSTRUCTIONS[tone]}
${instructionBlock}${analysisBlock}
## 対応エリア
${settings.serviceAreas.join("、") || "未設定"}

## サービス一覧
${JSON.stringify(services, null, 2)}

## 使用したいキーワード
${settings.keywords.join("、")}

## 避けるべき表現（NGワード）
${settings.ngWords.join("、")}

## 参考投稿文
${samples.map((s: { title?: string; body?: string }, i: number) => `【例${i + 1}】\nタイトル: ${s.title}\n本文: ${s.body}`).join("\n\n")}

## 今回の現場情報
- 地域: ${input.region || "未指定"}
- サービス種別: ${input.serviceType || "未指定"}
- 作業内容: ${input.workDescription || "未指定"}
- 現場メモ: ${input.memo || "なし"}
- 写真枚数: ${input.imageUrls?.length || 0}枚

## 出力形式（JSON）
以下のJSON形式のみで回答してください。誇大表現やNGワードは使わないでください。
トーン指定に合わせて "body" を主な投稿文として最適化してください。
{
  "title": "投稿タイトル（30文字程度）",
  "body": "トーン指定に合わせた投稿本文",
  "shortBody": "短めの投稿文（100文字程度）",
  "politeBody": "より丁寧な投稿文（250〜400文字）",
  "regionalBody": "地域名を自然に含めた投稿文",
  "serviceKeywords": ["使用したキーワードの配列"],
  "cautions": "投稿時の注意点（社内メモ）",
  "reviewRequestText": "口コミ依頼文の候補"
}`;
}

function checkNgWords(text: string, ngWords: string[]): string[] {
  return ngWords.filter((word) => text.includes(word));
}

function buildFallbackContent(
  input: GenerationInput,
  settings: Awaited<ReturnType<typeof getSettings>>,
  prompt: string,
  reason?: string
): GenerationResult {
  const fallbackTitle = `${input.region || "現地"}での${input.serviceType || "作業"}のご報告`;
  const fallbackBody = `本日は${input.region || "現地"}にて、${input.serviceType || "作業"}を行いました。${input.memo || input.workDescription || "詳細は現地で確認いたしました。"} 屋根・外壁・雨漏りで気になることがありましたら、お気軽にご相談ください。`;
  return {
    title: fallbackTitle,
    body: fallbackBody,
    shortBody: fallbackBody.slice(0, 100),
    politeBody: fallbackBody,
    regionalBody: fallbackBody,
    serviceKeywords: settings.keywords.slice(0, 3),
    cautions: reason || "フォールバック文を使用しています",
    reviewRequestText: "この度はご依頼いただきありがとうございました。よろしければGoogle口コミでのご感想もお待ちしております。",
    prompt,
    rawResponse: { fallback: true, reason },
  };
}

/** OpenAI Vision が取得できる公開 HTTPS URL のみ使用 */
export function filterOpenAiImageUrls(urls: string[] = []): string[] {
  return urls.filter((url) => {
    if (!url.startsWith("https://")) return false;
    if (url.startsWith("data:")) return false;
    try {
      const host = new URL(url).hostname;
      if (host === "localhost" || host === "127.0.0.1") return false;
    } catch {
      return false;
    }
    return true;
  });
}

/** OpenAI Vision — 画像解析（work_type / summary / location） */
export async function analyzePostImages(imageUrls: string[]): Promise<ImageAnalysisResult | null> {
  const settings = await getSettings();
  const visionUrls = filterOpenAiImageUrls(imageUrls);
  if (!openai || visionUrls.length === 0) return null;

  try {
    const response = await openai.chat.completions.create({
      model: settings.openaiModel || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "建築・リフォーム現場の写真を解析するアシスタントです。JSON形式のみで回答してください。",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: '写真から作業種別・概要・推定地域を抽出し、以下のJSONのみで回答:\n{"work_type":"","summary":"","location":""}',
            },
            ...visionUrls.slice(0, 3).map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content) as ImageAnalysisResult;
  } catch (err) {
    console.error("[OpenAI] analyzePostImages failed:", err);
    return null;
  }
}

export async function generatePostContent(
  input: GenerationInput,
  options: { tone?: RegenerateTone; instruction?: string } = {}
): Promise<GenerationResult> {
  const settings = await getSettings();
  const tone = options.tone || "default";
  const prompt = buildPrompt(input, settings, tone, options.instruction);

  if (!openai) {
    return buildFallbackContent(input, settings, prompt, "OpenAI APIキー未設定のためフォールバック文を使用しています");
  }

  const visionUrls = filterOpenAiImageUrls(input.imageUrls);

  try {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "JSON形式のみで回答する日本語のライターです。" },
      { role: "user", content: prompt },
    ];

    if (visionUrls.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "以下の現場写真を参考に、具体的な描写を加えてください。" },
          ...visionUrls.slice(0, 3).map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ],
      });
    }

    const response = await openai.chat.completions.create({
      model: settings.openaiModel || "gpt-4o-mini",
      messages,
      response_format: { type: "json_object" },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("AIからの応答が空です");

    const parsed = JSON.parse(content) as Omit<GenerationResult, "prompt" | "rawResponse">;
    const allText = [parsed.title, parsed.body, parsed.shortBody, parsed.politeBody, parsed.regionalBody].join(" ");
    const foundNg = checkNgWords(allText, settings.ngWords);
    if (foundNg.length > 0) {
      parsed.cautions = `${parsed.cautions || ""} NGワード検出: ${foundNg.join("、")}`.trim();
    }

    return { ...parsed, prompt, rawResponse: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI生成エラー";
    console.error("[OpenAI] generatePostContent failed, using fallback:", message);
    return buildFallbackContent(input, settings, prompt, `AI生成に失敗したためフォールバック文を使用: ${message}`);
  }
}

export async function generateReviewMessages(input: {
  customerName: string;
  completionDate: string;
  reviewUrl?: string;
}) {
  const settings = await getSettings();

  if (!openai) {
    return {
      thankMessage: `${input.customerName}様、この度は工事のご依頼ありがとうございました。`,
      reviewMessage: `よろしければ、こちらからGoogle口コミをお願いできます：${input.reviewUrl || settings.reviewRequestUrl || ""}`,
      followUpMessage: "ご不明点がございましたら、いつでもお気軽にご連絡ください。",
    };
  }

  try {
    const response = await openai.chat.completions.create({
      model: settings.openaiModel || "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "建築業者の顧客向けメッセージを作成するアシスタントです。JSON形式のみで回答してください。",
        },
        {
          role: "user",
          content: `顧客名: ${input.customerName}\n工事完了日: ${input.completionDate}\n口コミURL: ${input.reviewUrl || settings.reviewRequestUrl}\n\n以下のJSONで出力:\n{"thankMessage":"","reviewMessage":"","followUpMessage":""}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("AIからの応答が空です");
    return JSON.parse(content);
  } catch (err) {
    console.error("[OpenAI] generateReviewMessages failed, using fallback:", err);
    return {
      thankMessage: `${input.customerName}様、この度は工事のご依頼ありがとうございました。`,
      reviewMessage: `よろしければ、こちらからGoogle口コミをお願いできます：${input.reviewUrl || settings.reviewRequestUrl || ""}`,
      followUpMessage: "ご不明点がございましたら、いつでもお気軽にご連絡ください。",
    };
  }
}
