from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from ninja import Schema
from pydantic import Field


class ErrorResponse(Schema):
    detail: str


class AuthRequest(Schema):
    email: str
    password: str


class AuthUserResponse(Schema):
    id: int
    email: str


class AuthResponse(Schema):
    token: str
    user: AuthUserResponse


class SessionCreateRequest(Schema):
    source_url: str = ""
    title: str = ""
    page_title: str = ""
    duration_seconds: float | None = None
    settings: dict[str, Any] = {}


class SessionResponse(Schema):
    id: UUID
    source_url: str
    title: str
    page_title: str
    status: str
    pipeline_stage: str
    expected_chunk_count: int | None
    duration_seconds: float | None
    settings: dict[str, Any]
    error_message: str
    synthesis_error: str
    created_at: datetime
    updated_at: datetime


class ReadingBlockResponse(Schema):
    id: UUID
    chunk_id: UUID
    order: int
    kind: str
    heading: str
    body: str
    start_seconds: float
    end_seconds: float
    source_evidence: list[Any]
    confidence: float
    is_user_edited: bool


class TimelineMomentResponse(Schema):
    id: UUID
    chunk_id: UUID
    timestamp_seconds: float
    label: str
    detail: str
    importance: int


class AgentRunResponse(Schema):
    id: UUID
    role: str
    model: str
    confidence: float
    latency_ms: int
    request_id: str
    output: dict[str, Any]


class ChunkResponse(Schema):
    id: UUID
    session_id: UUID
    chunk_index: int
    start_seconds: float
    end_seconds: float
    transcript_text: str
    capture_notes: str
    status: str
    error_message: str
    frame_count: int
    latency_ms: int | None
    blocks: list[ReadingBlockResponse]
    timeline: list[TimelineMomentResponse]


class ReadingDocumentResponse(Schema):
    session: SessionResponse
    blocks: list[ReadingBlockResponse]
    timeline: list[TimelineMomentResponse]


class CorrectionRequest(Schema):
    body: str
    note: str = ""

class CorrectionResponse(Schema):
    block: ReadingBlockResponse


class TranscriptRequest(Schema):
    url: str


class UrlProcessRequest(Schema):
    url: str
    chunk_seconds: int = Field(default=30, ge=5, le=300)
    frame_count: int = Field(default=4, ge=1, le=12)
    frame_width: int = Field(default=640, ge=320, le=1920)
    max_height: int = Field(default=360, ge=144, le=1080)
    workflow_template: str = "reading_document"
    auto_synthesize: bool = True
    output_targets: list[str] = Field(default_factory=list)


class SessionListItemResponse(Schema):
    id: UUID
    source_url: str
    title: str
    page_title: str
    status: str
    pipeline_stage: str
    duration_seconds: float | None
    workflow_template: str
    chunk_count: int
    ready_chunk_count: int
    failed_chunk_count: int
    artifact_count: int
    expected_chunk_count: int | None
    created_at: datetime
    updated_at: datetime


class ChunkSummaryResponse(Schema):
    id: UUID
    chunk_index: int
    start_seconds: float
    end_seconds: float
    status: str
    error_message: str
    frame_count: int
    block_count: int
    latency_ms: int | None


class SessionProgressResponse(Schema):
    session_id: UUID
    status: str
    step: str
    percent: int
    total_chunks: int
    ready_chunks: int
    failed_chunks: int
    artifact_ready: bool
    artifact_required: bool
    last_event_type: str
    error_message: str
    synthesis_error: str
    ingest_error_code: str = ""


class ArtifactResponse(Schema):
    id: UUID
    artifact_type: str
    workflow_template: str
    title: str
    summary: str
    markdown: str
    payload: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class ArtifactRegenerateRequest(Schema):
    workflow_template: str = ""
    artifact_type: str = "reading_document"


class RetrySynthesisRequest(Schema):
    workflow_template: str = "reading_document"
    output_targets: list[str] = Field(default_factory=list)
