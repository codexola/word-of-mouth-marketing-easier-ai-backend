import { Router, type Request } from "express";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}
import { z } from "zod";
import { resolveActorUserId } from "../lib/actor.js";
import { authenticate, type AuthRequest } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  createReviewRequest,
  deleteReviewRequest,
  listReviewRequests,
  regenerateReviewMessages,
  sendReviewNow,
  updateReviewRequest,
} from "../services/review.service.js";
import { processScheduledReviewSends } from "../jobs/reviewSender.js";

const router = Router();

router.use(authenticate, requireAdmin);

router.get("/", async (req, res, next) => {
  try {
    const result = await listReviewRequests({
      status: req.query.status as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  customerName: z.string().min(1),
  completionDate: z.string(),
  reviewUrl: z.string().optional(),
  scheduledSendDate: z.string().optional(),
  lineUserId: z.string().optional(),
  customerEmail: z.string().email().optional().or(z.literal("")),
});

const updateSchema = z.object({
  customerName: z.string().min(1).optional(),
  completionDate: z.string().optional(),
  reviewUrl: z.string().optional(),
  lineUserId: z.string().optional(),
  customerEmail: z.string().optional(),
  thankMessage: z.string().optional(),
  reviewMessage: z.string().optional(),
  followUpMessage: z.string().optional(),
  scheduledSendDate: z.string().optional(),
  thankScheduledDate: z.string().optional(),
  reviewScheduledDate: z.string().optional(),
  followUpScheduledDate: z.string().optional(),
  sendStatus: z.enum(["DRAFT", "SCHEDULED", "SENT", "CANCELLED"]).optional(),
});

router.post("/", async (req: AuthRequest, res, next) => {
  try {
    const data = createSchema.parse(req.body);
    const request = await createReviewRequest({
      ...data,
      createdById: resolveActorUserId(req.user?.id),
    });
    res.status(201).json(request);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const request = await updateReviewRequest(paramId(req), data);
    res.json(request);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const result = await deleteReviewRequest(paramId(req));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/regenerate", async (req, res, next) => {
  try {
    const request = await regenerateReviewMessages(paramId(req));
    res.json(request);
  } catch (err) {
    next(err);
  }
});

const sendSchema = z.object({
  type: z.enum(["thank", "review", "followUp"]),
  channel: z.enum(["line", "email"]).optional(),
});

router.post("/:id/send-line", async (req, res, next) => {
  try {
    const { type } = sendSchema.parse(req.body);
    const request = await sendReviewNow(paramId(req), type, "line");
    res.json(request);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/send-email", async (req, res, next) => {
  try {
    const { type } = sendSchema.parse(req.body);
    const request = await sendReviewNow(paramId(req), type, "email");
    res.json(request);
  } catch (err) {
    next(err);
  }
});

router.post("/process-scheduled", async (_req, res, next) => {
  try {
    await processScheduledReviewSends();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
