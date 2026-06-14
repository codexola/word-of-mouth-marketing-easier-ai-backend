import crypto from "crypto";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSettings } from "./settings.service.js";
import { createPostCandidate, generateForPost } from "./post.service.js";
import { saveImageBuffer } from "./image-storage.service.js";

export async function getLineCredentials() {
  const settings = await getSettings();
  const secret = settings.lineChannelSecret || env.LINE_CHANNEL_SECRET || "";
  const token = settings.lineChannelAccessToken || env.LINE_CHANNEL_ACCESS_TOKEN || "";
  const enabled = settings.lineEnabled !== false && !!(secret && token);
  return { secret, token, enabled };
}

export async function getLineStatus() {
  const { secret, token, enabled } = await getLineCredentials();
  const settings = await getSettings();
  const webhookUrl = `${process.env.PUBLIC_API_URL || `http://localhost:${env.PORT}`}/api/line/webhook`;
  return {
    enabled,
    configured: !!(secret && token),
    hasSecret: !!secret,
    hasToken: !!token,
    webhookUrl,
    autoSendEnabled: settings.lineAutoSendEnabled,
  };
}

export async function pushLineMessage(to: string, text: string) {
  const { token, enabled } = await getLineCredentials();
  if (!enabled || !token) {
    throw new Error("LINE連携が無効、またはアクセストークンが未設定です");
  }
  const trimmed = text.trim().slice(0, 5000);
  if (!trimmed) throw new Error("送信するメッセージが空です");

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text: trimmed }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE送信失敗 (${res.status}): ${body}`);
  }
}

export function verifyLineSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!secret || !signature) return false;
  const hash = crypto.createHmac("SHA256", secret).update(body).digest("base64");
  return hash === signature;
}

async function downloadAndStoreLineImage(
  messageId: string,
  token: string
): Promise<{ url: string; storagePath: string; mimeType: string } | null> {
  if (!token) return null;

  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type") || "image/jpeg";
  const saved = saveImageBuffer(buffer, mimeType, `line-${messageId.slice(0, 12)}`);
  return { url: saved.publicUrl, storagePath: saved.storagePath, mimeType: saved.mimeType };
}

function parseMemo(text: string): { region?: string; serviceType?: string; workDescription?: string } {
  const parts = text.split(/[、,]/).map((p) => p.trim());
  return {
    region: parts[0],
    serviceType: parts[1],
    workDescription: parts.slice(2).join("、") || parts.slice(1).join("、"),
  };
}

const lineProcessLocks = new Set<string>();

async function processBufferedMessages(lineUserId: string) {
  if (lineProcessLocks.has(lineUserId)) return;
  lineProcessLocks.add(lineUserId);

  try {
  const buffers = await prisma.lineMessageBuffer.findMany({
    where: { lineUserId, processed: false },
    orderBy: { createdAt: "asc" },
  });

  if (buffers.length === 0) return;

  const images = buffers.filter((b) => b.messageType === "image" && b.imageUrl);
  const texts = buffers.filter((b) => b.messageType === "text" && b.content);

  if (images.length === 0) return;

  const newImages = [];
  for (const img of images) {
    if (img.messageId) {
      const alreadyImported = await prisma.postImage.findFirst({
        where: { sourceFileId: img.messageId },
      });
      if (alreadyImported) continue;
    }
    newImages.push(img);
  }

  if (newImages.length === 0) {
    await prisma.lineMessageBuffer.updateMany({
      where: { id: { in: buffers.map((b) => b.id) } },
      data: { processed: true },
    });
    return;
  }

  const memoText = texts.map((t) => t.content).join("\n");
  const parsed = memoText ? parseMemo(memoText) : {};

  const post = await createPostCandidate({
    source: "LINE",
    lineUserId,
    region: parsed.region,
    serviceType: parsed.serviceType,
    workDescription: parsed.workDescription,
    memo: memoText || undefined,
    images: newImages.map((img, i) => ({
      url: img.imageUrl!,
      fileName: `line-${lineUserId}-${i + 1}.jpg`,
      mimeType: "image/jpeg",
      storagePath: img.content || undefined,
      sourceFileId: img.messageId || undefined,
    })),
  });

  await prisma.lineMessageBuffer.updateMany({
    where: { id: { in: buffers.map((b) => b.id) } },
    data: { processed: true },
  });

  try {
    await generateForPost(post.id);
  } catch (err) {
    await prisma.postCandidate.update({
      where: { id: post.id },
      data: {
        status: "ERROR",
        errorMessage: err instanceof Error ? err.message : "AI generation error",
      },
    });
  }
  } finally {
    lineProcessLocks.delete(lineUserId);
  }
}

export async function handleLineWebhook(events: LineWebhookEvent[]) {
  const { secret, token, enabled } = await getLineCredentials();
  if (!enabled) throw new Error("LINE integration is disabled");

  const results: string[] = [];

  for (const event of events) {
    if (event.type !== "message" || !event.source?.userId) continue;

    const userId = event.source.userId;

    if (event.message?.type === "text" && event.message.text) {
      await prisma.lineMessageBuffer.create({
        data: { lineUserId: userId, messageType: "text", content: event.message.text },
      });
      results.push(`text buffered for ${userId}`);
    }

    if (event.message?.type === "image" && event.message.id) {
      const stored = await downloadAndStoreLineImage(event.message.id, token);
      if (stored) {
        await prisma.lineMessageBuffer.create({
          data: {
            lineUserId: userId,
            messageType: "image",
            imageUrl: stored.url,
            content: stored.storagePath,
            messageId: event.message.id,
          },
        });
        results.push(`image buffered for ${userId}`);
      }
    }

    await processBufferedMessages(userId);
  }

  return results;
}

export async function verifyLineWebhook(body: string, signature: string | undefined) {
  const { secret, enabled } = await getLineCredentials();
  if (!enabled) return false;
  return verifyLineSignature(body, signature, secret);
}

interface LineWebhookEvent {
  type: string;
  source?: { userId?: string };
  message?: { type: string; id?: string; text?: string };
}
