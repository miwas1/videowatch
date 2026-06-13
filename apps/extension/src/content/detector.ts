import type {
  DetectedMedia,
  InaccessibleRegion,
  PageAccessibilitySnapshot
} from "@describeops/shared";

const TEXT_LIMIT = 40;

export function scanDocument(doc: Document = document): PageAccessibilitySnapshot {
  return {
    url: doc.location?.href ?? "",
    title: documentTitle(doc),
    media: collectMedia(doc),
    headings: collectHeadings(doc),
    landmarks: collectLandmarks(doc),
    visibleText: collectVisibleText(doc),
    transcriptText: collectTranscriptText(doc),
    captions: collectCaptions(doc),
    inaccessibleRegions: collectInaccessibleRegions(doc)
  };
}

function collectMedia(doc: Document): DetectedMedia[] {
  const media: DetectedMedia[] = [];

  doc.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio").forEach((element, index) => {
    const kind = element instanceof HTMLAudioElement ? "audio" : "video";
    const source = element.currentSrc || element.querySelector("source")?.getAttribute("src") || undefined;
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
      source
    });
  });

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
        source: frame.src || undefined
      });
    }
  });

  const youtubeMedia = detectYouTubeWatchPage(doc, media.length);
  if (youtubeMedia && !media.some((item) => item.source === youtubeMedia.source)) {
    media.push(youtubeMedia);
  }

  return media;
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
    if (value && value.length > 2 && isElementVisible(node.parentElement)) {
      text.push(value);
    }
    node = walker.nextNode();
  }

  return unique(text);
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
    source: doc.location?.href
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
  return style ? style.display !== "none" && style.visibility !== "hidden" : true;
}

function looksLikeEmbeddedPlayer(frame: HTMLIFrameElement): boolean {
  const value = `${frame.src} ${frame.title} ${frame.getAttribute("aria-label") ?? ""}`.toLowerCase();
  return /youtube|vimeo|player|video|wistia|brightcove|kaltura|panopto|iframe/.test(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
