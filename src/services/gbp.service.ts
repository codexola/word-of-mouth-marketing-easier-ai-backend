import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { isAllowedFrontendOrigin } from "../lib/frontend-origin.js";
import { pickPublicImageUrls, normalizePublicUrl } from "./image-storage.service.js";
import { refreshApprovedPostImages } from "./media.service.js";
import { recordPublicationLog, saveArchiveSnapshot } from "./post-audit.service.js";
import { computeNextRetryAt } from "./retry.service.js";
import { getSettings, updateSettings } from "./settings.service.js";

const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

export function isGbpOAuthConfigured() {
  return !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
}

export async function getGbpStatus() {
  const settings = await getSettings();
  const oauthConfigured = isGbpOAuthConfigured();
  const connected = !!(settings.gbpRefreshToken && settings.gbpAccessToken);
  const hasLocation = !!(settings.gbpAccountId && settings.gbpLocationId);
  const issues: string[] = [];
  if (!oauthConfigured) issues.push("OAuth未設定（.env の GOOGLE_OAUTH_*）");
  if (!connected) issues.push("Googleアカウント未連携");
  if (connected && !hasLocation) issues.push("投稿先店舗が未選択");
  if (connected && hasLocation && !settings.gbpAutoPostEnabled) {
    issues.push("自動投稿がオフ（手動投稿は可能）");
  }
  return {
    oauthConfigured,
    connected,
    autoPostEnabled: settings.gbpAutoPostEnabled,
    accountId: settings.gbpAccountId,
    locationId: settings.gbpLocationId,
    locationName: settings.gbpLocationName,
    tokenExpiresAt: settings.gbpTokenExpiresAt,
    readyToPublish: connected && hasLocation,
    issues,
  };
}

export function getGbpAuthUrl(returnOrigin?: string) {
  if (!isGbpOAuthConfigured()) {
    throw new Error("Google OAuth が設定されていません（.env の GOOGLE_OAUTH_* を確認してください）");
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
    response_type: "code",
    scope: GBP_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  if (returnOrigin && isAllowedFrontendOrigin(returnOrigin)) {
    params.set("state", returnOrigin);
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "OAuthトークン取得に失敗しました");
  }
  return data;
}

export async function handleGbpOAuthCallback(code: string) {
  const tokens = await exchangeCodeForTokens(code);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : new Date(Date.now() + 3600 * 1000);

  await updateSettings({
    gbpAccessToken: tokens.access_token,
    gbpRefreshToken: tokens.refresh_token || undefined,
    gbpTokenExpiresAt: expiresAt,
  } as Parameters<typeof updateSettings>[0]);

  try {
    const locations = await listGbpLocations();
    if (locations.length === 1) {
      await selectGbpLocation(locations[0].accountId, locations[0].locationId, locations[0].title);
    }
  } catch (err) {
    console.warn("[GBP OAuth] Auto-select location skipped:", err);
  }

  return getGbpStatus();
}

async function refreshGbpAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "トークンの更新に失敗しました");
  }
  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : new Date(Date.now() + 3600 * 1000);

  await updateSettings({
    gbpAccessToken: data.access_token,
    gbpTokenExpiresAt: expiresAt,
  } as Parameters<typeof updateSettings>[0]);

  return data.access_token;
}

export async function getValidGbpAccessToken(): Promise<string> {
  const settings = await getSettings();
  if (!settings.gbpAccessToken && !settings.gbpRefreshToken) {
    throw new Error("Googleビジネスプロフィールが未連携です");
  }

  const expiresSoon =
    settings.gbpTokenExpiresAt &&
    settings.gbpTokenExpiresAt.getTime() < Date.now() + 60_000;

  if (settings.gbpAccessToken && !expiresSoon) {
    return settings.gbpAccessToken;
  }

  if (!settings.gbpRefreshToken) {
    throw new Error("GBPアクセストークンの有効期限が切れています。再連携してください");
  }

  return refreshGbpAccessToken(settings.gbpRefreshToken);
}

export async function disconnectGbp() {
  await updateSettings({
    gbpAccountId: null,
    gbpLocationId: null,
    gbpLocationName: null,
    gbpRefreshToken: null,
    gbpAccessToken: null,
    gbpTokenExpiresAt: null,
    gbpAutoPostEnabled: false,
  } as Parameters<typeof updateSettings>[0]);
}

export interface GbpLocationOption {
  accountId: string;
  accountName: string;
  locationId: string;
  locationName: string;
  title: string;
  address?: string;
}

let cachedLocations: { items: GbpLocationOption[]; fetchedAt: number } | null = null;
const LOCATIONS_CACHE_TTL_MS = 5 * 60 * 1000;

