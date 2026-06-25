import { findMediaElement, scanDocument } from "./detector";
import type { CapturedFrame, ReviewCue } from "../types";

type CaptureDetail = "media" | "captions" | "context";
type ScreenshotFallback = "cropped" | "off";

type ActiveSession = {
  media: HTMLVideoElement | HTMLAudioElement;
  cues: ReviewCue[];
  spokenCueIds: Set<string>;
  lastSpokenText: string;
  enabled: boolean;
};

const OVERLAY_ID = "describeops-accessibility-layer";
let activeSession: ActiveSession | null = null;
let resumeAfterSpeech = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.name === "PAGE_SCAN_REQUESTED") {
    sendResponse({ ok: true, payload: scanDocument(document) });
    return true;
  }

  if (message?.name === "CAPTURE_FRAME_REQUESTED") {
    captureFrame(
      String(message.mediaId ?? ""),
      Number(message.timestampSeconds ?? 0),
      normalizeCaptureDetail(message.captureDetail),
      normalizeScreenshotFallback(message.screenshotFallback)
    )
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, message: "Could not capture a frame.", diagnostics: String(error) }));
    return true;
  }

  if (message?.name === "CAPTURE_MULTI_FRAMES_REQUESTED") {
    captureMultiFrames(
      String(message.mediaId ?? ""),
      Number(message.startSeconds ?? 0),
      Number(message.endSeconds ?? 30),
      Number(message.frameCount ?? 4),
      normalizeCaptureDetail(message.captureDetail),
      normalizeScreenshotFallback(message.screenshotFallback)
    )
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, message: "Multi-frame capture failed.", diagnostics: String(error) }));
    return true;
  }

  if (message?.name === "DESCRIPTIONS_ATTACH_REQUESTED") {
    const result = attachDescriptions(String(message.mediaId ?? ""), Array.isArray(message.cues) ? message.cues : []);
    sendResponse(result);
    return true;
  }

  if (message?.name === "DESCRIPTIONS_STOP_REQUESTED") {
    stopDescriptions();
    sendResponse({ ok: true, payload: { status: "stopped" } });
    return true;
  }

  if (message?.name === "DESCRIBE_NOW_REQUESTED") {
    sendResponse(describeNow());
    return true;
  }

  if (message?.name === "SEEK_VIDEO_REQUESTED") {
    const media = findMediaElement();
    if (media) {
      media.currentTime = Number(message.seconds ?? 0);
    }
    sendResponse({ ok: true, payload: { seeked: true } });
    return true;
  }

  return false;
});

async function captureFrame(
  mediaId: string,
  timestampSeconds: number,
  captureDetail: CaptureDetail,
  screenshotFallback: ScreenshotFallback
): Promise<CapturedFrame> {
  const media = findMediaElement(mediaId);
  if (media instanceof HTMLVideoElement && media.videoWidth > 0 && media.videoHeight > 0) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(1280, media.videoWidth);
      canvas.height = Math.max(1, Math.round((canvas.width / media.videoWidth) * media.videoHeight));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas context unavailable.");
      context.drawImage(media, 0, 0, canvas.width, canvas.height);
      return {
        mediaId,
        timestampSeconds: media.currentTime || timestampSeconds,
        dataUrl: canvas.toDataURL("image/png"),
        mimeType: "image/png",
        isFallback: false,
        note: "Captured a browser-accessible video frame."
      };
    } catch (error) {
      return fallbackFrame(mediaId, media.currentTime || timestampSeconds, `Frame pixels were blocked by the page: ${String(error)}`, captureDetail);
    }
  }

  return fallbackFrame(mediaId, timestampSeconds, "No directly readable video pixels were available; using a limited placeholder frame.", captureDetail);
}

