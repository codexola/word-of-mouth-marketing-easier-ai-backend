import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "認証が必要です" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as {
      userId: string;
      email: string;
      name: string;
      role: string;
    };
    req.user = {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: "トークンが無効です" });
  }
}

export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as {
        userId: string;
        email: string;
        name: string;
        role: string;
      };
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (user) {
        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      }
    } catch {
      // ignore invalid token
    }
  }
  next();
}
