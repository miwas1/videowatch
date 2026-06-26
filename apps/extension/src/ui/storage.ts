import type { ExtensionSettings } from "../types";

const STORAGE_KEY = "describeops.settings";
const PRODUCTION_API_BASE_URL = "https://videowatch.platinexsolutions.com.ng";
const PRODUCTION_API_TOKEN = "describeops-ext-2025@yello11";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiBaseUrl: PRODUCTION_API_BASE_URL,
  apiToken: PRODUCTION_API_TOKEN,
  chunkSeconds: 30,
  framesPerChunk: 4,
  autoCapture: false,
  captureDetail: "media",
  screenshotFallback: "cropped"
};

export async function loadSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const value = result[STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  return normalizeSettings(value);
}

export async function saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.sync.set({ [STORAGE_KEY]: normalized });
  return normalized;
}

export function normalizeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  const chunkSeconds = Number(value?.chunkSeconds ?? DEFAULT_SETTINGS.chunkSeconds);
  const framesPerChunk = Number(value?.framesPerChunk ?? DEFAULT_SETTINGS.framesPerChunk);
  const rawApiBaseUrl = trimTrailingSlash(value?.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl);
  return {
    apiBaseUrl: isLegacyLocalDefault(rawApiBaseUrl) ? PRODUCTION_API_BASE_URL : rawApiBaseUrl,
    apiToken: (value?.apiToken ?? DEFAULT_SETTINGS.apiToken).trim(),
    chunkSeconds: Number.isFinite(chunkSeconds) ? Math.max(8, Math.min(120, Math.round(chunkSeconds))) : DEFAULT_SETTINGS.chunkSeconds,
    framesPerChunk: Number.isFinite(framesPerChunk) ? Math.max(1, Math.min(8, Math.round(framesPerChunk))) : DEFAULT_SETTINGS.framesPerChunk,
    autoCapture: Boolean(value?.autoCapture ?? DEFAULT_SETTINGS.autoCapture),
    captureDetail: normalizeCaptureDetail(value?.captureDetail),
    screenshotFallback: normalizeScreenshotFallback(value?.screenshotFallback)
  };
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isLegacyLocalDefault(value: string): boolean {
  return value === "http://127.0.0.1:8000" || value === "http://localhost:8000";
}

function normalizeCaptureDetail(value: unknown): ExtensionSettings["captureDetail"] {
  return value === "captions" || value === "context" || value === "media" ? value : DEFAULT_SETTINGS.captureDetail;
}

function normalizeScreenshotFallback(value: unknown): ExtensionSettings["screenshotFallback"] {
  return value === "off" || value === "cropped" ? value : DEFAULT_SETTINGS.screenshotFallback;
}
