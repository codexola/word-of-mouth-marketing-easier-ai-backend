/**
 * Re-download missing upload files from Google Drive (sourceFileId) and restore PostImage rows.
 * Run from repo root: node backend/scripts/repair-missing-images.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const prisma = new PrismaClient();
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

function uploadsFileExists(url) {
  if (!url?.includes("/uploads/")) return false;
  const filename = url.split("/uploads/")[1]?.split("?")[0];
  if (!filename) return false;
  return fs.existsSync(path.join(UPLOADS_DIR, filename));
}

async function loadServices() {
  const drive = await import("../dist/services/drive.service.js");
  const media = await import("../dist/services/media.service.js");
  return {
    downloadAndStoreDriveFile: drive.downloadAndStoreDriveFile,
    syncPostCandidateEntity: media.syncPostCandidateEntity,
  };
}

async function main() {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  const { downloadAndStoreDriveFile, syncPostCandidateEntity } = await loadServices();
  let restored = 0;
  let skipped = 0;
  let failed = 0;

  const posts = await prisma.postCandidate.findMany({
    include: { images: true, approvedPost: true },
    orderBy: { updatedAt: "desc" },
  });

  for (const post of posts) {
    const snapshot = post.approvedPost?.archiveSnapshot;
    const snapshotImages = Array.isArray(snapshot?.originalImages) ? snapshot.originalImages : [];
    const candidates = [];

    for (const img of post.images) {
      candidates.push({
        sourceFileId: img.sourceFileId,
        fileName: img.fileName,
        mimeType: img.mimeType,
        existingId: img.id,
        url: img.url,
        storagePath: img.storagePath,
      });
    }

    for (const simg of snapshotImages) {
      if (!simg?.sourceFileId) continue;
      if (candidates.some((c) => c.sourceFileId === simg.sourceFileId)) continue;
      candidates.push({
        sourceFileId: simg.sourceFileId,
        fileName: simg.fileName || "photo.jpg",
        mimeType: null,
        existingId: null,
        url: simg.url,
        storagePath: null,
      });
    }

    let postChanged = false;

    for (const cand of candidates) {
      if (!cand.sourceFileId) {
        skipped++;
        continue;
      }

      const onDisk =
        (cand.storagePath && fs.existsSync(cand.storagePath)) || uploadsFileExists(cand.url);

      if (onDisk) {
        skipped++;
        continue;
      }

      try {
        const stored = await downloadAndStoreDriveFile(
          cand.sourceFileId,
          cand.fileName || "photo.jpg",
          cand.mimeType || undefined
        );
        if (!stored) {
          failed++;
          console.warn(`[SKIP] Drive download failed: post=${post.id} file=${cand.sourceFileId}`);
          continue;
        }

        if (cand.existingId) {
          await prisma.postImage.update({
            where: { id: cand.existingId },
            data: {
              url: stored.publicUrl,
              storagePath: stored.storagePath,
              mimeType: stored.mimeType,
            },
          });
        } else {
          await prisma.postImage.create({
            data: {
              postCandidateId: post.id,
              url: stored.publicUrl,
              storagePath: stored.storagePath,
              fileName: cand.fileName,
              mimeType: stored.mimeType,
              sourceFileId: cand.sourceFileId,
            },
          });
        }

        restored++;
        postChanged = true;
        console.log(`[OK] Restored post=${post.id} file=${cand.sourceFileId}`);
      } catch (err) {
        failed++;
        console.warn(`[FAIL] post=${post.id}`, err instanceof Error ? err.message : err);
      }
    }

    if (postChanged) {
      const fresh = await prisma.postCandidate.findUnique({
        where: { id: post.id },
        include: { images: true, approvedPost: true },
      });
      if (fresh) await syncPostCandidateEntity(fresh);
    }
  }

  console.log(JSON.stringify({ restored, skipped, failed, totalPosts: posts.length }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
