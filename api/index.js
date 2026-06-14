import { createApp } from "../dist/app.js";
import { ensureDatabaseReady } from "../dist/lib/ensure-db.js";

let app;
let initPromise;

async function getApp() {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureDatabaseReady();
      app = createApp();
    })();
  }
  await initPromise;
  return app;
}

export default async function handler(req, res) {
  const expressApp = await getApp();
  return expressApp(req, res);
}
