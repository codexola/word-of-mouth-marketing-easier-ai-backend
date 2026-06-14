import { Router, type Request } from "express";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authenticate, type AuthRequest } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireDeveloper } from "../middleware/requireDeveloper.js";
import { prisma } from "../lib/prisma.js";
import { generateLoginCode } from "../lib/login-code.js";
import { captureSignupGeoIfNeeded } from "../lib/signup-geo.js";
import { getClientIp } from "../lib/client-ip.js";
import { resolveGeoFromIp } from "../lib/geoip.js";

const router = Router();

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.enum(["ADMIN", "USER"]),
});

router.use(authenticate);

router.get("/subscriber-locations", requireAdmin, async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { signupLat: { not: null }, signupLng: { not: null } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        signupLat: true,
        signupLng: true,
        signupCity: true,
        signupRegion: true,
        signupCountry: true,
        signupLocationLabel: true,
        createdAt: true,
      },
    });
    res.json({
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        lat: u.signupLat!,
        lng: u.signupLng!,
        city: u.signupCity,
        region: u.signupRegion,
        country: u.signupCountry,
        label: u.signupLocationLabel,
        subscribedAt: u.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.use(requireDeveloper);

router.get("/", async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        loginCode: true,
        createdAt: true,
      },
    });
    res.json({ items: users });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req: AuthRequest, res, next) => {
  try {
    const data = createUserSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      return res.status(409).json({ error: "このメールアドレスは既に使用されています" });
    }

    const loginCode = data.role === "USER" ? generateLoginCode() : null;
    const ip = getClientIp(req);
    const geo = await resolveGeoFromIp(ip);
    const label = [geo.city, geo.region, geo.country].filter(Boolean).join(", ");

    const user = await prisma.user.create({
      data: {
        email: data.email,
        passwordHash: await bcrypt.hash(data.password, 10),
        name: data.name,
        role: data.role,
        loginCode,
        signupIp: ip,
        signupLat: geo.lat,
        signupLng: geo.lng,
        signupCity: geo.city,
        signupCountry: geo.country,
        signupRegion: geo.region,
        signupLocationLabel: label || null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        loginCode: true,
        createdAt: true,
      },
    });

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: AuthRequest, res, next) => {
  try {
    const id = paramId(req);
    if (req.user?.id === id) {
      return res.status(400).json({ error: "自分自身のアカウントは削除できません" });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return res.status(404).json({ error: "ユーザーが見つかりません" });
    }

    await prisma.$transaction([
      prisma.approvedPost.updateMany({
        where: { approvedById: id },
        data: { approvedById: null },
      }),
      prisma.postEditHistory.updateMany({
        where: { userId: id },
        data: { userId: null },
      }),
      prisma.reviewRequest.updateMany({
        where: { createdById: id },
        data: { createdById: null },
      }),
      prisma.user.delete({ where: { id } }),
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
