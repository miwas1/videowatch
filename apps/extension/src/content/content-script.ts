import { scanDocument } from "./detector";
import type { ReviewCue } from "@describeops/shared";
import { commandFromKeyboardEvent } from "./shortcuts";

type StartAccessibilityPayload = {
  mediaId?: string;
  cues: ReviewCue[];
  detailLevel: "minimal" | "balanced" | "detailed";
  options: {
    readOnScreenText: boolean;
    describeActions: boolean;
    avoidDialogue: boolean;
  };
  ducking?: {
    enabled: boolean;
    level: number;
  };
};

type ActiveSession = {
  mediaId: string;
  media: HTMLVideoElement | HTMLAudioElement;
  cues: ReviewCue[];
  spokenCueIds: Set<string>;
  detailLevel: StartAccessibilityPayload["detailLevel"];
  options: StartAccessibilityPayload["options"];
  pauseDuringSpeech: boolean;
  lastSpokenText: string;
  audioDescriptionEnabled: boolean;
  status: "ready" | "playing" | "speaking" | "stopped";
};

const OVERLAY_ID = "describeops-accessibility-layer";
const SHORTCUT_TEXT = "Alt+Shift+D";

// Spoken text that is page chrome, not a video description, is never read aloud.
const NOISE_PATTERNS = [
  /^skip( to)?( main)?( navigation| content| to content)?$/i,
  /^(sign in|sign up|log in|subscribe|share|save|more|menu|search|home|settings)$/i,
  /the page context highlights/i,
  /page title is/i
];

let activeSession: ActiveSession | null = null;
let resumeAfterSpeech = false;
let pausedForSpeech = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.name === "PAGE_SCAN_REQUESTED") {
    if (window.top !== window) {
      sendResponse({
        ok: false,
        message: "DescribeOps scans the top page frame only."
      });
      return true;
    }

    const snapshot = scanDocument(document);
    updateOverlay(snapshot.media.length ? `${snapshot.media.length} video/audio item(s) detected.` : "No video detected on this page.");
    sendResponse({
      id: crypto.randomUUID(),
      name: "PAGE_SCAN_COMPLETED",
      createdAt: new Date().toISOString(),
      payload: snapshot
    });
    return true;
  }

  if (message?.name === "ACCESSIBILITY_MODE_START_REQUESTED") {
    const result = startAccessibilityMode(message.payload);
    sendResponse(result);
    return true;
  }

  if (message?.name === "ACCESSIBILITY_MODE_STOP_REQUESTED") {
    stopAccessibilityMode();
    sendResponse({ ok: true, status: "stopped" });
    return true;
  }

  if (message?.name === "ACCESSIBILITY_DESCRIBE_NOW_REQUESTED") {
    sendResponse(describeNow());
    return true;
  }

  if (message?.name === "ACCESSIBILITY_STATUS_REQUESTED") {
    sendResponse(sessionStatus());
    return true;
  }

  return false;
});

document.addEventListener("keydown", (event) => {
  const command = commandFromKeyboardEvent(event);
  if (command === "toggle_ad") {
    event.preventDefault();
    toggleAudioDescriptions();
  } else if (command === "describe_now") {
    event.preventDefault();
    describeNow();
  } else if (command === "read_screen_text") {
    event.preventDefault();
    readScreenText();
  } else if (command === "summarize_so_far") {
    event.preventDefault();
    summarizeSoFar();
  }
}, true);

function startAccessibilityMode(payload: StartAccessibilityPayload | undefined) {
  const media = findMediaElement(payload?.mediaId);
  if (!payload || !media) {
    updateOverlay("DescribeOps could not attach to a playable video on this page.");
    return {
      ok: false,
      status: "no_media",
      message: "No playable video or audio element is available for Direct Video Mode."
    };
  }

  stopSpeech();
  activeSession = {
    mediaId: payload.mediaId || media.dataset.describeopsMediaId || "video-0",
    media,
    cues: payload.cues.slice().sort((a, b) => a.start - b.start).filter((cue) => !isNoise(cue.text)),
    spokenCueIds: new Set(),
    detailLevel: payload.detailLevel,
    options: payload.options,
    pauseDuringSpeech: payload.ducking?.enabled ?? true,
    lastSpokenText: "",
    audioDescriptionEnabled: true,
    status: media.paused ? "ready" : "playing"
  };

  attachMediaListeners(media);
  // Follow the focused video as the user scrolls a social feed or switches clips.
  document.addEventListener("play", handleForeignMediaPlay, true);

  updateOverlay(`Accessibility ready. Following the video in focus. Press ${SHORTCUT_TEXT} to ask what is happening.`);
  handleTimeUpdate();
  return {
    ok: true,
    status: "ready",
    mediaId: activeSession.mediaId,
    cueCount: activeSession.cues.length
  };
}

