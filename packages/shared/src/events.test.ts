import { describe, expect, it } from "vitest";
import {
  DescribeOpsEventSchema,
  EventNames,
  PageAccessibilitySnapshotSchema
} from "./index";

describe("shared event contracts", () => {
  it("accepts the required Phase 2 event names", () => {
    expect(EventNames).toEqual([
      "PAGE_SCAN_REQUESTED",
      "PAGE_SCAN_COMPLETED",
      "MEDIA_CAPTURE_REQUESTED",
      "AD_JOB_CREATED",
      "REVIEW_SEGMENT_UPDATED",
      "PLAYBACK_SYNC_CHANGED"
    ]);
  });

  it("validates a completed page scan payload with media and readable text", () => {
    const parsed = DescribeOpsEventSchema.parse({
      id: "evt_scan_1",
      name: "PAGE_SCAN_COMPLETED",
      createdAt: "2026-06-12T22:00:00.000Z",
      payload: {
        url: "https://example.test/lesson",
        title: "Accessible Biology Lesson",
        media: [
          {
            id: "video-0",
            kind: "video",
            label: "Lecture video",
            currentTime: 4,
            duration: 60,
            width: 1280,
            height: 720,
            hasCaptions: true,
            source: "blob:https://example.test/media"
          }
        ],
        headings: ["Chapter 1"],
        landmarks: ["main"],
        visibleText: ["Chapter 1", "Cell structure overview"],
        transcriptText: ["Welcome to the lesson"],
        captions: ["English"],
        inaccessibleRegions: []
      }
    });

    expect(parsed.name).toBe("PAGE_SCAN_COMPLETED");
  });

  it("requires page snapshots to include scan evidence arrays", () => {
    expect(() =>
      PageAccessibilitySnapshotSchema.parse({
        url: "https://example.test",
        title: "Missing evidence"
      })
    ).toThrow();
  });
});
