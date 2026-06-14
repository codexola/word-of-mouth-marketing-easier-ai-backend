import { SourceType } from "@prisma/client";
import { AppError } from "../lib/app-error.js";
import { prisma } from "../lib/prisma.js";
import { deleteDriveFile } from "./drive.service.js";
import {
  deleteImageByPublicUrl,
  deleteImageFile,
  ensurePublicUrlsForPost,
  isPublicHttpUrl,
  isUsableGbpMediaUrl,
  normalizePublicUrl,
  resolveImageRecordToPublicUrl,
} from "./image-storage.service.js";

export interface MediaPhotoItem {
  id: string;
  url: string;
  fileName?: string | null;
  mimeType?: string | null;
  sourceFileId?: string | null;
  storagePath?: string | null;
  createdAt: Date;
  postCandidateId: string;
  postStatus: string;
  postSource: string;
  postTitle?: string | null;
  postRegion?: string | null;
  approvedPostId?: string | null;
  approvedStatus?: string | null;
  inArchive: boolean;
}

export async function listMediaPhotos(filters?: {
  source?: "GOOGLE_DRIVE" | "LINE" | "MANUAL";
  page?: number;
  limit?: number;
}) {
  const page = filters?.page || 1;
  const limit = filters?.limit || 48;
  const skip = (page - 1) * limit;

  const defaultSources: SourceType[] = ["GOOGLE_DRIVE", "LINE"];
  const where = {
    postCandidate: filters?.source
      ? { source: filters.source, deletedAt: null }
      : { source: { in: defaultSources }, deletedAt: null },
  };

  const [images, total] = await Promise.all([
    prisma.postImage.findMany({
      where,
      include: {
        postCandidate: {
          include: {
            generation: { select: { title: true } },
            approvedPost: { select: { id: true, status: true, imageUrls: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.postImage.count({ where }),
  ]);

  const items: MediaPhotoItem[] = images.map((img) => ({
    id: img.id,
    url: normalizePublicUrl(img.url),
    fileName: img.fileName,
    mimeType: img.mimeType,
    sourceFileId: img.sourceFileId,
    storagePath: img.storagePath,
    createdAt: img.createdAt,
    postCandidateId: img.postCandidateId,
    postStatus: img.postCandidate.status,
    postSource: img.postCandidate.source,
    postTitle: img.postCandidate.generation?.title ?? null,
    postRegion: img.postCandidate.region,
    approvedPostId: img.postCandidate.approvedPost?.id ?? null,
    approvedStatus: img.postCandidate.approvedPost?.status ?? null,
    inArchive: !!img.postCandidate.approvedPost,
  }));

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

type SyncableImage = {
  id: string;
  url: string;
  storagePath?: string | null;
  sourceFileId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
};

/** PostCandidate の画像URLと ApprovedPost.imageUrls を常に同期する */
export async function syncPostCandidateEntity<
  T extends {
    id: string;
    images: SyncableImage[];
    approvedPost?: { id: string; imageUrls: string[] } | null;
  },
>(post: T): Promise<T> {
  const syncedImages: SyncableImage[] = [];
  for (const img of post.images) {
    const resolved = normalizePublicUrl(await resolveImageRecordToPublicUrl(img));
    syncedImages.push({ ...img, url: resolved });
  }
  post.images = syncedImages;

  if (post.approvedPost) {
    const urls = syncedImages.map((img) => img.url).filter((u) => isUsableGbpMediaUrl(u));
    const current = post.approvedPost.imageUrls || [];
    if (JSON.stringify(current) !== JSON.stringify(urls)) {
      await prisma.approvedPost.update({
        where: { id: post.approvedPost.id },
        data: { imageUrls: urls },
      });
    }
    post.approvedPost.imageUrls = urls;
  }

  return post;
}

export async function refreshApprovedPostImages(postCandidateId: string): Promise<string[]> {
  const urls = await ensurePublicUrlsForPost(postCandidateId);
  const usable = urls
    .map((u) => normalizePublicUrl(u))
    .filter((u) => isUsableGbpMediaUrl(u));

  const approved = await prisma.approvedPost.findUnique({ where: { postCandidateId } });
  if (approved) {
    await prisma.approvedPost.update({
      where: { id: approved.id },
      data: { imageUrls: usable },
    });
  }
  return usable;
}

export async function enrichApprovedPostImages<T extends { imageUrls: string[]; postCandidateId: string; postCandidate?: { images: { id: string; url: string; storagePath?: string | null; sourceFileId?: string | null; fileName?: string | null; mimeType?: string | null }[] } | null }>(
  item: T
): Promise<T> {
  let urls = (item.imageUrls || []).map((u) => normalizePublicUrl(u));

  if (urls.length === 0 && item.postCandidate?.images?.length) {
    urls = [];
    for (const img of item.postCandidate.images) {
      const resolved = await resolveImageRecordToPublicUrl(img);
      if (isUsableGbpMediaUrl(resolved)) urls.push(resolved);
    }
    if (urls.length > 0) {
      await prisma.approvedPost.update({
        where: { postCandidateId: item.postCandidateId },
        data: { imageUrls: urls },
      });
      item.imageUrls = urls;
    }
  } else if (urls.some((u) => !isUsableGbpMediaUrl(u))) {
    const refreshed = await refreshApprovedPostImages(item.postCandidateId);
    item.imageUrls = refreshed;
  } else {
    item.imageUrls = urls.filter((u) => isPublicHttpUrl(u));
  }

  return item;
}

export async function deleteMediaPhoto(imageId: string) {
  const image = await prisma.postImage.findUnique({
    where: { id: imageId },
    include: {
      postCandidate: {
        include: { approvedPost: true, images: true },
      },
    },
  });

  if (!image) throw new AppError("写真が見つかりません", 404);

  const post = image.postCandidate;
  const warnings: string[] = [];

  if (post.source === "GOOGLE_DRIVE" && image.sourceFileId) {
    try {
      await deleteDriveFile(image.sourceFileId);
      await prisma.syncedDriveFile.deleteMany({
        where: { driveFileId: image.sourceFileId },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Google Drive からの削除に失敗";
      warnings.push(msg);
      console.warn("[Media] Drive delete failed:", msg);
    }
  }

  if (post.source === "LINE") {
    await prisma.lineMessageBuffer.deleteMany({
      where: {
        OR: [
          { imageUrl: image.url },
          ...(image.sourceFileId ? [{ messageId: image.sourceFileId }] : []),
        ],
      },
    });
    warnings.push(
      "LINE上のユーザー送信メッセージはAPIでは削除できません（サーバー上のコピーのみ削除しました）"
    );
  }

  deleteImageFile(image.storagePath);
  deleteImageByPublicUrl(image.url);

  await prisma.postImage.delete({ where: { id: imageId } });

  const remainingImages = post.images.filter((i) => i.id !== imageId);

  if (post.approvedPost) {
    const urls: string[] = [];
    for (const img of remainingImages) {
      const resolved = await resolveImageRecordToPublicUrl(img);
      if (isUsableGbpMediaUrl(resolved)) urls.push(resolved);
    }
    await prisma.approvedPost.update({
      where: { id: post.approvedPost.id },
      data: { imageUrls: urls },
    });
  }

  const remainingCount = await prisma.postImage.count({
    where: { postCandidateId: post.id },
  });

  if (remainingCount === 0 && ["NOT_CREATED", "ERROR", "CANCELLED"].includes(post.status)) {
    await prisma.postCandidate.delete({ where: { id: post.id } });
  }

  return {
    success: true,
    warnings: [...new Set(warnings)],
    postDeleted: remainingCount === 0,
  };
}