function stopAccessibilityMode() {
  if (activeSession) {
    detachMediaListeners(activeSession.media);
  }
  document.removeEventListener("play", handleForeignMediaPlay, true);
  stopSpeech();
  activeSession = null;
  updateOverlay("Accessibility mode stopped.");
}

function attachMediaListeners(media: HTMLVideoElement | HTMLAudioElement) {
  media.addEventListener("timeupdate", handleTimeUpdate);
  media.addEventListener("play", handlePlaybackState);
  media.addEventListener("pause", handlePlaybackState);
  media.addEventListener("seeked", handleSeeked);
}

function detachMediaListeners(media: HTMLVideoElement | HTMLAudioElement) {
  media.removeEventListener("timeupdate", handleTimeUpdate);
  media.removeEventListener("play", handlePlaybackState);
  media.removeEventListener("pause", handlePlaybackState);
  media.removeEventListener("seeked", handleSeeked);
}

// When another video begins playing (e.g. the next clip in a feed) and it is the
// one now in focus, move the accessibility session to it.
function handleForeignMediaPlay(event: Event) {
  if (!activeSession) return;
  const target = event.target;
  if (!(target instanceof HTMLVideoElement)) return;
  if (target === activeSession.media) return;
  if (pausedForSpeech) return; // ignore the resume of our own paused media
  if (!isInViewport(target)) return;

  detachMediaListeners(activeSession.media);
  ensureMediaId(target);
  activeSession.media = target;
  activeSession.mediaId = target.dataset.describeopsMediaId ?? activeSession.mediaId;
  activeSession.spokenCueIds = new Set();
  attachMediaListeners(target);
  updateOverlay("Switched to the video now in focus.");
  handleTimeUpdate();
}

function handlePlaybackState() {
  if (!activeSession || pausedForSpeech) return;
  activeSession.status = activeSession.media.paused ? "ready" : "playing";
}

function handleSeeked() {
  if (!activeSession) return;
  const currentTime = activeSession.media.currentTime;
  activeSession.spokenCueIds = new Set(
    activeSession.cues
      .filter((cue) => cue.end < currentTime - 1)
      .map((cue) => cue.id)
  );
  handleTimeUpdate();
}

function handleTimeUpdate() {
  if (!activeSession || activeSession.media.paused || isSpeaking() || !activeSession.audioDescriptionEnabled) return;

  const currentTime = activeSession.media.currentTime;
  const nextCue = activeSession.cues.find((cue) =>
    !activeSession?.spokenCueIds.has(cue.id) &&
    cue.status !== "rejected" &&
    currentTime >= cue.start &&
    currentTime <= cue.end + 0.75
  );

  if (nextCue) {
    speakCue(nextCue, "scheduled");
  }
}

function describeNow() {
  if (!activeSession) {
    updateOverlay("Start accessibility mode before asking for a description.");
    return {
      ok: false,
      status: "inactive",
      message: "Accessibility mode has not started."
    };
  }

  const currentTime = activeSession.media.currentTime;
  const cue = nearestCue(currentTime);
  const text = cue
    ? `At ${formatTime(currentTime)}, ${cue.text}`
    : `At ${formatTime(currentTime)}, DescribeOps has no generated visual moment for this timestamp yet.`;

  speakText(text);
  return {
    ok: true,
    status: "describing",
    text
  };
}

