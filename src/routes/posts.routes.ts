import { Router, type Request } from "express";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}
import { z } from "zod";
import { PostStatus, SourceType } from "@prisma/client";
import { resolveActorUserId } from "../lib/actor.js";
import { authenticate, type AuthRequest } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { publishApprovedPostToGbp } from "../services/gbp.service.js";
import {
  approvePost,
  cancelPost,
  createManualPost,
  deleteApprovedPost,
  deletePostMaterial,
  generateForPost,
  getDashboardStats,
  getPostById,
  listApprovedPosts,
  listArchivePosts,
  listPosts,
  markAsPosted,
  rejectPost,
  repairErrorPosts,
  restorePost,
  restoreDeletedPost,
  updateApprovedPost,
  updatePostContent,
} from "../services/post.service.js";

const router = Router();

router.use(authenticate, requireAdmin);

router.get("/stats", async (_req, res, next) => {
  try {
    const stats = await getDashboardStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

router.post("/repair-errors", async (_req, res, next) => {
  try {
    const result = await repairErrorPosts();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const manualPostSchema = z.object({
  region: z.string().optional(),
  serviceType: z.string().optional(),
  workDescription: z.string().optional(),
  memo: z.string().optional(),
  imageUrl: z.string().url().optional(),
});

router.post("/manual", async (req, res, next) => {
  try {
    const data = manualPostSchema.parse(req.body);
    const post = await createManualPost(data);
    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const result = await listPosts({
      status: req.query.status as PostStatus | undefined,
      source: req.query.source as SourceType | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/approved", async (req, res, next) => {
  try {
    const result = await listApprovedPosts({
      status: req.query.status as PostStatus | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/archive", async (req, res, next) => {
  try {
    const result = await listArchivePosts({
      search: req.query.search as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const post = await getPostById(paramId(req));
    if (!post) return res.status(404).json({ error: "投稿候補が見つかりません" });
    res.json(post);
  } catch (err) {
    next(err);
  }
});

const generateSchema = z.object({
  tone: z
    .enum(["default", "short", "long", "sales", "professional", "review", "seo"])
    .optional(),
  instruction: z.string().max(500).optional(),
});

router.post("/:id/generate", async (req, res, next) => {
  try {
    const body = generateSchema.parse(req.body ?? {});
    const generation = await generateForPost(paramId(req), body);
    res.json(generation);
  } catch (err) {
    next(err);
  }
});

const updateSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

router.put("/:id/content", async (req: AuthRequest, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const generation = await updatePostContent(paramId(req), {
      ...data,
      userId: resolveActorUserId(req.user?.id),
      action: "edit",
    });
    res.json(generation);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", async (req: AuthRequest, res, next) => {
  try {
    const approved = await approvePost(paramId(req), resolveActorUserId(req.user?.id));
    res.json(approved);
  } catch (err) {
    next(err);
  }
});

const rejectSchema = z.object({ reason: z.string().optional() });

router.post("/:id/reject", async (req: AuthRequest, res, next) => {
  try {
    const { reason } = rejectSchema.parse(req.body);
    const post = await rejectPost(paramId(req), resolveActorUserId(req.user?.id), reason);
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/cancel", async (req: AuthRequest, res, next) => {
  try {
    await cancelPost(paramId(req), resolveActorUserId(req.user?.id));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/restore", async (req: AuthRequest, res, next) => {
  try {
    const post = await restorePost(paramId(req), resolveActorUserId(req.user?.id));
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/undelete", async (req: AuthRequest, res, next) => {
  try {
    const post = await restoreDeletedPost(paramId(req), resolveActorUserId(req.user?.id));
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.post("/approved/:id/mark-posted", async (req: AuthRequest, res, next) => {
  try {
    const approved = await markAsPosted(paramId(req), resolveActorUserId(req.user?.id));
    res.json(approved);
  } catch (err) {
    next(err);
  }
});

router.post("/approved/:id/publish-gbp", async (req: AuthRequest, res, next) => {
  try {
    const approved = await publishApprovedPostToGbp(
      paramId(req),
      resolveActorUserId(req.user?.id),
      { requireAutoPostEnabled: false }
    );
    res.json(approved);
  } catch (err) {
    next(err);
  }
});

router.put("/approved/:id", async (req: AuthRequest, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const post = await updateApprovedPost(paramId(req), {
      ...data,
      userId: resolveActorUserId(req.user?.id),
    });
    res.json(post);
  } catch (err) {
    next(err);
  }
});

router.delete("/approved/:id", async (req: AuthRequest, res, next) => {
  try {
    const result = await deleteApprovedPost(
      paramId(req),
      resolveActorUserId(req.user?.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: AuthRequest, res, next) => {
  try {
    const result = await deletePostMaterial(
      paramId(req),
      resolveActorUserId(req.user?.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