function isQuotaError(message: string): boolean {
  return /quota exceeded|rate limit|429/i.test(message);
}

export async function listGbpLocations(options?: { force?: boolean }): Promise<GbpLocationOption[]> {
  if (
    !options?.force &&
    cachedLocations &&
    Date.now() - cachedLocations.fetchedAt < LOCATIONS_CACHE_TTL_MS
  ) {
    return cachedLocations.items;
  }

  const token = await getValidGbpAccessToken();
  const accountsRes = await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accountsData = (await accountsRes.json()) as {
    accounts?: { name: string; accountName?: string }[];
    error?: { message?: string };
  };
  if (!accountsRes.ok) {
    const msg = accountsData.error?.message || "GBPアカウント一覧の取得に失敗しました";
    if (isQuotaError(msg)) {
      throw new Error(
        "GBP APIの利用上限に達しました。1〜2分待ってから再度「店舗一覧を取得」を押してください"
      );
    }
    throw new Error(msg);
  }

  const results: GbpLocationOption[] = [];
  for (const account of accountsData.accounts || []) {
    const accountId = account.name.replace("accounts/", "");
    const locRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const locData = (await locRes.json()) as {
      locations?: {
        name: string;
        title?: string;
        storefrontAddress?: { addressLines?: string[]; locality?: string };
      }[];
      error?: { message?: string };
    };
    if (!locRes.ok) {
      const msg = locData.error?.message || `店舗一覧の取得に失敗 (${locRes.status})`;
      console.warn(`[GBP] locations for ${account.name}: ${msg}`);
      continue;
    }

    for (const loc of locData.locations || []) {
      const locationId = loc.name.split("/").pop() || loc.name;
      const address = loc.storefrontAddress
        ? [loc.storefrontAddress.locality, ...(loc.storefrontAddress.addressLines || [])]
            .filter(Boolean)
            .join(" ")
        : undefined;
      results.push({
        accountId,
        accountName: account.accountName || accountId,
        locationId,
        locationName: loc.name,
        title: loc.title || locationId,
        address,
      });
    }
  }
  cachedLocations = { items: results, fetchedAt: Date.now() };
  return results;
}

function resolveGbpLocalPostResourceName(
  gbpPostId: string,
  settings: { gbpAccountId?: string | null; gbpLocationId?: string | null }
): string {
  if (gbpPostId.startsWith("accounts/")) return gbpPostId;
  if (settings.gbpAccountId && settings.gbpLocationId) {
    return `accounts/${settings.gbpAccountId}/locations/${settings.gbpLocationId}/localPosts/${gbpPostId}`;
  }
  return gbpPostId;
}

/** GBP 上の投稿を削除（404 は成功扱い） */
export async function deleteGbpLocalPost(gbpPostId: string): Promise<void> {
  if (!gbpPostId) return;
  const settings = await getSettings();
  const token = await getValidGbpAccessToken();
  const resource = resolveGbpLocalPostResourceName(gbpPostId, settings);
  const url = `https://mybusiness.googleapis.com/v4/${resource}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok || res.status === 404) return;
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  throw new Error(data.error?.message || `GBP投稿の削除に失敗しました (${res.status})`);
}

/** GBP 上の投稿本文を更新 */
export async function updateGbpLocalPostSummary(gbpPostId: string, summary: string): Promise<void> {
  const settings = await getSettings();
  const token = await getValidGbpAccessToken();
  const resource = resolveGbpLocalPostResourceName(gbpPostId, settings);
  const url = `https://mybusiness.googleapis.com/v4/${resource}?updateMask=summary`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      languageCode: "ja",
      summary: summary.slice(0, 1500),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(data.error?.message || `GBP投稿の更新に失敗しました (${res.status})`);
  }
}

export async function selectGbpLocation(accountId: string, locationId: string, locationTitle?: string) {
  await updateSettings({
    gbpAccountId: accountId,
    gbpLocationId: locationId,
    gbpLocationName: locationTitle || locationId,
    gbpAutoPostEnabled: true,
  } as Parameters<typeof updateSettings>[0]);
  return getGbpStatus();
}

function parseGbpApiError(data: unknown, status: number): string {
  const err = data as {
    error?: { message?: string; status?: string; details?: { reason?: string; message?: string }[] };
  };
  const parts = [
    err.error?.message,
    err.error?.status,
    ...(err.error?.details?.map((d) => d.message || d.reason) || []),
  ].filter(Boolean);
  return parts.join(" — ") || `GBP投稿に失敗しました (${status})`;
}

