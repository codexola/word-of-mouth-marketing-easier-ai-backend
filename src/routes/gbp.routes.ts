import { Router } from "express";
import { z } from "zod";
import { resolveFrontendOrigin } from "../lib/frontend-origin.js";
import { authenticate } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  disconnectGbp,
  getGbpAuthUrl,
  getGbpStatus,
  handleGbpOAuthCallback,
  listGbpLocations,
  selectGbpLocation,
} from "../services/gbp.service.js";

const router = Router();

router.get("/status", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    res.json(await getGbpStatus());
  } catch (err) {
    next(err);
  }
});

router.get("/auth-url", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const returnUrl = req.query.returnUrl as string | undefined;
    res.json({ url: getGbpAuthUrl(returnUrl) });
  } catch (err) {
    next(err);
  }
});

router.get("/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;
  const state = req.query.state as string | undefined;
  const redirect = `${resolveFrontendOrigin(state)}/settings`;

  if (error || !code) {
    return res.redirect(`${redirect}?gbp=error`);
  }

  try {
    await handleGbpOAuthCallback(code);
    res.redirect(`${redirect}?gbp=connected`);
  } catch {
    res.redirect(`${redirect}?gbp=error`);
  }
});

router.get("/locations", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const items = await listGbpLocations();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const selectSchema = z.object({
  accountId: z.string().min(1),
  locationId: z.string().min(1),
  locationTitle: z.string().optional(),
});

router.post("/select-location", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const data = selectSchema.parse(req.body);
    const status = await selectGbpLocation(data.accountId, data.locationId, data.locationTitle);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.post("/disconnect", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    await disconnectGbp();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
