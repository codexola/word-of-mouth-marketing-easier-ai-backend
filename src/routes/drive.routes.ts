import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { syncDriveFolder } from "../services/drive.service.js";

const router = Router();

router.post("/sync", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const result = await syncDriveFolder();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
