import { google } from "googleapis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { isAllowedFrontendOrigin } from "../lib/frontend-origin.js";
import { getSettings, updateSettings } from "./settings.service.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function getGmailOAuthConfig() {
  const clientId =
    process.env.GMAIL_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret =
    process.env.GMAIL_OAUTH_CLIENT_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri =
    process.env.GMAIL_OAUTH_REDIRECT_URI ||
    `${process.env.PUBLIC_API_URL || `http://localhost:${env.PORT}`}/api/gmail/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function isGmailOAuthConfigured() {
  const { clientId, clientSecret, redirectUri } = getGmailOAuthConfig();
  return !!(clientId && clientSecret && redirectUri);
}

export async function getGmailStatus() {
  const settings = await getSettings();
  const oauthConfigured = isGmailOAuthConfigured();
  return {
    oauthConfigured,
    connected: !!(settings.gmailRefreshToken && settings.gmailAccessToken),
    fromEmail: settings.gmailFromEmail,
    sendMethod: settings.emailSendMethod || "gmail",
    autoSendEnabled: settings.emailAutoSendEnabled,
    tokenExpiresAt: settings.gmailTokenExpiresAt,
  };
}

export function getGmailAuthUrl(returnOrigin?: string) {
  const { clientId, clientSecret, redirectUri } = getGmailOAuthConfig();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Gmail OAuth が未設定です（.env の GMAIL_OAUTH_* または GOOGLE_OAUTH_* を確認してください）"
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
    ...(returnOrigin && isAllowedFrontendOrigin(returnOrigin)
      ? { state: returnOrigin }
      : {}),
  });
}

async function exchangeCodeForTokens(code: string) {
  const { clientId, clientSecret, redirectUri } = getGmailOAuthConfig();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.access_token) {
    throw new Error("Gmail OAuth トークン取得に失敗しました");
  }
  return tokens;
}

async function fetchGoogleEmail(accessToken: string): Promise<string | undefined> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { email?: string };
  return data.email;
}

export async function handleGmailOAuthCallback(code: string) {
  const tokens = await exchangeCodeForTokens(code);
  const expiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : new Date(Date.now() + 3600 * 1000);
  const fromEmail = tokens.access_token
    ? await fetchGoogleEmail(tokens.access_token)
    : undefined;

  await updateSettings({
    gmailAccessToken: tokens.access_token,
    gmailRefreshToken: tokens.refresh_token || undefined,
    gmailTokenExpiresAt: expiresAt,
    gmailFromEmail: fromEmail,
    emailSendMethod: "gmail",
  } as Parameters<typeof updateSettings>[0]);

  return getGmailStatus();
}

export async function disconnectGmail() {
  await updateSettings({
    gmailRefreshToken: null,
    gmailAccessToken: null,
    gmailTokenExpiresAt: null,
    gmailFromEmail: null,
  } as Parameters<typeof updateSettings>[0]);
}

async function getOAuth2Client() {
  const settings = await getSettings();
  if (!settings.gmailRefreshToken && !settings.gmailAccessToken) {
    throw new Error("Gmail が未連携です。設定画面から Gmail アカウントを連携してください");
  }

  const { clientId, clientSecret, redirectUri } = getGmailOAuthConfig();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  oauth2.setCredentials({
    access_token: settings.gmailAccessToken || undefined,
    refresh_token: settings.gmailRefreshToken || undefined,
    expiry_date: settings.gmailTokenExpiresAt?.getTime(),
  });

  oauth2.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await prisma.appSettings.update({
        where: { id: "default" },
        data: {
          gmailAccessToken: tokens.access_token,
          gmailRefreshToken: tokens.refresh_token || settings.gmailRefreshToken,
          gmailTokenExpiresAt: tokens.expiry_date
            ? new Date(tokens.expiry_date)
            : settings.gmailTokenExpiresAt,
        },
      });
    }
  });

  return oauth2;
}

function encodeMimeSubject(subject: string): string {
  const encoded = Buffer.from(subject, "utf8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

function buildRawMessage(from: string, to: string, subject: string, text: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeMimeSubject(subject.slice(0, 200))}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text.slice(0, 10000), "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sendViaGmailApi(to: string, subject: string, text: string) {
  const settings = await getSettings();
  const from = settings.gmailFromEmail;
  if (!from) {
    throw new Error("Gmail 送信元アドレスが未設定です。Gmail を再連携してください");
  }

  const auth = await getOAuth2Client();
  const gmail = google.gmail({ version: "v1", auth });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: buildRawMessage(from, to, subject, text),
    },
  });
}
