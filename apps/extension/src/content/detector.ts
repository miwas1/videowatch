import type {
  DetectedMedia,
  InaccessibleRegion,
  PageAccessibilitySnapshot
} from "@describeops/shared";

type VideoPlatform = DetectedMedia["platform"];

const TEXT_LIMIT = 40;
const TINY_VIDEO_AREA = 12_000;

// Boilerplate chrome that should never be spoken as a "description".
const NOISE_PATTERNS = [
  /^skip( to)?( main)?( navigation| content| to content)?$/i,
  /^(sign in|sign up|log in|log out|subscribe|share|save|more|menu|search|home|settings|help)$/i,
  /^(next|previous|play|pause|mute|unmute|like|dislike|comment|notifications?)$/i,
  /^(accept|reject|got it|ok|close|dismiss)( all)?( cookies?)?$/i,
  /cookie|consent|advertisement|^ad$|sponsored/i,
  /^\d+(\.\d+)?[KMB]?\s*(views?|likes?|subscribers?|comments?)$/i
];

const SOCIAL_PLATFORMS: ReadonlySet<VideoPlatform> = new Set([
  "tiktok",
  "instagram",
  "twitter",
  "facebook"
]);

export function scanDocument(doc: Document = document): PageAccessibilitySnapshot {
  const platform = detectPlatform(doc);
  return {
    url: doc.location?.href ?? "",
    title: documentTitle(doc),
    media: collectMedia(doc, platform),
    headings: collectHeadings(doc),
    landmarks: collectLandmarks(doc),
    visibleText: collectVisibleText(doc),
    transcriptText: collectTranscriptText(doc),
    captions: collectCaptions(doc),
    liveCaptionText: collectLiveCaptionText(doc),
    platform,
    inaccessibleRegions: collectInaccessibleRegions(doc)
  };
}

function detectPlatform(doc: Document): VideoPlatform {
  const host = doc.location?.hostname.toLowerCase() ?? "";
  if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") return "youtube";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return "twitter";
  if (/(^|\.)(facebook\.com|fb\.watch)$/.test(host)) return "facebook";
  if (/(^|\.)vimeo\.com$/.test(host)) return "vimeo";
  if (/(^|\.)twitch\.tv$/.test(host)) return "twitch";
  return "generic";
}

function collectMedia(doc: Document, platform: VideoPlatform): DetectedMedia[] {
  const media: DetectedMedia[] = [];
  const isSocial = SOCIAL_PLATFORMS.has(platform);

  doc.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio").forEach((element, index) => {
    if (!isPlayableMediaElement(element)) {
      return;
    }

    const kind = element instanceof HTMLAudioElement ? "audio" : "video";
    const source = element.currentSrc || element.getAttribute("src") || element.querySelector("source")?.getAttribute("src") || undefined;
    const tracks = Array.from(element.querySelectorAll("track"));

    media.push({
      id: `${kind}-${index}`,
      kind,
      label: accessibleName(element) || `${kind} ${index + 1}`,
      currentTime: finiteOrUndefined(element.currentTime),
      duration: finiteOrUndefined(element.duration),
      width: kind === "video" ? finiteOrUndefined((element as HTMLVideoElement).videoWidth || element.clientWidth || element.getAttribute("width")) : undefined,
      height: kind === "video" ? finiteOrUndefined((element as HTMLVideoElement).videoHeight || element.clientHeight || element.getAttribute("height")) : undefined,
      hasCaptions: tracks.some((track) => ["captions", "subtitles"].includes(track.kind)),
      source,
      platform,
      isSocial,
      isPlaying: isMediaPlaying(element),
      isFocused: false
    });
  });

  // Only surface iframe players when there is no directly attachable media,
  // because an <iframe> cannot be controlled or sampled from the content script.
  if (!media.some((item) => item.kind !== "audio")) {
    doc.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame, index) => {
      const title = frame.title || frame.getAttribute("aria-label") || frame.src || "Embedded player";
      if (looksLikeEmbeddedPlayer(frame)) {
        media.push({
          id: `embedded-player-${index}`,
          kind: "embedded-player",
          label: title,
          width: finiteOrUndefined(frame.width || frame.clientWidth),
          height: finiteOrUndefined(frame.height || frame.clientHeight),
          hasCaptions: false,
          source: frame.src || undefined,
          platform,
          isSocial,
          isPlaying: false,
          isFocused: false
        });
      }
    });
  }

  const youtubeMedia = detectYouTubeWatchPage(doc, media.length);
  if (youtubeMedia && !media.some((item) => item.source === youtubeMedia.source)) {
    media.push(youtubeMedia);
  }

  const ranked = rankMediaByFocus(doc, media);
  if (ranked.length) {
    ranked[0].isFocused = true;
  }
  return ranked;
}

