import { describe, expect, it } from "vitest";
import {
  AudioDescriptionCueSchema,
  EvidenceBundleSchema,
  SceneObservationSchema,
  TranscriptSegmentSchema,
  VideoFrameSampleSchema
} from "./index";

describe("phase 5 evidence schemas", () => {
  it("validates frame, transcript, observation, cue, and evidence bundle contracts", () => {
    const frame = VideoFrameSampleSchema.parse({
      id: "frame-1",
      timestamp: 4.5,
      sourcePath: "/tmp/frame-1.jpg",
      ocrText: ["EXIT"]
    });
    const transcript = TranscriptSegmentSchema.parse({
      id: "tx-1",
      start: 0,
      end: 2,
      text: "Welcome."
    });
    const observation = SceneObservationSchema.parse({
      id: "obs-1",
      evidenceRefs: ["frame-1"],
      text: "Exit sign appears above the door.",
      confidence: 0.9
    });
    const cue = AudioDescriptionCueSchema.parse({
      id: "cue-1",
      start: 2.2,
      end: 4.2,
      text: "An exit sign appears above the door.",
      evidenceRefs: ["obs-1"],
      confidence: 0.82,
      needsReview: false
    });

    const bundle = EvidenceBundleSchema.parse({
      jobId: "job-1",
      mode: "standard",
      page: {
        url: "https://example.test",
        title: "Safety",
        media: [],
        headings: ["Safety"],
        landmarks: ["main"],
        visibleText: ["Safety"],
        transcriptText: [],
        captions: [],
        inaccessibleRegions: []
      },
      frames: [frame],
      transcript: [transcript],
      observations: [observation],
      speechGaps: [{ start: 2, end: 5 }],
      cues: [cue],
      memoryConstraints: ["Prefer short cues."],
      uncertainty: [],
      privacy: { redactedFields: ["cookies"] }
    });

    expect(bundle.frames[0].ocrText).toEqual(["EXIT"]);
    expect(bundle.cues[0].evidenceRefs).toEqual(["obs-1"]);
  });
});
