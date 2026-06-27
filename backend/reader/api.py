from __future__ import annotations

import hashlib
import json
import math
import shutil
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.models import AbstractBaseUser
from django.db import transaction
from django.db.models import Count, Q
from django.core.files.storage import default_storage
from django.http import FileResponse, HttpRequest, HttpResponse, StreamingHttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, NinjaAPI, Status
from ninja.files import UploadedFile
from ninja.security import APIKeyHeader

from reader.models import CanonicalVideo, FrameAsset, GeneratedArtifact, ProcessingJob, ReadingBlock, StoredAsset, TimelineMoment, UserApiToken, UserCorrection, VideoChunk, VideoSession
from reader.schemas import (
    AuthRequest,
    AuthResponse,
    AuthUserResponse,
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
from reader.services.audio import enrich_chunk_with_audio_transcripts
from reader.services.artifact_builder import build_artifact_from_session, normalize_workflow_targets
from reader.services.events import emit_event
from reader.services.export import export_reading_document_markdown
from reader.services.jobs import JobCanceled, cancel_session_jobs, enqueue_job
from reader.services.qwen import QwenConfigurationError, QwenResponseError, stable_hash
from reader.services.storage import FrameValidationError, save_uploaded_audio_chunk, save_uploaded_frame
from reader.services.media_ingest import (
    ALLOWED_VIDEO_UPLOAD_EXTENSIONS,
    YouTubeAccessError,
    attach_frame_file,
    extract_frames_for_chunk,
    probe_duration,
    timed_transcript_from_vtt,
    transcript_for_range,
)
from reader.services.transcript import fetch_transcript_for_url


@dataclass(frozen=True)
class AuthContext:
    kind: str
    user: AbstractBaseUser | None = None
    token: UserApiToken | None = None


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_user_token(user: AbstractBaseUser) -> tuple[str, UserApiToken]:
    raw_token = secrets.token_urlsafe(32)
    token = UserApiToken.objects.create(user=user, token_hash=hash_token(raw_token))
    return raw_token, token


def auth_user_schema(user: AbstractBaseUser) -> AuthUserResponse:
    return AuthUserResponse(id=int(user.pk), email=str(getattr(user, "email", "")))


class ExtensionTokenAuth(APIKeyHeader):
    param_name = "X-DescribeOps-Token"

    def authenticate(self, request: HttpRequest, key: str | None) -> AuthContext | None:
        configured = settings.DESCRIBEOPS_API_TOKEN
        if configured and key == configured:
            return AuthContext(kind="service")
        if key:
            token = UserApiToken.objects.select_related("user").filter(token_hash=hash_token(key), revoked_at__isnull=True).first()
            if token:
                token.last_used_at = timezone.now()
                token.save(update_fields=["last_used_at"])
                return AuthContext(kind="user", user=token.user, token=token)
        if is_debug_automatic_extension_request(request):
            return AuthContext(kind="service")
        if is_trusted_extension_origin_request(request):
            return AuthContext(kind="service")
        if settings.DEBUG and not configured:
            return AuthContext(kind="service")
        return None


def is_trusted_extension_origin_request(request: HttpRequest) -> bool:
    return request.headers.get("Origin", "").startswith("chrome-extension://")


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


def current_user(request: HttpRequest) -> AbstractBaseUser | None:
    auth = request.auth
    return auth.user if isinstance(auth, AuthContext) and auth.kind == "user" else None


def scope_sessions(request: HttpRequest):
    user = current_user(request)
    queryset = VideoSession.objects.all()
    return queryset.filter(owner=user) if user else queryset


def video_fingerprint(*, source_url: str = "", title: str = "", duration_seconds: float | None = None, file_checksum: str = "") -> str:
    return stable_hash(
        {
            "source_url": source_url.strip().lower(),
            "title": title.strip().lower(),
            "duration_seconds": round(float(duration_seconds), 2) if duration_seconds is not None else None,
            "file_checksum": file_checksum,
        }
    )


def get_or_create_canonical_video(
    *,
    source_url: str = "",
    title: str = "",
    duration_seconds: float | None = None,
    file_checksum: str = "",
    metadata: dict[str, Any] | None = None,
) -> CanonicalVideo:
    fingerprint = video_fingerprint(
        source_url=source_url,
        title=title,
        duration_seconds=duration_seconds,
        file_checksum=file_checksum,
    )
    canonical, created = CanonicalVideo.objects.get_or_create(
        fingerprint=fingerprint,
        defaults={
            "canonical_url": source_url,
            "title": title,
            "duration_seconds": duration_seconds,
            "metadata": metadata or {},
        },
    )
    if not created:
        changed = False
        if title and not canonical.title:
            canonical.title = title
            changed = True
        if source_url and not canonical.canonical_url:
            canonical.canonical_url = source_url
            changed = True
        if duration_seconds and not canonical.duration_seconds:
            canonical.duration_seconds = duration_seconds
            changed = True
        if metadata:
            canonical.metadata = {**canonical.metadata, **metadata}
            changed = True
        if changed:
            canonical.save(update_fields=["title", "canonical_url", "duration_seconds", "metadata", "updated_at"])
    return canonical


def get_session_for_request(request: HttpRequest, session_id: UUID) -> VideoSession:
    return get_object_or_404(scope_sessions(request), id=session_id)


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


def fail_ingest_session(session: VideoSession, exc: Exception) -> None:
    settings_payload = dict(session.settings or {})
    if isinstance(exc, YouTubeAccessError):
        settings_payload["ingest_error_code"] = exc.code
        session.settings = settings_payload
        session.save(update_fields=["settings", "updated_at"])
    fail_session(session, str(exc))


def process_local_video_session(
    *,
    session: VideoSession,
    video_path: Path,
    metadata: dict[str, Any],
    subtitle_paths: list[Path],
    chunk_seconds: int,
    frame_count: int,
    frame_width: int,
    workflow_targets: list[str],
    auto_synthesize: bool,
    work_dir: Path,
) -> None:
    duration = float(metadata.get("duration_seconds") or probe_duration(video_path))
    canonical = get_or_create_canonical_video(
        source_url=str(metadata.get("webpage_url") or session.source_url),
        title=str(metadata.get("title") or session.title),
        duration_seconds=duration,
        file_checksum=str(metadata.get("file_checksum") or ""),
        metadata=metadata,
    )
    expected_chunks = max(1, math.ceil(duration / chunk_seconds))
    session.canonical_video = canonical
    session.source_fingerprint = canonical.fingerprint
    session.title = metadata.get("title") or session.title
    session.page_title = session.title
    session.duration_seconds = duration
    session.expected_chunk_count = expected_chunks
    session.pipeline_stage = VideoSession.PipelineStage.ANALYZING
    session.save(
        update_fields=[
            "title",
            "page_title",
            "canonical_video",
            "source_fingerprint",
            "duration_seconds",
            "expected_chunk_count",
            "pipeline_stage",
            "updated_at",
        ]
    )

    segments = timed_transcript_from_vtt(subtitle_paths)
    runner = AgentSocietyRunner()
    for chunk_index in range(expected_chunks):
        session.refresh_from_db(fields=["settings", "error_message"])
        if session.settings.get("cancel_requested"):
            raise JobCanceled(session.error_message or "Canceled by user.")
        start = chunk_index * chunk_seconds
        end = min(start + chunk_seconds, duration)
        chunk = VideoChunk.objects.create(
            session=session,
            chunk_index=chunk_index,
            start_seconds=start,
            end_seconds=end,
            transcript_text=transcript_for_range(segments, start_seconds=start, end_seconds=end),
            status=VideoChunk.Status.ACCEPTED,
        )

        frame_paths = extract_frames_for_chunk(
            video_path=video_path,
            output_dir=work_dir / f"frames-{chunk_index:05d}",
            start_seconds=start,
            end_seconds=end,
            frame_count=frame_count,
            width=frame_width,
        )
        for frame_path in frame_paths:
            attach_frame_file(chunk, frame_path)
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

        try:
            runner.process_chunk(chunk)
            session.refresh_from_db(fields=["settings", "error_message"])
            if session.settings.get("cancel_requested"):
                raise JobCanceled(session.error_message or "Canceled by user.")
        except (QwenConfigurationError, QwenResponseError) as exc:
            chunk.status = VideoChunk.Status.FAILED
            chunk.error_message = str(exc)
            chunk.save(update_fields=["status", "error_message", "updated_at"])
            emit_event(session, "chunk.error", {"chunk_id": str(chunk.id), "detail": str(exc)})

    if session.chunks.filter(status=VideoChunk.Status.FAILED).exists():
        fail_session(session, "One or more chunks failed during ingestion.")
        return

    if auto_synthesize:
        synthesize_artifacts(session, workflow_targets)
    else:
        session.status = VideoSession.Status.READY
        session.pipeline_stage = VideoSession.PipelineStage.READY
        session.save(update_fields=["status", "pipeline_stage", "updated_at"])
        emit_event(session, "session.ready", {"session_id": str(session.id)})


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


def reuse_canonical_artifacts_if_ready(session: VideoSession) -> bool:
    if not session.canonical_video_id:
        return False
    source_session = (
        session.canonical_video.sessions.exclude(id=session.id)
        .filter(status=VideoSession.Status.READY, artifacts__isnull=False)
        .order_by("-updated_at")
        .first()
    )
    if source_session is None:
        return False

    artifact_map: dict[str, GeneratedArtifact] = {}
    with transaction.atomic():
        for source_artifact in source_session.artifacts.all():
            artifact, _created = GeneratedArtifact.objects.update_or_create(
                session=session,
                workflow_template=source_artifact.workflow_template,
                defaults={
                    "artifact_type": source_artifact.artifact_type,
                    "title": source_artifact.title,
                    "summary": source_artifact.summary,
                    "markdown": source_artifact.markdown,
                    "payload": {
                        **(source_artifact.payload or {}),
                        "reused_from_session_id": str(source_session.id),
                    },
                },
            )
            artifact_map[source_artifact.workflow_template] = artifact

        reusable_assets = source_session.stored_assets.filter(
            asset_type__in=[StoredAsset.AssetType.FINAL_ARTIFACT, StoredAsset.AssetType.EVIDENCE_MANIFEST]
        ).select_related("artifact")
        for source_asset in reusable_assets:
            target_artifact = None
            if source_asset.artifact_id and source_asset.artifact:
                target_artifact = artifact_map.get(source_asset.artifact.workflow_template)
            StoredAsset.objects.create(
                canonical_video=session.canonical_video,
                session=session,
                artifact=target_artifact,
                asset_type=source_asset.asset_type,
                object_key=source_asset.object_key,
                storage_backend=source_asset.storage_backend,
                content_type=source_asset.content_type,
                checksum=source_asset.checksum,
                byte_size=source_asset.byte_size,
                metadata={
                    **(source_asset.metadata or {}),
                    "reused_from_session_id": str(source_session.id),
                    "reused_from_asset_id": str(source_asset.id),
                },
            )

        session.status = VideoSession.Status.READY
        session.pipeline_stage = VideoSession.PipelineStage.READY
        session.error_message = ""
        session.synthesis_error = ""
        session.save(update_fields=["status", "pipeline_stage", "error_message", "synthesis_error", "updated_at"])

    emit_event(session, "cache.hit", {"session_id": str(session.id), "source_session_id": str(source_session.id)})
    emit_event(session, "session.ready", {"session_id": str(session.id), "cache_hit": True})
    return True


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


@api.post("/api/v1/auth/register", auth=None, response={201: AuthResponse, 400: ErrorResponse})
def register(request: HttpRequest, payload: AuthRequest) -> Status:
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        return Status(400, ErrorResponse(detail="Enter a valid email address."))
    if len(payload.password) < 8:
        return Status(400, ErrorResponse(detail="Password must be at least 8 characters."))
    User = get_user_model()
    if User.objects.filter(email__iexact=email).exists() or User.objects.filter(username__iexact=email).exists():
        return Status(400, ErrorResponse(detail="An account with this email already exists."))
    user = User.objects.create_user(username=email, email=email, password=payload.password)
    raw_token, _token = issue_user_token(user)
    return Status(201, AuthResponse(token=raw_token, user=auth_user_schema(user)))


@api.post("/api/v1/auth/login", auth=None, response={200: AuthResponse, 400: ErrorResponse})
def login(request: HttpRequest, payload: AuthRequest) -> Status:
    email = payload.email.strip().lower()
    user = authenticate(request, username=email, password=payload.password)
    if user is None:
        return Status(400, ErrorResponse(detail="Invalid email or password."))
    raw_token, _token = issue_user_token(user)
    return Status(200, AuthResponse(token=raw_token, user=auth_user_schema(user)))


@api.get("/api/v1/auth/me", response=AuthUserResponse)
def me(request: HttpRequest) -> AuthUserResponse:
    user = current_user(request)
    if user is None:
        return AuthUserResponse(id=0, email="service")
    return auth_user_schema(user)


@api.post("/api/v1/auth/logout", response={200: dict})
def logout(request: HttpRequest) -> dict[str, str]:
    auth = request.auth
    if isinstance(auth, AuthContext) and auth.token:
        auth.token.revoked_at = timezone.now()
        auth.token.save(update_fields=["revoked_at"])
    return {"status": "logged_out"}


@api.post("/api/v1/sessions", response={201: SessionResponse})
def create_session(request: HttpRequest, payload: SessionCreateRequest) -> Status:
    title = payload.title or payload.page_title
    canonical = get_or_create_canonical_video(
        source_url=payload.source_url,
        title=title,
        duration_seconds=payload.duration_seconds,
        metadata={"source_type": "browser_extension", **(payload.settings or {})},
    )
    session = VideoSession.objects.create(
        owner=current_user(request),
        canonical_video=canonical,
        source_fingerprint=canonical.fingerprint,
        source_url=payload.source_url,
        title=payload.title,
        page_title=payload.page_title,
        duration_seconds=payload.duration_seconds,
        settings=payload.settings,
    )
    emit_event(session, "session.created", {"session_id": str(session.id)})
    reuse_canonical_artifacts_if_ready(session)
    return Status(201, session_schema(session))


@api.get("/api/v1/sessions", response=list[SessionListItemResponse])
def list_sessions(request: HttpRequest, limit: int = 20, offset: int = 0) -> list[SessionListItemResponse]:
    sessions = (
        scope_sessions(request).order_by("-created_at").annotate(
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
    return session_schema(get_session_for_request(request, session_id))


@api.post("/api/v1/sessions/{session_id}/cancel", response={202: dict, 400: ErrorResponse})
def cancel_session(request: HttpRequest, session_id: UUID) -> Status:
    session = get_session_for_request(request, session_id)
    if session.status not in {VideoSession.Status.CREATED, VideoSession.Status.PROCESSING}:
        return Status(400, ErrorResponse(detail="Only queued or processing sessions can be canceled."))
    settings_payload = dict(session.settings or {})
    settings_payload["cancel_requested"] = True
    session.settings = settings_payload
    session.status = VideoSession.Status.FAILED
    session.pipeline_stage = VideoSession.PipelineStage.FAILED
    session.error_message = "Canceled by user."
    session.save(update_fields=["settings", "status", "pipeline_stage", "error_message", "updated_at"])
    canceled_jobs = cancel_session_jobs(session)
    return Status(202, {"session_id": str(session.id), "status": "canceled", "canceled_jobs": canceled_jobs})


@api.post("/api/v1/sessions/{session_id}/retry", response={202: dict, 400: ErrorResponse})
def retry_session(request: HttpRequest, session_id: UUID) -> Status:
    session = get_session_for_request(request, session_id)
    workflow_template = str(session.settings.get("workflow_template", "reading_document"))
    output_targets = list(session.settings.get("output_targets", []))
    try:
        workflow_targets = normalize_workflow_targets(workflow_template, output_targets)
    except ValueError as exc:
        return Status(400, ErrorResponse(detail=str(exc)))

    if session.chunks.exists() and not session.chunks.exclude(status=VideoChunk.Status.READY).exists():
        session.settings = {
            **session.settings,
            "cancel_requested": False,
            "auto_synthesize": True,
            "output_targets": workflow_targets,
        }
        session.status = VideoSession.Status.PROCESSING
        session.pipeline_stage = VideoSession.PipelineStage.SYNTHESIZING
        session.error_message = ""
        session.synthesis_error = ""
        session.save(update_fields=["settings", "status", "pipeline_stage", "error_message", "synthesis_error", "updated_at"])
        enqueue_job(
            session=session,
            job_type=ProcessingJob.JobType.SYNTHESIS_RETRY,
            payload={"workflow_targets": workflow_targets},
            max_attempts=1,
        )
        return Status(202, {"session_id": str(session.id), "status": "processing", "message": "Synthesis retry queued."})

    if session.settings.get("source_type") == "upload":
        return Status(400, ErrorResponse(detail="Uploaded source videos are not retained for retry. Upload the file again."))
    if not session.source_url.startswith(("http://", "https://")):
        return Status(400, ErrorResponse(detail="This session cannot be retried from its original source."))

    session.chunks.all().delete()
    session.artifacts.all().delete()
    session.processing_jobs.exclude(status=ProcessingJob.Status.RUNNING).delete()
    settings_payload = {
        **session.settings,
        "cancel_requested": False,
        "ingest_error_code": "",
        "output_targets": workflow_targets,
    }
    session.settings = settings_payload
    session.status = VideoSession.Status.PROCESSING
    session.pipeline_stage = VideoSession.PipelineStage.DOWNLOADING
    session.expected_chunk_count = None
    session.duration_seconds = None
    session.error_message = ""
    session.synthesis_error = ""
    session.save(
        update_fields=[
            "settings",
            "status",
            "pipeline_stage",
            "expected_chunk_count",
            "duration_seconds",
            "error_message",
            "synthesis_error",
            "updated_at",
        ]
    )
    enqueue_job(
        session=session,
        job_type=ProcessingJob.JobType.URL_INGEST,
        payload={
            "url": session.source_url,
            "chunk_seconds": int(session.settings.get("chunk_seconds", 30)),
            "frame_count": int(session.settings.get("frame_count", 4)),
            "frame_width": int(session.settings.get("frame_width", 640)),
            "max_height": int(session.settings.get("max_height", 360)),
            "workflow_targets": workflow_targets,
            "auto_synthesize": bool(session.settings.get("auto_synthesize", True)),
        },
        max_attempts=1,
    )
    return Status(202, {"session_id": str(session.id), "status": "processing", "message": "Session retry queued."})


@api.delete("/api/v1/sessions/{session_id}", response={200: dict})
def delete_session(request: HttpRequest, session_id: UUID) -> dict[str, str]:
    session = get_session_for_request(request, session_id)
    stored_assets = list(StoredAsset.objects.filter(session=session).values_list("object_key", flat=True))
    for object_key in stored_assets:
        if not StoredAsset.objects.exclude(session=session).filter(object_key=object_key).exists():
            default_storage.delete(object_key)
    frames = FrameAsset.objects.filter(chunk__session=session).only("file")
    for frame in frames.iterator(chunk_size=200):
        frame.file.delete(save=False)
    pending_dir = Path(settings.MEDIA_ROOT) / "pending_uploads" / str(session.id)
    shutil.rmtree(pending_dir, ignore_errors=True)
    session.delete()
    return {"session_id": str(session_id), "status": "deleted"}


@api.get("/api/v1/sessions/{session_id}/progress", response=SessionProgressResponse)
def get_session_progress(request: HttpRequest, session_id: UUID) -> SessionProgressResponse:
    session = get_session_for_request(request, session_id)
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
        ingest_error_code=str(session.settings.get("ingest_error_code", "")),
    )


@api.get("/api/v1/sessions/{session_id}/chunks", response=list[ChunkSummaryResponse])
def list_session_chunks(request: HttpRequest, session_id: UUID) -> list[ChunkSummaryResponse]:
    session = get_session_for_request(request, session_id)
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
    session = get_session_for_request(request, session_id)
    return [artifact_schema(artifact) for artifact in session.artifacts.all()]


@api.post("/api/v1/sessions/{session_id}/artifacts", response={201: ArtifactResponse, 400: ErrorResponse, 502: ErrorResponse})
def regenerate_artifact(request: HttpRequest, session_id: UUID, payload: ArtifactRegenerateRequest) -> Status:
    session = get_session_for_request(request, session_id)
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
    session = get_session_for_request(request, session_id)
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

    enqueue_job(
        session=session,
        job_type=ProcessingJob.JobType.SYNTHESIS_RETRY,
        payload={"workflow_targets": workflow_targets},
        max_attempts=1,
    )
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
    audio_chunks: list[UploadedFile] = File([]),
) -> Status:
    session = get_session_for_request(request, session_id)
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
            for audio_chunk in audio_chunks or []:
                save_uploaded_audio_chunk(chunk, audio_chunk)
        except FrameValidationError as exc:
            transaction.set_rollback(True)
            return Status(400, ErrorResponse(detail=str(exc)))
        session.status = VideoSession.Status.PROCESSING
        session.pipeline_stage = VideoSession.PipelineStage.ANALYZING
        session.save(update_fields=["status", "pipeline_stage", "updated_at"])
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

    if process_now:
        try:
            enrich_chunk_with_audio_transcripts(chunk)
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
    session = get_session_for_request(request, session_id)
    return ReadingDocumentResponse(
        session=session_schema(session),
        blocks=[block_schema(block) for block in session.reading_blocks.select_related("chunk").all()],
        timeline=[timeline_schema(moment) for moment in session.timeline_moments.select_related("chunk").all()],
    )


@api.get("/api/v1/sessions/{session_id}/timeline", response=list[TimelineMomentResponse])
def get_timeline(request: HttpRequest, session_id: UUID) -> list[TimelineMomentResponse]:
    session = get_session_for_request(request, session_id)
    return [timeline_schema(moment) for moment in session.timeline_moments.select_related("chunk").all()]


@api.patch("/api/v1/reading-blocks/{block_id}", response=CorrectionResponse)
def correct_block(request: HttpRequest, block_id: UUID, payload: CorrectionRequest) -> CorrectionResponse:
    block = get_object_or_404(ReadingBlock.objects.select_related("session"), id=block_id, session__in=scope_sessions(request))
    previous = block.body
    block.body = payload.body
    block.is_user_edited = True
    block.save(update_fields=["body", "is_user_edited", "updated_at"])
    UserCorrection.objects.create(block=block, previous_body=previous, corrected_body=payload.body, note=payload.note)
    emit_event(block.session, "block.corrected", {"block_id": str(block.id), "chunk_id": str(block.chunk_id)})
    return CorrectionResponse(block=block_schema(block))


@api.get("/api/v1/sessions/{session_id}/events")
def stream_events(request: HttpRequest, session_id: UUID, after: int = 0) -> StreamingHttpResponse:
    session = get_session_for_request(request, session_id)

    def event_iter():
        for event in session.events.filter(id__gt=after).order_by("id")[:500]:
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
    audio_chunks: list[UploadedFile] = File([]),
) -> Status:
    session = get_session_for_request(request, session_id)
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
            for audio_chunk in audio_chunks or []:
                save_uploaded_audio_chunk(chunk, audio_chunk)
        except FrameValidationError as exc:
            transaction.set_rollback(True)
            return Status(400, ErrorResponse(detail=str(exc)))
        session.status = VideoSession.Status.PROCESSING
        session.pipeline_stage = VideoSession.PipelineStage.ANALYZING
        session.save(update_fields=["status", "pipeline_stage", "updated_at"])
        emit_event(session, "chunk.accepted", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

    enqueue_job(
        session=session,
        job_type=ProcessingJob.JobType.CHUNK_ANALYSIS,
        payload={"chunk_id": str(chunk.id)},
        max_attempts=1,
    )
    return Status(202, {"chunk_id": str(chunk.id), "status": "accepted", "message": "Processing in background."})


@api.post("/api/v1/sessions/{session_id}/synthesize", response={200: dict, 400: ErrorResponse})
def synthesize_session(request: HttpRequest, session_id: UUID) -> Status:
    session = get_session_for_request(request, session_id)
    ready_chunks = session.chunks.filter(status="ready").count()
    if ready_chunks == 0:
        return Status(400, ErrorResponse(detail="No ready chunks to synthesize."))
    try:
        result = AgentSocietyRunner().synthesize_session(session)
        artifact = build_artifact_from_session(
            session,
            workflow_template=str(session.settings.get("workflow_template", "reading_document")),
            synthesis_result=result,
        )
        return Status(200, {**result, "artifact": artifact_schema(artifact)})
    except (QwenConfigurationError, QwenResponseError) as exc:
        return Status(502, ErrorResponse(detail=str(exc)))


@api.get("/api/v1/sessions/{session_id}/export/markdown")
def export_markdown(request: HttpRequest, session_id: UUID) -> HttpResponse:
    session = get_session_for_request(request, session_id)
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
    frame = get_object_or_404(FrameAsset.objects.select_related("chunk__session"), id=frame_id, chunk__session__in=scope_sessions(request))
    response = FileResponse(frame.file.open("rb"), content_type=frame.mime_type)
    response["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


@api.post("/api/v1/ingest/from-url", response={202: dict, 400: ErrorResponse})
def create_session_from_url(request: HttpRequest, payload: UrlProcessRequest) -> Status:
    if not payload.url:
        return Status(400, ErrorResponse(detail="url is required."))
    try:
        workflow_targets = normalize_workflow_targets(payload.workflow_template, payload.output_targets)
    except ValueError as exc:
        return Status(400, ErrorResponse(detail=str(exc)))

    canonical = get_or_create_canonical_video(
        source_url=payload.url,
        metadata={"source_type": "url_ingest"},
    )
    session = VideoSession.objects.create(
        owner=current_user(request),
        canonical_video=canonical,
        source_fingerprint=canonical.fingerprint,
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
    if reuse_canonical_artifacts_if_ready(session):
        return Status(202, {"session_id": str(session.id), "status": "ready", "message": "Stored analysis reused."})

    enqueue_job(
        session=session,
        job_type=ProcessingJob.JobType.URL_INGEST,
        payload={
            "url": payload.url,
            "chunk_seconds": payload.chunk_seconds,
            "frame_count": payload.frame_count,
            "frame_width": payload.frame_width,
            "max_height": payload.max_height,
            "workflow_targets": workflow_targets,
            "auto_synthesize": payload.auto_synthesize,
        },
        max_attempts=1,
    )
    return Status(202, {"session_id": str(session.id), "status": "processing", "message": "Video ingestion started in background."})


@api.post("/api/v1/ingest/from-file", response={202: dict, 400: ErrorResponse})
def create_session_from_file(
    request: HttpRequest,
    video: UploadedFile = File(...),
    workflow_template: str = Form("reading_document"),
    output_targets: list[str] = Form([]),
    chunk_seconds: int = Form(30),
    frame_count: int = Form(4),
    frame_width: int = Form(640),
    auto_synthesize: bool = Form(True),
) -> Status:
    if not video:
        return Status(400, ErrorResponse(detail="video file is required."))
    filename = Path(video.name or "uploaded-video").name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_VIDEO_UPLOAD_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_VIDEO_UPLOAD_EXTENSIONS))
        return Status(400, ErrorResponse(detail=f"Unsupported video file type. Use one of: {allowed}."))
    if getattr(video, "size", 0) and video.size > settings.DESCRIBEOPS_MAX_VIDEO_UPLOAD_BYTES:
        return Status(400, ErrorResponse(detail="Uploaded video exceeds the configured size limit."))
    if chunk_seconds <= 0:
        return Status(400, ErrorResponse(detail="chunk_seconds must be greater than zero."))
    if frame_count <= 0 or frame_count > settings.DESCRIBEOPS_MAX_FRAMES_PER_CHUNK:
        return Status(400, ErrorResponse(detail=f"frame_count must be between 1 and {settings.DESCRIBEOPS_MAX_FRAMES_PER_CHUNK}."))
    try:
        workflow_targets = normalize_workflow_targets(workflow_template, output_targets)
    except ValueError as exc:
        return Status(400, ErrorResponse(detail=str(exc)))

    session = VideoSession.objects.create(
        owner=current_user(request),
        source_url=f"upload://{filename}",
        title=Path(filename).stem,
        page_title=filename,
        status=VideoSession.Status.PROCESSING,
        pipeline_stage=VideoSession.PipelineStage.DOWNLOADING,
        settings={
            "source_type": "upload",
            "filename": filename,
            "chunk_seconds": chunk_seconds,
            "frame_count": frame_count,
            "frame_width": frame_width,
            "workflow_template": workflow_template,
            "auto_synthesize": auto_synthesize,
            "output_targets": workflow_targets,
        },
    )
    emit_event(session, "session.created", {"session_id": str(session.id), "source_type": "upload"})

    work_dir = Path(settings.MEDIA_ROOT) / "pending_uploads" / str(session.id)
    work_dir.mkdir(parents=True, exist_ok=True)
    video_path = work_dir / f"source{suffix}"
    upload_hasher = hashlib.sha256()
    with video_path.open("wb") as target:
        for chunk in video.chunks():
            upload_hasher.update(chunk)
            target.write(chunk)
    if video_path.stat().st_size > settings.DESCRIBEOPS_MAX_VIDEO_UPLOAD_BYTES:
        video_path.unlink(missing_ok=True)
        try:
            work_dir.rmdir()
        except OSError:
            pass
        session.delete()
        return Status(400, ErrorResponse(detail="Uploaded video exceeds the configured size limit."))
    file_checksum = upload_hasher.hexdigest()
    canonical = get_or_create_canonical_video(
        source_url=f"upload://{filename}",
        title=Path(filename).stem,
        file_checksum=file_checksum,
        metadata={"source_type": "upload", "filename": filename},
    )
    session.canonical_video = canonical
    session.source_fingerprint = canonical.fingerprint
    session.save(update_fields=["canonical_video", "source_fingerprint", "updated_at"])
    if reuse_canonical_artifacts_if_ready(session):
        try:
            video_path.unlink(missing_ok=True)
            work_dir.rmdir()
        except OSError:
            pass
        return Status(202, {"session_id": str(session.id), "status": "ready", "message": "Stored analysis reused."})

    enqueue_job(
        session=session,
        job_type=ProcessingJob.JobType.FILE_INGEST,
        payload={
            "video_path": str(video_path),
            "title": Path(filename).stem,
            "file_checksum": file_checksum,
            "chunk_seconds": chunk_seconds,
            "frame_count": frame_count,
            "frame_width": frame_width,
            "workflow_targets": workflow_targets,
            "auto_synthesize": auto_synthesize,
        },
        max_attempts=1,
    )
    return Status(202, {"session_id": str(session.id), "status": "processing", "message": "Video upload ingestion started in background."})
