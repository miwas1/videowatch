import { describe, expect, it } from "vitest";
import type { DetectedMedia, PageAccessibilitySnapshot } from "@describeops/shared";
import { buildCaptureReviewCues, buildFallbackReviewCues } from "./cues";

const media: DetectedMedia = {
  id: "video-0",
  kind: "video",
  label: "Fixture video",
  currentTime: 4,
  duration: 60,
  width: 320,
  height: 180,
  hasCaptions: true,
  source: "fixture.mp4",
  platform: "generic",
  isSocial: false,
  isFocused: true,
  isPlaying: true
};

const snapshot: PageAccessibilitySnapshot = {
  url: "https://example.test/video",
  title: "Training Fixture",
  media: [media],
  headings: ["Training Fixture"],
  landmarks: ["Training fixture"],
  visibleText: ["Training Fixture", "Cook for two minutes on each side."],
  transcriptText: ["Now add the milk to the flour."],
  captions: ["English"],
  liveCaptionText: [],
  platform: "generic",
  inaccessibleRegions: []
};

describe("buildFallbackReviewCues", () => {
  it("builds timed accepted cues from detected video evidence", () => {
    const cues = buildFallbackReviewCues(snapshot, media, "balanced", {
      readOnScreenText: true,
      describeActions: true,
      avoidDialogue: true
    });

    expect(cues).toHaveLength(3);
    expect(cues[0]).toMatchObject({
      id: "local-cue-1",
      start: 5,
      status: "accepted",
      impact: "high"
    });
    expect(cues.map((cue) => cue.text).join(" ")).toContain("Text on screen");
  });

  it("keeps minimal descriptions short", () => {
    const cues = buildFallbackReviewCues(snapshot, media, "minimal");

    expect(cues).toHaveLength(2);
  });

  it("builds cues from tab capture evidence", () => {
    const cues = buildCaptureReviewCues(snapshot, {
      sampleCount: 2,
      speechGaps: [{ start: 0.5, end: 1.5 }],
      samples: [
        { timestamp: 0, luminance: 120, audioLevel: 0.02, width: 1280, height: 720 },
        { timestamp: 0.5, luminance: 130, audioLevel: 0.04, width: 1280, height: 720 }
      ]
    }, "balanced");

    expect(cues[0]).toMatchObject({
      id: "capture-cue-1",
      start: 0.5,
      status: "accepted"
    });
    expect(cues.map((cue) => cue.text).join(" ")).toContain("tab capture");
  });
});
