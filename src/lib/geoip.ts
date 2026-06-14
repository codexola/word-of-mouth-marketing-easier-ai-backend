/** Default center: Tokyo — regional GBP project fallback for local/private IPs */
const FALLBACK = {
  lat: 35.6762,
  lng: 139.6503,
  city: "東京",
  country: "日本",
  region: "関東",
};

export interface GeoLocation {
  lat: number;
  lng: number;
  city: string | null;
  country: string | null;
  region: string | null;
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("172.16.") ||
    ip.startsWith("172.17.") ||
    ip.startsWith("172.18.") ||
    ip.startsWith("172.19.") ||
    ip.startsWith("172.2") ||
    ip.startsWith("172.30.") ||
    ip.startsWith("172.31.")
  );
}

/** Resolve IP to coordinates via ip-api.com (no API key required). */
export async function resolveGeoFromIp(ip: string): Promise<GeoLocation> {
  if (isPrivateIp(ip)) {
    return { ...FALLBACK };
  }

  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,lat,lon,city,country,regionName`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = (await res.json()) as {
      status?: string;
      lat?: number;
      lon?: number;
      city?: string;
      country?: string;
      regionName?: string;
    };

    if (data.status === "success" && typeof data.lat === "number" && typeof data.lon === "number") {
      return {
        lat: data.lat,
        lng: data.lon,
        city: data.city ?? null,
        country: data.country ?? null,
        region: data.regionName ?? null,
      };
    }
  } catch {
    // fall through
  }

  return { ...FALLBACK };
}
