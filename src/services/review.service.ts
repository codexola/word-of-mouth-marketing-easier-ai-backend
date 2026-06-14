import { AppError } from "../lib/app-error.js";
import { prisma } from "../lib/prisma.js";
import { addDays } from "../lib/date.js";
import { sendReviewEmail } from "./email.service.js";
import { generateReviewMessages } from "./openai.service.js";
import { getSettings } from "./settings.service.js";
import { pushLineMessage } from "./line.service.js";

function canAutoScheduleReview(
  settings: Awaited<ReturnType<typeof getSettings>>,
  lineUserId?: string,
  customerEmail?: string
) {
  const lineReady = settings.lineAutoSendEnabled && !!lineUserId;
  const emailReady = settings.emailAutoSendEnabled && !!customerEmail;
  return lineReady || emailReady;
}

export async function listReviewRequests(filters: { status?: string; page?: number; limit?: number } = {}) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where = filters.status
    ? { sendStatus: filters.status as "DRAFT" | "SCHEDULED" | "SENT" | "CANCELLED" }
    : {};

  const [items, total] = await Promise.all([
    prisma.reviewRequest.findMany({
      where,
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.reviewRequest.count({ where }),
  ]);

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function createReviewRequest(data: {
  customerName: string;
  completionDate: string;
  reviewUrl?: string;
  scheduledSendDate?: string;
  lineUserId?: string;
  customerEmail?: string;
  createdById?: string;
}) {
  const settings = await getSettings();
  const messages = await generateReviewMessages({
    customerName: data.customerName,
    completionDate: data.completionDate,
    reviewUrl: data.reviewUrl || settings.reviewRequestUrl || undefined,
  });

  const completion = new Date(data.completionDate);
  const thankScheduledDate = completion;
  const reviewScheduledDate = data.scheduledSendDate
    ? new Date(data.scheduledSendDate)
    : addDays(completion, 1);
  const followUpScheduledDate = addDays(completion, 3);

  const autoSchedule = canAutoScheduleReview(settings, data.lineUserId, data.customerEmail);

  return prisma.reviewRequest.create({
    data: {
      customerName: data.customerName,
      completionDate: completion,
      lineUserId: data.lineUserId || null,
      customerEmail: data.customerEmail || null,
      reviewUrl: data.reviewUrl || settings.reviewRequestUrl,
      thankMessage: messages.thankMessage,
      reviewMessage: messages.reviewMessage,
      followUpMessage: messages.followUpMessage,
      scheduledSendDate: reviewScheduledDate,
      thankScheduledDate,
      reviewScheduledDate,
      followUpScheduledDate,
      sendStatus: autoSchedule ? "SCHEDULED" : "DRAFT",
      createdById: data.createdById,
    },
  });
}

export async function sendReviewNow(id: string, type: "thank" | "review" | "followUp", channel: "line" | "email" = "line") {
  const review = await prisma.reviewRequest.findUnique({ where: { id } });
  if (!review) throw new AppError("口コミ依頼が見つかりません", 404);

  const now = new Date();

  if (channel === "email") {
    if (!review.customerEmail) throw new AppError("顧客メールアドレスが未設定です", 400);
    if (type === "thank" && review.thankMessage) {
      await sendReviewEmail(review.customerEmail, "ご依頼ありがとうございました", review.thankMessage);
      return prisma.reviewRequest.update({
        where: { id },
        data: { thankSentAt: now, thankEmailSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
      });
    }
    if (type === "review" && review.reviewMessage) {
      const text = review.reviewUrl
        ? `${review.reviewMessage}\n\n${review.reviewUrl}`
        : review.reviewMessage;
      await sendReviewEmail(review.customerEmail, "口コミのお願い", text);
      return prisma.reviewRequest.update({
        where: { id },
        data: { reviewSentAt: now, reviewEmailSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
      });
    }
    if (type === "followUp" && review.followUpMessage) {
      await sendReviewEmail(review.customerEmail, "ご感想をお聞かせください", review.followUpMessage);
      return prisma.reviewRequest.update({
        where: { id },
        data: { followUpSentAt: now, followUpEmailSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
      });
    }
    throw new AppError("送信できるメッセージがありません", 400);
  }

  if (!review.lineUserId) throw new AppError("LINEユーザーIDが未設定です", 400);

  if (type === "thank" && review.thankMessage) {
    await pushLineMessage(review.lineUserId, review.thankMessage);
    return prisma.reviewRequest.update({
      where: { id },
      data: { thankSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
    });
  }
  if (type === "review" && review.reviewMessage) {
    const text = review.reviewUrl
      ? `${review.reviewMessage}\n\n${review.reviewUrl}`
      : review.reviewMessage;
    await pushLineMessage(review.lineUserId, text);
    return prisma.reviewRequest.update({
      where: { id },
      data: { reviewSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
    });
  }
  if (type === "followUp" && review.followUpMessage) {
    await pushLineMessage(review.lineUserId, review.followUpMessage);
    return prisma.reviewRequest.update({
      where: { id },
      data: { followUpSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
    });
  }
  throw new AppError("送信できるメッセージがありません", 400);
}

export async function updateReviewRequest(
  id: string,
  data: Partial<{
    customerName: string;
    completionDate: string;
    reviewUrl: string;
    lineUserId: string;
    customerEmail: string;
    thankMessage: string;
    reviewMessage: string;
    followUpMessage: string;
    scheduledSendDate: string;
    thankScheduledDate: string;
    reviewScheduledDate: string;
    followUpScheduledDate: string;
    sendStatus: "DRAFT" | "SCHEDULED" | "SENT" | "CANCELLED";
  }>
) {
  return prisma.reviewRequest.update({
    where: { id },
    data: {
      ...data,
      completionDate: data.completionDate ? new Date(data.completionDate) : undefined,
      scheduledSendDate: data.scheduledSendDate ? new Date(data.scheduledSendDate) : undefined,
      thankScheduledDate: data.thankScheduledDate ? new Date(data.thankScheduledDate) : undefined,
      reviewScheduledDate: data.reviewScheduledDate ? new Date(data.reviewScheduledDate) : undefined,
      followUpScheduledDate: data.followUpScheduledDate ? new Date(data.followUpScheduledDate) : undefined,
    },
  });
}

export async function deleteReviewRequest(id: string) {
  const review = await prisma.reviewRequest.findUnique({ where: { id } });
  if (!review) throw new AppError("口コミ依頼が見つかりません", 404);

  const anyMessageSent = review.thankSentAt || review.reviewSentAt || review.followUpSentAt;
  if (review.sendStatus === "SENT" || anyMessageSent) {
    throw new AppError(
      "送信済みの口コミ依頼は削除できません。キャンセルをご利用ください。",
      409
    );
  }

  await prisma.reviewRequest.delete({ where: { id } });
  return { success: true };
}

export async function regenerateReviewMessages(id: string) {
  const request = await prisma.reviewRequest.findUnique({ where: { id } });
  if (!request) throw new Error("口コミ依頼が見つかりません");

  const messages = await generateReviewMessages({
    customerName: request.customerName,
    completionDate: request.completionDate.toISOString().split("T")[0],
    reviewUrl: request.reviewUrl || undefined,
  });

  return prisma.reviewRequest.update({
    where: { id },
    data: messages,
  });
}
