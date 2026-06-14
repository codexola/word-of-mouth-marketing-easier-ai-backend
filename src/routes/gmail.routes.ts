import { Router } from "express";
import { resolveFrontendOrigin } from "../lib/frontend-origin.js";
import { authenticate } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  disconnectGmail,
  getGmailAuthUrl,
  getGmailStatus,
  handleGmailOAuthCallback,
} from "../services/gmail.service.js";

const router = Router();

router.get("/status", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    res.json(await getGmailStatus());
  } catch (err) {
    next(err);
  }
});

router.get("/auth-url", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const returnUrl = req.query.returnUrl as string | undefined;
    res.json({ url: getGmailAuthUrl(returnUrl) });
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
    return res.redirect(`${redirect}?gmail=error`);
  }

  try {
    await handleGmailOAuthCallback(code);
    res.redirect(`${redirect}?gmail=connected`);
  } catch {
    res.redirect(`${redirect}?gmail=error`);
  }
});

router.post("/disconnect", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    await disconnectGmail();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
