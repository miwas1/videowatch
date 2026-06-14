import { describe, expect, it } from "vitest";
import {
  ExportArtifactSchema,
  MemoryPreferenceSchema,
  PlaybackPackageSchema,
  ReviewCueSchema,
  retrieveMemoryForContext
} from "./index";

describe("phase 7 and 8 workflow contracts", () => {
  it("retrieves only scoped, active, high-confidence memories", () => {
    const now = "2026-06-13T12:00:00.000Z";
    const memories = [
      MemoryPreferenceSchema.parse({
        id: "mem_voice",
        scope: "user",
        subjectId: "user-1",
        kind: "voice_style",
        value: "Use present tense and plain language.",
        confidence: 0.91,
        sourceJobId: "job-a",
        reviewerId: "reviewer-1",
        createdAt: "2026-06-12T12:00:00.000Z"
      }),
      MemoryPreferenceSchema.parse({
        id: "mem_fact",
        scope: "job",
        subjectId: "job-a",
        kind: "content_fact",
        value: "The speaker wears a red jacket.",
        confidence: 0.99,
        sourceJobId: "job-a",
        createdAt: "2026-06-12T12:00:00.000Z"
      }),
      MemoryPreferenceSchema.parse({
        id: "mem_deleted",
        scope: "org",
        subjectId: "org-1",
        kind: "org_standard",
        value: "Spell out visual acronyms on first use.",
        confidence: 0.88,
        sourceJobId: "job-a",
        createdAt: "2026-06-12T12:00:00.000Z",
        deletedAt: "2026-06-13T08:00:00.000Z"
      }),
      MemoryPreferenceSchema.parse({
        id: "mem_expired",
        scope: "user",
        subjectId: "user-1",
        kind: "pronunciation",
        value: "Pronounce Qwen as kwen.",
        confidence: 0.9,
        sourceJobId: "job-a",
        createdAt: "2026-06-12T12:00:00.000Z",
        expiresAt: "2026-06-13T10:00:00.000Z"
      })
    ];

    const retrieved = retrieveMemoryForContext(memories, {
      userId: "user-1",
      orgId: "org-1",
      jobId: "job-b",
      now,
      maxItems: 5
    });

    expect(retrieved.map((memory) => memory.id)).toEqual(["mem_voice"]);
  });

  it("validates review cues, playback packages, and exports", () => {
    const reviewCue = ReviewCueSchema.parse({
      id: "cue-1",
      start: 2.5,
      end: 5,
      text: "A chart appears.",
      confidence: 0.62,
      impact: "high",
      qaWarnings: ["Missing chart label evidence."],
      status: "needs_review",
      notes: "Ask reviewer to confirm chart label.",
      rememberable: true
    });

    const playbackPackage = PlaybackPackageSchema.parse({
      id: "pkg-1",
      jobId: "job-1",
      mediaId: "video-1",
      cues: [reviewCue],
      speechGaps: [{ start: 2, end: 5.5 }],
      audioTrackUrl: "describeops://artifacts/job-1/ad.mp3",
      offlineAvailable: true,
      ducking: { enabled: true, level: 0.35 }
    });

    const artifact = ExportArtifactSchema.parse({
      id: "artifact-webvtt",
      jobId: "job-1",
      kind: "webvtt",
      filename: "job-1-descriptions.vtt",
      mimeType: "text/vtt",
      sizeBytes: 842,
      createdAt: "2026-06-13T12:00:00.000Z",
      offlineAvailable: true
    });

    expect(playbackPackage.cues[0].rememberable).toBe(true);
    expect(artifact.kind).toBe("webvtt");
  });
});
