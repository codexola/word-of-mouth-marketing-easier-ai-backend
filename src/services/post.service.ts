import type { PostStatus, SourceType } from "@prisma/client";
import { AppError } from "../lib/app-error.js";
import { prisma } from "../lib/prisma.js";
import {
  deleteGbpLocalPost,
  tryAutoPublishOnApprove,
  updateGbpLocalPostSummary,
} from "./gbp.service.js";
import {
  ensurePublicUrlsForPost,
  resolveImageRecordToPublicUrl,
} from "./image-storage.service.js";
import {
  enrichApprovedPostImages,
  refreshApprovedPostImages,
  syncPostCandidateEntity,
} from "./media.service.js";
import {
  analyzePostImages,
  generatePostContent,
  type RegenerateTone,
} from "./openai.service.js";
import {
  recordApprovalLog,
  recordPublicationLog,
  saveArchiveSnapshot,
} from "./post-audit.service.js";

export interface PostListFilters {
  status?: PostStatus;
  source?: SourceType;
  search?: string;
  page?: number;
  limit?: number;
}

export async function listPosts(filters: PostListFilters = {}) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where = {
    deletedAt: null,
    ...(filters.status && { status: filters.status }),
    ...(filters.source && { source: filters.source }),
    ...(filters.search && {
      OR: [
        { region: { contains: filters.search, mode: "insensitive" as const } },
        { serviceType: { contains: filters.search, mode: "insensitive" as const } },
        { memo: { contains: filters.search, mode: "insensitive" as const } },
        { generation: { title: { contains: filters.search, mode: "insensitive" as const } } },
        { generation: { body: { contains: filters.search, mode: "insensitive" as const } } },
      ],
    }),
  };

  const [rawItems, total] = await Promise.all([
    prisma.postCandidate.findMany({
      where,
      include: {
        images: { orderBy: { createdAt: "asc" } },
        generation: true,
        approvedPost: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.postCandidate.count({ where }),
  ]);

  const items = await Promise.all(rawItems.map((item) => syncPostCandidateEntity(item)));

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getPostById(id: string) {
  const post = await prisma.postCandidate.findFirst({
    where: { id, deletedAt: null },
    include: {
      images: { orderBy: { createdAt: "asc" } },
      generation: true,
      approvedPost: true,
      versions: { orderBy: { versionNo: "desc" }, take: 20 },
      approvalLogs: {
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { user: { select: { name: true } } },
      },
      publicationLogs: { orderBy: { createdAt: "desc" }, take: 30 },
      editHistories: { orderBy: { createdAt: "desc" }, include: { user: true } },
    },
  });
  if (!post) return null;
  return syncPostCandidateEntity(post);
}

/** ERROR状態の投稿を再生成して復旧する */
export async function repairErrorPosts() {
  const errors = await prisma.postCandidate.findMany({
    where: { status: "ERROR" },
    select: { id: true },
  });
  let repaired = 0;
  for (const post of errors) {
    try {
      await generateForPost(post.id);
      repaired++;
    } catch (err) {
      console.error(`[Repair] Failed to repair post ${post.id}:`, err);
    }
  }
  return { total: errors.length, repaired };
}

export async function getDashboardStats() {
  const [
    pendingReview,
    aiGenerated,
    posted,
    errors,
    reviewScheduled,
    total,
    readyToPost,
    cancelled,
  ] = await Promise.all([
    prisma.postCandidate.count({ where: { status: "PENDING_REVIEW" } }),
    prisma.postCandidate.count({ where: { status: "NOT_CREATED" } }),
    prisma.approvedPost.count({ where: { status: "POSTED" } }),
    prisma.postCandidate.count({ where: { status: "ERROR" } }),
    prisma.reviewRequest.count({ where: { sendStatus: "SCHEDULED" } }),
    prisma.postCandidate.count(),
    prisma.approvedPost.count({ where: { status: "READY_TO_POST" } }),
    prisma.postCandidate.count({ where: { status: "CANCELLED" } }),
  ]);

  return {
    pendingReview,
    aiGenerated,
    posted,
    errors,
    reviewScheduled,
    total,
    readyToPost,
    cancelled,
  };
}

export async function createPostCandidate(data: {
  source: SourceType;
  region?: string;
  workDescription?: string;
  serviceType?: string;
  memo?: string;
  lineUserId?: string;
  images?: { url: string; fileName?: string; mimeType?: string; sourceFileId?: string; storagePath?: string }[];
}) {
  const post = await prisma.postCandidate.create({
    data: {
      source: data.source,
      region: data.region,
      workDescription: data.workDescription,
      serviceType: data.serviceType,
      memo: data.memo,
      lineUserId: data.lineUserId,
      status: "NOT_CREATED",
      images: data.images?.length
        ? { create: data.images }
        : undefined,
    },
    include: { images: true },
  });

  return post;
}

export async function generateForPost(
  postId: string,
  options: { tone?: RegenerateTone; instruction?: string } = {}
) {
  const post = await getPostById(postId);
  if (!post) throw new AppError("投稿候補が見つかりません", 404);
  if (["APPROVED", "POSTED", "CANCELLED"].includes(post.status)) {
    throw new AppError("この投稿は再生成できません", 409);
  }

  const resolvedUrls: string[] = [];
  for (const img of post.images) {
    resolvedUrls.push(await resolveImageRecordToPublicUrl(img));
  }

  const imageAnalysis = await analyzePostImages(resolvedUrls);
  if (imageAnalysis && post.images[0]) {
    await prisma.postImage.update({
      where: { id: post.images[0].id },
      data: { analysisJson: imageAnalysis as object },
    });
    if (imageAnalysis.location && !post.region) {
      await prisma.postCandidate.update({
        where: { id: postId },
        data: { region: imageAnalysis.location },
      });
      post.region = imageAnalysis.location;
    }
    if (imageAnalysis.work_type && !post.serviceType) {
      await prisma.postCandidate.update({
        where: { id: postId },
        data: { serviceType: imageAnalysis.work_type },
      });
      post.serviceType = imageAnalysis.work_type;
    }
  }

  const result = await generatePostContent(
    {
      region: post.region,
      serviceType: post.serviceType,
      workDescription: post.workDescription,
      memo: post.memo,
      imageUrls: resolvedUrls,
      imageAnalysis,
    },
    { tone: options.tone, instruction: options.instruction }
  );

  const lastVersion = await prisma.postVersion.findFirst({
    where: { postCandidateId: postId },
    orderBy: { versionNo: "desc" },
    select: { versionNo: true },
  });
  const versionNo = (lastVersion?.versionNo ?? 0) + 1;

  await prisma.postVersion.create({
    data: {
      postCandidateId: postId,
      versionNo,
      title: result.title,
      body: result.body,
      tone: options.tone || "default",
      instruction: options.instruction,
      prompt: result.prompt,
      rawResponse: result.rawResponse as object,
    },
  });

  const generation = await prisma.postGeneration.upsert({
    where: { postCandidateId: postId },
    update: {
      title: result.title,
      body: result.body,
      shortBody: result.shortBody,
      politeBody: result.politeBody,
      regionalBody: result.regionalBody,
      serviceKeywords: result.serviceKeywords,
      cautions: result.cautions,
      reviewRequestText: result.reviewRequestText,
      rawResponse: result.rawResponse as object,
    },
    create: {
      postCandidateId: postId,
      title: result.title,
      body: result.body,
      shortBody: result.shortBody,
      politeBody: result.politeBody,
      regionalBody: result.regionalBody,
      serviceKeywords: result.serviceKeywords,
      cautions: result.cautions,
      reviewRequestText: result.reviewRequestText,
      rawResponse: result.rawResponse as object,
    },
  });

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { status: "PENDING_REVIEW", errorMessage: null },
  });

  await recordApprovalLog(postId, "regenerate", undefined, {
    tone: options.tone || "default",
    versionNo,
    imageAnalysis: imageAnalysis ? (imageAnalysis as object) : null,
  });

  return generation;
}

export async function updatePostContent(
  postId: string,
  data: { title: string; body: string; userId?: string; action?: string }
) {
  const post = await getPostById(postId);
  if (!post?.generation && !post?.approvedPost) {
    throw new AppError("編集対象の投稿が見つかりません", 404);
  }

  if (post.approvedPost || ["APPROVED", "POSTED"].includes(post.status)) {
    return updatePostMaterial(postId, {
      title: data.title,
      body: data.body,
      userId: data.userId,
    });
  }

  const generation = await prisma.postGeneration.update({
    where: { postCandidateId: postId },
    data: { title: data.title, body: data.body },
  });

  await prisma.postEditHistory.create({
    data: {
      postCandidateId: postId,
      userId: data.userId,
      title: data.title,
      body: data.body,
      action: data.action || "edit",
    },
  });

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { status: "PENDING_REVIEW" },
  });

  return generation;
}

