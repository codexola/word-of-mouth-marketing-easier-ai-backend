import { Router } from "express";
import { z } from "zod";
import { authenticate, type AuthRequest } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getSettings, updateSettings } from "../services/settings.service.js";
import { omitEmptySecretUpdates, toPublicSettings } from "../services/settings-public.js";

const router = Router();

router.use(authenticate, requireAdmin);

const updateSchema = z.object({
  businessProfileUrl: z.string().optional(),
  reviewRequestUrl: z.string().optional(),
  serviceAreas: z.array(z.string()).optional(),
  services: z.array(z.object({ name: z.string(), keywords: z.array(z.string()).optional() })).optional(),
  keywords: z.array(z.string()).optional(),
  ngWords: z.array(z.string()).optional(),
  toneDescription: z.string().optional(),
  samplePosts: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
  driveFolderId: z.string().optional(),
  drivePollInterval: z.number().min(1).max(60).optional(),
  openaiModel: z.string().optional(),
  lineChannelSecret: z.string().optional(),
  lineChannelAccessToken: z.string().optional(),
  lineEnabled: z.boolean().optional(),
  lineAutoSendEnabled: z.boolean().optional(),
  emailAutoSendEnabled: z.boolean().optional(),
  emailSendMethod: z.enum(["gmail", "smtp"]).optional(),
  smtpHost: z.string().nullable().optional(),
  smtpPort: z.number().min(1).max(65535).optional(),
  smtpUser: z.string().nullable().optional(),
  smtpPass: z.string().nullable().optional(),
  smtpFrom: z.string().nullable().optional(),
  autoRetryEnabled: z.boolean().optional(),
  maxRetryAttempts: z.number().min(1).max(20).optional(),
  retryIntervalMinutes: z.number().min(5).max(1440).optional(),
  gbpAutoPostEnabled: z.boolean().optional(),
  gbpAccountId: z.string().nullable().optional(),
  gbpLocationId: z.string().nullable().optional(),
  gbpLocationName: z.string().nullable().optional(),
});

router.get("/", async (_req, res, next) => {
  try {
    const settings = await getSettings();
    res.json(toPublicSettings(settings));
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req: AuthRequest, res, next) => {
  try {
    const data = updateSchema.parse(req.body);
    const settings = await updateSettings(omitEmptySecretUpdates(data));
    res.json(toPublicSettings(settings));
  } catch (err) {
    next(err);
  }
});

export default router;
