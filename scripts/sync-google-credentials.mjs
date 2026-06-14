/**
 * Sync Google service account JSON + OAuth into backend/.env
 * Run from repo root: node backend/scripts/sync-google-credentials.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const saPath =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
  path.join(root, "google-service-account.json");
const envPath = path.join(root, "backend", ".env");

const sa = JSON.parse(fs.readFileSync(saPath, "utf8"));

const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";

if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
  console.error(
    "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in the environment before running this script."
  );
  process.exit(1);
}

const updates = {
  GOOGLE_CLIENT_EMAIL: sa.client_email,
  GOOGLE_PRIVATE_KEY: JSON.stringify(sa.private_key),
  GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || "",
  GOOGLE_OAUTH_CLIENT_ID: OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:4000/api/gbp/callback",
};

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

for (const [key, value] of Object.entries(updates)) {
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(env)) {
    env = env.replace(regex, line);
  } else {
    env += `\n${line}`;
  }
}

// Remove TODO comments for applied keys
env = env.replace(/^# TODO:.*\n/gm, "");

fs.writeFileSync(envPath, env.trimEnd() + "\n", "utf8");
console.log("Updated backend/.env:");
console.log("  GOOGLE_CLIENT_EMAIL:", sa.client_email);
console.log("  GOOGLE_PRIVATE_KEY: (set from service account JSON)");
console.log("  GOOGLE_OAUTH_CLIENT_ID:", OAUTH_CLIENT_ID);
console.log("  GOOGLE_OAUTH_CLIENT_SECRET: (set)");
