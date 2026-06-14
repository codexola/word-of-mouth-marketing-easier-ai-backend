import type { Response, NextFunction } from "express";
import { DEVELOPER_USER_ID } from "../config/developer.js";
import type { AuthRequest } from "./auth.js";

/** Restrict routes to administrators (DB ADMIN role or developer session). */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const isAdmin =
    req.user?.role === "ADMIN" || req.user?.id === DEVELOPER_USER_ID;
  if (!isAdmin) {
    return res.status(403).json({ error: "管理者権限が必要です" });
  }
  next();
}
