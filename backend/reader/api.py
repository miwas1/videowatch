from __future__ import annotations

import json
import math
import tempfile
import threading
from pathlib import Path
from typing import Any
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Q
from django.http import FileResponse, HttpRequest, HttpResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from ninja import File, Form, NinjaAPI, Status
from ninja.files import UploadedFile
from ninja.security import APIKeyHeader

from reader.models import FrameAsset, GeneratedArtifact, ReadingBlock, TimelineMoment, UserCorrection, VideoChunk, VideoSession
from reader.schemas import (
    ArtifactRegenerateRequest,
    ArtifactResponse,
    ChunkResponse,
    ChunkSummaryResponse,
    CorrectionRequest,
    CorrectionResponse,
    ErrorResponse,
    ReadingBlockResponse,
    ReadingDocumentResponse,
    RetrySynthesisRequest,
    SessionCreateRequest,
    SessionListItemResponse,
    SessionProgressResponse,
    SessionResponse,
    TimelineMomentResponse,
    TranscriptRequest,
    UrlProcessRequest,
)
from reader.services.agents import AgentSocietyRunner
from reader.services.artifact_builder import build_artifact_from_session, normalize_workflow_targets
from reader.services.events import emit_event
from reader.services.export import export_reading_document_markdown
from reader.services.qwen import QwenConfigurationError, QwenResponseError
from reader.services.storage import FrameValidationError, save_uploaded_frame
from reader.services.media_ingest import (
    attach_frame_file,
    download_youtube_video,
    extract_frames_for_chunk,
    probe_duration,
    timed_transcript_from_vtt,
    transcript_for_range,
)
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


def mark_session_ready_when_current_chunks_ready(session: VideoSession) -> None:
    if session.chunks.exists() and not session.chunks.exclude(status=VideoChunk.Status.READY).exists():
        session.status = VideoSession.Status.READY
        session.pipeline_stage = VideoSession.PipelineStage.READY
        session.error_message = ""
        session.save(update_fields=["status", "pipeline_stage", "error_message", "updated_at"])
        emit_event(session, "session.ready", {"session_id": str(session.id)})


def fail_session(session: VideoSession, detail: str, *, synthesis: bool = False) -> None:
    session.status = VideoSession.Status.FAILED
    session.pipeline_stage = VideoSession.PipelineStage.FAILED
    session.error_message = detail
    if synthesis:
        session.synthesis_error = detail
    session.save(update_fields=["status", "pipeline_stage", "error_message", "synthesis_error", "updated_at"])
    emit_event(session, "session.error", {"session_id": str(session.id), "detail": detail})


def artifact_schema(artifact: GeneratedArtifact) -> ArtifactResponse:
    return ArtifactResponse(
        id=artifact.id,
        artifact_type=artifact.artifact_type,
        workflow_template=artifact.workflow_template,
        title=artifact.title,
        summary=artifact.summary,
        markdown=artifact.markdown,
        payload=artifact.payload,
        created_at=artifact.created_at,
        updated_at=artifact.updated_at,
    )


def synthesize_artifacts(session: VideoSession, workflow_targets: list[str]) -> None:
    session.status = VideoSession.Status.PROCESSING
    session.pipeline_stage = VideoSession.PipelineStage.SYNTHESIZING
    session.error_message = ""
    session.synthesis_error = ""
    session.save(update_fields=["status", "pipeline_stage", "error_message", "synthesis_error", "updated_at"])

    runner = AgentSocietyRunner()
    for workflow_template in workflow_targets:
        session.pipeline_stage = VideoSession.PipelineStage.SYNTHESIZING
        session.save(update_fields=["pipeline_stage", "updated_at"])
        synthesis_result = runner.synthesize_session(session, workflow_template=workflow_template)
        session.pipeline_stage = VideoSession.PipelineStage.BUILDING_ARTIFACTS
        session.save(update_fields=["pipeline_stage", "updated_at"])
        build_artifact_from_session(
            session,
            workflow_template=workflow_template,
            synthesis_result=synthesis_result,
        )
        emit_event(
            session,
            "artifact.ready",
            {"session_id": str(session.id), "workflow_template": workflow_template},
        )

    session.status = VideoSession.Status.READY
    session.pipeline_stage = VideoSession.PipelineStage.READY
    session.error_message = ""
    session.synthesis_error = ""
    session.save(update_fields=["status", "pipeline_stage", "error_message", "synthesis_error", "updated_at"])
    emit_event(session, "session.ready", {"session_id": str(session.id)})


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
        pipeline_stage=session.pipeline_stage,
        expected_chunk_count=session.expected_chunk_count,
        duration_seconds=session.duration_seconds,
        settings=session.settings,
        error_message=session.error_message,
        synthesis_error=session.synthesis_error,
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


