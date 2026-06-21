from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from ninja import File, Form, NinjaAPI, Status
from ninja.files import UploadedFile
from ninja.security import APIKeyHeader

from reader.models import ReadingBlock, TimelineMoment, UserCorrection, VideoChunk, VideoSession
from reader.schemas import (
    ChunkResponse,
    CorrectionRequest,
    CorrectionResponse,
    ErrorResponse,
    ReadingBlockResponse,
    ReadingDocumentResponse,
    SessionCreateRequest,
    SessionResponse,
    TimelineMomentResponse,
    TranscriptRequest,
)
from reader.services.agents import AgentSocietyRunner
from reader.services.events import emit_event
from reader.services.export import export_reading_document_markdown
from reader.services.qwen import QwenConfigurationError, QwenResponseError
from reader.services.storage import FrameValidationError, save_uploaded_frame
from reader.services.transcript import fetch_transcript_for_url


class ExtensionTokenAuth(APIKeyHeader):
    param_name = "X-DescribeOps-Token"

    def authenticate(self, request: HttpRequest, key: str | None) -> str | None:
        configured = settings.DESCRIBEOPS_API_TOKEN
        if configured and key == configured:
            return key
        if is_debug_automatic_extension_request(request):
            return "debug-extension"
        if settings.DEBUG and not configured:
            return "debug"
        return None


def is_debug_automatic_extension_request(request: HttpRequest) -> bool:
    if not settings.DEBUG or not settings.DESCRIBEOPS_ALLOW_DEBUG_EXTENSION_AUTH:
        return False

    origin = request.headers.get("Origin", "")
    if origin.startswith("chrome-extension://"):
        return True

    host = request.get_host().split(":", 1)[0]
    return host in {"127.0.0.1", "localhost", "testserver"}


api = NinjaAPI(
    title="DescribeOps Video Reading API",
    version="0.1.0",
    description="Turns extension-captured video context into context-preserving reading documents.",
    auth=ExtensionTokenAuth(),
)


def block_schema(block: ReadingBlock) -> ReadingBlockResponse:
    return ReadingBlockResponse(
        id=block.id,
        chunk_id=block.chunk_id,
        order=block.order,
        kind=block.kind,
        heading=block.heading,
        body=block.body,
        start_seconds=block.start_seconds,
        end_seconds=block.end_seconds,
        source_evidence=block.source_evidence,
        confidence=block.confidence,
        is_user_edited=block.is_user_edited,
    )


def timeline_schema(moment: TimelineMoment) -> TimelineMomentResponse:
    return TimelineMomentResponse(
        id=moment.id,
        chunk_id=moment.chunk_id,
        timestamp_seconds=moment.timestamp_seconds,
        label=moment.label,
        detail=moment.detail,
        importance=moment.importance,
    )


def session_schema(session: VideoSession) -> SessionResponse:
    return SessionResponse(
        id=session.id,
        source_url=session.source_url,
        title=session.title,
        page_title=session.page_title,
        status=session.status,
        duration_seconds=session.duration_seconds,
        settings=session.settings,
        error_message=session.error_message,
        created_at=session.created_at,
        updated_at=session.updated_at,
    )


def chunk_schema(chunk: VideoChunk) -> ChunkResponse:
    return ChunkResponse(
        id=chunk.id,
        session_id=chunk.session_id,
        chunk_index=chunk.chunk_index,
        start_seconds=chunk.start_seconds,
        end_seconds=chunk.end_seconds,
        transcript_text=chunk.transcript_text,
        capture_notes=chunk.capture_notes,
        status=chunk.status,
        error_message=chunk.error_message,
        frame_count=chunk.frames.count(),
        latency_ms=chunk.latency_ms,
        blocks=[block_schema(block) for block in chunk.reading_blocks.all()],
        timeline=[timeline_schema(moment) for moment in chunk.timeline_moments.all()],
    )


@api.get("/health", auth=None)
def health(request: HttpRequest) -> dict[str, Any]:
    return {
        "ok": True,
        "service": "describeops-backend",
        "qwen_configured": bool(settings.DASHSCOPE_API_KEY),
        "visual_model": settings.QWEN_VISUAL_MODEL,
        "text_model": settings.QWEN_TEXT_MODEL,
        "final_model": settings.QWEN_FINAL_MODEL,
        "deployment": settings.ALIBABA_CLOUD_DEPLOYMENT if hasattr(settings, "ALIBABA_CLOUD_DEPLOYMENT") else "local",
    }


