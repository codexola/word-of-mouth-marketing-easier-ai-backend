import { env } from "./env.js";

/** Developer credentials live only in backend env — never stored in or exposed via the database. */
export function isDeveloperCredential(email: string, password: string): boolean {
  if (!env.DEVELOPER_EMAIL || !env.DEVELOPER_PASSWORD) return false;
  return email === env.DEVELOPER_EMAIL && password === env.DEVELOPER_PASSWORD;
}

export const DEVELOPER_USER_ID = "developer-env";
