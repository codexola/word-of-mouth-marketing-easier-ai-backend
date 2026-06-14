import { createApp } from "../dist/app.js";
import { ensureDatabaseReady } from "../dist/lib/ensure-db.js";

const app = createApp();
let dbReady: Promise<void> | null = null;

function ensureDb(): Promise<void> {
  if (!dbReady) {
    dbReady = ensureDatabaseReady();
  }
  return dbReady;
}

export default async function handler(
  req: import("http").IncomingMessage,
  res: import("http").ServerResponse
) {
  await ensureDb();
  app(req, res);
}
