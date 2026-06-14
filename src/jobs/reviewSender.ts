import cron from "node-cron";
import type { ReviewRequest } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendReviewEmail } from "../services/email.service.js";
import { pushLineMessage } from "../services/line.service.js";
import { computeNextRetryAt } from "../services/retry.service.js";
import { getSettings } from "../services/settings.service.js";

let task: cron.ScheduledTask | null = null;

async function scheduleReviewRetry(reviewId: string, message: string, retryCount: number) {
  const nextRetryAt = await computeNextRetryAt(retryCount);
  await prisma.reviewRequest.update({
    where: { id: reviewId },
    data: {
      sendError: message,
      retryCount,
      lastErrorAt: new Date(),
      nextRetryAt,
    },
  });
}

async function sendThankMessage(review: ReviewRequest, now: Date) {
  if (!review.thankMessage || review.thankSentAt || !review.thankScheduledDate || review.thankScheduledDate > now) {
    return;
  }
  const settings = await getSettings();

  if (settings.lineAutoSendEnabled && review.lineUserId) {
    await pushLineMessage(review.lineUserId, review.thankMessage);
    await prisma.reviewRequest.update({
      where: { id: review.id },
      data: { thankSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
    });
    return;
  }

  if (settings.emailAutoSendEnabled && review.customerEmail) {
    await sendReviewEmail(review.customerEmail, "ご依頼ありがとうございました", review.thankMessage);
    await prisma.reviewRequest.update({
      where: { id: review.id },
      data: {
        thankEmailSentAt: now,
        thankSentAt: now,
        sendError: null,
        retryCount: 0,
        nextRetryAt: null,
      },
    });
  }
}

async function sendReviewMessage(review: ReviewRequest, now: Date) {
  if (!review.reviewMessage || review.reviewSentAt || !review.reviewScheduledDate || review.reviewScheduledDate > now) {
    return;
  }
  const settings = await getSettings();
  const text = review.reviewUrl
    ? `${review.reviewMessage}\n\n${review.reviewUrl}`
    : review.reviewMessage;

  if (settings.lineAutoSendEnabled && review.lineUserId) {
    await pushLineMessage(review.lineUserId, text);
    await prisma.reviewRequest.update({
      where: { id: review.id },
      data: { reviewSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
    });
    return;
  }

  if (settings.emailAutoSendEnabled && review.customerEmail) {
    await sendReviewEmail(review.customerEmail, "口コミのお願い", text);
    await prisma.reviewRequest.update({
      where: { id: review.id },
      data: {
        reviewEmailSentAt: now,
        reviewSentAt: now,
        sendError: null,
        retryCount: 0,
        nextRetryAt: null,
      },
    });
  }
}

async function sendFollowUpMessage(review: ReviewRequest, now: Date) {
  if (
    !review.followUpMessage ||
    review.followUpSentAt ||
    !review.followUpScheduledDate ||
    review.followUpScheduledDate > now
  ) {
    return;
  }
  const settings = await getSettings();

  if (settings.lineAutoSendEnabled && review.lineUserId) {
    await pushLineMessage(review.lineUserId, review.followUpMessage);
    await prisma.reviewRequest.update({
      where: { id: review.id },
      data: { followUpSentAt: now, sendError: null, retryCount: 0, nextRetryAt: null },
    });
    return;
  }

  if (settings.emailAutoSendEnabled && review.customerEmail) {
    await sendReviewEmail(review.customerEmail, "ご感想をお聞かせください", review.followUpMessage);
    await prisma.reviewRequest.update({
      where: { id: review.id },
      data: {
        followUpEmailSentAt: now,
        followUpSentAt: now,
        sendError: null,
        retryCount: 0,
        nextRetryAt: null,
      },
    });
  }
}

async function markReviewCompleteIfDone(reviewId: string) {
  const done = await prisma.reviewRequest.findUnique({ where: { id: reviewId } });
  if (!done) return;

  const allSent =
    (!done.thankMessage || done.thankSentAt) &&
    (!done.reviewMessage || done.reviewSentAt) &&
    (!done.followUpMessage || done.followUpSentAt);

  if (allSent) {
    await prisma.reviewRequest.update({
      where: { id: reviewId },
      data: { sendStatus: "SENT", sendError: null, retryCount: 0, nextRetryAt: null },
    });
  }
}

export async function processScheduledReviewSends() {
  const settings = await getSettings();
  const lineEnabled = settings.lineAutoSendEnabled;
  const emailEnabled = settings.emailAutoSendEnabled;
  if (!lineEnabled && !emailEnabled) return;

  const now = new Date();
  const reviews = await prisma.reviewRequest.findMany({
    where: {
      sendStatus: "SCHEDULED",
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      AND: {
        OR: [
          ...(lineEnabled ? [{ lineUserId: { not: null } }] : []),
          ...(emailEnabled ? [{ customerEmail: { not: null } }] : []),
        ],
      },
    },
  });

  for (const review of reviews) {
    const canLine = lineEnabled && !!review.lineUserId;
    const canEmail = emailEnabled && !!review.customerEmail;
    if (!canLine && !canEmail) continue;

    try {
      await sendThankMessage(review, now);
      const refreshed = await prisma.reviewRequest.findUnique({ where: { id: review.id } });
      if (!refreshed) continue;

      await sendReviewMessage(refreshed, now);
      const latest = await prisma.reviewRequest.findUnique({ where: { id: review.id } });
      if (!latest) continue;

      await sendFollowUpMessage(latest, now);
      await markReviewCompleteIfDone(review.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "送信エラー";
      console.error(`[Review Sender] ${review.id}:`, message);
      await scheduleReviewRetry(review.id, message, review.retryCount + 1);
    }
  }
}

export async function startReviewSender() {
  if (task) return;
  task = cron.schedule("*/15 * * * *", async () => {
    try {
      await processScheduledReviewSends();
    } catch (err) {
      console.error("[Review Sender] Error:", err);
    }
  });
  console.log("[Review Sender] Started (every 15 minutes)");
  await processScheduledReviewSends();
}

export function stopReviewSender() {
  if (task) {
    task.stop();
    task = null;
  }
}