function readScreenText() {
  if (!activeSession) {
    updateOverlay("Start accessibility mode before reading screen text.");
    return {
      ok: false,
      status: "inactive",
      message: "Accessibility mode has not started."
    };
  }

  const currentTime = activeSession.media.currentTime;
  const cue = activeSession.cues.find((item) =>
    /text on screen|ocr/i.test(item.text) &&
    currentTime >= item.start - 5 &&
    currentTime <= item.end + 5
  );
  const text = cue?.text ?? "No readable on-screen text has been generated for this moment yet.";
  speakText(text);
  return {
    ok: true,
    status: "reading_text",
    text
  };
}

function summarizeSoFar() {
  if (!activeSession) {
    updateOverlay("Start accessibility mode before asking for a summary.");
    return {
      ok: false,
      status: "inactive",
      message: "Accessibility mode has not started."
    };
  }

  const currentTime = activeSession.media.currentTime;
  const recent = activeSession.cues
    .filter((cue) => cue.start <= currentTime)
    .slice(-3)
    .map((cue) => cue.text)
    .join(" ");
  const text = recent || "No completed accessibility timeline moments are available yet.";
  speakText(text);
  return {
    ok: true,
    status: "summarizing",
    text
  };
}

function toggleAudioDescriptions() {
  if (!activeSession) {
    updateOverlay("Start accessibility mode before toggling audio descriptions.");
    return {
      ok: false,
      status: "inactive",
      message: "Accessibility mode has not started."
    };
  }

  activeSession.audioDescriptionEnabled = !activeSession.audioDescriptionEnabled;
  updateOverlay(activeSession.audioDescriptionEnabled ? "Audio descriptions on." : "Audio descriptions off.");
  return {
    ok: true,
    status: activeSession.audioDescriptionEnabled ? "ad_on" : "ad_off"
  };
}

function sessionStatus() {
  if (!activeSession) {
    return { ok: true, status: "inactive" };
  }

  return {
    ok: true,
    status: activeSession.status,
    mediaId: activeSession.mediaId,
    currentTime: activeSession.media.currentTime,
    cueCount: activeSession.cues.length,
    spokenCueCount: activeSession.spokenCueIds.size,
    lastSpokenText: activeSession.lastSpokenText
  };
}

function speakCue(cue: ReviewCue, reason: "scheduled" | "manual") {
  if (!activeSession || !activeSession.audioDescriptionEnabled) return;
  activeSession.spokenCueIds.add(cue.id);
  speakText(cue.text, reason);
}

function speakText(text: string, reason: "scheduled" | "manual" = "manual") {
  if (!("speechSynthesis" in window)) {
    updateOverlay("Speech synthesis is not available in this browser.");
    return;
  }

  if (!activeSession) return;
  stopSpeech();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = activeSession.detailLevel === "detailed" ? 0.92 : 0.98;
  utterance.pitch = 1;
  utterance.onstart = () => {
    if (!activeSession) return;
    activeSession.status = "speaking";
    activeSession.lastSpokenText = text;
    pauseMediaForSpeech();
    updateOverlay(reason === "scheduled" ? text : `Answering now: ${text}`);
  };
  utterance.onend = () => {
    resumeMediaAfterSpeech();
    if (activeSession) {
      activeSession.status = activeSession.media.paused ? "ready" : "playing";
    }
  };
  utterance.onerror = () => {
    resumeMediaAfterSpeech();
    updateOverlay("DescribeOps could not play that description.");
  };

  window.speechSynthesis.speak(utterance);
}

function stopSpeech() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  resumeMediaAfterSpeech();
}

function isSpeaking() {
  return "speechSynthesis" in window && window.speechSynthesis.speaking;
}

// Circuit breaker: never let the spoken description overlap the video's own
// audio. Pause the video while speaking, then resume if it was playing.
function pauseMediaForSpeech() {
  if (!activeSession?.pauseDuringSpeech) return;
  const media = activeSession.media;
  if (!media.paused) {
    resumeAfterSpeech = true;
    pausedForSpeech = true;
    media.pause();
  }
}

function resumeMediaAfterSpeech() {
  if (!activeSession) {
    pausedForSpeech = false;
    resumeAfterSpeech = false;
    return;
  }
  if (resumeAfterSpeech && activeSession.audioDescriptionEnabled) {
    const playResult = activeSession.media.play();
    if (playResult && typeof playResult.catch === "function") {
      playResult.catch(() => undefined);
    }
  }
  resumeAfterSpeech = false;
  pausedForSpeech = false;
}

