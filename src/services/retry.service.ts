import { getSettings } from "./settings.service.js";

export async function computeNextRetryAt(retryCount: number): Promise<Date | null> {
  const settings = await getSettings();
  if (!settings.autoRetryEnabled) return null;
  if (retryCount >= settings.maxRetryAttempts) return null;
  return new Date(Date.now() + settings.retryIntervalMinutes * 60_000);
}

export async function shouldRetry(retryCount: number): Promise<boolean> {
  const settings = await getSettings();
  return settings.autoRetryEnabled && retryCount < settings.maxRetryAttempts;
}
