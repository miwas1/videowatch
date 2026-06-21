import type { DetectedMedia, PageAccessibilitySnapshot, VideoPlatform } from "../types";

const TEXT_LIMIT = 42;
const TINY_VIDEO_AREA = 12_000;
const NOISE_PATTERNS = [
  /^skip( to)?( main)?( navigation| content| to content)?$/i,
  /^(sign in|sign up|log in|log out|subscribe|share|save|more|menu|search|home|settings|help)$/i,
  /^(next|previous|play|pause|mute|unmute|like|dislike|comment|notifications?)$/i,
  /^(accept|reject|got it|ok|close|dismiss)( all)?( cookies?)?$/i,
  /cookie|consent|advertisement|^ad$|sponsored/i,
  /^\d+(\.\d+)?[KMB]?\s*(views?|likes?|subscribers?|comments?)$/i
];

export function scanDocument(doc: Document = document): PageAccessibilitySnapshot {
  const platform = detectPlatform(doc);
  return {
    url: doc.location?.href ?? "",
    title: documentTitle(doc),
    media: collectMedia(doc, platform),
    headings: collectHeadings(doc),
    visibleText: collectVisibleText(doc),
    transcriptText: collectTranscriptText(doc),
    captions: collectCaptions(doc),
    liveCaptionText: collectLiveCaptionText(doc),
    platform
  };
}

export function findMediaElement(mediaId?: string): HTMLVideoElement | HTMLAudioElement | null {
  const elements = Array.from(document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio"));
  elements.forEach((element, index) => {
    const kind = element instanceof HTMLAudioElement ? "audio" : "video";
    element.dataset.describeopsMediaId = `${kind}-${index}`;
  });

  if (mediaId) {
    const exact = elements.find((element) => element.dataset.describeopsMediaId === mediaId);
    if (exact) return exact;
  }

  return elements.slice().sort((a, b) => mediaScore(b) - mediaScore(a))[0] ?? null;
}

function detectPlatform(doc: Document): VideoPlatform {
  const host = doc.location?.hostname.toLowerCase() ?? "";
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") return "youtube";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return "twitter";
  if (/(^|\.)facebook\.com$/.test(host) || host === "fb.watch") return "facebook";
  if (/(^|\.)vimeo\.com$/.test(host)) return "vimeo";
  if (/(^|\.)twitch\.tv$/.test(host)) return "twitch";
  return "generic";
}

function collectMedia(doc: Document, platform: VideoPlatform): DetectedMedia[] {
  const media: DetectedMedia[] = [];

  doc.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio").forEach((element, index) => {
    if (!isPlayableMediaElement(element)) return;

    const kind = element instanceof HTMLAudioElement ? "audio" : "video";
    element.dataset.describeopsMediaId = `${kind}-${index}`;
    const source = element.currentSrc || element.getAttribute("src") || element.querySelector("source")?.getAttribute("src") || undefined;
    const tracks = Array.from(element.querySelectorAll("track"));

    media.push({
      id: `${kind}-${index}`,
      kind,
      label: accessibleName(element) || `${kind === "audio" ? "Audio" : "Video"} ${index + 1}`,
      currentTime: finiteOrUndefined(element.currentTime),
      duration: finiteOrUndefined(element.duration),
      width: kind === "video" ? finiteOrUndefined((element as HTMLVideoElement).videoWidth || element.clientWidth || element.getAttribute("width")) : undefined,
      height: kind === "video" ? finiteOrUndefined((element as HTMLVideoElement).videoHeight || element.clientHeight || element.getAttribute("height")) : undefined,
      hasCaptions: tracks.some((track) => ["captions", "subtitles", "descriptions"].includes(track.kind)),
      source,
      platform,
      isPlaying: isMediaPlaying(element),
      isFocused: false
    });
  });

  if (!media.some((item) => item.kind !== "audio")) {
    doc.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame, index) => {
      if (!looksLikeEmbeddedPlayer(frame)) return;
      media.push({
        id: `embedded-player-${index}`,
        kind: "embedded-player",
        label: frame.title || frame.getAttribute("aria-label") || frame.src || "Embedded video player",
        width: finiteOrUndefined(frame.width || frame.clientWidth),
        height: finiteOrUndefined(frame.height || frame.clientHeight),
        hasCaptions: false,
        source: frame.src || undefined,
        platform,
        isPlaying: false,
        isFocused: false
      });
    });
  }

  const youtube = detectYouTubeWatchPage(doc, media.length);
  if (youtube && !media.some((item) => item.source === youtube.source)) {
    media.push(youtube);
  }

  const ranked = media.slice().sort((a, b) => mediaItemScore(doc, b) - mediaItemScore(doc, a));
  if (ranked[0]) ranked[0].isFocused = true;
  return ranked;
}