function isMediaPlaying(element: HTMLVideoElement | HTMLAudioElement): boolean {
  return !element.paused && !element.ended && element.readyState > 2 && element.currentTime > 0;
}

// The video "in focus" is the one the user is actually watching: prefer a
// playing element, then the one most centered and largest in the viewport.
function rankMediaByFocus(doc: Document, media: DetectedMedia[]): DetectedMedia[] {
  const view = doc.defaultView;
  const viewportHeight = view?.innerHeight ?? 0;
  const viewportWidth = view?.innerWidth ?? 0;
  const elements = new Map<string, Element>();
  doc.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio").forEach((element, index) => {
    const kind = element instanceof HTMLAudioElement ? "audio" : "video";
    elements.set(`${kind}-${index}`, element);
  });

  const score = (item: DetectedMedia): number => {
    let value = 0;
    if (item.kind === "audio") value -= 5_000_000;
    if (item.kind === "embedded-player") value -= 2_000_000;
    if (item.isPlaying) value += 8_000_000;

    const element = elements.get(item.id);
    const rect = element?.getBoundingClientRect?.();
    if (rect && viewportHeight && viewportWidth && rect.width * rect.height > 0) {
      const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
      const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
      value += visibleHeight * visibleWidth;
      const viewportCenter = viewportHeight / 2;
      const elementCenter = rect.top + rect.height / 2;
      value -= Math.abs(elementCenter - viewportCenter);
    } else {
      value += area(item);
    }
    return value;
  };

  return media
    .map((item) => ({ item, value: score(item) }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.item);
}

function collectHeadings(doc: Document): string[] {
  return Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .map((heading) => firstText(heading))
    .filter(Boolean);
}

function collectLandmarks(doc: Document): string[] {
  const selectors = "main,nav,aside,header,footer,section,[role='main'],[role='navigation'],[role='complementary'],[role='banner'],[role='contentinfo'],[role='region']";
  return unique(
    Array.from(doc.querySelectorAll<HTMLElement>(selectors))
      .map((element) => element.getAttribute("aria-label") || element.getAttribute("role") || element.tagName.toLowerCase())
      .filter(Boolean)
  );
}

function collectVisibleText(doc: Document): string[] {
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
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

// Filters out navigation/control boilerplate so the assistant never speaks
// page chrome (e.g. "Skip navigation", "Subscribe") as a video description.
function isNoiseText(value: string): boolean {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // Single short tokens are almost always buttons or labels, not content.
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

// Live caption/subtitle text currently rendered over the player. This is the
// strongest signal for what the focused video is actually about right now.
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
    ).filter((value) => value && !isNoiseText(value))
  ).slice(0, 12);
}

function collectTranscriptText(doc: Document): string[] {
  const transcriptSelectors = [
    "[data-transcript]",
    "[aria-label*='transcript' i]",
    "[class*='transcript' i]",
    "track[kind='descriptions']"
  ];

  return unique(
    transcriptSelectors.flatMap((selector) =>
      Array.from(doc.querySelectorAll(selector)).map((element) => firstText(element) || element.getAttribute("label") || "")
    ).filter(Boolean)
  );
}

function collectCaptions(doc: Document): string[] {
  return unique(
    Array.from(doc.querySelectorAll<HTMLTrackElement>("track[kind='captions'],track[kind='subtitles']"))
      .map((track) => track.label || track.srclang || track.src)
      .filter(Boolean)
  );
}

