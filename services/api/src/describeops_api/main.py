from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from .config import load_root_env
from .gateway import ModelPurpose, QwenGateway
from .media_analysis import analyze_media_job, asset_storage_path
from .schemas import (
    AnalysisStage,
    JobCreateRequest,
    JobRecord,
    MemoryPreference,
    MemoryPreferenceListResponse,
    MemoryPreferenceRequest,
    MemoryPreferenceResponse,
    ReviewSubmission,
    new_id,
)
from .security import require_api_token
from .store import JobStore

SERVICE_VERSION = "0.1.0"
LOGGER = logging.getLogger("describeops.api")

load_root_env()


def create_app() -> FastAPI:
    load_root_env()
    configure_logging()
    app = FastAPI(title="DescribeOps API", version=SERVICE_VERSION)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(chrome-extension://[a-z]+|http://127\.0\.0\.1:\d+|http://localhost:\d+)$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    store = JobStore()

    @app.middleware("http")
    async def log_request_lifecycle(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or f"req_{uuid4().hex[:12]}"
        started = time.monotonic()
        LOGGER.info(
            "request.start method=%s path=%s requestId=%s client=%s",
            request.method,
            request.url.path,
            request_id,
            request.client.host if request.client else "unknown",
        )
        try:
            response = await call_next(request)
        except Exception:
            LOGGER.exception(
                "request.error method=%s path=%s requestId=%s durationMs=%s",
                request.method,
                request.url.path,
                request_id,
                round((time.monotonic() - started) * 1000),
            )
            raise

        response.headers["x-request-id"] = request_id
        LOGGER.info(
            "request.finish method=%s path=%s status=%s requestId=%s durationMs=%s",
            request.method,
            request.url.path,
            response.status_code,
            request_id,
            round((time.monotonic() - started) * 1000),
        )
        return response

    def get_store() -> JobStore:
        return store

    def get_gateway() -> QwenGateway:
        return QwenGateway.from_env()

    @app.get("/health")
    def health(gateway: QwenGateway = Depends(get_gateway)) -> dict:
        LOGGER.info(
            "health.checked deployment=%s qwenConfigured=%s baseUrl=%s",
            os.getenv("ALIBABA_CLOUD_DEPLOYMENT", "local"),
            gateway.configured,
            gateway.base_url,
        )
        return {
            "service": "describeops-api",
            "version": SERVICE_VERSION,
            "cloud": {
                "provider": "alibaba-cloud",
                "deployment": os.getenv("ALIBABA_CLOUD_DEPLOYMENT", "local"),
            },
            "qwen": {
                "configured": gateway.configured,
                "baseUrl": gateway.base_url,
                "models": {purpose.value: gateway.model_for(purpose) for purpose in ModelPurpose},
            },
        }

    @app.post("/v1/jobs", response_model=JobRecord, status_code=status.HTTP_201_CREATED)
    def create_job(
        request: JobCreateRequest,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> JobRecord:
        job = jobs.add(JobRecord.create(request))
        LOGGER.info(
            "job.created jobId=%s traceId=%s source=%s mode=%s snapshot=%s",
            job.id,
            job.traceId,
            job.source,
            job.mode,
            summarize_snapshot(job.snapshot),
        )
        return job

    @app.post("/v1/jobs/{job_id}/assets", status_code=status.HTTP_201_CREATED)
    async def upload_asset(
        job_id: str,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
        file: UploadFile = File(...),
    ) -> dict:
        job_or_404(jobs, job_id)
        max_bytes = int(os.getenv("DESCRIBEOPS_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
        content = await file.read(max_bytes + 1)
        if len(content) > max_bytes:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Asset exceeds upload limit")
        storage_path = asset_storage_path(file.filename, file.content_type)
        storage_path.write_bytes(content)
        asset = {
            "filename": file.filename,
            "contentType": file.content_type,
            "size": len(content),
            "storagePath": str(storage_path),
            "authorized": True,
        }
        jobs.add_asset(job_id, asset)
        LOGGER.info(
            "job.asset_uploaded jobId=%s filename=%s contentType=%s size=%s",
            job_id,
            asset["filename"],
            asset["contentType"],
            asset["size"],
        )
        return asset

    @app.post("/v1/jobs/{job_id}/analyze", status_code=status.HTTP_202_ACCEPTED)
    def analyze_job(
        job_id: str,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
        gateway: QwenGateway = Depends(get_gateway),
    ) -> dict:
        job = job_or_404(jobs, job_id)
        if not gateway.configured:
            jobs.update_status(job_id, "failed")
            jobs.update_progress(
                job_id,
                stage="failed",
                message="Qwen is not configured. Add an API key before starting AI analysis.",
                percent=100,
            )
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "code": "CONFIG_ERROR",
                    "message": "QWEN_API_KEY is required before starting AI analysis jobs.",
                },
            )
        status_value = "running"
        LOGGER.info(
            "job.analysis_requested jobId=%s traceId=%s mode=%s qwenConfigured=%s model=%s snapshot=%s",
            job.id,
            job.traceId,
            job.mode,
            gateway.configured,
            gateway.model_for(ModelPurpose.TEXT_REASONING),
            summarize_snapshot(job.snapshot),
        )
        jobs.update_status(job_id, status_value)
        jobs.update_progress(
            job_id,
            stage="queued",
            message="Analysis job accepted.",
            percent=5,
        )

        qwen_payload: dict | None = None
        qwen_error: str | None = None
        analysis_artifacts: list[dict] = []

        def record_progress(
            stage: AnalysisStage,
            message: str,
            percent: int,
            current_chunk: int | None,
            total_chunks: int | None,
            partial_cue_count: int | None,
        ) -> None:
            jobs.update_progress(
                job_id,
                stage=stage,
                message=message,
                percent=percent,
                current_chunk=current_chunk,
                total_chunks=total_chunks,
                partial_cue_count=partial_cue_count,
            )

        try:
            media_result = analyze_media_job(job, gateway=gateway, on_progress=record_progress)
            qwen_payload = media_result.qwen_payload
            analysis_artifacts = media_result.artifacts
            LOGGER.info(
                "job.qwen_described jobId=%s traceId=%s model=%s cues=%s",
                job.id,
                job.traceId,
                gateway.model_for(ModelPurpose.MULTIMODAL_FRAME_ANALYSIS),
                len(qwen_payload.get("cues", [])),
            )
        except Exception as exc:  # noqa: BLE001 - degrade gracefully to deterministic cues
            qwen_error = f"{type(exc).__name__}: {exc}"
            jobs.update_progress(
                job_id,
                stage="building_playback",
                message="Visual analysis was limited; building fallback descriptions.",
                percent=82,
            )
            LOGGER.warning(
                "job.qwen_failed jobId=%s traceId=%s error=%s",
                job.id,
                job.traceId,
                qwen_error,
            )

        generated = build_accessibility_artifacts(job, qwen_payload=qwen_payload)
        plan_artifact = {
            "kind": "analysis-plan",
            "traceId": job.traceId,
            "mode": job.mode,
            "qwenConfigured": gateway.configured,
            "qwenUsed": qwen_payload_used_model(qwen_payload),
            "qwenError": qwen_error,
            "model": gateway.model_for(ModelPurpose.MULTIMODAL_FRAME_ANALYSIS),
            "videoSummary": (qwen_payload or {}).get("summary", ""),
            "note": (
                "Audio descriptions generated from chunked visual media analysis."
                if qwen_payload_used_model(qwen_payload)
                else "Visual model output was unavailable; generated video-focused fallback descriptions."
            ),
        }
        for artifact in [plan_artifact, *analysis_artifacts, *generated]:
            jobs.add_artifact(job_id, artifact)
        jobs.update_status(job_id, "complete")
        jobs.update_progress(
            job_id,
            stage="complete",
            message="Descriptions are ready.",
            percent=100,
            partial_cue_count=len(generated[0].get("cues", [])) if generated else 0,
        )
        LOGGER.info(
            "job.analysis_planned jobId=%s traceId=%s status=%s qwenUsed=%s artifacts=%s",
            job.id,
            job.traceId,
            "complete",
            qwen_payload is not None,
            [artifact["kind"] for artifact in [plan_artifact, *analysis_artifacts, *generated]],
        )
        return {"id": job_id, "status": "complete", "traceId": job.traceId, "qwenUsed": qwen_payload_used_model(qwen_payload)}

    @app.get("/v1/jobs/{job_id}", response_model=JobRecord)
    def get_job(
        job_id: str,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> JobRecord:
        job = job_or_404(jobs, job_id)
        LOGGER.info(
            "job.fetched jobId=%s traceId=%s status=%s assets=%s artifacts=%s reviewItems=%s",
            job.id,
            job.traceId,
            job.status,
            len(job.assets),
            len(job.artifacts),
            len(job.review),
        )
        return job

    @app.get("/v1/jobs/{job_id}/artifacts")
    def list_artifacts(
        job_id: str,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> dict:
        job = job_or_404(jobs, job_id)
        LOGGER.info(
            "job.artifacts_listed jobId=%s traceId=%s count=%s kinds=%s",
            job.id,
            job.traceId,
            len(job.artifacts),
            [artifact.get("kind") for artifact in job.artifacts],
        )
        return {"jobId": job_id, "artifacts": job.artifacts}

    @app.post("/v1/jobs/{job_id}/review")
    def submit_review(
        job_id: str,
        review: ReviewSubmission,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> dict:
        jobs.add_review(job_id, review.model_dump())
        LOGGER.info(
            "job.review_submitted jobId=%s cueId=%s confidence=%s",
            job_id,
            review.cueId,
            review.confidence,
        )
        return {"jobId": job_id, "stored": True}

    @app.post("/v1/memory/preferences", response_model=MemoryPreferenceResponse)
    def update_preference(
        request: MemoryPreferenceRequest,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> MemoryPreferenceResponse:
        key = f"{request.scope}:{request.subjectId}"
        memory = MemoryPreference(
            id=new_id("mem"),
            scope=request.scope,
            subjectId=request.subjectId,
            kind=request.kind,
            value=request.preference,
            confidence=request.confidence,
            sourceJobId=request.sourceJobId,
            reviewerId=request.reviewerId,
            createdAt=datetime.now(timezone.utc),
            expiresAt=request.expiresAt,
        )
        jobs.save_memory(memory)
        LOGGER.info(
            "memory.saved memoryId=%s scope=%s subjectId=%s kind=%s confidence=%s",
            memory.id,
            memory.scope,
            memory.subjectId,
            memory.kind,
            memory.confidence,
        )
        return MemoryPreferenceResponse(stored=True, key=key, memory=memory)

    @app.get("/v1/memory/preferences", response_model=MemoryPreferenceListResponse)
    def list_preferences(
        userId: str | None = None,
        orgId: str | None = None,
        jobId: str | None = None,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> MemoryPreferenceListResponse:
        memories = jobs.list_memory(user_id=userId, org_id=orgId, job_id=jobId)
        LOGGER.info(
            "memory.listed userId=%s orgId=%s jobId=%s count=%s",
            userId,
            orgId,
            jobId,
            len(memories),
        )
        return MemoryPreferenceListResponse(memories=memories)

    @app.delete("/v1/memory/preferences/{memory_id}")
    def delete_preference(
        memory_id: str,
        _: None = Depends(require_api_token),
        jobs: JobStore = Depends(get_store),
    ) -> dict:
        deleted = jobs.delete_memory(memory_id)
        if not deleted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory preference not found")
        LOGGER.info("memory.deleted memoryId=%s", memory_id)
        return {"id": memory_id, "deleted": True}

    return app


def job_or_404(jobs: JobStore, job_id: str) -> JobRecord:
    try:
        return jobs.require(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found") from exc


def configure_logging() -> None:
    level_name = os.getenv("DESCRIBEOPS_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    LOGGER.setLevel(level)


def summarize_snapshot(snapshot) -> dict:
    if snapshot is None:
        return {
            "present": False,
            "media": 0,
            "headings": 0,
            "textBlocks": 0,
            "captions": 0,
            "inaccessibleRegions": 0,
        }

    return {
        "present": True,
        "url": snapshot.url,
        "title": snapshot.title,
        "media": len(snapshot.media),
        "headings": len(snapshot.headings),
        "textBlocks": len(snapshot.visibleText),
        "captions": len(snapshot.captions),
        "inaccessibleRegions": len(snapshot.inaccessibleRegions),
    }


def focused_media(snapshot) -> "DetectedMedia | None":
    if not snapshot or not snapshot.media:
        return None
    playable = [m for m in snapshot.media if m.kind != "audio"] or list(snapshot.media)
    focused = next((m for m in playable if m.isFocused), None)
    return focused or playable[0]


def build_video_context(snapshot) -> dict:
    """Build a compact, video-only context payload for the Qwen prompt."""
    media = focused_media(snapshot)
    captions = list(snapshot.captions) if snapshot else []
    live_caption = list(snapshot.liveCaptionText) if snapshot else []
    transcript = list(snapshot.transcriptText) if snapshot else []
    platform = media.platform if media else (snapshot.platform if snapshot else "generic")
    return {
        "videoTitle": (media.label if media else (snapshot.title if snapshot else "")),
        "pageTitle": snapshot.title if snapshot else "",
        "platform": platform,
        "isSocial": bool(media.isSocial) if media else False,
        "durationSeconds": media.duration if media else None,
        "currentTimeSeconds": media.currentTime if media else None,
        "hasCaptions": bool(media.hasCaptions) if media else False,
        "liveCaptionText": live_caption[:12],
        "captionTracks": captions[:6],
        "transcript": transcript[:12],
    }


def build_accessibility_artifacts(job: JobRecord, *, qwen_payload: dict | None = None) -> list[dict]:
    snapshot = job.snapshot
    now = datetime.now(timezone.utc).isoformat()
    media = focused_media(snapshot)
    media_id = media.id if media else "page"
    captions = snapshot.captions if snapshot else []

    cues = build_cues_from_qwen(qwen_payload) if qwen_payload else []
    if not cues:
        cues = build_fallback_video_cues(snapshot, media)

    speech_gaps = [{"start": cue["start"], "end": cue["end"]} for cue in cues]
    webvtt = render_webvtt(cues)
    qa_report = {
        "jobId": job.id,
        "traceId": job.traceId,
        "mode": job.mode,
        "cueCount": len(cues),
        "captionsDetected": bool(captions or (media and media.hasCaptions)),
        "source": "qwen-frame-list" if qwen_payload_used_model(qwen_payload) else "deterministic-fallback",
        "videoSummary": (qwen_payload or {}).get("summary", ""),
        "generatedAt": now,
    }

    return [
        {
            "kind": "review-cues",
            "jobId": job.id,
            "traceId": job.traceId,
            "cues": cues,
            "createdAt": now,
        },
        {
            "kind": "playback-package",
            "id": f"pkg-{job.id}",
            "jobId": job.id,
            "mediaId": media_id,
            "cues": cues,
            "speechGaps": speech_gaps,
            "audioTrackUrl": f"speechSynthesis://{job.id}",
            "offlineAvailable": True,
            "ducking": {"enabled": True, "level": 0.35},
            "createdAt": now,
        },
        {
            "kind": "webvtt",
            "id": f"artifact-webvtt-{job.id}",
            "jobId": job.id,
            "filename": f"{job.id}-audio-descriptions.vtt",
            "mimeType": "text/vtt",
            "sizeBytes": len(webvtt.encode("utf-8")),
            "createdAt": now,
            "offlineAvailable": True,
            "content": webvtt,
        },
        {
            "kind": "qa_report",
            "id": f"artifact-qa-{job.id}",
            "jobId": job.id,
            "filename": f"{job.id}-accessibility-qa.json",
            "mimeType": "application/json",
            "sizeBytes": len(str(qa_report).encode("utf-8")),
            "createdAt": now,
            "offlineAvailable": True,
            "report": qa_report,
        },
    ]


def qwen_payload_used_model(qwen_payload: dict | None) -> bool:
    if not qwen_payload:
        return False
    return any(chunk.get("transport") == "qwen-frame-list" for chunk in qwen_payload.get("chunks", []))


IMPORTANCE_TO_IMPACT = {"high": "high", "medium": "medium", "low": "low"}


def build_cues_from_qwen(payload: dict) -> list[dict]:
    """Convert Qwen's described cues into playback cues (no human review step)."""
    cues: list[dict] = []
    for index, raw in enumerate(payload.get("cues", [])):
        if not isinstance(raw, dict):
            continue
        text = str(raw.get("text", "")).strip()
        if not text:
            continue
        start = _coerce_float(raw.get("start"), default=index * 6.0 + 1.0)
        end = _coerce_float(raw.get("end"), default=start + 4.0)
        if end < start:
            end = start + 4.0
        impact_value = raw.get("impact", raw.get("importance", "medium"))
        impact = IMPORTANCE_TO_IMPACT.get(str(impact_value).lower(), "medium")
        cues.append(
            {
                "id": str(raw.get("id") or f"cue-{index + 1}"),
                "start": round(start, 1),
                "end": round(end, 1),
                "text": text,
                "evidenceRefs": raw.get("evidenceRefs") if isinstance(raw.get("evidenceRefs"), list) else [f"qwen-{index + 1}"],
                "confidence": _coerce_float(raw.get("confidence"), default=0.85),
                "needsReview": bool(raw.get("needsReview", False)),
                "notes": str(raw.get("notes") or "Generated by chunked media analysis."),
                "impact": impact,
                "qaWarnings": raw.get("qaWarnings") if isinstance(raw.get("qaWarnings"), list) else [],
                "status": raw.get("status") if raw.get("status") in {"needs_review", "accepted", "rejected", "edited"} else "accepted",
                "rememberable": bool(raw.get("rememberable", False)),
            }
        )
    return cues


def build_fallback_video_cues(snapshot, media) -> list[dict]:
    """Deterministic, video-focused descriptions when Qwen is unavailable.

    This intentionally describes the video (title, platform, captions) and never
    the surrounding page chrome.
    """
    title = (media.label if media else (snapshot.title if snapshot else "this video")) or "this video"
    platform = (media.platform if media else (snapshot.platform if snapshot else "generic"))
    live_caption = next((t for t in (snapshot.liveCaptionText if snapshot else []) if t), "")
    transcript = next((t for t in (snapshot.transcriptText if snapshot else []) if t), "")

    statements: list[str] = [f"Now playing: {title}."]
    if platform and platform != "generic":
        statements[0] = f"Now playing on {platform}: {title}."
    if live_caption:
        statements.append(f"On screen it reads: {_trim(live_caption)}.")
    elif transcript:
        statements.append(f"The video says: {_trim(transcript)}.")
    else:
        statements.append("Press the describe shortcut at any moment to hear what is on screen.")

    cues: list[dict] = []
    for index, text in enumerate(statements):
        start = index * 6.0 + 1.0
        cues.append(
            {
                "id": f"cue-{index + 1}",
                "start": round(start, 1),
                "end": round(start + 4.0, 1),
                "text": text,
                "evidenceRefs": [f"snapshot-{index + 1}"],
                "confidence": 0.6,
                "needsReview": False,
                "notes": "Deterministic video-focused fallback (Qwen unavailable).",
                "impact": "high" if index == 0 else "medium",
                "qaWarnings": [],
                "status": "accepted",
                "rememberable": False,
            }
        )
    return cues


def _coerce_float(value, *, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if result >= 0 else default


def _trim(value: str, limit: int = 140) -> str:
    compact = " ".join(str(value).split())
    return compact if len(compact) <= limit else f"{compact[: limit - 3].strip()}..."


def render_webvtt(cues: list[dict]) -> str:
    lines = ["WEBVTT", ""]
    for cue in cues:
        lines.extend([
            cue["id"],
            f"{format_vtt_time(cue['start'])} --> {format_vtt_time(cue['end'])}",
            cue["text"],
            "",
        ])
    return "\n".join(lines)


def format_vtt_time(seconds: float) -> str:
    milliseconds = int(round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}.{millis:03}"


app = create_app()
