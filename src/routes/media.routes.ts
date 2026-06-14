import { Router } from "express";
import { SourceType } from "@prisma/client";
import { authenticate } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { deleteMediaPhoto, listMediaPhotos } from "../services/media.service.js";

const router = Router();

router.use(authenticate, requireAdmin);

router.get("/", async (req, res, next) => {
  try {
    const source = req.query.source as SourceType | undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 48;
    const result = await listMediaPhotos({
      source: source && ["GOOGLE_DRIVE", "LINE", "MANUAL"].includes(source) ? source : undefined,
      page,
      limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await deleteMediaPhoto(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
