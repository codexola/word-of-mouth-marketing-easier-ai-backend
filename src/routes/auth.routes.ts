import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { DEVELOPER_USER_ID, isDeveloperCredential } from "../config/developer.js";
import { authenticate, type AuthRequest } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { generateLoginCode } from "../lib/login-code.js";
import { captureSignupGeoIfNeeded } from "../lib/signup-geo.js";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  code: z.string().length(6).optional(),
});

const accountUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).optional(),
  preferredLocale: z.enum(["ja", "en"]).optional(),
  preferredTheme: z.enum(["light", "dark"]).optional(),
});

function signToken(user: { id: string; email: string; name: string; role: string }) {
  return jwt.sign(
    { userId: user.id, email: user.email, name: user.name, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );
}

function userResponse(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  preferredLocale?: string;
  preferredTheme?: string;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    preferredLocale: user.preferredLocale ?? "ja",
    preferredTheme: user.preferredTheme ?? "light",
    isDeveloperSession: user.id === DEVELOPER_USER_ID,
  };
}

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    if (isDeveloperCredential(email, password)) {
      const token = signToken({
        id: DEVELOPER_USER_ID,
        email: env.DEVELOPER_EMAIL!,
        name: "Developer",
        role: "ADMIN",
      });
      return res.json({
        token,
        user: userResponse({
          id: DEVELOPER_USER_ID,
          email: env.DEVELOPER_EMAIL!,
          name: "Developer",
          role: "ADMIN",
        }),
      });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "メールアドレスまたはパスワードが正しくありません" });
    }

    if (user.role === "ADMIN") {
      await captureSignupGeoIfNeeded(user.id, req);
      const token = signToken(user);
      return res.json({ token, user: userResponse(user) });
    }

    // General users require a 6-digit passcode from the developer account
    if (!user.loginCode) {
      return res.status(403).json({
        error: "ログインコードが未設定です。開発者アカウントにお問い合わせください",
      });
    }

    if (!req.body.code) {
      return res.json({ requiresCode: true, message: "6桁のログインコードを入力してください" });
    }

    const { code } = loginSchema.parse(req.body);
    if (code !== user.loginCode) {
      return res.status(401).json({ error: "ログインコードが正しくありません" });
    }

    const newCode = generateLoginCode();
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { loginCode: newCode },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        preferredLocale: true,
        preferredTheme: true,
      },
    });

    await captureSignupGeoIfNeeded(updated.id, req);
    const token = signToken(updated);
    res.json({ token, user: userResponse(updated) });
  } catch (err) {
    next(err);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "認証が必要です" });
    }

    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as { userId: string };

    if (payload.userId === DEVELOPER_USER_ID) {
      return res.json({
        user: userResponse({
          id: DEVELOPER_USER_ID,
          email: env.DEVELOPER_EMAIL || "developer@local",
          name: "Developer",
          role: "ADMIN",
        }),
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        preferredLocale: true,
        preferredTheme: true,
      },
    });

    if (!user) return res.status(401).json({ error: "ユーザーが見つかりません" });
    res.json({ user: userResponse(user) });
  } catch (err) {
    next(err);
  }
});

router.put("/account", authenticate, async (req: AuthRequest, res, next) => {
  try {
    if (req.user?.id === DEVELOPER_USER_ID) {
      return res.status(400).json({
        error: "開発者アカウントの設定はバックエンドの環境変数で管理されます",
      });
    }

    const data = accountUpdateSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: "ユーザーが見つかりません" });

    const valid = await bcrypt.compare(data.currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "現在のパスワードが正しくありません" });
    }

    if (data.email && data.email !== user.email) {
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) {
        return res.status(409).json({ error: "このメールアドレスは既に使用されています" });
      }
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(data.name && { name: data.name }),
        ...(data.email && { email: data.email }),
        ...(data.newPassword && { passwordHash: await bcrypt.hash(data.newPassword, 10) }),
        ...(data.preferredLocale && { preferredLocale: data.preferredLocale }),
        ...(data.preferredTheme && { preferredTheme: data.preferredTheme }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        preferredLocale: true,
        preferredTheme: true,
      },
    });

    const token = signToken(updated);
    res.json({ token, user: userResponse(updated) });
  } catch (err) {
    next(err);
  }
});

export default router;
