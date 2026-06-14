import type { Request } from "express";

/** Resolve client IP from proxy headers or socket. */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() || "127.0.0.1";
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(",")[0]?.trim() || "127.0.0.1";
  }
  return req.socket.remoteAddress?.replace("::ffff:", "") || "127.0.0.1";
}
