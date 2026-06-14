import cron from "node-cron";
import { prisma } from "../lib/prisma.js";
import { publishApprovedPostToGbp } from "../services/gbp.service.js";
import { getSettings } from "../services/settings.service.js";

let task: cron.ScheduledTask | null = null;

async function processGbpRetries() {
  const settings = await getSettings();
  if (!settings.autoRetryEnabled || !settings.gbpAutoPostEnabled) return;

  const now = new Date();
  const posts = await prisma.approvedPost.findMany({
    where: {
      status: { in: ["READY_TO_POST", "APPROVED"] },
      errorMessage: { not: null },
      gbpRetryCount: { lt: settings.maxRetryAttempts },
      OR: [{ gbpNextRetryAt: null }, { gbpNextRetryAt: { lte: now } }],
    },
    take: 20,
  });

  for (const post of posts) {
    try {
      await publishApprovedPostToGbp(post.id);
      console.log(`[Retry Worker] GBP retry succeeded for ${post.id}`);
    } catch (err) {
      console.error(`[Retry Worker] GBP retry failed for ${post.id}:`, err);
    }
  }
}

async function runRetryCycle() {
  await processGbpRetries();
}

export async function startRetryWorker() {
  if (task) return;
  task = cron.schedule("*/10 * * * *", async () => {
    try {
      await runRetryCycle();
    } catch (err) {
      console.error("[Retry Worker] Error:", err);
    }
  });
  console.log("[Retry Worker] Started (every 10 minutes)");
  await runRetryCycle();
}

export function stopRetryWorker() {
  if (task) {
    task.stop();
    task = null;
  }
}
