import { DEVELOPER_USER_ID } from "../config/developer.js";

/** 開発者セッションはDBにユーザー行がないため、FK用IDは null にする */
export function resolveActorUserId(userId?: string): string | undefined {
  return userId && userId !== DEVELOPER_USER_ID ? userId : undefined;
}
