import type { DetectedMedia, MediaAnalysisRequest, MediaSourceKind, PageAccessibilitySnapshot } from "@describeops/shared";
import type { AccessibilityOptions, DescriptionLevel } from "./cues";

export type VideoAnalysisRequest = MediaAnalysisRequest;

export type OnDemandQuestionRequest = {
  question: string;
  currentTime: number;
  contextWindow: {
    start: number;
    end: number;
  };
};

export type AnalysisMode = "DIRECT_VIDEO" | "TAB_CAPTURE" | "FRAME_SAMPLING";

export function buildVideoAnalysisRequest(
  snapshot: PageAccessibilitySnapshot,
  media: DetectedMedia,
  detailLevel: DescriptionLevel,
  options: AccessibilityOptions,
  frameSamples: string[] = []
): VideoAnalysisRequest {
  return {
    mediaId: media.id,
    sourceKind: chooseMediaSourceKind(media),
    videoUrl: media.source || undefined,
    pageUrl: snapshot.url,
    title: media.label || snapshot.title,
    duration: media.duration ?? 0,
    currentTime: media.currentTime ?? 0,
    platform: media.platform,
    detailLevel,
    features: {
      ocr: options.readOnScreenText,
      avoidDialogue: options.avoidDialogue,
      audioDescription: options.describeActions
    },
    frameSamples
  };
}

export function chooseAnalysisMode(media: DetectedMedia | undefined): AnalysisMode {
  if (!media) return "TAB_CAPTURE";
  if (media.kind === "embedded-player") return "TAB_CAPTURE";
  if (!media.source) return "TAB_CAPTURE";
  return "DIRECT_VIDEO";
}

export function chooseMediaSourceKind(media: DetectedMedia | undefined): MediaSourceKind {
  if (!media) return "page_snapshot";
  if (media.kind === "embedded-player") return "embedded_player";
  if (media.source) return "direct_url";
  return "tab_capture";
}

export function buildQuestionRequest(currentTime: number, question = "What just happened?"): OnDemandQuestionRequest {
  return {
    question,
    currentTime,
    contextWindow: {
      start: Math.max(0, currentTime - 10),
      end: currentTime
    }
  };
}

export function noVideoState() {
  return {
    errorState: "NO_VIDEO_FOUND" as const,
    backendCalls: 0,
    message: "No playable video found."
  };
}

export function analysisFailedState() {
  return {
    status: "Analysis failed. Try again.",
    retryVisible: true
  };
}
