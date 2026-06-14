import cron from "node-cron";
import { syncDriveFolder } from "../services/drive.service.js";
import { getSettings } from "../services/settings.service.js";

let task: cron.ScheduledTask | null = null;

export async function startDrivePoller() {
  if (task) return;

  const settings = await getSettings();
  const interval = settings.drivePollInterval || 1;

  task = cron.schedule(`*/${interval} * * * *`, async () => {
    try {
      const result = await syncDriveFolder();
      if (result.synced > 0) {
        console.log(`[Drive Poller] Synced ${result.synced} new files`);
      }
    } catch (err) {
      console.error("[Drive Poller] Error:", err);
    }
  });

  console.log(`[Drive Poller] Started (every ${interval} minutes)`);
}

export function stopDrivePoller() {
  if (task) {
    task.stop();
    task = null;
  }
}
