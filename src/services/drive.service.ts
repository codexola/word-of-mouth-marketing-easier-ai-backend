import { Prisma } from "@prisma/client";
import { google } from "googleapis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSettings } from "./settings.service.js";
import { createPostCandidate, generateForPost } from "./post.service.js";
import { saveImageBuffer, type SavedImage } from "./image-storage.service.js";

let driveSyncInProgress = false;

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  );
}

function getDriveAuth(scopes: string[]) {
  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    return null;
  }
  return new google.auth.JWT({
    email: env.GOOGLE_CLIENT_EMAIL,
    key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes,
  });
}

export function getDriveClient() {
  const auth = getDriveAuth(["https://www.googleapis.com/auth/drive"]);
  return auth ? google.drive({ version: "v3", auth }) : null;
}

export async function downloadAndStoreDriveFile(
  fileId: string,
  fileName: string,
  mimeType?: string
): Promise<SavedImage | null> {
  const drive = getDriveClient();
  if (!drive) return null;

  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buffer = Buffer.from(res.data as ArrayBuffer);
    const type = mimeType || "image/jpeg";
    const prefix = `drive-${fileId.slice(0, 12)}`;
    return saveImageBuffer(buffer, type, prefix);
  } catch (err) {
    console.error(`[Drive] Failed to download ${fileId}:`, err);
    return null;
  }
}

function parseFileName(fileName: string): { region?: string; serviceType?: string; workDescription?: string } {
  const parts = fileName.replace(/\.[^.]+$/, "").split(/[_\-、,]/);
  return {
    region: parts[0]?.trim(),
    serviceType: parts[1]?.trim(),
    workDescription: parts.slice(2).join(" ").trim() || undefined,
  };
}