def chunk_schema_prefetched(chunk: VideoChunk) -> ChunkResponse:
    """Use when chunk already has prefetched frames/reading_blocks/timeline_moments."""
    frames = chunk.frames.all() if hasattr(chunk, "_prefetched_objects_cache") and "frames" in chunk._prefetched_objects_cache else chunk.frames.all()
    blocks = chunk.reading_blocks.all() if hasattr(chunk, "_prefetched_objects_cache") and "reading_blocks" in chunk._prefetched_objects_cache else chunk.reading_blocks.all()
    moments = chunk.timeline_moments.all() if hasattr(chunk, "_prefetched_objects_cache") and "timeline_moments" in chunk._prefetched_objects_cache else chunk.timeline_moments.all()
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
        frame_count=len(frames) if hasattr(frames, '__len__') else frames.count(),
        latency_ms=chunk.latency_ms,
        blocks=[block_schema(block) for block in blocks],
        timeline=[timeline_schema(moment) for moment in moments],
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


@api.get("/api/v1/sessions", response=list[SessionListItemResponse])
def list_sessions(request: HttpRequest, limit: int = 20, offset: int = 0) -> list[SessionListItemResponse]:
    sessions = (
        VideoSession.objects.annotate(
            chunk_count=Count("chunks"),
            ready_chunk_count=Count("chunks", filter=Q(chunks__status=VideoChunk.Status.READY)),
            failed_chunk_count=Count("chunks", filter=Q(chunks__status=VideoChunk.Status.FAILED)),
            artifact_count=Count("artifacts"),
        )[offset : offset + limit]
    )
    return [
        SessionListItemResponse(
            id=s.id,
            source_url=s.source_url,
            title=s.title,
            page_title=s.page_title,
            status=s.status,
            pipeline_stage=s.pipeline_stage,
            duration_seconds=s.duration_seconds,
            workflow_template=s.settings.get("workflow_template", "reading_document"),
            chunk_count=s.chunk_count,
            ready_chunk_count=s.ready_chunk_count,
            failed_chunk_count=s.failed_chunk_count,
            artifact_count=s.artifact_count,
            expected_chunk_count=s.expected_chunk_count,
            created_at=s.created_at,
            updated_at=s.updated_at,
        )
        for s in sessions
    ]


@api.get("/api/v1/sessions/{session_id}", response=SessionResponse)
def get_session(request: HttpRequest, session_id: UUID) -> SessionResponse:
    return session_schema(get_object_or_404(VideoSession, id=session_id))


@api.get("/api/v1/sessions/{session_id}/progress", response=SessionProgressResponse)
def get_session_progress(request: HttpRequest, session_id: UUID) -> SessionProgressResponse:
    session = get_object_or_404(VideoSession, id=session_id)
    chunk_stats = session.chunks.aggregate(
        total=Count("id"),
        ready=Count("id", filter=Q(status=VideoChunk.Status.READY)),
        failed=Count("id", filter=Q(status=VideoChunk.Status.FAILED)),
    )
    total = session.expected_chunk_count or chunk_stats["total"]
    ready = chunk_stats["ready"]
    failed = chunk_stats["failed"]
    artifact_ready = session.artifacts.exists()

    artifact_required = bool(session.settings.get("auto_synthesize", False))
    stage = session.pipeline_stage
    if stage == VideoSession.PipelineStage.CREATED:
        step, percent = "created", 0
    elif stage == VideoSession.PipelineStage.DOWNLOADING:
        step, percent = "downloading", 5
    elif stage == VideoSession.PipelineStage.ANALYZING:
        step = "analyzing"
        percent = 10 + int((ready / total * 75) if total else 0)
    elif stage == VideoSession.PipelineStage.SYNTHESIZING:
        step, percent = "synthesizing", 88
    elif stage == VideoSession.PipelineStage.BUILDING_ARTIFACTS:
        step, percent = "building_artifacts", 96
    elif stage == VideoSession.PipelineStage.READY:
        step, percent = "ready", 100
    else:
        step, percent = "failed", 0

    last_event = session.events.order_by("-id").first()
    return SessionProgressResponse(
        session_id=session.id,
        status=session.status,
        step=step,
        percent=percent,
        total_chunks=total,
        ready_chunks=ready,
        failed_chunks=failed,
        artifact_ready=artifact_ready,
        artifact_required=artifact_required,
        last_event_type=last_event.event_type if last_event else "",
        error_message=session.error_message,
        synthesis_error=session.synthesis_error,
    )


