import pg from "pg";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[FAIL] DATABASE_URL が未設定です");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  const res = await client.query("SELECT current_database(), current_user, version()");
  console.log("[OK] 接続成功");
  console.log("  DB:", res.rows[0].current_database);
  console.log("  User:", res.rows[0].current_user);
  console.log("  Version:", res.rows[0].version.split(",")[0]);
  process.exit(0);
} catch (err) {
  console.error("[FAIL]", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
