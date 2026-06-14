/**
 * Skip prisma generate on Vercel install — vercel-build runs it instead.
 * Keeps local `npm install` working without EPERM from a running server.
 */
import { execSync } from "child_process";

if (process.env.VERCEL === "1" || process.env.CI === "true") {
  process.exit(0);
}

execSync("npx prisma generate", { stdio: "inherit" });