@api.post("/api/v1/sessions", response={201: SessionResponse})
def create_session(request: HttpRequest, payload: SessionCreateRequest) -> Status:
    session = VideoSession.objects.create(
        source_url=payload.source_url,
        title=payload.title,
        page_title=payload.page_title,
        duration_seconds=payload.duration_seconds,
        settings=payload.settings,
    )
    emit_event(session, "session.created", {"session_id": str(session.id)})
    return Status(201, session_schema(session))


@api.get("/api/v1/sessions/{session_id}", response=SessionResponse)
def get_session(request: HttpRequest, session_id: UUID) -> SessionResponse:
    return session_schema(get_object_or_404(VideoSession, id=session_id))


@api.post("/api/v1/sessions/{session_id}/chunks", response={201: ChunkResponse, 400: ErrorResponse, 502: ErrorResponse})
def upload_chunk(
    request: HttpRequest,
    session_id: UUID,
    chunk_index: int = Form(...),
    start_seconds: float = Form(...),
    end_seconds: float = Form(...),
    transcript_text: str = Form(""),
    capture_notes: str = Form(""),
    process_now: bool = Form(True),
    frames: list[UploadedFile] = File(...),
) -> Status:
    session = get_object_or_404(VideoSession, id=session_id)
    if end_seconds <= start_seconds:
        return Status(400, ErrorResponse(detail="end_seconds must be greater than start_seconds."))
    if not frames:
        return Status(400, ErrorResponse(detail="At least one captured frame is required."))
    if len(frames) > settings.DESCRIBEOPS_MAX_FRAMES_PER_CHUNK:
        return Status(400, ErrorResponse(detail=f"At most {settings.DESCRIBEOPS_MAX_FRAMES_PER_CHUNK} frames are allowed per chunk."))

    with transaction.atomic():
        chunk, _created = VideoChunk.objects.update_or_create(
            session=session,
            chunk_index=chunk_index,
            defaults={
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "transcript_text": transcript_text,
                "capture_notes": capture_notes,
                "status": VideoChunk.Status.ACCEPTED,
                "error_message": "",
            },
        )
        chunk.frames.all().delete()
        try:
            for frame in frames:
                save_uploaded_frame(chunk, frame)
        except FrameValidationError as exc:
            transaction.set_rollback(True)
            return Status(400, ErrorResponse(detail=str(exc)))
        session.status = VideoSession.Status.PROCESSING
        session.save(update_fields=["status", "updated_at"])
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

    if process_now:
        try:
            AgentSocietyRunner().process_chunk(chunk)
        except (QwenConfigurationError, QwenResponseError) as exc:
            chunk.status = VideoChunk.Status.FAILED
            chunk.error_message = str(exc)
            chunk.save(update_fields=["status", "error_message", "updated_at"])
            session.status = VideoSession.Status.FAILED
            session.error_message = str(exc)
            session.save(update_fields=["status", "error_message", "updated_at"])
            emit_event(session, "session.error", {"chunk_id": str(chunk.id), "detail": str(exc)})
            return Status(502, ErrorResponse(detail=str(exc)))
    return Status(201, chunk_schema(VideoChunk.objects.get(id=chunk.id)))


@api.get("/api/v1/sessions/{session_id}/document", response=ReadingDocumentResponse)
def get_document(request: HttpRequest, session_id: UUID) -> ReadingDocumentResponse:
    session = get_object_or_404(VideoSession, id=session_id)
    return ReadingDocumentResponse(
        session=session_schema(session),
        blocks=[block_schema(block) for block in session.reading_blocks.select_related("chunk").all()],
        timeline=[timeline_schema(moment) for moment in session.timeline_moments.select_related("chunk").all()],
    )


@api.get("/api/v1/sessions/{session_id}/timeline", response=list[TimelineMomentResponse])
def get_timeline(request: HttpRequest, session_id: UUID) -> list[TimelineMomentResponse]:
    session = get_object_or_404(VideoSession, id=session_id)
    return [timeline_schema(moment) for moment in session.timeline_moments.select_related("chunk").all()]


@api.patch("/api/v1/reading-blocks/{block_id}", response=CorrectionResponse)
def correct_block(request: HttpRequest, block_id: UUID, payload: CorrectionRequest) -> CorrectionResponse:
    block = get_object_or_404(ReadingBlock, id=block_id)
    previous = block.body
    block.body = payload.body
    block.is_user_edited = True
    block.save(update_fields=["body", "is_user_edited", "updated_at"])
    UserCorrection.objects.create(block=block, previous_body=previous, corrected_body=payload.body, note=payload.note)
    emit_event(block.session, "block.corrected", {"block_id": str(block.id), "chunk_id": str(block.chunk_id)})
    return CorrectionResponse(block=block_schema(block))