export async function approvePost(postId: string, userId?: string) {
  const post = await getPostById(postId);
  if (!post?.generation) throw new AppError("承認対象の投稿が見つかりません", 404);
  if (!["AI_GENERATED", "PENDING_REVIEW"].includes(post.status)) {
    throw new AppError("この投稿は承認できません", 409);
  }

  const publicImageUrls = await refreshApprovedPostImages(postId);

  const approved = await prisma.approvedPost.upsert({
    where: { postCandidateId: postId },
    update: {
      title: post.generation.title,
      body: post.generation.body,
      region: post.region,
      serviceType: post.serviceType,
      imageUrls: publicImageUrls,
      status: "READY_TO_POST",
      approvedById: userId,
      approvedAt: new Date(),
    },
    create: {
      postCandidateId: postId,
      title: post.generation.title,
      body: post.generation.body,
      region: post.region,
      serviceType: post.serviceType,
      imageUrls: publicImageUrls,
      status: "READY_TO_POST",
      approvedById: userId,
    },
  });

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { status: "APPROVED" },
  });

  await recordApprovalLog(postId, "approve", userId, {
    approvedPostId: approved.id,
    title: post.generation.title,
  });

  await tryAutoPublishOnApprove(approved.id, userId);

  const result = await prisma.approvedPost.findUnique({
    where: { id: approved.id },
    include: {
      postCandidate: { include: { images: true } },
      approvedBy: { select: { id: true, name: true, email: true } },
    },
  });
  return result ? enrichApprovedPostImages(result) : null;
}

