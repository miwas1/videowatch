from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any
from uuid import UUID

from django.db import connection, transaction
from django.utils import timezone

from reader.models import ProcessingJob, VideoChunk, VideoSession
from reader.services.events import emit_event
from reader.services.media_ingest import download_youtube_video
from reader.services.qwen import QwenConfigurationError, QwenResponseError


class JobCanceled(RuntimeError):
    pass


def enqueue_job(
    *,
    session: VideoSession,
    job_type: str,
    payload: dict[str, Any],
    max_attempts: int = 2,
) -> ProcessingJob:
    job = ProcessingJob.objects.create(
        session=session,
        job_type=job_type,
        payload=payload,
        max_attempts=max_attempts,
    )
    emit_event(session, "job.queued", {"job_id": str(job.id), "job_type": job.job_type})
    return job


def claim_next_job() -> ProcessingJob | None:
    with transaction.atomic():
        queryset = ProcessingJob.objects.filter(status=ProcessingJob.Status.QUEUED).order_by("created_at")
        if connection.features.has_select_for_update_skip_locked:
            queryset = queryset.select_for_update(skip_locked=True)
        elif connection.features.has_select_for_update:
            queryset = queryset.select_for_update()
        job = queryset.first()
        if job is None:
            return None
        now = timezone.now()
        job.status = ProcessingJob.Status.RUNNING
        job.attempts += 1
        job.locked_at = now
        job.started_at = now
        job.error_message = ""
        job.save(update_fields=["status", "attempts", "locked_at", "started_at", "error_message", "updated_at"])
        emit_event(job.session, "job.started", {"job_id": str(job.id), "job_type": job.job_type, "attempts": job.attempts})
        return job


def run_next_job() -> ProcessingJob | None:
    job = claim_next_job()
    if job is None:
        return None
    run_job(job)
    return job


def run_job(job: ProcessingJob) -> None:
    try:
        dispatch_job(job)
    except JobCanceled as exc:
        cancel_job(job, str(exc))
        return
    except Exception as exc:
        fail_job(job, exc)
        return
    job.status = ProcessingJob.Status.SUCCEEDED
    job.finished_at = timezone.now()
    job.error_message = ""
    job.save(update_fields=["status", "finished_at", "error_message", "updated_at"])
    emit_event(job.session, "job.succeeded", {"job_id": str(job.id), "job_type": job.job_type})


def cancel_job(job: ProcessingJob, detail: str = "Canceled by user.") -> None:
    job.status = ProcessingJob.Status.CANCELED
    job.error_message = detail
    job.finished_at = timezone.now()
    job.locked_at = None
    job.save(update_fields=["status", "error_message", "finished_at", "locked_at", "updated_at"])
    emit_event(job.session, "job.canceled", {"job_id": str(job.id), "job_type": job.job_type, "detail": detail})


def fail_job(job: ProcessingJob, exc: Exception) -> None:
    job.status = ProcessingJob.Status.QUEUED if job.attempts < job.max_attempts else ProcessingJob.Status.FAILED
    job.error_message = str(exc)
    job.finished_at = timezone.now() if job.status == ProcessingJob.Status.FAILED else None
    job.locked_at = None
    job.save(update_fields=["status", "error_message", "finished_at", "locked_at", "updated_at"])
    emit_event(
        job.session,
        "job.failed" if job.status == ProcessingJob.Status.FAILED else "job.retrying",
        {"job_id": str(job.id), "job_type": job.job_type, "attempts": job.attempts, "detail": str(exc)},
    )


def ensure_not_canceled(session: VideoSession) -> None:
    session.refresh_from_db(fields=["settings", "status", "error_message"])
    if session.settings.get("cancel_requested"):
        raise JobCanceled(session.error_message or "Canceled by user.")


def cancel_session_jobs(session: VideoSession, detail: str = "Canceled by user.") -> int:
    updated = ProcessingJob.objects.filter(session=session, status=ProcessingJob.Status.QUEUED).update(
        status=ProcessingJob.Status.CANCELED,
        error_message=detail,
        finished_at=timezone.now(),
        locked_at=None,
    )
    emit_event(session, "session.canceled", {"session_id": str(session.id), "canceled_jobs": updated, "detail": detail})
    return updated


