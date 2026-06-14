from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .gateway import QwenGateway
from .schemas import AnalysisStage, DetectedMedia, JobRecord, MediaAnalysisRequest

PROMPT_VERSION = "api-frame-list-v1"
DEFAULT_FIRST_CHUNK_SECONDS = 6
DEFAULT_CHUNK_SECONDS = 30
DEFAULT_FRAME_COUNT = 4
DEFAULT_FRAME_WIDTH = 448
DEFAULT_FPS = 0.5
MAX_FRAME_DATA_URL_BYTES = 9 * 1024 * 1024

ProgressCallback = Callable[[AnalysisStage, str, int, int | None, int | None, int | None], None]


@dataclass(frozen=True)
class PlannedChunk:
    index: int
    start: float
    end: float


@dataclass(frozen=True)
class MediaAnalysisResult:
    qwen_payload: dict[str, Any] | None
    artifacts: list[dict[str, Any]]


def analyze_media_job(
    job: JobRecord,
    *,
    gateway: QwenGateway,
    on_progress: ProgressCallback | None = None,
) -> MediaAnalysisResult:
    request = build_media_analysis_request(job)
    source = resolve_media_source(job, request)
    duration = bounded_duration(request.duration or source.get("duration") or 0)
    title = request.title or source.get("label") or (job.snapshot.title if job.snapshot else "current video")
    now = datetime.now(timezone.utc).isoformat()

    progress(on_progress, "resolving_media", f"Found {source['sourceKind'].replace('_', ' ')} for {title}.", 12)

    chunks = plan_live_chunks(duration)
    progress(
        on_progress,
        "preparing_media",
        f"Planned {len(chunks)} visual segment(s) for analysis.",
        22,
        current_chunk=0,
        total_chunks=len(chunks),
    )

    chunk_results: list[dict[str, Any]] = []
    cues: list[dict[str, Any]] = []
    total = max(1, len(chunks))

    for chunk in chunks:
        progress(
            on_progress,
            "sampling_frames",
            f"Sampling visual evidence for {format_ts(chunk.start)} to {format_ts(chunk.end)}.",
            24 + round((chunk.index / total) * 20),
            current_chunk=chunk.index + 1,
            total_chunks=len(chunks),
            partial_cue_count=len(cues),
        )
        frames = frames_for_chunk(source, request, chunk)

        progress(
            on_progress,
            "analyzing_chunk",
            f"Analyzing segment {chunk.index + 1} of {len(chunks)}.",
            44 + round((chunk.index / total) * 36),
            current_chunk=chunk.index + 1,
            total_chunks=len(chunks),
            partial_cue_count=len(cues),
        )

        result = analyze_chunk_with_qwen(
            gateway=gateway,
            request=request,
            source=source,
            chunk=chunk,
            frames=frames,
            trace_id=f"{job.traceId}_{chunk.index + 1}",
        )
        chunk_results.append(result)
        cue = cue_from_chunk_result(result, index=len(cues), title=title)
        if cue:
            cues.append(cue)

    progress(
        on_progress,
        "building_playback",
        "Building spoken descriptions and review artifacts.",
        86,
        current_chunk=len(chunks),
        total_chunks=len(chunks),
        partial_cue_count=len(cues),
    )

    summary = summarize_analysis(title, chunk_results)
    qwen_payload = {
        "summary": summary,
        "cues": cues,
        "chunks": chunk_results,
        "source": source,
        "promptVersion": PROMPT_VERSION,
    }
    artifacts = [
        {
            "kind": "media-analysis-summary",
            "jobId": job.id,
            "traceId": job.traceId,
            "source": source,
            "durationSeconds": duration,
            "chunkCount": len(chunks),
            "promptVersion": PROMPT_VERSION,
            "summary": summary,
            "createdAt": now,
        },
        {
            "kind": "chunk-timeline",
            "jobId": job.id,
            "traceId": job.traceId,
            "chunks": chunk_results,
            "createdAt": now,
        },
    ]

    progress(
        on_progress,
        "complete",
        "Descriptions are ready.",
        100,
        current_chunk=len(chunks),
        total_chunks=len(chunks),
        partial_cue_count=len(cues),
    )
    return MediaAnalysisResult(qwen_payload=qwen_payload, artifacts=artifacts)


def build_media_analysis_request(job: JobRecord) -> MediaAnalysisRequest:
    if job.analysisRequest:
        return job.analysisRequest

    media = focused_media(job.snapshot)
    return MediaAnalysisRequest(
        mediaId=media.id if media else None,
        sourceKind=source_kind_for_media(media),
        videoUrl=media.source if media else None,
        pageUrl=job.snapshot.url if job.snapshot else "",
        title=media.label if media else (job.snapshot.title if job.snapshot else ""),
        duration=media.duration or 0 if media else 0,
        currentTime=media.currentTime or 0 if media else 0,
        platform=media.platform if media else (job.snapshot.platform if job.snapshot else "generic"),
    )


