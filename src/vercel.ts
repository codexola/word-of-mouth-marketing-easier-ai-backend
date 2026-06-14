import { createApp } from "./app.js";
import { ensureDatabaseReady } from "./lib/ensure-db.js";

await ensureDatabaseReady();

export default createApp();
