import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { getSettings } from "./settings.service.js";
import { getGmailStatus, isGmailOAuthConfigured, sendViaGmailApi } from "./gmail.service.js";

export async function getEmailConfig() {
  const settings = await getSettings();
  const gmailStatus = await getGmailStatus();
  const host = settings.smtpHost || process.env.SMTP_HOST;
  const port = settings.smtpPort || Number(process.env.SMTP_PORT || 587);
  const user = settings.smtpUser || process.env.SMTP_USER;
  const pass = settings.smtpPass || process.env.SMTP_PASS;
  const from = settings.smtpFrom || process.env.SMTP_FROM || user;
  const smtpConfigured = !!(host && from);
  const gmailConfigured = gmailStatus.connected;
  const method = settings.emailSendMethod === "smtp" ? "smtp" : "gmail";
  const configured =
    method === "smtp" ? smtpConfigured : gmailConfigured || smtpConfigured;
  return {
    host,
    port,
    user,
    pass,
    from,
    smtpConfigured,
    gmailConfigured,
    gmailOAuthConfigured: isGmailOAuthConfigured(),
    method,
    gmailFrom: settings.gmailFromEmail,
    configured,
    enabled: settings.emailAutoSendEnabled,
  };
}

async function sendViaSmtp(to: string, subject: string, text: string) {
  const config = await getEmailConfig();
  if (!config.host || !config.from) {
    throw new Error("SMTPが未設定です（設定画面でSMTPホスト・送信元を入力してください）");
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
  });

  await transport.sendMail({
    from: config.from,
    to,
    subject: subject.slice(0, 200),
    text: text.slice(0, 10000),
  });
}

export async function sendEmail(to: string, subject: string, text: string) {
  const config = await getEmailConfig();

  if (config.method === "gmail" && config.gmailConfigured) {
    await sendViaGmailApi(to, subject, text);
    return;
  }

  if (config.smtpConfigured) {
    await sendViaSmtp(to, subject, text);
    return;
  }

  if (config.gmailConfigured) {
    await sendViaGmailApi(to, subject, text);
    return;
  }

  throw new Error(
    "メール送信が未設定です。設定画面で Gmail を連携するか、SMTP を入力してください"
  );
}

export async function sendReviewEmail(to: string, subject: string, body: string) {
  await sendEmail(to, subject, body);
}