def resolve_media_source(job: JobRecord, request: MediaAnalysisRequest) -> dict[str, Any]:
    media = focused_media(job.snapshot)
    uploaded = next((asset for asset in reversed(job.assets) if asset.get("storagePath")), None)
    if uploaded:
        return {
            "sourceKind": "uploaded_asset",
            "mediaId": request.mediaId or (media.id if media else "uploaded-media"),
            "label": request.title or uploaded.get("filename") or (media.label if media else "Uploaded media"),
            "url": None,
            "path": uploaded["storagePath"],
            "platform": request.platform,
            "duration": request.duration or (media.duration if media else 0),
        }

    return {
        "sourceKind": request.sourceKind,
        "mediaId": request.mediaId or (media.id if media else "page"),
        "label": request.title or (media.label if media else "Current media"),
        "url": request.videoUrl or (media.source if media else None) or request.pageUrl,
        "path": None,
        "platform": request.platform,
        "duration": request.duration or (media.duration if media else 0),
    }


def focused_media(snapshot) -> DetectedMedia | None:
    if not snapshot or not snapshot.media:
        return None
    playable = [media for media in snapshot.media if media.kind != "audio"] or list(snapshot.media)
    return next((media for media in playable if media.isFocused), None) or playable[0]


def source_kind_for_media(media: DetectedMedia | None) -> str:
    if media is None:
        return "page_snapshot"
    if media.kind == "embedded-player":
        return "embedded_player"
    if media.source:
        return "direct_url"
    return "page_snapshot"


def bounded_duration(duration: float) -> float:
    if duration and duration > 0:
        return min(duration, float(os.getenv("DESCRIBEOPS_MAX_ANALYSIS_DURATION_SECONDS", "900")))
    return float(os.getenv("DESCRIBEOPS_DEFAULT_ANALYSIS_DURATION_SECONDS", "30"))


def plan_live_chunks(duration: float) -> list[PlannedChunk]:
    first = int(os.getenv("QWEN_FIRST_CHUNK_SECONDS", str(DEFAULT_FIRST_CHUNK_SECONDS)))
    chunk_seconds = int(os.getenv("QWEN_CHUNK_SECONDS", str(DEFAULT_CHUNK_SECONDS)))
    chunks: list[PlannedChunk] = []
    start = 0.0
    while start < duration - 0.25:
        span = first if not chunks else chunk_seconds
        end = min(duration, start + span)
        if end - start < 1:
            break
        chunks.append(PlannedChunk(index=len(chunks), start=start, end=end))
        start = end
    return chunks or [PlannedChunk(index=0, start=0.0, end=max(1.0, duration))]


def frames_for_chunk(source: dict[str, Any], request: MediaAnalysisRequest, chunk: PlannedChunk) -> list[str]:
    if request.frameSamples:
        return request.frameSamples[:DEFAULT_FRAME_COUNT]
    if source.get("sourceKind") == "page_snapshot":
        return []
    path = source.get("path")
    if path:
        extracted = extract_frame_data_urls(Path(path), chunk)
        if extracted:
            return extracted
    url = source.get("url")
    return [url] if isinstance(url, str) and url else []


def extract_frame_data_urls(path: Path, chunk: PlannedChunk) -> list[str]:
    if not path.exists() or not ffmpeg_available():
        return []

    frame_count = int(os.getenv("QWEN_FRAME_COUNT", str(DEFAULT_FRAME_COUNT)))
    frame_width = int(os.getenv("QWEN_FRAME_WIDTH", str(DEFAULT_FRAME_WIDTH)))
    with tempfile.TemporaryDirectory(prefix="describeops-frames-") as tmp:
        frame_dir = Path(tmp)
        pattern = frame_dir / "frame_%03d.jpg"
        duration = max(0.25, chunk.end - chunk.start)
        extract_fps = max(1.0 / max(duration, 1.0), min(DEFAULT_FPS, frame_count / max(duration, 1.0)))
        command = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{chunk.start:.3f}",
            "-i",
            str(path),
            "-t",
            f"{duration:.3f}",
            "-vf",
            f"fps={extract_fps:.6f},scale=w='min({frame_width},iw)':h=-2",
            "-frames:v",
            str(frame_count),
            "-q:v",
            "4",
            str(pattern),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True)
        except (OSError, subprocess.CalledProcessError):
            return []

        urls: list[str] = []
        total_bytes = 0
        for frame in sorted(frame_dir.glob("frame_*.jpg"))[:frame_count]:
            raw = frame.read_bytes()
            total_bytes += len(raw)
            if total_bytes > MAX_FRAME_DATA_URL_BYTES:
                break
            urls.append(f"data:image/jpeg;base64,{base64.b64encode(raw).decode('ascii')}")
        return urls