/** Remove duplicate post candidates that share the same Drive file id. */
export async function deduplicateDrivePostCandidates(): Promise<number> {
  const images = await prisma.postImage.findMany({
    where: {
      sourceFileId: { not: null },
      postCandidate: { source: "GOOGLE_DRIVE" },
    },
    include: {
      postCandidate: {
        include: { approvedPost: true, generation: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const byDriveFileId = new Map<string, typeof images>();
  for (const image of images) {
    if (!image.sourceFileId) continue;
    const group = byDriveFileId.get(image.sourceFileId) ?? [];
    group.push(image);
    byDriveFileId.set(image.sourceFileId, group);
  }

  let removed = 0;

  for (const [driveFileId, group] of byDriveFileId) {
    if (group.length <= 1) continue;

    const synced = await prisma.syncedDriveFile.findUnique({
      where: { driveFileId },
    });

    const keeper =
      group.find((img) => img.postCandidateId === synced?.postCandidateId) ??
      group.find((img) => img.postCandidate.approvedPost) ??
      group.find((img) => img.postCandidate.generation) ??
      group[0];

    for (const image of group) {
      if (image.postCandidateId === keeper.postCandidateId) continue;

      const post = image.postCandidate;
      const safeToDelete =
        !post.approvedPost &&
        ["NOT_CREATED", "PENDING_REVIEW", "AI_GENERATED", "ERROR", "REJECTED", "CANCELLED"].includes(
          post.status
        );

      if (!safeToDelete) continue;

      await prisma.postCandidate.delete({ where: { id: post.id } });
      removed++;
    }

    await prisma.syncedDriveFile.upsert({
      where: { driveFileId },
      create: {
        driveFileId,
        fileName: keeper.fileName || driveFileId,
        postCandidateId: keeper.postCandidateId,
      },
      update: { postCandidateId: keeper.postCandidateId },
    });
  }

  if (removed > 0) {
    console.log(`[Drive] Removed ${removed} duplicate post candidate(s)`);
  }

  return removed;
}

async function linkSyncedDriveFile(
  driveFileId: string,
  fileName: string,
  mimeType: string | null | undefined,
  postCandidateId: string
) {
  await prisma.syncedDriveFile.upsert({
    where: { driveFileId },
    create: {
      driveFileId,
      fileName,
      mimeType: mimeType || undefined,
      postCandidateId,
    },
    update: {
      fileName,
      mimeType: mimeType || undefined,
      postCandidateId,
    },
  });
}

async function claimDriveFile(
  driveFileId: string,
  fileName: string,
  mimeType: string | null | undefined
): Promise<"claimed" | "already_synced" | "contended"> {
  const existing = await prisma.syncedDriveFile.findUnique({
    where: { driveFileId },
  });

  if (existing?.postCandidateId) {
    const post = await prisma.postCandidate.findUnique({
      where: { id: existing.postCandidateId },
    });
    if (post) return "already_synced";
    await prisma.syncedDriveFile.update({
      where: { driveFileId },
      data: { postCandidateId: null },
    });
  }

  if (existing) return "claimed";

  try {
    await prisma.syncedDriveFile.create({
      data: {
        driveFileId,
        fileName,
        mimeType: mimeType || undefined,
      },
    });
    return "claimed";
  } catch (err) {
    if (isPrismaUniqueViolation(err)) return "contended";
    throw err;
  }
}

export async function syncDriveFolder() {
  if (driveSyncInProgress) {
    return { synced: 0, skipped: 0, message: "同期処理中です" };
  }

  driveSyncInProgress = true;

  try {
    const drive = getDriveClient();
    const settings = await getSettings();
    const folderId = settings.driveFolderId || env.GOOGLE_DRIVE_FOLDER_ID;

    if (!drive || !folderId) {
      return { synced: 0, skipped: 0, message: "Google Drive未設定" };
    }

    const deduped = await deduplicateDrivePostCandidates();

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (mimeType contains 'image/')`,
      fields: "files(id, name, mimeType, createdTime, webContentLink, thumbnailLink)",
      orderBy: "createdTime desc",
      pageSize: 50,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = response.data.files || [];
    let synced = 0;
    let skipped = 0;

    for (const file of files) {
      if (!file.id || !file.name) continue;

      const existingImage = await prisma.postImage.findFirst({
        where: { sourceFileId: file.id },
        orderBy: { createdAt: "asc" },
      });

      if (existingImage) {
        await linkSyncedDriveFile(
          file.id,
          file.name,
          file.mimeType,
          existingImage.postCandidateId
        );
        skipped++;
        continue;
      }

      const claim = await claimDriveFile(file.id, file.name, file.mimeType);
      if (claim === "already_synced" || claim === "contended") {
        skipped++;
        continue;
      }

      const parsed = parseFileName(file.name);
      const stored = await downloadAndStoreDriveFile(
        file.id,
        file.name,
        file.mimeType || undefined
      );

      const imageEntry = stored
        ? {
            url: stored.publicUrl,
            fileName: file.name,
            mimeType: stored.mimeType,
            sourceFileId: file.id,
            storagePath: stored.storagePath,
          }
        : {
            url:
              file.webContentLink ||
              file.thumbnailLink ||
              `https://drive.google.com/uc?id=${file.id}`,
            fileName: file.name,
            mimeType: file.mimeType || undefined,
            sourceFileId: file.id,
          };

      let postId: string | null = null;

      try {
        const post = await createPostCandidate({
          source: "GOOGLE_DRIVE",
          region: parsed.region,
          serviceType: parsed.serviceType,
          workDescription: parsed.workDescription,
          images: [imageEntry],
        });
        postId = post.id;

        await linkSyncedDriveFile(file.id, file.name, file.mimeType, post.id);

        try {
          await generateForPost(post.id);
        } catch (err) {
          await prisma.postCandidate.update({
            where: { id: post.id },
            data: {
              status: "ERROR",
              errorMessage: err instanceof Error ? err.message : "AI生成エラー",
            },
          });
        }

        synced++;
      } catch (err) {
        if (postId) {
          await prisma.postCandidate.delete({ where: { id: postId } }).catch(() => {});
        }
        await prisma.syncedDriveFile
          .deleteMany({ where: { driveFileId: file.id, postCandidateId: null } })
          .catch(() => {});
        if (!isPrismaUniqueViolation(err)) throw err;
        skipped++;
      }
    }

    return { synced, skipped, deduped, total: files.length };
  } finally {
    driveSyncInProgress = false;
  }
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  if (!drive) {
    throw new Error("Google Drive が未設定です");
  }
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (err: unknown) {
    const status = (err as { code?: number })?.code;
    if (status === 404) return;
    throw err;
  }
}