@api.get("/api/v1/sessions/{session_id}/chunks", response=list[ChunkSummaryResponse])
def list_session_chunks(request: HttpRequest, session_id: UUID) -> list[ChunkSummaryResponse]:
    session = get_object_or_404(VideoSession, id=session_id)
    chunks = session.chunks.annotate(
        frame_count=Count("frames"),
        block_count=Count("reading_blocks"),
    )
    return [
        ChunkSummaryResponse(
            id=c.id,
            chunk_index=c.chunk_index,
            start_seconds=c.start_seconds,
            end_seconds=c.end_seconds,
            status=c.status,
            error_message=c.error_message,
            frame_count=c.frame_count,
            block_count=c.block_count,
            latency_ms=c.latency_ms,
        )
        for c in chunks
    ]


@api.get("/api/v1/sessions/{session_id}/artifacts", response=list[ArtifactResponse])
def list_artifacts(request: HttpRequest, session_id: UUID) -> list[ArtifactResponse]:
    session = get_object_or_404(VideoSession, id=session_id)
    return [artifact_schema(artifact) for artifact in session.artifacts.all()]


@api.post("/api/v1/sessions/{session_id}/artifacts", response={201: ArtifactResponse, 400: ErrorResponse, 502: ErrorResponse})
def regenerate_artifact(request: HttpRequest, session_id: UUID, payload: ArtifactRegenerateRequest) -> Status:
    session = get_object_or_404(VideoSession, id=session_id)
    if session.status != VideoSession.Status.READY:
        return Status(400, ErrorResponse(detail="Session is not ready for artifact generation."))
    try:
        workflow_template = normalize_workflow_targets(payload.workflow_template or payload.artifact_type)[0]
        synthesis_result = AgentSocietyRunner().synthesize_session(session, workflow_template=workflow_template)
        artifact = build_artifact_from_session(
            session,
            workflow_template=workflow_template,
            synthesis_result=synthesis_result,
        )
        return Status(201, artifact_schema(artifact))
    except ValueError as exc:
        return Status(400, ErrorResponse(detail=str(exc)))
    except (QwenConfigurationError, QwenResponseError) as exc:
        return Status(502, ErrorResponse(detail=str(exc)))


@api.post("/api/v1/sessions/{session_id}/retry-synthesis", response={202: dict, 400: ErrorResponse})
def retry_synthesis(request: HttpRequest, session_id: UUID, payload: RetrySynthesisRequest) -> Status:
    session = get_object_or_404(VideoSession, id=session_id)
    if not session.chunks.exists() or session.chunks.exclude(status=VideoChunk.Status.READY).exists():
        return Status(400, ErrorResponse(detail="All chunks must be ready before synthesis can be retried."))
    try:
        workflow_targets = normalize_workflow_targets(payload.workflow_template, payload.output_targets)
    except ValueError as exc:
        return Status(400, ErrorResponse(detail=str(exc)))

    session.settings = {
        **session.settings,
        "workflow_template": payload.workflow_template,
        "output_targets": workflow_targets,
        "auto_synthesize": True,
    }
    session.save(update_fields=["settings", "updated_at"])

    def _retry() -> None:
        from django.db import connection
        try:
            synthesize_artifacts(session, workflow_targets)
        except Exception as exc:
            fail_session(session, str(exc), synthesis=True)
        finally:
            connection.close()

    threading.Thread(target=_retry, daemon=True).start()
    return Status(202, {"session_id": str(session.id), "status": "processing", "message": "Synthesis retry started."})


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
        session.pipeline_stage = VideoSession.PipelineStage.ANALYZING
        session.save(update_fields=["status", "pipeline_stage", "updated_at"])
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

    if process_now:
        try:
            AgentSocietyRunner().process_chunk(chunk)
            mark_session_ready_when_current_chunks_ready(session)
        except (QwenConfigurationError, QwenResponseError) as exc:
            chunk.status = VideoChunk.Status.FAILED
            chunk.error_message = str(exc)
            chunk.save(update_fields=["status", "error_message", "updated_at"])
            fail_session(session, str(exc))
            return Status(502, ErrorResponse(detail=str(exc)))
    fresh_chunk = VideoChunk.objects.prefetch_related("frames", "reading_blocks", "timeline_moments").get(id=chunk.id)
    return Status(201, chunk_schema_prefetched(fresh_chunk))


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
        session.pipeline_stage = VideoSession.PipelineStage.ANALYZING
        session.save(update_fields=["status", "pipeline_stage", "updated_at"])
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

    def _process():
        from django.db import connection
        try:
            AgentSocietyRunner().process_chunk(chunk)
            mark_session_ready_when_current_chunks_ready(session)
        except (QwenConfigurationError, QwenResponseError) as exc:
            chunk.status = VideoChunk.Status.FAILED
            chunk.error_message = str(exc)
            chunk.save(update_fields=["status", "error_message", "updated_at"])
            fail_session(session, str(exc))
        finally:
            connection.close()

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


