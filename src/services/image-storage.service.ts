import crypto from "crypto";
import fs from "fs";
import path from "path";
import { env } from "../config/env.js";
import { ensureUploadsDir, UPLOADS_DIR } from "../lib/uploads.js";
import { prisma } from "../lib/prisma.js";

export function getPublicBaseUrl(): string {
  return (env.PUBLIC_API_URL || `http://localhost:${env.PORT}`).replace(/\/$/, "");
}

export function getPublicUrlForFilename(filename: string): string {
  return `${getPublicBaseUrl()}/uploads/${filename}`;
}

/** localhost 等の古い URL を PUBLIC_API_URL ベースに置き換える */
export function normalizePublicUrl(url: string): string {
  const base = getPublicBaseUrl();
  return url
    .replace(/^https?:\/\/localhost(?::\d+)?/i, base)
    .replace(/^https?:\/\/127\.0\.0\.1(?::\d+)?/i, base);
}

export function isUsableGbpMediaUrl(url: string): boolean {
  if (!isPublicHttpUrl(url) || isDriveLikeUrl(url)) return false;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url)) return false;
  return true;
}

export function getPublicUrlForStoragePath(storagePath: string): string {
  const filename = path.basename(storagePath);
  return getPublicUrlForFilename(filename);
}

function extensionForMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
  };
  return map[mimeType.toLowerCase()] || ".jpg";
}

export interface SavedImage {
  storagePath: string;
  publicUrl: string;
  mimeType: string;
}

export function saveImageBuffer(
  buffer: Buffer,
  mimeType: string,
  prefix = "img"
): SavedImage {
  ensureUploadsDir();
  const ext = extensionForMime(mimeType);
  const filename = `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
  const storagePath = path.join(UPLOADS_DIR, filename);
  fs.writeFileSync(storagePath, buffer);
  return {
    storagePath,
    publicUrl: getPublicUrlForFilename(filename),
    mimeType,
  };
}

export function saveDataUrlImage(dataUrl: string, prefix = "img"): SavedImage | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  return saveImageBuffer(buffer, mimeType, prefix);
}

export function isPublicHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

export function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}

export function isDriveLikeUrl(url: string): boolean {
  return (
    url.includes("drive.google.com") ||
    url.includes("googleusercontent.com") ||
    url.includes("docs.google.com")
  );
}

export async function resolveImageRecordToPublicUrl(image: {
  id: string;
  url: string;
  storagePath?: string | null;
  sourceFileId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}): Promise<string> {
  if (image.storagePath && fs.existsSync(image.storagePath)) {
    const publicUrl = normalizePublicUrl(getPublicUrlForStoragePath(image.storagePath));
    if (image.url !== publicUrl) {
      await prisma.postImage.update({
        where: { id: image.id },
        data: { url: publicUrl },
      });
    }
    return publicUrl;
  }

  if (isPublicHttpUrl(image.url) && !isDriveLikeUrl(image.url)) {
    return normalizePublicUrl(image.url);
  }

  if (isDataUrl(image.url)) {
    const saved = saveDataUrlImage(image.url, `line-${image.id}`);
    if (!saved) return image.url;
    await prisma.postImage.update({
      where: { id: image.id },
      data: { url: saved.publicUrl, storagePath: saved.storagePath, mimeType: saved.mimeType },
    });
    return saved.publicUrl;
  }

  if (image.sourceFileId) {
    const { downloadAndStoreDriveFile } = await import("./drive.service.js");
    const saved = await downloadAndStoreDriveFile(
      image.sourceFileId,
      image.fileName || `drive-${image.sourceFileId}`,
      image.mimeType || undefined
    );
    if (saved) {
      await prisma.postImage.update({
        where: { id: image.id },
        data: { url: saved.publicUrl, storagePath: saved.storagePath, mimeType: saved.mimeType },
      });
      return saved.publicUrl;
    }
  }

  return image.url;
}

export async function ensurePublicUrlsForPost(postId: string): Promise<string[]> {
  const images = await prisma.postImage.findMany({
    where: { postCandidateId: postId },
    orderBy: { createdAt: "asc" },
  });
  const urls: string[] = [];
  for (const img of images) {
    urls.push(await resolveImageRecordToPublicUrl(img));
  }
  return urls.filter((url) => isPublicHttpUrl(url) && !isDriveLikeUrl(url));
}

export function pickPublicImageUrls(imageUrls: string[]): string[] {
  return imageUrls
    .map((url) => normalizePublicUrl(url))
    .filter((url) => isUsableGbpMediaUrl(url));
}

export function deleteImageFile(storagePath?: string | null) {
  if (!storagePath) return;
  try {
    if (fs.existsSync(storagePath)) fs.unlinkSync(storagePath);
  } catch (err) {
    console.warn("[Image] Failed to delete file:", storagePath, err);
  }
}

export function deleteImageByPublicUrl(url?: string | null) {
  if (!url || !isPublicHttpUrl(url)) return;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.includes("/uploads/")) return;
    const filename = path.basename(parsed.pathname);
    const full = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (err) {
    console.warn("[Image] Failed to delete by URL:", url, err);
  }
}

export function deletePostImagesFromDisk(
  images: { storagePath?: string | null; url?: string }[],
  extraUrls: string[] = []
) {
  for (const img of images) {
    deleteImageFile(img.storagePath);
    deleteImageByPublicUrl(img.url);
  }
  for (const url of extraUrls) {
    deleteImageByPublicUrl(url);
  }
}