export async function rejectPost(postId: string, userId?: string, reason?: string) {
  const post = await getPostById(postId);
  if (!post) throw new AppError("投稿候補が見つかりません", 404);
  if (!["AI_GENERATED", "PENDING_REVIEW"].includes(post.status)) {
    throw new AppError("この投稿は却下できません", 409);
  }

  if (post.generation) {
    await prisma.postEditHistory.create({
      data: {
        postCandidateId: postId,
        userId,
        title: post.generation.title,
        body: post.generation.body,
        action: `reject: ${reason || "却下"}`,
      },
    });
  }

  const updated = await prisma.postCandidate.update({
    where: { id: postId },
    data: { status: "REJECTED" },
  });
  await recordApprovalLog(postId, "reject", userId, { reason });
  return updated;
}

export async function createManualPost(data: {
  region?: string;
  serviceType?: string;
  workDescription?: string;
  memo?: string;
  imageUrl?: string;
}) {
  const post = await createPostCandidate({
    source: "MANUAL",
    region: data.region,
    serviceType: data.serviceType,
    workDescription: data.workDescription,
    memo: data.memo,
    images: data.imageUrl
      ? [{ url: data.imageUrl, fileName: "manual-upload" }]
      : undefined,
  });

  if (post.images.length > 0 || post.memo || post.region) {
    try {
      await generateForPost(post.id);
    } catch (err) {
      await prisma.postCandidate.update({
        where: { id: post.id },
        data: {
          status: "ERROR",
          errorMessage: err instanceof Error ? err.message : "AI生成に失敗しました",
        },
      });
    }
  }

  return getPostById(post.id);
}

export async function restorePost(postId: string, userId?: string) {
  const post = await getPostById(postId);
  if (!post) throw new AppError("投稿候補が見つかりません", 404);
  if (post.status !== "CANCELLED") {
    throw new AppError("キャンセル済みの投稿のみ復元できます", 409);
  }

  const newStatus: PostStatus = post.generation ? "PENDING_REVIEW" : "NOT_CREATED";

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { status: newStatus, errorMessage: null },
  });

  if (userId && post.generation) {
    await prisma.postEditHistory.create({
      data: {
        postCandidateId: postId,
        userId,
        title: post.generation.title,
        body: post.generation.body,
        action: "restore",
      },
    });
  }

  return getPostById(postId);
}

