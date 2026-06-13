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
from .schemas import (
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
        asset = {
            "filename": file.filename,
            "contentType": file.content_type,
            "size": len(content),
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
        status_value = "running" if gateway.configured else "needs_review"
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
        generated = build_accessibility_artifacts(job)
        plan_artifact = {
            "kind": "analysis-plan",
            "traceId": job.traceId,
            "mode": job.mode,
            "qwenConfigured": gateway.configured,
            "model": gateway.model_for(ModelPurpose.TEXT_REASONING),
            "note": "Backend generated deterministic review/playback artifacts from the submitted page snapshot. Qwen multimodal enrichment can replace this planner output when model execution is enabled.",
        }
        for artifact in [plan_artifact, *generated]:
            jobs.add_artifact(job_id, artifact)
        LOGGER.info(
            "job.analysis_planned jobId=%s traceId=%s status=%s artifacts=%s",
            job.id,
            job.traceId,
            status_value,
            [artifact["kind"] for artifact in [plan_artifact, *generated]],
        )
        return {"id": job_id, "status": status_value, "traceId": job.traceId}

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


def build_accessibility_artifacts(job: JobRecord) -> list[dict]:
    snapshot = job.snapshot
    now = datetime.now(timezone.utc).isoformat()
    media = snapshot.media[0] if snapshot and snapshot.media else None
    media_id = media.id if media else "page"
    title = snapshot.title if snapshot else "Untitled page"
    source_label = media.label if media else title
    visible_text = snapshot.visibleText if snapshot else []
    captions = snapshot.captions if snapshot else []
    inaccessible = snapshot.inaccessibleRegions if snapshot else []

    cue_texts = build_cue_texts(title=title, source_label=source_label, visible_text=visible_text, captions=captions, inaccessible_count=len(inaccessible))
    cues = [
        {
            "id": f"cue-{index + 1}",
            "start": round(index * 6.0 + 1.0, 1),
            "end": round(index * 6.0 + 5.0, 1),
            "text": text,
            "evidenceRefs": [f"snapshot-{index + 1}"],
            "confidence": 0.72 if index == 0 else 0.64,
            "needsReview": True,
            "notes": "Generated from browser-visible page evidence.",
            "impact": "high" if index == 0 else "medium",
            "qaWarnings": build_qa_warnings(captions=captions, inaccessible_count=len(inaccessible), index=index),
            "status": "needs_review",
            "rememberable": True,
        }
        for index, text in enumerate(cue_texts)
    ]
    speech_gaps = [{"start": cue["start"], "end": cue["end"]} for cue in cues]
    webvtt = render_webvtt(cues)
    qa_report = {
        "jobId": job.id,
        "traceId": job.traceId,
        "mode": job.mode,
        "cueCount": len(cues),
        "captionsDetected": bool(captions or (media and media.hasCaptions)),
        "samplingFlags": len(inaccessible),
        "warnings": sorted({warning for cue in cues for warning in cue["qaWarnings"]}),
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


def build_cue_texts(*, title: str, source_label: str, visible_text: list[str], captions: list[str], inaccessible_count: int) -> list[str]:
    readable_context = next((text for text in visible_text if text and text != title), "")
    caption_context = f" Captions are available for timing support." if captions else ""
    sampling_context = (
        f" {inaccessible_count} visual region(s) were flagged for reviewer confirmation."
        if inaccessible_count
        else ""
    )
    first = f"{source_label} is the active media on the page.{caption_context}{sampling_context}".strip()
    second = (
        f"The page context highlights {readable_context}."
        if readable_context
        else f"The page title is {title}."
    )
    return [first, second]


def build_qa_warnings(*, captions: list[str], inaccessible_count: int, index: int) -> list[str]:
    warnings: list[str] = []
    if index == 0 and not captions:
        warnings.append("No caption track text was available; confirm timing manually.")
    if inaccessible_count:
        warnings.append("Visual sampling flags need human confirmation before publishing.")
    return warnings


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
