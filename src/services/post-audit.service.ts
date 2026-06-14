import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function recordApprovalLog(
  postCandidateId: string,
  action: string,
  userId?: string,
  metadata?: Prisma.InputJsonValue
) {
  return prisma.approvalLog.create({
    data: { postCandidateId, userId, action, metadata },
  });
}

export async function recordPublicationLog(data: {
  postCandidateId: string;
  approvedPostId?: string;
  action: string;
  gbpPostId?: string;
  errorMessage?: string;
}) {
  return prisma.publicationLog.create({ data });
}

export async function saveArchiveSnapshot(postCandidateId: string, approvedPostId: string) {
  const post = await prisma.postCandidate.findUnique({
    where: { id: postCandidateId },
    include: {
      images: true,
      generation: true,
      approvedPost: { include: { approvedBy: { select: { id: true, name: true, email: true } } } },
      versions: { orderBy: { versionNo: "desc" }, take: 5 },
      approvalLogs: { orderBy: { createdAt: "desc" }, take: 10 },
      publicationLogs: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!post?.approvedPost) return null;

  const snapshot = {
    originalImages: post.images.map((img) => ({
      url: img.url,
      fileName: img.fileName,
      sourceFileId: img.sourceFileId,
      analysisJson: img.analysisJson,
    })),
    staffMemo: post.memo,
    workDescription: post.workDescription,
    region: post.region,
    serviceType: post.serviceType,
    aiGeneration: post.generation,
    versions: post.versions,
    approvalLogs: post.approvalLogs,
    publicationLogs: post.publicationLogs,
    approver: post.approvedPost.approvedBy,
    approvedAt: post.approvedPost.approvedAt,
    gbpPostId: post.approvedPost.gbpPostId,
    gbpPublishedAt: post.approvedPost.gbpPublishedAt,
    postedAt: post.approvedPost.postedAt,
    archivedAt: new Date().toISOString(),
  };

  const now = new Date();
  await prisma.approvedPost.update({
    where: { id: approvedPostId },
    data: { archivedAt: now, archiveSnapshot: snapshot as Prisma.InputJsonValue },
  });
  await prisma.postCandidate.update({
    where: { id: postCandidateId },
    data: { archivedAt: now },
  });

  return snapshot;
}