function validateGbpPublishConfig(
  settings: Awaited<ReturnType<typeof getSettings>>,
  requireAutoPostEnabled: boolean
) {
  if (requireAutoPostEnabled && !settings.gbpAutoPostEnabled) {
    throw new Error("GBP自動投稿が無効です。設定画面で「承認後にGBPへ自動投稿」を有効にしてください");
  }
  if (!settings.gbpRefreshToken && !settings.gbpAccessToken) {
    throw new Error("Googleビジネスプロフィールが未連携です。設定画面からGoogleアカウントを連携してください");
  }
  if (!settings.gbpAccountId || !settings.gbpLocationId) {
    throw new Error(
      "GBPの投稿先店舗が未選択です。設定画面 → GBP →「店舗一覧を取得」→ 店舗を選んで保存してください"
    );
  }
}

export async function publishApprovedPostToGbp(
  approvedPostId: string,
  userId?: string,
  options: { requireAutoPostEnabled?: boolean } = {}
) {
  const requireAutoPostEnabled = options.requireAutoPostEnabled ?? true;
  const settings = await getSettings();
  validateGbpPublishConfig(settings, requireAutoPostEnabled);

  const approved = await prisma.approvedPost.findUnique({
    where: { id: approvedPostId },
    include: { postCandidate: true },
  });
  if (!approved) throw new Error("承認済み投稿が見つかりません");
  if (approved.status === "POSTED" && approved.gbpPostId) {
    return approved;
  }

  const refreshedUrls = await refreshApprovedPostImages(approved.postCandidateId);
  if (refreshedUrls.length > 0) {
    approved.imageUrls = refreshedUrls;
  } else if (approved.imageUrls.length > 0) {
    const repaired = approved.imageUrls.map((url) => normalizePublicUrl(url));
    await prisma.approvedPost.update({
      where: { id: approvedPostId },
      data: { imageUrls: repaired },
    });
    approved.imageUrls = repaired;
  }

  const token = await getValidGbpAccessToken();
  const summary = [approved.title, approved.body].filter(Boolean).join("\n\n").slice(0, 1500);
  const publicImages = pickPublicImageUrls(approved.imageUrls);
  const publicImage = publicImages[0];

  const payload: Record<string, unknown> = {
    languageCode: "ja",
    summary,
    topicType: "STANDARD",
  };
  if (publicImage) {
    payload.media = [{ mediaFormat: "PHOTO", sourceUrl: publicImage }];
  }

  const url = `https://mybusiness.googleapis.com/v4/accounts/${settings.gbpAccountId}/locations/${settings.gbpLocationId}/localPosts`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as { name?: string; error?: { message?: string } };
  if (!res.ok) {
    const message = parseGbpApiError(data, res.status);
    const nextCount = approved.gbpRetryCount + 1;
    const nextRetryAt = await computeNextRetryAt(nextCount);
    await prisma.approvedPost.update({
      where: { id: approvedPostId },
      data: {
        errorMessage: message,
        gbpRetryCount: nextCount,
        gbpLastErrorAt: new Date(),
        gbpNextRetryAt: nextRetryAt,
      },
    });
    await recordPublicationLog({
      postCandidateId: approved.postCandidateId,
      approvedPostId,
      action: "gbp_publish_failed",
      errorMessage: message,
    });
    throw new Error(message);
  }

  const gbpPostId = data.name || null;
  const now = new Date();
  const updated = await prisma.approvedPost.update({
    where: { id: approvedPostId },
    data: {
      status: "POSTED",
      postedAt: now,
      postedById: userId,
      gbpPostId,
      gbpPublishedAt: now,
      errorMessage: null,
      gbpRetryCount: 0,
      gbpNextRetryAt: null,
      gbpLastErrorAt: null,
    },
  });

  await prisma.postCandidate.update({
    where: { id: approved.postCandidateId },
    data: { status: "POSTED" },
  });

  await recordPublicationLog({
    postCandidateId: approved.postCandidateId,
    approvedPostId,
    action: "gbp_publish",
    gbpPostId: gbpPostId || undefined,
  });
  await saveArchiveSnapshot(approved.postCandidateId, approvedPostId);

  return updated;
}

export async function tryAutoPublishOnApprove(approvedPostId: string, userId?: string) {
  const settings = await getSettings();
  if (!settings.gbpAutoPostEnabled || !settings.gbpAccountId || !settings.gbpLocationId) {
    return null;
  }
  if (!isGbpOAuthConfigured() || !settings.gbpRefreshToken) {
    return null;
  }
  try {
    return await publishApprovedPostToGbp(approvedPostId, userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "GBP投稿に失敗しました";
    await prisma.approvedPost.update({
      where: { id: approvedPostId },
      data: {
        errorMessage: message,
        gbpLastErrorAt: new Date(),
      },
    });
    console.error("[GBP Auto-Post]", err);
    return null;
  }
}
