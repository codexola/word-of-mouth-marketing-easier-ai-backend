import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Vercel serverless: use /tmp (ephemeral). VPS/local: backend/uploads */
export const UPLOADS_DIR =
  process.env.VERCEL === "1"
    ? path.join("/tmp", "gbp-uploads")
    : path.join(__dirname, "..", "..", "uploads");

export function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}