async function captureMultiFrames(
  mediaId: string,
  startSeconds: number,
  endSeconds: number,
  frameCount: number,
  captureDetail: CaptureDetail,
  screenshotFallback: ScreenshotFallback
): Promise<CapturedFrame[]> {
  const media = findMediaElement(mediaId);
  if (!(media instanceof HTMLVideoElement) || media.videoWidth === 0) {
    return [fallbackFrame(mediaId, startSeconds, "No video element available for multi-frame capture.", captureDetail)];
  }

  const duration = endSeconds - startSeconds;
  const interval = duration / Math.max(1, frameCount);
  const frames: CapturedFrame[] = [];
  const originalTime = media.currentTime;
  const wasPaused = media.paused;

  if (!wasPaused) media.pause();

  for (let i = 0; i < frameCount; i++) {
    const targetTime = startSeconds + (i * interval) + (interval * 0.5);
    try {
      await seekTo(media, targetTime);
      const frame = await captureFrameAtCurrentTime(media, mediaId, targetTime, screenshotFallback);
      frames.push(frame);
    } catch {
      frames.push(fallbackFrame(mediaId, targetTime, `Frame ${i + 1} capture failed.`, captureDetail));
    }
  }

  await seekTo(media, originalTime);
  if (!wasPaused) {
    media.play().catch(() => undefined);
  }

  return frames.length > 0 ? frames : [fallbackFrame(mediaId, startSeconds, "All frame captures failed.", captureDetail)];
}

function seekTo(media: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(media.currentTime - time) < 0.1) {
      resolve();
      return;
    }
    const handler = () => {
      media.removeEventListener("seeked", handler);
      resolve();
    };
    media.addEventListener("seeked", handler);
    media.currentTime = time;
    setTimeout(() => {
      media.removeEventListener("seeked", handler);
      resolve();
    }, 2000);
  });
}

async function captureFrameAtCurrentTime(
  media: HTMLVideoElement,
  mediaId: string,
  timestampSeconds: number,
  screenshotFallback: ScreenshotFallback
): Promise<CapturedFrame> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(1280, media.videoWidth);
  canvas.height = Math.max(1, Math.round((canvas.width / media.videoWidth) * media.videoHeight));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context unavailable.");
  try {
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    // Test for tainted canvas by trying to read back
    context.getImageData(0, 0, 1, 1);
    return {
      mediaId,
      timestampSeconds: media.currentTime || timestampSeconds,
      dataUrl,
      mimeType: "image/jpeg" as const,
      isFallback: false,
      note: `Frame captured at ${formatClock(media.currentTime)}.`
    };
  } catch {
    if (screenshotFallback === "off") {
      throw new Error("Cross-origin frame capture was blocked and screenshot fallback is disabled.");
    }
    // Cross-origin tainted canvas — request tab screenshot from service worker
    const response = await chrome.runtime.sendMessage({ name: "CAPTURE_TAB_SCREENSHOT" }) as
      { ok: true; payload: { dataUrl: string } } | { ok: false; message: string };
    if (response.ok) {
      const cropped = await cropScreenshotToMedia(response.payload.dataUrl, media);
      return {
        mediaId,
        timestampSeconds: media.currentTime || timestampSeconds,
        dataUrl: cropped,
        mimeType: "image/jpeg" as const,
        isFallback: true,
        note: `Cropped video-area screenshot at ${formatClock(media.currentTime)} (cross-origin video).`
      };
    }
    throw new Error("Cross-origin frame capture failed and tab screenshot unavailable.");
  }
}

function fallbackFrame(mediaId: string, timestampSeconds: number, note: string, captureDetail: CaptureDetail): CapturedFrame {
  const snapshot = scanDocument(document);
  const canvas = document.createElement("canvas");
  canvas.width = 960;
  canvas.height = 540;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas context unavailable.");

  context.fillStyle = "#f7f8f6";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1f292e";
  context.font = "700 30px Arial, sans-serif";
  context.fillText("DescribeOps browser context", 48, 72);
  context.fillStyle = "#2f6f73";
  context.fillRect(48, 106, 220, 6);
  context.fillStyle = "#46545c";
  context.font = "22px Arial, sans-serif";
  const title = captureDetail === "context" ? snapshot.title : "Video frame unavailable";
  wrapText(context, title, 48, 160, 840, 30, 3);
  context.font = "18px Arial, sans-serif";
  context.fillStyle = "#66737a";
  const detail = captureDetail === "context"
    ? snapshot.liveCaptionText[0] || snapshot.visibleText[0] || note
    : captureDetail === "captions"
      ? snapshot.liveCaptionText[0] || note
      : note;
  wrapText(context, detail, 48, 300, 840, 26, 4);
  context.fillStyle = "#9ca3a3";
  context.font = "16px Arial, sans-serif";
  context.fillText(`Time ${formatClock(timestampSeconds)}`, 48, 486);

  return {
    mediaId,
    timestampSeconds,
    dataUrl: canvas.toDataURL("image/png"),
    mimeType: "image/png",
    isFallback: true,
    note
  };
}

