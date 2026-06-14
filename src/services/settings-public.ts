import type { AppSettings } from "@prisma/client";

const SECRET_FIELDS = ["lineChannelSecret", "lineChannelAccessToken", "smtpPass"] as const;

/** Strip OAuth tokens and mask secret fields for API responses. */
export function toPublicSettings(settings: AppSettings) {
  const {
    gmailRefreshToken: _gmailRefresh,
    gmailAccessToken: _gmailAccess,
    gbpRefreshToken: _gbpRefresh,
    gbpAccessToken: _gbpAccess,
    gmailTokenExpiresAt: _gmailExp,
    gbpTokenExpiresAt: _gbpExp,
    lineChannelSecret,
    lineChannelAccessToken,
    smtpPass,
    ...rest
  } = settings;

  return {
    ...rest,
    lineChannelSecret: lineChannelSecret ? "" : null,
    lineChannelAccessToken: lineChannelAccessToken ? "" : null,
    smtpPass: smtpPass ? "" : null,
    hasLineChannelSecret: !!lineChannelSecret,
    hasLineChannelAccessToken: !!lineChannelAccessToken,
    hasSmtpPass: !!smtpPass,
  };
}

/** Do not overwrite stored secrets when the client sends empty placeholders. */
export function omitEmptySecretUpdates<T extends Record<string, unknown>>(data: T): T {
  const result = { ...data };
  for (const key of SECRET_FIELDS) {
    const value = result[key];
    if (value === "" || value === null || value === undefined) {
      delete result[key];
    }
  }
  return result;
}