export async function cancelPost(postId: string, userId?: string) {
  const post = await getPostById(postId);
  if (!post) throw new AppError("投稿候補が見つかりません", 404);
  if (["POSTED", "CANCELLED"].includes(post.status)) {
    throw new AppError("この投稿はキャンセルできません", 409);
  }

  if (post.approvedPost) {
    await prisma.approvedPost.delete({ where: { postCandidateId: postId } });
  }

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { status: "CANCELLED" },
  });

  if (userId && post.generation) {
    await prisma.postEditHistory.create({
      data: {
        postCandidateId: postId,
        userId,
        title: post.generation.title,
        body: post.generation.body,
        action: "cancel",
      },
    });
  }
}

export async function markAsPosted(approvedPostId: string, userId?: string) {
  const approved = await prisma.approvedPost.update({
    where: { id: approvedPostId },
    data: {
      status: "POSTED",
      postedAt: new Date(),
      postedById: userId,
    },
  });

  await prisma.postCandidate.update({
    where: { id: approved.postCandidateId },
    data: { status: "POSTED" },
  });

  await recordPublicationLog({
    postCandidateId: approved.postCandidateId,
    approvedPostId,
    action: "mark_posted",
  });
  await saveArchiveSnapshot(approved.postCandidateId, approvedPostId);

  return approved;
}

export interface ApprovedListFilters {
  status?: PostStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export async function deletePostMaterial(
  postId: string,
  userId?: string,
  options: { removeFromGbp?: boolean } = {}
) {
  const removeFromGbp = options.removeFromGbp !== false;
  const post = await getPostById(postId);
  if (!post) throw new AppError("投稿が見つかりません", 404);

  let gbpWarning: string | undefined;
  if (removeFromGbp && post.approvedPost?.gbpPostId) {
    try {
      await deleteGbpLocalPost(post.approvedPost.gbpPostId);
    } catch (err) {
      gbpWarning =
        err instanceof Error ? err.message : "GBP上の投稿削除に失敗しました";
      console.warn("[Delete Post] GBP removal failed:", gbpWarning);
    }
  }

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { deletedAt: new Date() },
  });

  await recordApprovalLog(postId, "soft_delete", userId, { gbpWarning });

  return { success: true, softDeleted: true, gbpWarning };
}

export async function deleteApprovedPost(
  approvedPostId: string,
  userId?: string,
  options?: { removeFromGbp?: boolean }
) {
  const approved = await prisma.approvedPost.findUnique({
    where: { id: approvedPostId },
    select: { postCandidateId: true },
  });
  if (!approved) throw new AppError("投稿履歴が見つかりません", 404);
  return deletePostMaterial(approved.postCandidateId, userId, options);
}

export async function updateApprovedPost(
  approvedPostId: string,
  data: { title: string; body: string; userId?: string }
) {
  const approved = await prisma.approvedPost.findUnique({
    where: { id: approvedPostId },
    select: { postCandidateId: true },
  });
  if (!approved) throw new AppError("投稿履歴が見つかりません", 404);
  return updatePostMaterial(approved.postCandidateId, data);
}

export async function updatePostMaterial(
  postId: string,
  data: { title: string; body: string; userId?: string; syncGbp?: boolean }
) {
  const post = await getPostById(postId);
  if (!post) throw new AppError("投稿が見つかりません", 404);

  if (post.generation) {
    await prisma.postGeneration.update({
      where: { postCandidateId: postId },
      data: { title: data.title, body: data.body },
    });
  }

  if (post.approvedPost) {
    const summary = [data.title, data.body].filter(Boolean).join("\n\n").slice(0, 1500);
    let gbpSyncWarning: string | undefined;

    if (data.syncGbp !== false && post.approvedPost.gbpPostId) {
      try {
        await updateGbpLocalPostSummary(post.approvedPost.gbpPostId, summary);
      } catch (err) {
        gbpSyncWarning =
          err instanceof Error ? err.message : "GBP上の投稿更新に失敗しました";
        console.warn("[Update Post] GBP sync failed:", gbpSyncWarning);
      }
    }

    await prisma.approvedPost.update({
      where: { id: post.approvedPost.id },
      data: {
        title: data.title,
        body: data.body,
        ...(gbpSyncWarning ? { errorMessage: gbpSyncWarning } : { errorMessage: null }),
      },
    });
  }

  await prisma.postEditHistory.create({
    data: {
      postCandidateId: postId,
      userId: data.userId,
      title: data.title,
      body: data.body,
      action: post.approvedPost ? "edit-published" : "edit",
    },
  });

  if (["APPROVED", "POSTED"].includes(post.status)) {
    await prisma.postCandidate.update({
      where: { id: postId },
      data: { status: post.approvedPost?.status === "POSTED" ? "POSTED" : "APPROVED" },
    });
  } else {
    await prisma.postCandidate.update({
      where: { id: postId },
      data: { status: "PENDING_REVIEW" },
    });
  }

  return getPostById(postId);
}

