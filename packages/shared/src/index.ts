import { z } from "zod";

export const EventNames = [
  "PAGE_SCAN_REQUESTED",
  "PAGE_SCAN_COMPLETED",
  "MEDIA_CAPTURE_REQUESTED",
  "AD_JOB_CREATED",
  "REVIEW_SEGMENT_UPDATED",
  "PLAYBACK_SYNC_CHANGED"
] as const;

export const DetectedMediaSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["video", "audio", "embedded-player"]),
  label: z.string().min(1),
  currentTime: z.number().nonnegative().optional(),
  duration: z.number().nonnegative().optional(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  hasCaptions: z.boolean(),
  source: z.string().optional()
});

export const InaccessibleRegionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["canvas", "iframe", "unknown"]),
  label: z.string(),
  reason: z.string().min(1)
});

export const PageAccessibilitySnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  media: z.array(DetectedMediaSchema),
  headings: z.array(z.string()),
  landmarks: z.array(z.string()),
  visibleText: z.array(z.string()),
  transcriptText: z.array(z.string()),
  captions: z.array(z.string()),
  inaccessibleRegions: z.array(InaccessibleRegionSchema)
});

export const VideoFrameSampleSchema = z.object({
  id: z.string().min(1),
  timestamp: z.number().nonnegative(),
  sourcePath: z.string().min(1),
  perceptualHash: z.string().optional(),
  ocrText: z.array(z.string()).default([])
});

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string().min(1),
  speaker: z.string().optional()
}).refine((segment) => segment.end >= segment.start, {
  message: "Transcript segment end must be greater than or equal to start"
});

export const SceneObservationSchema = z.object({
  id: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  uncertainty: z.array(z.string()).default([])
});

export const AudioDescriptionCueSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
  notes: z.string().optional()
}).refine((cue) => cue.end >= cue.start, {
  message: "Audio description cue end must be greater than or equal to start"
});

export const SpeechGapSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative()
}).refine((gap) => gap.end >= gap.start, {
  message: "Speech gap end must be greater than or equal to start"
});

export const MemoryPreferenceSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(["user", "org", "job"]),
  subjectId: z.string().min(1),
  kind: z.enum([
    "voice_style",
    "org_standard",
    "glossary",
    "pronunciation",
    "reviewer_correction",
    "ignored_preference",
    "content_fact"
  ]),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  sourceJobId: z.string().min(1),
  reviewerId: z.string().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional()
});

export const ReviewCueSchema = z.object({
  id: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean().default(true),
  notes: z.string().optional(),
  impact: z.enum(["low", "medium", "high"]),
  qaWarnings: z.array(z.string()).default([]),
  status: z.enum(["needs_review", "accepted", "rejected", "edited"]),
  rememberable: z.boolean().default(false)
}).refine((cue) => cue.end >= cue.start, {
  message: "Review cue end must be greater than or equal to start"
});

export const PlaybackPackageSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  mediaId: z.string().min(1),
  cues: z.array(ReviewCueSchema),
  speechGaps: z.array(SpeechGapSchema),
  audioTrackUrl: z.string().min(1).optional(),
  offlineAvailable: z.boolean(),
  ducking: z.object({
    enabled: z.boolean(),
    level: z.number().min(0).max(1)
  })
});

export const ExportArtifactSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  kind: z.enum(["webvtt", "json", "mp3", "wav", "qa_report", "offline_package"]),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  offlineAvailable: z.boolean()
});

export const OfflineQueueItemSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  action: z.enum(["create_job", "sync_review", "render_tts", "publish_artifacts"]),
  status: z.enum(["queued", "syncing", "failed", "complete"]),
  createdAt: z.string().datetime(),
  retryCount: z.number().int().nonnegative(),
  payloadSummary: z.string().min(1),
  lastError: z.string().optional()
});

export const EvidenceBundleSchema = z.object({
  jobId: z.string().min(1),
  mode: z.enum(["standard", "low_bandwidth"]),
  page: PageAccessibilitySnapshotSchema,
  frames: z.array(VideoFrameSampleSchema),
  transcript: z.array(TranscriptSegmentSchema),
  observations: z.array(SceneObservationSchema),
  speechGaps: z.array(SpeechGapSchema),
  cues: z.array(AudioDescriptionCueSchema).default([]),
  memoryConstraints: z.array(z.string()).default([]),
  uncertainty: z.array(z.string()).default([]),
  privacy: z.object({
    redactedFields: z.array(z.string())
  })
});

const BaseEventSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime()
});

export const DescribeOpsEventSchema = z.discriminatedUnion("name", [
  BaseEventSchema.extend({
    name: z.literal("PAGE_SCAN_REQUESTED"),
    payload: z.object({ tabId: z.number().int().optional() }).default({})
  }),
  BaseEventSchema.extend({
    name: z.literal("PAGE_SCAN_COMPLETED"),
    payload: PageAccessibilitySnapshotSchema
  }),
  BaseEventSchema.extend({
    name: z.literal("MEDIA_CAPTURE_REQUESTED"),
    payload: z.object({
      mediaId: z.string().min(1),
      consentConfirmed: z.boolean()
    })
  }),
  BaseEventSchema.extend({
    name: z.literal("AD_JOB_CREATED"),
    payload: z.object({
      jobId: z.string().min(1),
      mediaId: z.string().min(1),
      status: z.enum(["queued", "running", "needs_review", "complete", "failed"])
    })
  }),
  BaseEventSchema.extend({
    name: z.literal("REVIEW_SEGMENT_UPDATED"),
    payload: z.object({
      jobId: z.string().min(1),
      segmentId: z.string().min(1),
      text: z.string(),
      confidence: z.number().min(0).max(1),
      notes: z.string().optional()
    })
  }),
  BaseEventSchema.extend({
    name: z.literal("PLAYBACK_SYNC_CHANGED"),
    payload: z.object({
      mediaId: z.string().min(1),
      currentTime: z.number().nonnegative(),
      playing: z.boolean()
    })
  })
]);

export type EventName = (typeof EventNames)[number];
export type DetectedMedia = z.infer<typeof DetectedMediaSchema>;
export type InaccessibleRegion = z.infer<typeof InaccessibleRegionSchema>;
export type PageAccessibilitySnapshot = z.infer<typeof PageAccessibilitySnapshotSchema>;
export type VideoFrameSample = z.infer<typeof VideoFrameSampleSchema>;
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type SceneObservation = z.infer<typeof SceneObservationSchema>;
export type AudioDescriptionCue = z.infer<typeof AudioDescriptionCueSchema>;
export type SpeechGap = z.infer<typeof SpeechGapSchema>;
export type MemoryPreference = z.infer<typeof MemoryPreferenceSchema>;
export type ReviewCue = z.infer<typeof ReviewCueSchema>;
export type PlaybackPackage = z.infer<typeof PlaybackPackageSchema>;
export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;
export type OfflineQueueItem = z.infer<typeof OfflineQueueItemSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export type DescribeOpsEvent = z.infer<typeof DescribeOpsEventSchema>;

export type MemoryRetrievalContext = {
  userId?: string;
  orgId?: string;
  jobId?: string;
  now?: string;
  maxItems?: number;
  minConfidence?: number;
};

export function retrieveMemoryForContext(
  memories: MemoryPreference[],
  context: MemoryRetrievalContext
): MemoryPreference[] {
  const nowMs = Date.parse(context.now ?? new Date().toISOString());
  const minConfidence = context.minConfidence ?? 0.7;
  const maxItems = context.maxItems ?? 6;

  return memories
    .filter((memory) => {
      if (memory.deletedAt) {
        return false;
      }
      if (memory.expiresAt && Date.parse(memory.expiresAt) <= nowMs) {
        return false;
      }
      if (memory.confidence < minConfidence) {
        return false;
      }
      if (memory.kind === "content_fact" && memory.scope !== "job") {
        return false;
      }
      if (memory.scope === "user") {
        return memory.subjectId === context.userId;
      }
      if (memory.scope === "org") {
        return memory.subjectId === context.orgId;
      }
      if (memory.scope === "job") {
        return memory.subjectId === context.jobId;
      }
      return false;
    })
    .sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    })
    .slice(0, maxItems);
}

export function createEvent<T extends DescribeOpsEvent["name"]>(
  name: T,
  payload: Extract<DescribeOpsEvent, { name: T }>["payload"]
): Extract<DescribeOpsEvent, { name: T }> {
  return DescribeOpsEventSchema.parse({
    id: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    payload
  }) as Extract<DescribeOpsEvent, { name: T }>;
}
