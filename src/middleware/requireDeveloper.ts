import type { Response, NextFunction } from "express";
import { DEVELOPER_USER_ID } from "../config/developer.js";
import type { AuthRequest } from "./auth.js";

/** Only the env-based developer session may manage users. */
export function requireDeveloper(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.id !== DEVELOPER_USER_ID) {
    return res.status(403).json({ error: "開発者アカウントでのみ利用できます" });
  }
  next();
}