export async function listApprovedPosts(filters: ApprovedListFilters = {}) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where = {
    postCandidate: { deletedAt: null },
    ...(filters.status && { status: filters.status }),
    ...(filters.search && {
      OR: [
        { title: { contains: filters.search, mode: "insensitive" as const } },
        { body: { contains: filters.search, mode: "insensitive" as const } },
        { region: { contains: filters.search, mode: "insensitive" as const } },
        { serviceType: { contains: filters.search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [rawItems, total] = await Promise.all([
    prisma.approvedPost.findMany({
      where,
      include: {
        postCandidate: { include: { images: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { approvedAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.approvedPost.count({ where }),
  ]);

  const items = await Promise.all(rawItems.map((item) => enrichApprovedPostImages(item)));

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export interface ArchiveListFilters {
  search?: string;
  page?: number;
  limit?: number;
}

export async function listArchivePosts(filters: ArchiveListFilters = {}) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where = {
    OR: [{ deletedAt: { not: null } }, { archivedAt: { not: null } }],
    ...(filters.search && {
      AND: [
        {
          OR: [
            { region: { contains: filters.search, mode: "insensitive" as const } },
            { serviceType: { contains: filters.search, mode: "insensitive" as const } },
            { memo: { contains: filters.search, mode: "insensitive" as const } },
            { generation: { title: { contains: filters.search, mode: "insensitive" as const } } },
            { generation: { body: { contains: filters.search, mode: "insensitive" as const } } },
            { approvedPost: { title: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        },
      ],
    }),
  };

  const [rawItems, total] = await Promise.all([
    prisma.postCandidate.findMany({
      where,
      include: {
        images: { orderBy: { createdAt: "asc" } },
        generation: true,
        approvedPost: {
          include: { approvedBy: { select: { id: true, name: true, email: true } } },
        },
        versions: { orderBy: { versionNo: "desc" }, take: 3 },
      },
      orderBy: [{ deletedAt: "desc" }, { archivedAt: "desc" }, { updatedAt: "desc" }],
      skip,
      take: limit,
    }),
    prisma.postCandidate.count({ where }),
  ]);

  const items = await Promise.all(
    rawItems.map(async (item) => {
      const synced = await syncPostCandidateEntity(item);
      if (synced.approvedPost && !synced.approvedPost.imageUrls?.length) {
        const fromImages = synced.images.map((img) => img.url).filter(Boolean);
        if (fromImages.length > 0) {
          synced.approvedPost.imageUrls = fromImages;
        } else {
          const snapshot = synced.approvedPost.archiveSnapshot as
            | { originalImages?: { url?: string }[] }
            | null
            | undefined;
          const fromSnapshot = (snapshot?.originalImages ?? [])
            .map((img) => img.url)
            .filter((url): url is string => !!url?.trim());
          if (fromSnapshot.length > 0) {
            synced.approvedPost.imageUrls = fromSnapshot;
          }
        }
      }
      return synced;
    })
  );

  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function restoreDeletedPost(postId: string, userId?: string) {
  const post = await prisma.postCandidate.findFirst({
    where: { id: postId, deletedAt: { not: null } },
    include: { generation: true },
  });
  if (!post) throw new AppError("削除済みの投稿が見つかりません", 404);

  await prisma.postCandidate.update({
    where: { id: postId },
    data: { deletedAt: null },
  });

  await recordApprovalLog(postId, "undelete", userId);

  return prisma.postCandidate.findUnique({
    where: { id: postId },
    include: {
      images: { orderBy: { createdAt: "asc" } },
      generation: true,
      approvedPost: true,
    },
  });
}