function isNoise(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width * rect.height === 0) return false;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const verticalOverlap = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  const horizontalOverlap = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
  return verticalOverlap > rect.height * 0.4 && horizontalOverlap > rect.width * 0.4;
}

function ensureMediaId(media: HTMLVideoElement | HTMLAudioElement) {
  if (media.dataset.describeopsMediaId) return;
  const kind = media instanceof HTMLAudioElement ? "audio" : "video";
  const sameKind = Array.from(document.querySelectorAll(kind));
  media.dataset.describeopsMediaId = `${kind}-${sameKind.indexOf(media)}`;
}

function nearestCue(currentTime: number) {
  if (!activeSession?.cues.length) return null;
  return activeSession.cues.reduce((nearest, cue) => {
    const nearestDistance = Math.abs(nearest.start - currentTime);
    const cueDistance = Math.abs(cue.start - currentTime);
    return cueDistance < nearestDistance ? cue : nearest;
  }, activeSession.cues[0]);
}

function findMediaElement(mediaId?: string): HTMLVideoElement | HTMLAudioElement | null {
  const elements = Array.from(document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio"));
  elements.forEach((element, index) => {
    const kind = element instanceof HTMLAudioElement ? "audio" : "video";
    element.dataset.describeopsMediaId = `${kind}-${index}`;
  });

  if (mediaId) {
    const exact = elements.find((element) => element.dataset.describeopsMediaId === mediaId);
    if (exact) return exact;
  }

  return pickFocusedMedia(elements);
}

// Choose the video the user is actually watching: a playing, in-viewport video
// outranks a paused one, which outranks the largest visible element.
function pickFocusedMedia(
  elements: Array<HTMLVideoElement | HTMLAudioElement>
): HTMLVideoElement | HTMLAudioElement | null {
  const score = (element: HTMLVideoElement | HTMLAudioElement): number => {
    let value = element instanceof HTMLVideoElement ? 0 : -5_000_000;
    const playing = !element.paused && !element.ended && element.currentTime > 0;
    if (playing) value += 8_000_000;
    if (isInViewport(element)) value += 1_000_000;
    const rect = element.getBoundingClientRect?.();
    value += rect ? rect.width * rect.height : 0;
    return value;
  };

  return elements
    .slice()
    .sort((a, b) => score(b) - score(a))[0] ?? null;
}

function updateOverlay(message: string) {
  const host = ensureOverlay();
  const status = host.shadowRoot?.querySelector<HTMLElement>("[data-status]");
  if (status) {
    status.textContent = message;
  }
}

function ensureOverlay() {
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
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .surface {
        display: grid;
        gap: 8px;
        border: 1px solid #2b5d6d;
        border-radius: 8px;
        background: #fbfcfd;
        color: #182229;
        box-shadow: 0 16px 42px rgba(24, 34, 41, 0.22);
        padding: 12px;
      }

      .eyebrow {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
        color: #2b5d6d;
      }

      [data-status] {
        margin: 0;
        font-size: 13px;
        line-height: 1.45;
      }

      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      button {
        min-height: 36px;
        border: 1px solid #2b5d6d;
        border-radius: 6px;
        background: #2b5d6d;
        color: #fff;
        font: inherit;
        font-size: 12px;
        font-weight: 750;
        padding: 0 10px;
        cursor: pointer;
      }

      button:focus-visible {
        outline: 3px solid #d38b19;
        outline-offset: 2px;
      }

      .hint {
        margin: 0;
        font-size: 11px;
        color: #4a5a63;
      }
    </style>
    <section class="surface" aria-label="DescribeOps accessibility layer">
      <div class="eyebrow">Video described</div>
      <p data-status role="status" aria-live="assertive">Ready.</p>
      <p class="hint">${SHORTCUT_TEXT}: describe now &middot; Alt+Shift+A: pause descriptions</p>
      <div class="actions">
        <button type="button" data-stop aria-label="Stop describing this video">Stop</button>
      </div>
    </section>
  `;
  shadow.querySelector("[data-stop]")?.addEventListener("click", () => stopAccessibilityMode());
  document.documentElement.append(host);
  return host;
}

function formatTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