function collectHeadings(doc: Document): string[] {
  return Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .map((heading) => firstText(heading))
    .filter(Boolean)
    .slice(0, 12);
}

function collectVisibleText(doc: Document): string[] {
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const text: string[] = [];
  let node = walker.nextNode();

  while (node && text.length < TEXT_LIMIT) {
    const value = node.textContent?.replace(/\s+/g, " ").trim();
    if (value && value.length > 2 && isElementVisible(node.parentElement) && !isNoiseText(value) && !isInteractiveChrome(node.parentElement)) {
      text.push(value);
    }
    node = walker.nextNode();
  }

  return unique(text);
}

function collectTranscriptText(doc: Document): string[] {
  const selectors = [
    "[data-transcript]",
    "[aria-label*='transcript' i]",
    "[class*='transcript' i]",
    "track[kind='descriptions']"
  ];
  return unique(
    selectors.flatMap((selector) =>
      Array.from(doc.querySelectorAll(selector))
        .filter((element) => isElementVisible(element))
        .map((element) => firstText(element) || element.getAttribute("label") || "")
    )
  ).slice(0, 16);
}

function collectCaptions(doc: Document): string[] {
  return unique(
    Array.from(doc.querySelectorAll<HTMLTrackElement>("track[kind='captions'],track[kind='subtitles']"))
      .map((track) => track.label || track.srclang || track.src)
      .filter(Boolean)
  );
}

function collectLiveCaptionText(doc: Document): string[] {
  const selectors = [
    ".ytp-caption-segment",
    ".caption-window",
    ".captions-text",
    "[class*='caption' i] span",
    "[class*='subtitle' i] span",
    "[aria-label*='caption' i]"
  ];
  return unique(
    selectors.flatMap((selector) =>
      Array.from(doc.querySelectorAll(selector))
        .filter((element) => isElementVisible(element))
        .map((element) => firstText(element))
    )
  )
    .filter((value) => value && !isNoiseText(value))
    .slice(0, 12);
}

function documentTitle(doc: Document): string {
  return (
    doc.title?.replace(/\s+-\s+YouTube$/, "").trim() ||
    metaContent(doc, "meta[property='og:title']") ||
    metaContent(doc, "meta[name='title']") ||
    firstText(doc.querySelector("h1")) ||
    "Untitled page"
  );
}

function detectYouTubeWatchPage(doc: Document, index: number): DetectedMedia | null {
  const host = doc.location?.hostname.toLowerCase() ?? "";
  const isWatchPage = (/(^|\.)youtube\.com$/.test(host) && doc.location?.pathname === "/watch") || Boolean(doc.querySelector("ytd-watch-flexy, #movie_player"));
  if (!isWatchPage) return null;

  const video = doc.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  const player = doc.querySelector<HTMLElement>("#movie_player, ytd-player, #player");
  return {
    id: `youtube-watch-${index}`,
    kind: video ? "video" : "embedded-player",
    label: documentTitle(doc) || "YouTube video",
    currentTime: finiteOrUndefined(video?.currentTime),
    duration: finiteOrUndefined(video?.duration),
    width: finiteOrUndefined(video?.videoWidth || player?.clientWidth),
    height: finiteOrUndefined(video?.videoHeight || player?.clientHeight),
    hasCaptions: Boolean(doc.querySelector(".ytp-subtitles-button, track[kind='captions'], track[kind='subtitles']")),
    source: doc.location?.href,
    platform: "youtube",
    isPlaying: video ? isMediaPlaying(video) : false,
    isFocused: false
  };
}