@api.get("/api/v1/sessions/{session_id}/events")
def stream_events(request: HttpRequest, session_id: UUID, after: int = 0) -> StreamingHttpResponse:
    session = get_object_or_404(VideoSession, id=session_id)

    def event_iter():
        for event in session.events.filter(id__gt=after).order_by("id"):
            payload = {"id": event.id, "type": event.event_type, "payload": event.payload}
            yield f"id: {event.id}\nevent: {event.event_type}\ndata: {json.dumps(payload)}\n\n"

    response = StreamingHttpResponse(event_iter(), content_type="text/event-stream")
    response["Cache-Control"] = "no-cache"
    return response


@api.post("/api/v1/sessions/{session_id}/chunks/async", response={202: dict, 400: ErrorResponse})
def upload_chunk_async(
    request: HttpRequest,
    session_id: UUID,
    chunk_index: int = Form(...),
    start_seconds: float = Form(...),
    end_seconds: float = Form(...),
    transcript_text: str = Form(""),
    capture_notes: str = Form(""),
    frames: list[UploadedFile] = File(...),
) -> Status:
    session = get_object_or_404(VideoSession, id=session_id)
    if end_seconds <= start_seconds:
        return Status(400, ErrorResponse(detail="end_seconds must be greater than start_seconds."))
    if not frames:
        return Status(400, ErrorResponse(detail="At least one captured frame is required."))
    if len(frames) > settings.DESCRIBEOPS_MAX_FRAMES_PER_CHUNK:
        return Status(400, ErrorResponse(detail=f"At most {settings.DESCRIBEOPS_MAX_FRAMES_PER_CHUNK} frames are allowed per chunk."))

    with transaction.atomic():
        chunk, _created = VideoChunk.objects.update_or_create(
            session=session,
            chunk_index=chunk_index,
            defaults={
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "transcript_text": transcript_text,
                "capture_notes": capture_notes,
                "status": VideoChunk.Status.ACCEPTED,
                "error_message": "",
            },
        )
        chunk.frames.all().delete()
        try:
            for frame in frames:
                save_uploaded_frame(chunk, frame)
        except FrameValidationError as exc:
            transaction.set_rollback(True)
            return Status(400, ErrorResponse(detail=str(exc)))
        session.status = VideoSession.Status.PROCESSING
        session.save(update_fields=["status", "updated_at"])
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

    import threading
    def _process():
        try:
            AgentSocietyRunner().process_chunk(chunk)
        except (QwenConfigurationError, QwenResponseError) as exc:
            chunk.status = VideoChunk.Status.FAILED
            chunk.error_message = str(exc)
            chunk.save(update_fields=["status", "error_message", "updated_at"])
            session.status = VideoSession.Status.FAILED
            session.error_message = str(exc)
            session.save(update_fields=["status", "error_message", "updated_at"])
            emit_event(session, "session.error", {"chunk_id": str(chunk.id), "detail": str(exc)})

    threading.Thread(target=_process, daemon=True).start()
    return Status(202, {"chunk_id": str(chunk.id), "status": "accepted", "message": "Processing in background."})


@api.post("/api/v1/sessions/{session_id}/synthesize", response={200: dict, 400: ErrorResponse})
def synthesize_session(request: HttpRequest, session_id: UUID) -> Status:
    session = get_object_or_404(VideoSession, id=session_id)
    ready_chunks = session.chunks.filter(status="ready").count()
    if ready_chunks == 0:
        return Status(400, ErrorResponse(detail="No ready chunks to synthesize."))
    try:
        result = AgentSocietyRunner().synthesize_session(session)
        return Status(200, result)
    except (QwenConfigurationError, QwenResponseError) as exc:
        return Status(502, ErrorResponse(detail=str(exc)))


@api.get("/api/v1/sessions/{session_id}/export/markdown")
def export_markdown(request: HttpRequest, session_id: UUID) -> HttpResponse:
    session = get_object_or_404(VideoSession, id=session_id)
    markdown = export_reading_document_markdown(session)
    response = HttpResponse(markdown, content_type="text/markdown; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{session.title or session_id}.md"'
    return response


@api.post("/api/v1/transcript", response={200: dict, 400: ErrorResponse})
def get_transcript(request: HttpRequest, payload: TranscriptRequest) -> Status:
    if not payload.url:
        return Status(400, ErrorResponse(detail="url is required."))
    try:
        result = fetch_transcript_for_url(payload.url)
        return Status(200, result)
    except Exception as exc:
        return Status(400, ErrorResponse(detail=str(exc)))
