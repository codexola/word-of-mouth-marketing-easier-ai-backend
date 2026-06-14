import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export async function getSettings() {
  let settings = await prisma.appSettings.findUnique({ where: { id: "default" } });
  if (!settings) {
    settings = await prisma.appSettings.create({ data: { id: "default" } });
  }
  return settings;
}

export async function updateSettings(data: {
  businessProfileUrl?: string;
  reviewRequestUrl?: string;
  serviceAreas?: string[];
  services?: Prisma.InputJsonValue;
  keywords?: string[];
  ngWords?: string[];
  toneDescription?: string;
  samplePosts?: Prisma.InputJsonValue;
  driveFolderId?: string;
  drivePollInterval?: number;
  openaiModel?: string;
  lineChannelSecret?: string;
  lineChannelAccessToken?: string;
  lineEnabled?: boolean;
  lineAutoSendEnabled?: boolean;
  emailAutoSendEnabled?: boolean;
  emailSendMethod?: string;
  gmailFromEmail?: string | null;
  gmailRefreshToken?: string | null;
  gmailAccessToken?: string | null;
  gmailTokenExpiresAt?: Date | null;
  smtpHost?: string | null;
  smtpPort?: number;
  smtpUser?: string | null;
  smtpPass?: string | null;
  smtpFrom?: string | null;
  autoRetryEnabled?: boolean;
  maxRetryAttempts?: number;
  retryIntervalMinutes?: number;
  gbpAutoPostEnabled?: boolean;
  gbpAccountId?: string | null;
  gbpLocationId?: string | null;
  gbpLocationName?: string | null;
  gbpRefreshToken?: string | null;
  gbpAccessToken?: string | null;
  gbpTokenExpiresAt?: Date | null;
}) {
  return prisma.appSettings.upsert({
    where: { id: "default" },
    update: data,
    create: { id: "default", ...data },
  });
}