def analyze_chunk_with_qwen(
    *,
    gateway: QwenGateway,
    request: MediaAnalysisRequest,
    source: dict[str, Any],
    chunk: PlannedChunk,
    frames: list[str],
    trace_id: str,
) -> dict[str, Any]:
    prompt = chunk_prompt(request, chunk)
    if not frames:
        return {
            "chunkId": chunk_id(chunk),
            "start": chunk.start,
            "end": chunk.end,
            "analysis": fallback_chunk_text(request, source, chunk),
            "transport": "snapshot-fallback",
            "frameCount": 0,
            "importance": "medium",
        }

    try:
        result = gateway.describe_frame_list(
            video_id=safe_id(source.get("url") or source.get("path") or request.title),
            chunk_id=chunk_id(chunk),
            start=chunk.start,
            end=chunk.end,
            frames=frames,
            prompt=prompt,
            fps=DEFAULT_FPS,
            trace_id=trace_id,
        )
        return {
            "chunkId": chunk_id(chunk),
            "start": chunk.start,
            "end": chunk.end,
            "analysis": clean_analysis_text(result.content),
            "transport": "qwen-frame-list",
            "model": result.model,
            "latencyMs": result.latencyMs,
            "usage": result.usage.model_dump(),
            "frameCount": len(frames),
            "importance": "high" if chunk.index == 0 else "medium",
        }
    except Exception as exc:  # noqa: BLE001 - partial descriptions are better UX than a dead job
        return {
            "chunkId": chunk_id(chunk),
            "start": chunk.start,
            "end": chunk.end,
            "analysis": fallback_chunk_text(request, source, chunk),
            "transport": "fallback-after-qwen-error",
            "error": f"{type(exc).__name__}: {exc}",
            "frameCount": len(frames),
            "importance": "medium",
        }


def chunk_prompt(request: MediaAnalysisRequest, chunk: PlannedChunk) -> str:
    return (
        f"Analyze ONLY this media segment from {format_ts(chunk.start)} to {format_ts(chunk.end)}. "
        "Return two short present-tense sentences at most. "
        "Mention visible action, setting, people, important objects, and readable on-screen text. "
        "Use timestamps like [MM:SS] for specific beats. "
        "Do not describe website navigation or controls."
    )


def fallback_chunk_text(request: MediaAnalysisRequest, source: dict[str, Any], chunk: PlannedChunk) -> str:
    label = request.title or source.get("label") or "The selected media"
    platform = request.platform if request.platform != "generic" else "this page"
    if chunk.index == 0:
        return f"{label} is selected for visual description from {platform}."
    return f"Visual description continues around {format_ts(chunk.start)} for {label}."


def cue_from_chunk_result(result: dict[str, Any], *, index: int, title: str) -> dict[str, Any] | None:
    text = clean_analysis_text(result.get("analysis") or "")
    if not text:
        return None
    start = float(result.get("start") or 0)
    end = float(result.get("end") or start + 4)
    cue_end = min(max(start + 3.0, start), end if end > start else start + 4.0)
    return {
        "id": f"cue-{index + 1}",
        "start": round(start + 0.4, 1),
        "end": round(cue_end, 1),
        "text": text,
        "evidenceRefs": [result.get("chunkId", f"chunk-{index + 1}")],
        "confidence": 0.82 if result.get("transport") == "qwen-frame-list" else 0.58,
        "needsReview": result.get("transport") != "qwen-frame-list",
        "notes": f"Generated from chunked media analysis for {title}.",
        "impact": result.get("importance", "medium"),
        "qaWarnings": [] if result.get("transport") == "qwen-frame-list" else ["Visual evidence was limited for this segment."],
        "status": "accepted",
        "rememberable": False,
    }


def summarize_analysis(title: str, chunks: list[dict[str, Any]]) -> str:
    qwen = [chunk["analysis"] for chunk in chunks if chunk.get("transport") == "qwen-frame-list" and chunk.get("analysis")]
    if qwen:
        return f"{title}: {qwen[0]}"
    first = next((chunk.get("analysis") for chunk in chunks if chunk.get("analysis")), "")
    return str(first or f"{title} is ready for accessible playback.")


def clean_analysis_text(value: str) -> str:
    text = " ".join(str(value or "").strip().split())
    if text.startswith("```"):
        text = text.strip("`").strip()
    text = text.removeprefix("json").strip()
    if len(text) > 280:
        text = f"{text[:277].rstrip()}..."
    return text


def chunk_id(chunk: PlannedChunk) -> str:
    return f"chunk-{chunk.index + 1:04d}"


def safe_id(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def format_ts(seconds: float) -> str:
    total = max(0, int(seconds))
    minutes, secs = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def ffmpeg_available() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def asset_storage_path(filename: str | None, content_type: str | None) -> Path:
    suffix = Path(filename or "").suffix
    if not suffix:
        suffix = mimetypes.guess_extension(content_type or "") or ".bin"
    digest = hashlib.sha256(f"{filename}-{datetime.now(timezone.utc).timestamp()}".encode("utf-8")).hexdigest()[:16]
    root = Path(tempfile.gettempdir()) / "describeops-api-assets"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"asset-{digest}{suffix}"


def progress(
    callback: ProgressCallback | None,
    stage: AnalysisStage,
    message: str,
    percent: int,
    current_chunk: int | None = None,
    total_chunks: int | None = None,
    partial_cue_count: int | None = None,
) -> None:
    if callback:
        callback(stage, message, percent, current_chunk, total_chunks, partial_cue_count)
