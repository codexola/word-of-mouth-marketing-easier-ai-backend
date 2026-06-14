import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { ensureDatabaseReady } from "./lib/ensure-db.js";
import { deduplicateDrivePostCandidates } from "./services/drive.service.js";
import { startDrivePoller } from "./jobs/drivePoller.js";
import { startRetryWorker } from "./jobs/retryWorker.js";
import { startReviewSender } from "./jobs/reviewSender.js";

const app = createApp();

app.listen(env.PORT, "0.0.0.0", async () => {
  await ensureDatabaseReady();

  console.log(`Server running on http://localhost:${env.PORT} (all interfaces)`);

  deduplicateDrivePostCandidates().catch((err) => {
    console.error("[Drive] Startup deduplication failed:", err);
  });

  await startDrivePoller();
  await startReviewSender();
  await startRetryWorker();
});
