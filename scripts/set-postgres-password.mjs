import pg from "pg";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Workhome124!";
const NEW_PASSWORD = process.env.NEW_PASSWORD || "1234";

const client = new pg.Client({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: ADMIN_PASSWORD,
  database: "postgres",
});

try {
  await client.connect();
  await client.query(`ALTER USER postgres WITH PASSWORD '${NEW_PASSWORD.replace(/'/g, "''")}'`);
  console.log(`[OK] postgres ユーザーのパスワードを "${NEW_PASSWORD}" に変更しました`);
} catch (err) {
  console.error("[ERROR]", err.message);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