@api.get("/api/v1/frames/{frame_id}")
def get_frame(request: HttpRequest, frame_id: UUID) -> FileResponse:
    frame = get_object_or_404(FrameAsset, id=frame_id)
    return FileResponse(frame.file.open("rb"), content_type=frame.mime_type)


@api.post("/api/v1/ingest/from-url", response={202: dict, 400: ErrorResponse})
def create_session_from_url(request: HttpRequest, payload: UrlProcessRequest) -> Status:
    if not payload.url:
        return Status(400, ErrorResponse(detail="url is required."))
    try:
        workflow_targets = normalize_workflow_targets(payload.workflow_template, payload.output_targets)
    except ValueError as exc:
        return Status(400, ErrorResponse(detail=str(exc)))

    session = VideoSession.objects.create(
        source_url=payload.url,
        status=VideoSession.Status.PROCESSING,
        pipeline_stage=VideoSession.PipelineStage.DOWNLOADING,
        settings={
            "chunk_seconds": payload.chunk_seconds,
            "frame_count": payload.frame_count,
            "frame_width": payload.frame_width,
            "max_height": payload.max_height,
            "workflow_template": payload.workflow_template,
            "auto_synthesize": payload.auto_synthesize,
            "output_targets": workflow_targets,
        },
    )
    emit_event(session, "session.created", {"session_id": str(session.id)})

    def _process():
        from django.db import connection
        try:
            with tempfile.TemporaryDirectory(prefix="describeops-ingest-") as tmp:
                work_dir = Path(tmp)
                download = download_youtube_video(payload.url, work_dir, max_height=payload.max_height)
                duration = float(download.metadata.get("duration_seconds") or probe_duration(download.video_path))
                expected_chunks = max(1, math.ceil(duration / payload.chunk_seconds))
                session.title = download.metadata.get("title") or session.title
                session.page_title = session.title
                session.duration_seconds = duration
                session.expected_chunk_count = expected_chunks
                session.pipeline_stage = VideoSession.PipelineStage.ANALYZING
                session.save(
                    update_fields=[
                        "title",
                        "page_title",
                        "duration_seconds",
                        "expected_chunk_count",
                        "pipeline_stage",
                        "updated_at",
                    ]
                )

                segments = timed_transcript_from_vtt(download.subtitle_paths)
                runner = AgentSocietyRunner()
                for chunk_index in range(expected_chunks):
                    start = chunk_index * payload.chunk_seconds
                    end = min(start + payload.chunk_seconds, duration)
                    chunk = VideoChunk.objects.create(
                        session=session,
                        chunk_index=chunk_index,
                        start_seconds=start,
                        end_seconds=end,
                        transcript_text=transcript_for_range(segments, start_seconds=start, end_seconds=end),
                        status=VideoChunk.Status.ACCEPTED,
                    )

                    frame_paths = extract_frames_for_chunk(
                        video_path=download.video_path,
                        output_dir=work_dir / f"frames-{chunk_index:05d}",
                        start_seconds=start,
                        end_seconds=end,
                        frame_count=payload.frame_count,
                        width=payload.frame_width,
                    )
                    for frame_path in frame_paths:
                        attach_frame_file(chunk, frame_path)
                    emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

                    try:
                        runner.process_chunk(chunk)
                    except (QwenConfigurationError, QwenResponseError) as exc:
                        chunk.status = VideoChunk.Status.FAILED
                        chunk.error_message = str(exc)
                        chunk.save(update_fields=["status", "error_message", "updated_at"])
                        emit_event(session, "chunk.error", {"chunk_id": str(chunk.id), "detail": str(exc)})

                if session.chunks.filter(status=VideoChunk.Status.FAILED).exists():
                    fail_session(session, "One or more chunks failed during ingestion.")
                    return

                if payload.auto_synthesize:
                    synthesize_artifacts(session, workflow_targets)
                else:
                    session.status = VideoSession.Status.READY
                    session.pipeline_stage = VideoSession.PipelineStage.READY
                    session.save(update_fields=["status", "pipeline_stage", "updated_at"])
                    emit_event(session, "session.ready", {"session_id": str(session.id)})
        except Exception as exc:
            fail_session(
                session,
                str(exc),
                synthesis=session.pipeline_stage in {
                    VideoSession.PipelineStage.SYNTHESIZING,
                    VideoSession.PipelineStage.BUILDING_ARTIFACTS,
                },
            )
        finally:
            connection.close()

    threading.Thread(target=_process, daemon=True).start()
    return Status(202, {"session_id": str(session.id), "status": "processing", "message": "Video ingestion started in background."})
