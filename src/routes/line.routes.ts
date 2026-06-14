import { Router } from "express";
import express from "express";
import { authenticate } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { handleLineWebhook, getLineStatus, verifyLineWebhook } from "../services/line.service.js";

const router = Router();

router.get("/status", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const status = await getLineStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const body = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-line-signature"] as string | undefined;

    const valid = await verifyLineWebhook(body, signature);
    if (!valid) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    try {
      const payload = JSON.parse(body) as { events?: Parameters<typeof handleLineWebhook>[0] };
      const results = await handleLineWebhook(payload.events || []);
      res.status(200).json({ success: true, results });
    } catch (err) {
      console.error("LINE webhook error:", err);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

export default router;
