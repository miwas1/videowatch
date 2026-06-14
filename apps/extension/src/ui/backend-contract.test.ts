import { describe, expect, it } from "vitest";
import type { DetectedMedia, PageAccessibilitySnapshot } from "@describeops/shared";
import {
  analysisFailedState,
  buildQuestionRequest,
  buildVideoAnalysisRequest,
  chooseAnalysisMode,
  chooseMediaSourceKind,
  noVideoState
} from "./backend-contract";

const media: DetectedMedia = {
  id: "video-0",
  kind: "video",
  label: "Demo Video",
  currentTime: 0,
  duration: 120,
  width: 1280,
  height: 720,
  hasCaptions: true,
  source: "https://example.com/demo.mp4",
  platform: "generic",
  isSocial: false,
  isFocused: true,
  isPlaying: true
};

const snapshot: PageAccessibilitySnapshot = {
  url: "https://example.com/watch",
  title: "Demo Video",
  media: [media],
  headings: ["Demo Video"],
  landmarks: ["main"],
  visibleText: ["private unrelated page note"],
  transcriptText: ["Today we are making pancakes."],
  captions: ["English"],
  liveCaptionText: [],
  platform: "generic",
  inaccessibleRegions: []
};

describe("backend request contract", () => {
  it("sends only the correct video analysis metadata and selected detail level", () => {
    const request = buildVideoAnalysisRequest(snapshot, media, "balanced", {
      readOnScreenText: true,
      describeActions: true,
      avoidDialogue: true
    });

    expect(request).toEqual({
      mediaId: "video-0",
      sourceKind: "direct_url",
      videoUrl: "https://example.com/demo.mp4",
      pageUrl: "https://example.com/watch",
      title: "Demo Video",
      duration: 120,
      currentTime: 0,
      platform: "generic",
      detailLevel: "balanced",
      features: {
        ocr: true,
        avoidDialogue: true,
        audioDescription: true
      },
      frameSamples: []
    });
    expect(JSON.stringify(request)).not.toContain("private unrelated page note");
  });

  it("switches to fallback mode when the video URL is unavailable", () => {
    expect(chooseAnalysisMode({ ...media, source: undefined })).toBe("TAB_CAPTURE");
    expect(chooseMediaSourceKind({ ...media, source: undefined })).toBe("tab_capture");
  });

  it("handles no video gracefully without backend calls", () => {
    expect(noVideoState()).toEqual({
      errorState: "NO_VIDEO_FOUND",
      backendCalls: 0,
      message: "No playable video found."
    });
  });

  it("uses current video time for What happened requests", () => {
    expect(buildQuestionRequest(45)).toEqual({
      question: "What just happened?",
      currentTime: 45,
      contextWindow: {
        start: 35,
        end: 45
      }
    });
  });

  it("exposes a retryable analysis failure state", () => {
    expect(analysisFailedState()).toEqual({
      status: "Analysis failed. Try again.",
      retryVisible: true
    });
  });
});
