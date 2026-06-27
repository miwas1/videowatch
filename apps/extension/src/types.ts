export type VideoPlatform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "twitter"
  | "facebook"
  | "vimeo"
  | "twitch"
  | "generic";

export type DetectedMedia = {
  id: string;
  kind: "video" | "audio" | "embedded-player";
  label: string;
  currentTime?: number;
  duration?: number;
  width?: number;
  height?: number;
  hasCaptions: boolean;
  source?: string;
  platform: VideoPlatform;
  isFocused: boolean;
  isPlaying: boolean;
};

export type PageAccessibilitySnapshot = {
  url: string;
  title: string;
  media: DetectedMedia[];
  headings: string[];
  visibleText: string[];
  transcriptText: string[];
  captions: string[];
  liveCaptionText: string[];
  platform: VideoPlatform;
};

export type CapturedFrame = {
  mediaId: string;
  timestampSeconds: number;
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  isFallback: boolean;
  note: string;
};

export type CapturedAudioChunk = {
  mediaId: string;
  startSeconds: number;
  endSeconds: number;
  dataUrl: string;
  mimeType: "audio/webm" | "video/webm" | "audio/ogg" | "audio/mpeg" | "audio/mp4" | "audio/wav";
  byteSize: number;
  note: string;
};

export type CaptureDetail = "media" | "captions" | "context";
export type ScreenshotFallback = "cropped" | "off";

export type ExtensionSettings = {
  apiBaseUrl: string;
  apiToken: string;
  chunkSeconds: number;
  framesPerChunk: number;
  autoCapture: boolean;
  captureDetail: CaptureDetail;
  screenshotFallback: ScreenshotFallback;
};

export type SessionResponse = {
  id: string;
  source_url: string;
  title: string;
  page_title: string;
  status: "created" | "processing" | "ready" | "failed" | string;
  duration_seconds: number | null;
  settings: Record<string, unknown>;
  error_message: string;
  created_at: string;
  updated_at: string;
};

export type ReadingBlock = {
  id: string;
  chunk_id: string;
  order: number;
  kind: string;
  heading: string;
  body: string;
  start_seconds: number;
  end_seconds: number;
  source_evidence: unknown[];
  confidence: number;
  is_user_edited: boolean;
};

export type TimelineMoment = {
  id: string;
  chunk_id: string;
  timestamp_seconds: number;
  label: string;
  detail: string;
  importance: number;
};

export type ChunkResponse = {
  id: string;
  session_id: string;
  chunk_index: number;
  start_seconds: number;
  end_seconds: number;
  transcript_text: string;
  capture_notes: string;
  status: "accepted" | "analyzing" | "ready" | "failed" | string;
  error_message: string;
  frame_count: number;
  latency_ms: number | null;
  blocks: ReadingBlock[];
  timeline: TimelineMoment[];
};

export type ChunkSummary = {
  id: string;
  chunk_index: number;
  start_seconds: number;
  end_seconds: number;
  status: "accepted" | "analyzing" | "ready" | "failed" | string;
  error_message: string;
  frame_count: number;
  block_count: number;
  latency_ms: number | null;
};

export type ReadingDocumentResponse = {
  session: SessionResponse;
  blocks: ReadingBlock[];
  timeline: TimelineMoment[];
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  qwen_configured: boolean;
  visual_model: string;
  text_model: string;
  final_model: string;
  deployment: string;
};

export type ReviewCue = {
  id: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
  status: "accepted" | "edited";
};

export type CapturedRange = {
  start: number;
  end: number;
  chunkIndex: number;
};

export type TranscriptResponse = {
  url: string;
  video_id: string;
  title: string;
  duration_seconds: number | null;
  segments: { start: number; end: number; text: string }[];
  full_text: string;
  segment_count: number;
};

export type ArtifactResponse = {
  id: string;
  artifact_type: string;
  workflow_template: string;
  title: string;
  summary: string;
  markdown: string;
  payload: {
    sections?: { heading: string; body: string; start_seconds: number; end_seconds: number; kind: string }[];
    synthesis?: unknown;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
};

export type SynthesisResponse = {
  title?: string;
  sections?: { heading: string; body: string; start_seconds: number; end_seconds: number; kind: string }[];
  summary?: string;
  skipped?: boolean;
  artifact?: ArtifactResponse;
};

export type PanelStage = "idle" | "scan" | "session" | "capture" | "upload" | "review" | "error";

export type RuntimeResponse<T> =
  | { ok: true; payload: T }
  | { ok: false; message: string; diagnostics?: string };