function cropScreenshotToMedia(dataUrl: string, media: HTMLVideoElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const rect = media.getBoundingClientRect();
      if (!rect.width || !rect.height || !window.innerWidth || !window.innerHeight) {
        reject(new Error("Video rectangle unavailable for cropped screenshot fallback."));
        return;
      }
      const scaleX = image.naturalWidth / window.innerWidth;
      const scaleY = image.naturalHeight / window.innerHeight;
      const sourceX = Math.max(0, Math.round(rect.left * scaleX));
      const sourceY = Math.max(0, Math.round(rect.top * scaleY));
      const sourceWidth = Math.min(image.naturalWidth - sourceX, Math.round(rect.width * scaleX));
      const sourceHeight = Math.min(image.naturalHeight - sourceY, Math.round(rect.height * scaleY));
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        reject(new Error("Video crop was outside the captured tab image."));
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(1280, sourceWidth);
      canvas.height = Math.max(1, Math.round((canvas.width / sourceWidth) * sourceHeight));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas context unavailable."));
        return;
      }
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    image.onerror = () => reject(new Error("Could not load tab screenshot for cropping."));
    image.src = dataUrl;
  });
}

function normalizeCaptureDetail(value: unknown): CaptureDetail {
  return value === "captions" || value === "context" || value === "media" ? value : "media";
}

function normalizeScreenshotFallback(value: unknown): ScreenshotFallback {
  return value === "off" || value === "cropped" ? value : "cropped";
}

function attachDescriptions(mediaId: string, cues: ReviewCue[]) {
  const media = findMediaElement(mediaId);
  if (!media) {
    updateOverlay("DescribeOps could not attach to a playable video.");
    return { ok: false, message: "No playable video element was found." };
  }

  stopDescriptions();
  activeSession = {
    media,
    cues: cues.slice().sort((a, b) => a.start - b.start),
    spokenCueIds: new Set(),
    lastSpokenText: "",
    enabled: true
  };
  media.addEventListener("timeupdate", handleTimeUpdate);
  media.addEventListener("seeked", handleSeeked);
  updateOverlay(`Descriptions attached. ${cues.length} moments are ready.`);
  handleTimeUpdate();
  return { ok: true, payload: { cueCount: cues.length } };
}

function stopDescriptions(): void {
  if (activeSession) {
    activeSession.media.removeEventListener("timeupdate", handleTimeUpdate);
    activeSession.media.removeEventListener("seeked", handleSeeked);
  }
  stopSpeech();
  activeSession = null;
  updateOverlay("Descriptions stopped.");
}

function handleSeeked(): void {
  if (!activeSession) return;
  const currentTime = activeSession.media.currentTime;
  activeSession.spokenCueIds = new Set(
    activeSession.cues.filter((cue) => cue.end < currentTime - 1).map((cue) => cue.id)
  );
}

function handleTimeUpdate(): void {
  if (!activeSession || !activeSession.enabled || activeSession.media.paused || isSpeaking()) return;
  const currentTime = activeSession.media.currentTime;
  const cue = activeSession.cues.find((item) =>
    !activeSession?.spokenCueIds.has(item.id) &&
    currentTime >= item.start &&
    currentTime <= item.end + 0.9
  );
  if (cue) speakCue(cue);
}

function describeNow() {
  if (!activeSession) {
    updateOverlay("Start DescribeOps from the side panel first.");
    return { ok: false, message: "Descriptions are not attached." };
  }

  const currentTime = activeSession.media.currentTime;
  const cue = nearestCue(currentTime);
  const text = cue ? `At ${formatClock(currentTime)}, ${cue.text}` : `At ${formatClock(currentTime)}, no generated description is available yet.`;
  speakText(text);
  return { ok: true, payload: { text } };
}