def dispatch_job(job: ProcessingJob) -> None:
    if job.job_type == ProcessingJob.JobType.URL_INGEST:
        run_url_ingest_job(job)
    elif job.job_type == ProcessingJob.JobType.FILE_INGEST:
        run_file_ingest_job(job)
    elif job.job_type == ProcessingJob.JobType.CHUNK_ANALYSIS:
        run_chunk_analysis_job(job)
    elif job.job_type == ProcessingJob.JobType.SYNTHESIS_RETRY:
        run_synthesis_retry_job(job)
    else:
        raise ValueError(f"Unsupported processing job type: {job.job_type}")


def run_url_ingest_job(job: ProcessingJob) -> None:
    from reader.api import fail_ingest_session, fail_session, process_local_video_session

    session = VideoSession.objects.get(id=job.session_id)
    payload = job.payload
    try:
        ensure_not_canceled(session)
        with tempfile.TemporaryDirectory(prefix="describeops-ingest-") as tmp:
            work_dir = Path(tmp)
            download = download_youtube_video(str(payload["url"]), work_dir, max_height=int(payload["max_height"]))
            ensure_not_canceled(session)
            process_local_video_session(
                session=session,
                video_path=download.video_path,
                metadata=download.metadata,
                subtitle_paths=download.subtitle_paths,
                chunk_seconds=int(payload["chunk_seconds"]),
                frame_count=int(payload["frame_count"]),
                frame_width=int(payload["frame_width"]),
                workflow_targets=list(payload["workflow_targets"]),
                auto_synthesize=bool(payload["auto_synthesize"]),
                work_dir=work_dir,
            )
    except Exception as exc:
        session.refresh_from_db()
        if session.pipeline_stage in {
            VideoSession.PipelineStage.SYNTHESIZING,
            VideoSession.PipelineStage.BUILDING_ARTIFACTS,
        }:
            fail_session(session, str(exc), synthesis=True)
        else:
            fail_ingest_session(session, exc)
        raise


def run_file_ingest_job(job: ProcessingJob) -> None:
    from reader.api import fail_ingest_session, fail_session, process_local_video_session

    session = VideoSession.objects.get(id=job.session_id)
    payload = job.payload
    video_path = Path(str(payload["video_path"]))
    try:
        ensure_not_canceled(session)
        process_local_video_session(
            session=session,
            video_path=video_path,
            metadata={
                "title": payload.get("title") or session.title,
                "webpage_url": session.source_url,
            },
            subtitle_paths=[],
            chunk_seconds=int(payload["chunk_seconds"]),
            frame_count=int(payload["frame_count"]),
            frame_width=int(payload["frame_width"]),
            workflow_targets=list(payload["workflow_targets"]),
            auto_synthesize=bool(payload["auto_synthesize"]),
            work_dir=video_path.parent,
        )
    except Exception as exc:
        session.refresh_from_db()
        if session.pipeline_stage in {
            VideoSession.PipelineStage.SYNTHESIZING,
            VideoSession.PipelineStage.BUILDING_ARTIFACTS,
        }:
            fail_session(session, str(exc), synthesis=True)
        else:
            fail_ingest_session(session, exc)
        raise
    finally:
        try:
            video_path.unlink(missing_ok=True)
            video_path.parent.rmdir()
        except OSError:
            pass


def run_chunk_analysis_job(job: ProcessingJob) -> None:
    from reader.api import fail_session, mark_session_ready_when_current_chunks_ready
    from reader.services.agents import AgentSocietyRunner

    chunk = VideoChunk.objects.select_related("session").get(id=UUID(str(job.payload["chunk_id"])))
    try:
        ensure_not_canceled(chunk.session)
        AgentSocietyRunner().process_chunk(chunk)
        ensure_not_canceled(chunk.session)
        mark_session_ready_when_current_chunks_ready(chunk.session)
    except (QwenConfigurationError, QwenResponseError) as exc:
        chunk.status = VideoChunk.Status.FAILED
        chunk.error_message = str(exc)
        chunk.save(update_fields=["status", "error_message", "updated_at"])
        fail_session(chunk.session, str(exc))
        raise


def run_synthesis_retry_job(job: ProcessingJob) -> None:
    from reader.api import fail_session, synthesize_artifacts

    session = VideoSession.objects.get(id=job.session_id)
    try:
        ensure_not_canceled(session)
        synthesize_artifacts(session, list(job.payload["workflow_targets"]))
    except Exception as exc:
        fail_session(session, str(exc), synthesis=True)
        raise
