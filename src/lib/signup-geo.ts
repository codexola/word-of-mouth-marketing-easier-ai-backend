import type { Request } from "express";
import { prisma } from "./prisma.js";
import { getClientIp } from "./client-ip.js";
import { resolveGeoFromIp } from "./geoip.js";

/** Record subscription-time IP geolocation once per user (first login or account creation). */
export async function captureSignupGeoIfNeeded(userId: string, req: Request): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { signupIp: true },
  });
  if (!user || user.signupIp) return;

  const ip = getClientIp(req);
  const geo = await resolveGeoFromIp(ip);
  const label = [geo.city, geo.region, geo.country].filter(Boolean).join(", ");

  await prisma.user.update({
    where: { id: userId },
    data: {
      signupIp: ip,
      signupLat: geo.lat,
      signupLng: geo.lng,
      signupCity: geo.city,
      signupCountry: geo.country,
      signupRegion: geo.region,
      signupLocationLabel: label || null,
    },
  });
}