function speakCue(cue: ReviewCue): void {
  if (!activeSession) return;
  activeSession.spokenCueIds.add(cue.id);
  speakText(cue.text);
}

function speakText(text: string): void {
  if (!activeSession || !("speechSynthesis" in window)) return;
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.96;
  utterance.pitch = 1;
  utterance.onstart = () => {
    if (!activeSession) return;
    activeSession.lastSpokenText = text;
    pauseMediaForSpeech();
    updateOverlay(text);
  };
  utterance.onend = () => resumeMediaAfterSpeech();
  utterance.onerror = () => {
    resumeMediaAfterSpeech();
    updateOverlay("DescribeOps could not play that description.");
  };
  window.speechSynthesis.speak(utterance);
}

function stopSpeech(): void {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  resumeMediaAfterSpeech();
}

function isSpeaking(): boolean {
  return "speechSynthesis" in window && window.speechSynthesis.speaking;
}

function pauseMediaForSpeech(): void {
  if (!activeSession || activeSession.media.paused) return;
  resumeAfterSpeech = true;
  activeSession.media.pause();
}

function resumeMediaAfterSpeech(): void {
  if (activeSession && resumeAfterSpeech && activeSession.enabled) {
    const result = activeSession.media.play();
    if (result && typeof result.catch === "function") {
      result.catch(() => undefined);
    }
  }
  resumeAfterSpeech = false;
}

function nearestCue(currentTime: number): ReviewCue | null {
  if (!activeSession?.cues.length) return null;
  return activeSession.cues.reduce((nearest, cue) => {
    const nearestDistance = Math.abs(nearest.start - currentTime);
    const cueDistance = Math.abs(cue.start - currentTime);
    return cueDistance < nearestDistance ? cue : nearest;
  }, activeSession.cues[0]);
}

function ensureOverlay(): HTMLElement {
  let host = document.getElementById(OVERLAY_ID);
  if (host) return host;

  host = document.createElement("div");
  host.id = OVERLAY_ID;
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        max-width: min(360px, calc(100vw - 32px));
        color-scheme: light;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .surface {
        display: grid;
        gap: 8px;
        border: 1px solid rgba(47, 111, 115, 0.42);
        border-radius: 8px;
        background: rgba(250, 251, 249, 0.94);
        color: #1f292e;
        box-shadow: 0 18px 46px rgba(31, 41, 46, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.8);
        padding: 12px;
        backdrop-filter: blur(14px);
      }

      .eyebrow {
        font-size: 11px;
        font-weight: 800;
        color: #2f6f73;
        text-transform: uppercase;
      }

      [data-status] {
        margin: 0;
        font-size: 13px;
        line-height: 1.45;
      }

      button {
        min-height: 34px;
        width: max-content;
        border: 1px solid #2f6f73;
        border-radius: 6px;
        background: #2f6f73;
        color: #fff;
        font: inherit;
        font-size: 12px;
        font-weight: 760;
        padding: 0 10px;
        cursor: pointer;
      }

      button:active {
        transform: translateY(1px);
      }

      button:focus-visible {
        outline: 3px solid #d49b45;
        outline-offset: 2px;
      }
    </style>
    <section class="surface" aria-label="DescribeOps accessibility layer">
      <div class="eyebrow">DescribeOps</div>
      <p data-status role="status" aria-live="assertive">Ready.</p>
      <button type="button" data-stop aria-label="Stop DescribeOps descriptions">Stop</button>
    </section>
  `;
  shadow.querySelector("[data-stop]")?.addEventListener("click", () => stopDescriptions());
  document.documentElement.append(host);
  return host;
}

function updateOverlay(message: string): void {
  const host = ensureOverlay();
  const status = host.shadowRoot?.querySelector<HTMLElement>("[data-status]");
  if (status) status.textContent = message;
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
): void {
  const words = text.split(/\s+/);
  let line = "";
  let lineCount = 0;

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (context.measureText(testLine).width > maxWidth && line) {
      context.fillText(line, x, y + lineCount * lineHeight);
      line = word;
      lineCount += 1;
      if (lineCount >= maxLines) return;
    } else {
      line = testLine;
    }
  }

  if (line && lineCount < maxLines) {
    context.fillText(line, x, y + lineCount * lineHeight);
  }
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
