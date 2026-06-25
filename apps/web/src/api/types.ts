export type SessionStatus = "created" | "processing" | "ready" | "failed";
export type ChunkStatus = "accepted" | "analyzing" | "ready" | "failed";

export type SessionListItem = {
  id: string;
  source_url: string;
  title: string;
  page_title: string;
  status: SessionStatus;
  pipeline_stage: string;
  duration_seconds: number | null;
  workflow_template: string;
  chunk_count: number;
  ready_chunk_count: number;
  failed_chunk_count: number;
  artifact_count: number;
  expected_chunk_count: number | null;
  created_at: string;
  updated_at: string;
};

export type Session = {
  id: string;
  source_url: string;
  title: string;
  page_title: string;
  status: SessionStatus;
  pipeline_stage: string;
  expected_chunk_count: number | null;
  duration_seconds: number | null;
  settings: Record<string, unknown>;
  error_message: string;
  synthesis_error: string;
  created_at: string;
  updated_at: string;
};

export type SessionProgress = {
  session_id: string;
  status: SessionStatus;
  step: string;
  percent: number;
  total_chunks: number;
  ready_chunks: number;
  failed_chunks: number;
  artifact_ready: boolean;
  artifact_required: boolean;
  last_event_type: string;
  error_message: string;
  synthesis_error: string;
  ingest_error_code: string;
};

export type ChunkSummary = {
  id: string;
  chunk_index: number;
  start_seconds: number;
  end_seconds: number;
  status: ChunkStatus;
  error_message: string;
  frame_count: number;
  block_count: number;
  latency_ms: number | null;
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

export type ReadingDocument = {
  session: Session;
  blocks: ReadingBlock[];
  timeline: TimelineMoment[];
};

export type Artifact = {
  id: string;
  artifact_type: string;
  workflow_template: string;
  title: string;
  summary: string;
  markdown: string;
  payload: {
    sections?: ArtifactSection[];
    synthesis?: Record<string, unknown>;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
};

export type ArtifactSection = {
  heading: string;
  body: string;
  start_seconds: number;
  end_seconds: number;
  kind: string;
};

export type IngestResponse = {
  session_id: string;
  status: string;
  message: string;
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