function mediaItemScore(doc: Document, item: DetectedMedia): number {
  const element = doc.querySelector<HTMLVideoElement | HTMLAudioElement>(`[data-describeops-media-id="${item.id}"]`);
  if (element) return mediaScore(element);
  let value = item.kind === "audio" ? -5_000_000 : 0;
  if (item.kind === "embedded-player") value -= 2_000_000;
  if (item.isPlaying) value += 8_000_000;
  value += (item.width ?? 300) * (item.height ?? 150);
  return value;
}

function mediaScore(element: HTMLVideoElement | HTMLAudioElement): number {
  let value = element instanceof HTMLVideoElement ? 0 : -5_000_000;
  if (isMediaPlaying(element)) value += 8_000_000;
  if (isInViewport(element)) value += 1_000_000;
  const rect = element.getBoundingClientRect?.();
  value += rect ? rect.width * rect.height : 0;
  return value;
}

function isMediaPlaying(element: HTMLVideoElement | HTMLAudioElement): boolean {
  return !element.paused && !element.ended && element.readyState > 2 && element.currentTime > 0;
}

function isPlayableMediaElement(element: HTMLVideoElement | HTMLAudioElement): boolean {
  if (!isElementVisible(element)) return false;
  if (element instanceof HTMLAudioElement) return Boolean(element.controls || element.currentSrc || element.getAttribute("src"));
  const width = finiteOrUndefined(element.videoWidth || element.clientWidth || element.getAttribute("width")) ?? 0;
  const height = finiteOrUndefined(element.videoHeight || element.clientHeight || element.getAttribute("height")) ?? 0;
  return !(width > 0 && height > 0 && width * height < TINY_VIDEO_AREA);
}

function isElementVisible(element: Element | null): boolean {
  if (!element) return false;
  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(htmlElement);
  return style ? style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" : true;
}

function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width * rect.height === 0) return false;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const verticalOverlap = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  const horizontalOverlap = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
  return verticalOverlap > rect.height * 0.35 && horizontalOverlap > rect.width * 0.35;
}

function isNoiseText(value: string): boolean {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return value.length < 12 && !/\s/.test(value);
}

function isInteractiveChrome(element: Element | null): boolean {
  let current: Element | null = element;
  let depth = 0;
  while (current && depth < 4) {
    const tag = current.tagName?.toLowerCase();
    if (tag === "button" || tag === "a" || tag === "nav") return true;
    const role = current.getAttribute?.("role");
    if (role && ["button", "navigation", "link", "menu", "menuitem", "tab"].includes(role)) return true;
    current = current.parentElement;
    depth += 1;
  }
  return false;
}

function looksLikeEmbeddedPlayer(frame: HTMLIFrameElement): boolean {
  const value = `${frame.src} ${frame.title} ${frame.getAttribute("aria-label") ?? ""}`.toLowerCase();
  return /youtube|vimeo|player|video|wistia|brightcove|kaltura|panopto|iframe/.test(value);
}

function accessibleName(element: Element): string {
  return element.getAttribute("aria-label") || element.getAttribute("title") || firstText(element);
}

function firstText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function metaContent(doc: Document, selector: string): string {
  return doc.querySelector<HTMLMetaElement>(selector)?.content?.trim() ?? "";
}

function finiteOrUndefined(value: unknown): number | undefined {
  const numberValue = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
