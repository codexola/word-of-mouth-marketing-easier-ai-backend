import pg from "pg";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "1234";
const DB_NAME = process.env.DB_NAME || "gbp_content_manager";
const ADMIN_DB = process.env.DB_ADMIN || "postgres";

async function ensureDatabase() {
  const client = new pg.Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: ADMIN_DB,
  });

  try {
    await client.connect();
    console.log(`[OK] PostgreSQL 接続成功 (${DB_HOST}:${DB_PORT} / ${DB_USER})`);

    const exists = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [DB_NAME]
    );

    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${DB_NAME}"`);
      console.log(`[OK] データベース "${DB_NAME}" を作成しました`);
    } else {
      console.log(`[OK] データベース "${DB_NAME}" は既に存在します`);
    }
  } finally {
    await client.end();
  }

  const appClient = new pg.Client({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });

  try {
    await appClient.connect();
    console.log(`[OK] "${DB_NAME}" への接続確認完了`);
  } finally {
    await appClient.end();
  }
}

ensureDatabase().catch((err) => {
  console.error("[ERROR] データベースセットアップ失敗:", err.message);
  console.error("");
  console.error(" Navicat 接続情報を確認してください:");
  console.error("   ホスト: localhost  ポート: 5432");
  console.error("   ユーザー: postgres  パスワード: 1234");
  console.error("   初期DB: postgres");
  process.exit(1);
});
