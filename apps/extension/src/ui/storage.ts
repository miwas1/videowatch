import type { ExtensionSettings } from "../types";

const STORAGE_KEY = "describeops.settings";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiBaseUrl: "http://127.0.0.1:8000",
  apiToken: "",
  chunkSeconds: 30,
  framesPerChunk: 4,
  autoCapture: false
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
  return {
    apiBaseUrl: trimTrailingSlash(value?.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl),
    apiToken: value?.apiToken ?? DEFAULT_SETTINGS.apiToken,
    chunkSeconds: Number.isFinite(chunkSeconds) ? Math.max(8, Math.min(120, Math.round(chunkSeconds))) : DEFAULT_SETTINGS.chunkSeconds,
    framesPerChunk: Number.isFinite(framesPerChunk) ? Math.max(1, Math.min(8, Math.round(framesPerChunk))) : DEFAULT_SETTINGS.framesPerChunk,
    autoCapture: Boolean(value?.autoCapture ?? DEFAULT_SETTINGS.autoCapture)
  };
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}
