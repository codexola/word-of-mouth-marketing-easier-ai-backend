import { env } from "../config/env.js";

function parseExtraOrigins(): string[] {
  const raw = env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function getAllowedFrontendOrigins(): string[] {
  const origins = new Set<string>([env.FRONTEND_URL.replace(/\/$/, "")]);
  for (const origin of parseExtraOrigins()) {
    origins.add(origin.replace(/\/$/, ""));
  }
  return [...origins];
}

/** Allow configured origins; Vercel domains; in development also allow port 3000. */
export function isAllowedFrontendOrigin(origin: string): boolean {
  const normalized = origin.replace(/\/$/, "");
  if (getAllowedFrontendOrigins().includes(normalized)) {
    return true;
  }

  if (env.ALLOW_VERCEL_ORIGINS !== false) {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:" && url.hostname.endsWith(".vercel.app")) {
        return true;
      }
    } catch {
      /* ignore invalid URL */
    }
  }

  if (env.NODE_ENV !== "development") {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.port === "3000"
    );
  } catch {
    return false;
  }
}

export function resolveFrontendOrigin(preferred?: string): string {
  if (preferred && isAllowedFrontendOrigin(preferred)) {
    return preferred.replace(/\/$/, "");
  }
  return env.FRONTEND_URL.replace(/\/$/, "");
}