function collectInaccessibleRegions(doc: Document): InaccessibleRegion[] {
  const regions: InaccessibleRegion[] = [];

  doc.querySelectorAll<HTMLCanvasElement>("canvas").forEach((canvas, index) => {
    regions.push({
      id: `canvas-${index}`,
      kind: "canvas",
      label: accessibleName(canvas) || `Canvas ${index + 1}`,
      reason: "needs visual sampling"
    });
  });

  doc.querySelectorAll<HTMLIFrameElement>("iframe").forEach((frame, index) => {
    if (!frame.title && !frame.getAttribute("aria-label")) {
      regions.push({
        id: `iframe-${index}`,
        kind: "iframe",
        label: frame.src || `Iframe ${index + 1}`,
        reason: "missing accessible frame label"
      });
    }
  });

  if (isYouTubeWatchPage(doc)) {
    regions.push({
      id: "youtube-player",
      kind: "unknown",
      label: documentTitle(doc),
      reason: "YouTube custom player needs browser visual sampling"
    });
  }

  return regions;
}

function documentTitle(doc: Document): string {
  return (
    doc.title?.replace(/\s+-\s+YouTube$/, "").trim() ||
    metaContent(doc, "meta[property='og:title']") ||
    metaContent(doc, "meta[name='title']") ||
    firstText(doc.querySelector("h1")) ||
    firstText(doc.querySelector("h1 yt-formatted-string")) ||
    firstText(doc.querySelector("#title h1")) ||
    "Untitled page"
  );
}

function detectYouTubeWatchPage(doc: Document, index: number): DetectedMedia | null {
  if (!isYouTubeWatchPage(doc)) return null;

  const video = doc.querySelector<HTMLVideoElement>("video.html5-main-video, video");
  const player = doc.querySelector<HTMLElement>("#movie_player, ytd-player, #player");
  const title = documentTitle(doc);

  return {
    id: `youtube-watch-${index}`,
    kind: "embedded-player",
    label: title === "Untitled page" ? "YouTube video" : title,
    currentTime: finiteOrUndefined(video?.currentTime),
    duration: finiteOrUndefined(video?.duration),
    width: finiteOrUndefined(video?.videoWidth || player?.clientWidth),
    height: finiteOrUndefined(video?.videoHeight || player?.clientHeight),
    hasCaptions: Boolean(
      doc.querySelector(".ytp-subtitles-button, track[kind='captions'], track[kind='subtitles']")
    ),
    source: doc.location?.href,
    platform: "youtube",
    isSocial: false,
    isPlaying: video ? isMediaPlaying(video) : false,
    isFocused: false
  };
}

function isYouTubeWatchPage(doc: Document): boolean {
  const host = doc.location?.hostname.toLowerCase() ?? "";
  return (
    (/(^|\.)youtube\.com$/.test(host) && doc.location?.pathname === "/watch") ||
    Boolean(doc.querySelector("ytd-watch-flexy, #movie_player.ytd-player, ytd-player #movie_player"))
  );
}

function metaContent(doc: Document, selector: string): string {
  return doc.querySelector<HTMLMetaElement>(selector)?.content?.trim() ?? "";
}

function accessibleName(element: Element): string {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("alt") ||
    firstText(element)
  );
}

function firstText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function finiteOrUndefined(value: unknown): number | undefined {
  const numberValue = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function isElementVisible(element: Element | null): boolean {
  if (!element) return false;
  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(htmlElement);
  return style ? style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" : true;
}

function isPlayableMediaElement(element: HTMLVideoElement | HTMLAudioElement): boolean {
  if (!isElementVisible(element)) return false;
  if (element instanceof HTMLAudioElement) return Boolean(element.controls || element.currentSrc || element.getAttribute("src"));

  const width = finiteOrUndefined(element.videoWidth || element.clientWidth || element.getAttribute("width")) ?? 0;
  const height = finiteOrUndefined(element.videoHeight || element.clientHeight || element.getAttribute("height")) ?? 0;
  const hasExplicitTinySize = width > 0 && height > 0 && width * height < TINY_VIDEO_AREA;
  if (hasExplicitTinySize) return false;

  return !element.hasAttribute("disabled");
}

function area(item: DetectedMedia): number {
  return (item.width ?? 300) * (item.height ?? 150);
}

function looksLikeEmbeddedPlayer(frame: HTMLIFrameElement): boolean {
  const value = `${frame.src} ${frame.title} ${frame.getAttribute("aria-label") ?? ""}`.toLowerCase();
  return /youtube|vimeo|player|video|wistia|brightcove|kaltura|panopto|iframe/.test(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
