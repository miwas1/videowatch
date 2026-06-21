from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from ninja import Schema


class ErrorResponse(Schema):
    detail: str


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
    duration_seconds: float | None
    settings: dict[str, Any]
    error_message: str
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
    chunk_seconds: int = 30
    frame_count: int = 4
    frame_width: int = 640
    max_height: int = 360

