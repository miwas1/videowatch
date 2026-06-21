#!/usr/bin/env python3
"""Download a YouTube video and analyze it with Qwen Cloud video understanding."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv

DEFAULT_MODEL = "qwen3.6-flash"
DEFAULT_FPS = 0.5
DEFAULT_CHUNK_SECONDS = 30
DEFAULT_FIRST_CHUNK_SECONDS = 6
DEFAULT_FRAME_COUNT = 4
DEFAULT_FRAME_WIDTH = 448
DEFAULT_FRAME_FORMAT = "jpg"
DEFAULT_MAX_PIXELS = 1_250_000
DEFAULT_MAX_TOKENS = 120
DEFAULT_TEMPERATURE = 0.2
DEFAULT_TOP_P = 0.7
LOCAL_FILE_LIMIT_MB = 100
BASE64_LIMIT_MB = 10
MAX_FRAMES_PER_CHUNK = 12
MAX_FRAME_WIDTH = 1024
PROMPT_VERSION = "live-frame-list-v2"

DASHSCOPE_REGION_BASES = {
    "china-beijing": "https://dashscope.aliyuncs.com",
    "china-hong-kong": "https://cn-hongkong.dashscope.aliyuncs.com",
    "singapore": "https://dashscope-intl.aliyuncs.com",
    "us-virginia": "https://dashscope-us.aliyuncs.com",
    "germany-frankfurt": "https://dashscope-eu-central-1.aliyuncs.com",
}

LIVE_PROMPT = """You are narrating this video LIVE for a presentation. The clip covers {start_label} to {end_label} of the full video.

Say one present-tense sentence first, under 18 words.
Then continue with at most two more short sentences.
- Include full-video timestamps inline like [MM:SS] when mentioning a beat
- Describe visible action, people, setting, on-screen text, and visual jokes
- No headings, no bullet lists, no "in this segment" meta-talk, no recap of earlier parts
- Keep it continuous and speakable

You receive video frames only; do not claim to have heard audio unless lip-sync or captions make it obvious."""

CHUNK_PROMPT = """Analyze ONLY this video clip ({start_label} to {end_label}).

Return a concise scene breakdown:
- Timestamps relative to the FULL video (offset {start_seconds:.0f}s)
- Visible actions, people, locations, props, on-screen text
- Bullet points, 4-8 items max

You receive video frames only; do not claim to have heard audio unless lip-sync or captions make speech obvious."""

SINGLE_PROMPT = """Analyze this video in full detail with overview, scene timeline (MM:SS), people, on-screen text, themes, and accessibility notes.
You receive video frames only."""

USAGE = """\
Usage:
  python scripts/youtube_qwen_analyze.py "https://www.youtube.com/watch?v=VIDEO_ID"
  python scripts/youtube_qwen_analyze.py URL --presentation
  python scripts/youtube_qwen_analyze.py URL --first-chunk-seconds 6 --chunk-seconds 30 --fps 0.25

Environment:
  DASHSCOPE_API_KEY or QWEN_API_KEY — Qwen Cloud API key
  DASHSCOPE_BASE_URL — optional (default: China compatible endpoint)
"""


@dataclass(frozen=True)
class VideoChunk:
    index: int
    start_seconds: float
    end_seconds: float
    path: Path
    frames: tuple[Path, ...] = ()


@dataclass(frozen=True)
class FrameSettings:
    frame_count: int
    frame_width: int
    frame_format: str
    fps: float
    max_pixels: int


@dataclass(frozen=True)
class ModelSettings:
    max_tokens: int
    temperature: float
    top_p: float
    enable_thinking: bool
    thinking_budget: int | None
    dashscope_base_url: str | None
    endpoint_region: str | None


@dataclass(frozen=True)
class CacheOptions:
    cache_dir: Path
    no_cache: bool
    refresh_cache: bool
    video_id: str


class StageTimer:
    def __init__(self) -> None:
        self._started = time.perf_counter()
        self.marks: list[tuple[str, float]] = []
        self.first_token_at: float | None = None

    def elapsed(self) -> float:
        return time.perf_counter() - self._started

    def log(self, message: str) -> None:
        print(f"[{self.elapsed():7.2f}s] {message}", file=sys.stderr, flush=True)

    def mark(self, name: str) -> float:
        elapsed = self.elapsed()
        self.marks.append((name, elapsed))
        return elapsed

    def note_first_token(self) -> None:
        if self.first_token_at is None:
            self.first_token_at = self.elapsed()
            self.log(f"time-to-first-token: {self.first_token_at:.2f}s")


def load_project_env() -> None:
    for directory in [Path.cwd(), *Path.cwd().parents]:
        env_path = directory / ".env"
        if env_path.is_file():
            load_dotenv(env_path, override=False)
            return


def resolve_api_key(explicit: str | None) -> str:
    key = explicit or os.getenv("DASHSCOPE_API_KEY") or os.getenv("QWEN_API_KEY")
    if not key:
        raise SystemExit(
            "Missing API key. Set DASHSCOPE_API_KEY (or QWEN_API_KEY) or pass --api-key."
        )
    return key


def normalize_dashscope_base(base: str, *, compatible: bool) -> str:
    base = base.rstrip("/")
    if base.endswith("/compatible-mode/v1"):
        root = base[: -len("/compatible-mode/v1")]
    elif base.endswith("/api/v1"):
        root = base[: -len("/api/v1")]
    else:
        root = base
    return root + ("/compatible-mode/v1" if compatible else "/api/v1")


def resolve_dashscope_base(
    *,
    explicit_base_url: str | None,
    endpoint_region: str | None,
    compatible: bool,
) -> str:
    if explicit_base_url:
        return normalize_dashscope_base(explicit_base_url, compatible=compatible)
    if endpoint_region:
        return normalize_dashscope_base(DASHSCOPE_REGION_BASES[endpoint_region], compatible=compatible)
    base = os.getenv(
        "DASHSCOPE_BASE_URL",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    return normalize_dashscope_base(base, compatible=compatible)


def dashscope_http_base(settings: ModelSettings | None = None) -> str:
    base = resolve_dashscope_base(
        explicit_base_url=settings.dashscope_base_url if settings else None,
        endpoint_region=settings.endpoint_region if settings else None,
        compatible=False,
    )
    if base.endswith("/compatible-mode/v1"):
        return base[: -len("/compatible-mode/v1")] + "/api/v1"
    if base.endswith("/api/v1"):
        return base
    return base + "/api/v1"


def openai_compatible_base(settings: ModelSettings | None = None) -> str:
    base = resolve_dashscope_base(
        explicit_base_url=settings.dashscope_base_url if settings else None,
        endpoint_region=settings.endpoint_region if settings else None,
        compatible=True,
    )
    if base.endswith("/compatible-mode/v1"):
        return base
    return base + "/compatible-mode/v1"


def mb(path: Path) -> float:
    return path.stat().st_size / (1024 * 1024)


def total_mb(paths: tuple[Path, ...] | list[Path]) -> float:
    return sum(path.stat().st_size for path in paths if path.exists()) / (1024 * 1024)


def format_ts(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def probe_image_size(path: Path) -> tuple[int, int]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=s=x:p=0",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    width, height = result.stdout.strip().split("x", 1)
    return int(width), int(height)


def hash_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:24]


def youtube_id_from_url(url: str) -> str | None:
    from urllib.parse import parse_qs, urlparse

    parsed = urlparse(url)
    host = parsed.netloc.lower()
    if "youtube.com" in host:
        query_id = parse_qs(parsed.query).get("v", [None])[0]
        if query_id:
            return query_id
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 2 and parts[0] in {"shorts", "embed", "live"}:
            return parts[1]
    if "youtu.be" in host:
        parts = [part for part in parsed.path.split("/") if part]
        if parts:
            return parts[0]
    return None


def safe_video_id(url: str) -> str:
    return youtube_id_from_url(url) or f"url-{hash_json({'url': url})}"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def benchmark_dashscope_endpoints(cache_dir: Path, timer: StageTimer) -> dict[str, Any]:
    from urllib.parse import urlparse

    results: list[dict[str, Any]] = []
    for region, base in DASHSCOPE_REGION_BASES.items():
        parsed = urlparse(base)
        host = parsed.netloc or parsed.path
        started = time.perf_counter()
        try:
            with socket.create_connection((host, 443), timeout=4) as sock:
                context = ssl.create_default_context()
                with context.wrap_socket(sock, server_hostname=host):
                    pass
            latency_ms = round((time.perf_counter() - started) * 1000)
            results.append({"region": region, "base_url": base, "latency_ms": latency_ms, "ok": True})
            timer.log(f"endpoint benchmark {region}: {latency_ms} ms")
        except OSError as exc:
            results.append({"region": region, "base_url": base, "ok": False, "error": str(exc)})
            timer.log(f"endpoint benchmark {region}: failed ({exc})")

    ok_results = [result for result in results if result.get("ok")]
    fastest = min(ok_results, key=lambda result: result["latency_ms"]) if ok_results else None
    payload = {
        "benchmarked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "fastest": fastest,
        "results": results,
    }
    write_json(cache_dir / "endpoint-benchmark.json", payload)
    if fastest:
        timer.log(f"fastest endpoint: {fastest['region']} ({fastest['latency_ms']} ms)")
    return payload


def ytdlp_base_opts(
    work_dir: Path,
    *,
    low_bandwidth: bool = False,
    include_audio: bool = False,
) -> dict[str, Any]:
    height = 144 if low_bandwidth else 360
    if include_audio:
        format_selector = f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"
    else:
        format_selector = f"bv*[height<={height}][ext=mp4]/b[height<={height}][ext=mp4]/b"
    return {
        "format": format_selector,
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_with_newline": False,
    }


def fetch_youtube_metadata(url: str, timer: StageTimer, cache: CacheOptions | None = None) -> dict[str, Any]:
    if cache and not cache.no_cache:
        metadata_path = cache.cache_dir / "metadata" / f"{cache.video_id}.json"
        if metadata_path.exists() and not cache.refresh_cache:
            cached = read_json(metadata_path)
            if cached:
                timer.log(f"metadata cache hit: id={cache.video_id}")
                return cached

    try:
        import yt_dlp
    except ImportError as exc:
        raise SystemExit(
            "yt-dlp is required. Install deps: pip install -r scripts/requirements-youtube-qwen.txt"
        ) from exc

    timer.log("metadata fetch start")
    with yt_dlp.YoutubeDL(ytdlp_base_opts(Path("."))) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise RuntimeError("yt-dlp returned no metadata")
    timer.log(
        f"metadata ready: {info.get('title', 'untitled')} "
        f"({info.get('duration', '?')}s, id={info.get('id')})"
    )
    if cache and not cache.no_cache:
        metadata_path = cache.cache_dir / "metadata" / f"{info.get('id') or cache.video_id}.json"
        write_json(metadata_path, info)
    return info


def download_youtube_section(
    url: str,
    work_dir: Path,
    *,
    start: float,
    end: float,
    timer: StageTimer,
    label: str,
    low_bandwidth: bool = False,
    cache: CacheOptions | None = None,
) -> Path:
    try:
        import yt_dlp
    except ImportError as exc:
        raise SystemExit(
            "yt-dlp is required. Install deps: pip install -r scripts/requirements-youtube-qwen.txt"
        ) from exc

    cache_key = hash_json(
        {
            "video_id": cache.video_id if cache else safe_video_id(url),
            "start": round(start, 3),
            "end": round(end, 3),
            "low_bandwidth": low_bandwidth,
        "format": ytdlp_base_opts(work_dir, low_bandwidth=low_bandwidth, include_audio=False)["format"],
        }
    )
    target_dir = work_dir
    if cache and not cache.no_cache:
        target_dir = cache.cache_dir / "sections" / cache_key
        if target_dir.exists() and not cache.refresh_cache:
            candidates = sorted(target_dir.glob("section_*.*"))
            if candidates:
                timer.log(
                    f"section cache hit {label}: {format_ts(start)}-{format_ts(end)} "
                    f"({mb(candidates[0]):.1f} MB)"
                )
                return candidates[0]
        target_dir.mkdir(parents=True, exist_ok=True)
    else:
        target_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    outtmpl = str(target_dir / f"section_{int(start)}_{int(end)}.%(ext)s")
    ydl_opts = {
        **ytdlp_base_opts(target_dir, low_bandwidth=low_bandwidth, include_audio=False),
        "outtmpl": outtmpl,
        "download_sections": f"*{start}-{end}",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError(f"Section download failed for {label}")
        path = Path(ydl.prepare_filename(info))
        if path.suffix != ".mp4" and path.with_suffix(".mp4").exists():
            path = path.with_suffix(".mp4")

    if not path.exists():
        candidates = sorted(target_dir.glob(f"section_{int(start)}_{int(end)}.*"))
        if not candidates:
            raise RuntimeError(f"Section file missing for {label}")
        path = candidates[0]

    timer.log(
        f"section ready {label}: {format_ts(start)}-{format_ts(end)} "
        f"({mb(path):.1f} MB, {time.perf_counter() - started:.1f}s)"
    )
    return path


def download_youtube_full(
    url: str,
    work_dir: Path,
    *,
    max_file_mb: int,
    max_duration: int | None,
    timer: StageTimer,
) -> tuple[Path, dict[str, Any]]:
    try:
        import yt_dlp
    except ImportError as exc:
        raise SystemExit(
            "yt-dlp is required. Install deps: pip install -r scripts/requirements-youtube-qwen.txt"
        ) from exc

    format_chain = [
        "bv*[height<=360][ext=mp4]/b[height<=360][ext=mp4]/b",
        "b",
    ]
    last_error: Exception | None = None
    for fmt in format_chain:
        ydl_opts: dict[str, Any] = {
            **ytdlp_base_opts(work_dir),
            "format": fmt,
            "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
        }
        if max_duration:
            ydl_opts["download_sections"] = f"*0-{max_duration}"
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                if info is None:
                    raise RuntimeError("yt-dlp returned no metadata")
                video_path = Path(ydl.prepare_filename(info))
            if not video_path.exists():
                candidates = list(work_dir.glob(f"{info.get('id', '*')}.*"))
                if not candidates:
                    raise RuntimeError("Download finished but video file was not found")
                video_path = candidates[0]
            if mb(video_path) <= max_file_mb:
                timer.log(
                    f"full download ok: {video_path.name} ({mb(video_path):.1f} MB, format={fmt})"
                )
                return video_path, info
            last_error = RuntimeError(f"File {mb(video_path):.1f} MB exceeds {max_file_mb} MB")
        except Exception as exc:  # noqa: BLE001
            last_error = exc
    raise RuntimeError(f"Full download failed: {last_error}")


def plan_chunk_ranges(
    duration: float,
    *,
    chunk_seconds: int,
    first_chunk_seconds: int,
) -> list[tuple[float, float]]:
    ranges: list[tuple[float, float]] = []
    start = 0.0
    while start < duration - 0.5:
        span = first_chunk_seconds if not ranges else chunk_seconds
        end = min(start + span, duration)
        if end - start < 2:
            break
        ranges.append((start, end))
        start = end
    return ranges


def cut_video_segment(
    source: Path,
    work_dir: Path,
    *,
    index: int,
    start: float,
    end: float,
    timer: StageTimer,
) -> Path:
    out_path = work_dir / f"chunk_{index:03d}.mp4"
    started = time.perf_counter()
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(source),
            "-t",
            f"{end - start:.3f}",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            str(out_path),
        ],
        check=True,
        capture_output=True,
    )
    timer.log(
        f"cut chunk {index + 1}: {format_ts(start)}-{format_ts(end)} "
        f"({mb(out_path):.1f} MB, {time.perf_counter() - started:.1f}s)"
    )
    return out_path


def validate_frame_settings(settings: FrameSettings) -> FrameSettings:
    if settings.frame_count < 1:
        raise SystemExit("--frame-count must be at least 1")
    if settings.frame_count > MAX_FRAMES_PER_CHUNK:
        raise SystemExit(f"--frame-count must be <= {MAX_FRAMES_PER_CHUNK}")
    if settings.frame_width < 64 or settings.frame_width > MAX_FRAME_WIDTH:
        raise SystemExit(f"--frame-width must be between 64 and {MAX_FRAME_WIDTH}")
    if settings.frame_format not in {"jpg", "webp"}:
        raise SystemExit("--frame-format must be jpg or webp")
    if settings.fps <= 0:
        raise SystemExit("--fps must be greater than 0")
    if settings.max_pixels < 32 * 32:
        raise SystemExit("--max-pixels is too small")
    return settings


def frame_mime(frame_format: str) -> str:
    return "image/webp" if frame_format == "webp" else "image/jpeg"


def cleanup_frames(frame_dir: Path, frame_format: str) -> None:
    for frame in frame_dir.glob(f"frame_*.{frame_format}"):
        frame.unlink(missing_ok=True)


def run_ffmpeg_frame_extract(
    source: Path,
    frame_dir: Path,
    *,
    duration: float,
    settings: FrameSettings,
) -> tuple[Path, ...]:
    frame_dir.mkdir(parents=True, exist_ok=True)
    cleanup_frames(frame_dir, settings.frame_format)

    extract_fps = max(1.0 / max(duration, 1.0), min(settings.fps, settings.frame_count / max(duration, 1.0)))
    vf = f"fps={extract_fps:.6f},scale=w='min({settings.frame_width},iw)':h=-2"
    out_pattern = frame_dir / f"frame_%03d.{settings.frame_format}"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-vf",
        vf,
        "-frames:v",
        str(settings.frame_count),
    ]
    if settings.frame_format == "webp":
        command.extend(["-quality", "70", "-compression_level", "4"])
    else:
        command.extend(["-q:v", "4"])
    command.append(str(out_pattern))
    subprocess.run(command, check=True, capture_output=True)
    return tuple(sorted(frame_dir.glob(f"frame_*.{settings.frame_format}"))[: settings.frame_count])


def extracted_frames_total_pixels(frames: tuple[Path, ...]) -> int:
    total = 0
    for frame in frames:
        width, height = probe_image_size(frame)
        total += width * height
    return total


def extract_frames_from_chunk(
    chunk: VideoChunk,
    frame_dir: Path,
    *,
    settings: FrameSettings,
    timer: StageTimer,
    cache: CacheOptions | None = None,
) -> tuple[Path, ...]:
    settings = validate_frame_settings(settings)
    duration = max(0.25, chunk.end_seconds - chunk.start_seconds)
    cache_key = hash_json(
        {
            "video_id": cache.video_id if cache else None,
            "start": round(chunk.start_seconds, 3),
            "end": round(chunk.end_seconds, 3),
            "fps": settings.fps,
            "frame_count": settings.frame_count,
            "frame_width": settings.frame_width,
            "frame_format": settings.frame_format,
            "max_pixels": settings.max_pixels,
        }
    )
    target_dir = frame_dir
    manifest_path: Path | None = None
    if cache and not cache.no_cache:
        target_dir = cache.cache_dir / "frames" / cache_key
        manifest_path = target_dir / "manifest.json"
        if manifest_path.exists() and not cache.refresh_cache:
            manifest = read_json(manifest_path) or {}
            frames = tuple(Path(path) for path in manifest.get("frames", []))
            if frames and all(frame.exists() for frame in frames):
                timer.log(
                    f"frame cache hit chunk {chunk.index + 1}: {len(frames)} frames, "
                    f"{total_mb(frames):.2f} MB"
                )
                return frames

    started = time.perf_counter()
    frames = run_ffmpeg_frame_extract(chunk.path, target_dir, duration=duration, settings=settings)
    if not frames:
        raise RuntimeError(f"No frames extracted for chunk {chunk.index + 1}")

    total_pixels = extracted_frames_total_pixels(frames)
    if total_pixels > settings.max_pixels and settings.frame_width > 64:
        scale = (settings.max_pixels / total_pixels) ** 0.5
        next_width = max(64, int(settings.frame_width * scale))
        bounded = FrameSettings(
            frame_count=settings.frame_count,
            frame_width=next_width,
            frame_format=settings.frame_format,
            fps=settings.fps,
            max_pixels=settings.max_pixels,
        )
        frames = run_ffmpeg_frame_extract(chunk.path, target_dir, duration=duration, settings=bounded)
        total_pixels = extracted_frames_total_pixels(frames)

    if manifest_path:
        write_json(
            manifest_path,
            {
                "frames": [str(frame) for frame in frames],
                "settings": settings.__dict__,
                "total_pixels": total_pixels,
            },
        )

    timer.log(
        f"frames ready chunk {chunk.index + 1}: {len(frames)} {settings.frame_format} frames, "
        f"{total_mb(frames):.2f} MB, pixels={total_pixels}, {time.perf_counter() - started:.1f}s"
    )
    return frames


def chunk_prompt(chunk: VideoChunk, *, presentation: bool) -> str:
    template = LIVE_PROMPT if presentation else CHUNK_PROMPT
    return template.format(
        start_label=format_ts(chunk.start_seconds),
        end_label=format_ts(chunk.end_seconds),
        start_seconds=chunk.start_seconds,
    )


def build_openai_frame_message(frames: tuple[Path, ...], prompt: str, fps: float) -> list[dict[str, Any]]:
    urls = []
    for frame in frames:
        encoded = base64.b64encode(frame.read_bytes()).decode("utf-8")
        urls.append(f"data:{frame_mime(frame.suffix.lstrip('.'))};base64,{encoded}")
    return [
        {"type": "video", "video": urls, "fps": fps},
        {"type": "text", "text": prompt},
    ]


def build_dashscope_frame_content(frames: tuple[Path, ...], prompt: str, fps: float) -> list[dict[str, Any]]:
    return [
        {"video": [f"file://{frame.resolve()}" for frame in frames], "fps": fps},
        {"text": prompt},
    ]


def extract_message_text(content: Any) -> str:
    if isinstance(content, list):
        return next(
            (part.get("text", "") for part in content if isinstance(part, dict) and part.get("text")),
            json.dumps(content, ensure_ascii=False),
        )
    return str(content or "")


def analyze_with_openai_stream(
    *,
    api_key: str,
    frames: tuple[Path, ...],
    model: str,
    prompt: str,
    fps: float,
    settings: ModelSettings,
    on_token: Callable[[str], None],
    timer: StageTimer,
) -> dict[str, Any]:
    from openai import OpenAI

    started = time.perf_counter()
    client = OpenAI(api_key=api_key, base_url=openai_compatible_base(settings), timeout=180.0)
    content = build_openai_frame_message(frames, prompt, fps)
    parts: list[str] = []
    usage: dict[str, Any] = {}
    request_id: str | None = None
    first_token_logged = False
    extra_body: dict[str, Any] = {"enable_thinking": settings.enable_thinking}
    if settings.thinking_budget is not None:
        extra_body["thinking_budget"] = settings.thinking_budget

    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        stream=True,
        stream_options={"include_usage": True},
        max_tokens=settings.max_tokens,
        temperature=settings.temperature,
        top_p=settings.top_p,
        extra_body=extra_body,
    )

    for event in stream:
        if event.id:
            request_id = event.id
        if event.usage:
            usage = event.usage.model_dump()
        delta = event.choices[0].delta.content if event.choices else None
        if delta:
            if not first_token_logged:
                timer.note_first_token()
                first_token_logged = True
            parts.append(delta)
            on_token(delta)

    text = "".join(parts).strip()
    return {
        "analysis": text,
        "model": model,
        "transport": "openai_stream_frame_list",
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": usage,
        "request_id": request_id,
    }


def dashscope_stream_text(response: Any) -> str:
    try:
        content = response.output.choices[0].message.content
    except (AttributeError, IndexError, KeyError):
        return ""
    return extract_message_text(content)


def analyze_with_dashscope(
    *,
    api_key: str,
    frames: tuple[Path, ...],
    model: str,
    prompt: str,
    fps: float,
    settings: ModelSettings,
    on_token: Callable[[str], None] | None,
    timer: StageTimer,
) -> dict[str, Any]:
    try:
        import dashscope
        from dashscope import MultiModalConversation
    except ImportError as exc:
        raise SystemExit(
            "dashscope is required. Install deps: pip install -r scripts/requirements-youtube-qwen.txt"
        ) from exc

    dashscope.base_http_api_url = dashscope_http_base(settings)
    started = time.perf_counter()
    messages = [{"role": "user", "content": build_dashscope_frame_content(frames, prompt, fps)}]
    call_kwargs: dict[str, Any] = {
        "api_key": api_key,
        "model": model,
        "messages": messages,
        "stream": True,
        "incremental_output": True,
        "max_tokens": settings.max_tokens,
        "temperature": settings.temperature,
        "top_p": settings.top_p,
        "enable_thinking": settings.enable_thinking,
    }
    if settings.thinking_budget is not None:
        call_kwargs["thinking_budget"] = settings.thinking_budget

    try:
        responses = MultiModalConversation.call(**call_kwargs)
        parts: list[str] = []
        usage: dict[str, Any] = {}
        request_id: str | None = None
        first_token_logged = False
        for response in responses:
            request_id = getattr(response, "request_id", request_id)
            if getattr(response, "status_code", 200) != 200:
                raise RuntimeError(
                    f"DashScope error {response.status_code}: {getattr(response, 'message', response)}"
                )
            text = dashscope_stream_text(response)
            if text:
                if not first_token_logged:
                    timer.note_first_token()
                    first_token_logged = True
                parts.append(text)
                if on_token:
                    on_token(text)
            usage_obj = getattr(response, "usage", None)
            if usage_obj:
                usage = usage_obj if isinstance(usage_obj, dict) else getattr(usage_obj, "__dict__", {})
        return {
            "analysis": "".join(parts).strip(),
            "model": model,
            "transport": "dashscope_stream_frame_list",
            "latency_ms": round((time.perf_counter() - started) * 1000),
            "usage": usage,
            "request_id": request_id,
        }
    except Exception as dashscope_exc:  # noqa: BLE001
        timer.log(f"DashScope native stream failed, falling back to OpenAI-compatible stream: {dashscope_exc}")
        if on_token is None:
            collected: list[str] = []

            def collect(token: str) -> None:
                collected.append(token)

            on_token = collect
        return analyze_with_openai_stream(
            api_key=api_key,
            frames=frames,
            model=model,
            prompt=prompt,
            fps=fps,
            settings=settings,
            on_token=on_token,
            timer=timer,
        )


def analyze_chunk(
    *,
    api_key: str,
    chunk: VideoChunk,
    model: str,
    fps: float,
    model_settings: ModelSettings,
    frame_settings: FrameSettings,
    presentation: bool,
    on_token: Callable[[str], None] | None,
    timer: StageTimer,
    cache: CacheOptions | None = None,
) -> dict[str, Any]:
    if not chunk.frames:
        raise RuntimeError(f"Chunk {chunk.index + 1} has no extracted frames")
    prompt = chunk_prompt(chunk, presentation=presentation)
    cache_key = hash_json(
        {
            "video_id": cache.video_id if cache else None,
            "start": round(chunk.start_seconds, 3),
            "end": round(chunk.end_seconds, 3),
            "prompt_version": PROMPT_VERSION,
            "prompt": prompt,
            "model": model,
            "fps": fps,
            "frame_settings": frame_settings.__dict__,
            "model_settings": model_settings.__dict__,
        }
    )
    cache_path = None
    if cache and not cache.no_cache:
        cache_path = cache.cache_dir / "outputs" / f"{cache_key}.json"
        if cache_path.exists() and not cache.refresh_cache:
            cached = read_json(cache_path)
            if cached and cached.get("analysis"):
                timer.log(f"model output cache hit chunk {chunk.index + 1}")
                if on_token:
                    timer.note_first_token()
                    on_token(cached["analysis"])
                cached["transport"] = "cache"
                return cached

    result = analyze_with_dashscope(
        api_key=api_key,
        frames=chunk.frames,
        model=model,
        prompt=prompt,
        fps=fps,
        settings=model_settings,
        on_token=on_token,
        timer=timer,
    )
    result["chunk"] = {
        "index": chunk.index,
        "start_seconds": chunk.start_seconds,
        "end_seconds": chunk.end_seconds,
        "start_label": format_ts(chunk.start_seconds),
        "end_label": format_ts(chunk.end_seconds),
        "section_file_mb": round(mb(chunk.path), 2),
        "frame_count": len(chunk.frames),
        "frame_file_mb": round(total_mb(chunk.frames), 3),
        "frames": [str(frame) for frame in chunk.frames],
    }
    if cache_path:
        write_json(cache_path, result)
    return result


class ChunkPrefetcher:
    """Download sections and extract frames several chunks ahead."""

    def __init__(
        self,
        *,
        url: str,
        work_dir: Path,
        ranges: list[tuple[float, float]],
        full_future: Future[tuple[Path, dict[str, Any]]] | None,
        frame_settings: FrameSettings,
        cache: CacheOptions | None,
        timer: StageTimer,
        prefetch_depth: int,
    ) -> None:
        self.url = url
        self.work_dir = work_dir
        self.ranges = ranges
        self.full_future = full_future
        self.frame_settings = frame_settings
        self.cache = cache
        self.timer = timer
        self.prefetch_depth = max(1, prefetch_depth)
        # Queue multiple prepared chunks, but keep section downloads serialized to avoid
        # starving the first live chunk on limited bandwidth.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="chunk-prefetch")
        self._futures: dict[int, Future[VideoChunk]] = {}

    def prefetch(self, index: int) -> None:
        if index in self._futures or index >= len(self.ranges):
            return
        self._futures[index] = self._executor.submit(self._prepare, index)

    def prefetch_window(self, current_index: int) -> None:
        for index in range(current_index, min(len(self.ranges), current_index + self.prefetch_depth)):
            self.prefetch(index)

    def get(self, index: int) -> VideoChunk:
        if index not in self._futures:
            self.prefetch(index)
        return self._futures[index].result()

    def _prepare(self, index: int) -> VideoChunk:
        start, end = self.ranges[index]
        label = f"{index + 1}/{len(self.ranges)}"
        self.timer.log(f"prefetch start chunk {label}: {format_ts(start)}-{format_ts(end)}")

        if index > 0 and self.full_future is not None:
            try:
                full_path, _info = self.full_future.result()
                cut_dir = self.work_dir / "cuts"
                cut_dir.mkdir(parents=True, exist_ok=True)
                path = cut_video_segment(
                    full_path,
                    cut_dir,
                    index=index,
                    start=start,
                    end=end,
                    timer=self.timer,
                )
                chunk = VideoChunk(index=index, start_seconds=start, end_seconds=end, path=path)
                frames = extract_frames_from_chunk(
                    chunk,
                    self.work_dir / "frames" / f"chunk_{index:03d}",
                    settings=self.frame_settings,
                    timer=self.timer,
                    cache=self.cache,
                )
                return VideoChunk(
                    index=index,
                    start_seconds=start,
                    end_seconds=end,
                    path=path,
                    frames=frames,
                )
            except Exception as exc:  # noqa: BLE001
                self.timer.log(f"full-video cut failed for chunk {label}, falling back to section: {exc}")

        section_dir = self.work_dir / "sections"
        section_dir.mkdir(parents=True, exist_ok=True)
        path = download_youtube_section(
            self.url,
            section_dir,
            start=start,
            end=end,
            timer=self.timer,
            label=label,
            low_bandwidth=index == 0,
            cache=self.cache,
        )
        chunk = VideoChunk(index=index, start_seconds=start, end_seconds=end, path=path)
        frames = extract_frames_from_chunk(
            chunk,
            self.work_dir / "frames" / f"chunk_{index:03d}",
            settings=self.frame_settings,
            timer=self.timer,
            cache=self.cache,
        )
        return VideoChunk(index=index, start_seconds=start, end_seconds=end, path=path, frames=frames)

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


def run_live_pipeline(
    *,
    url: str,
    api_key: str,
    metadata: dict[str, Any],
    work_dir: Path,
    model: str,
    fps: float,
    frame_settings: FrameSettings,
    model_settings: ModelSettings,
    chunk_seconds: int,
    first_chunk_seconds: int,
    prefetch_depth: int,
    ahead_analysis: bool,
    allow_early_narration: bool,
    max_live_lag_seconds: float,
    presentation: bool,
    json_output: bool,
    max_file_mb: int,
    max_duration: int | None,
    cache: CacheOptions,
    timer: StageTimer,
) -> list[dict[str, Any]]:
    duration = float(max_duration or metadata.get("duration") or 0)
    if duration <= 0:
        raise SystemExit("Could not determine video duration from metadata.")

    ranges = plan_chunk_ranges(
        duration,
        chunk_seconds=chunk_seconds,
        first_chunk_seconds=first_chunk_seconds,
    )
    timer.log(
        f"live pipeline: {len(ranges)} segments over {format_ts(duration)}, first={first_chunk_seconds}s, "
        f"then={chunk_seconds}s, model={model}, fps={fps}, frames<={frame_settings.frame_count}"
    )

    download_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="full-download")
    full_future: Future[tuple[Path, dict[str, Any]]] | None = None

    def start_full_download_once() -> None:
        nonlocal full_future
        if full_future is not None:
            return
        full_dir = work_dir / "full"
        full_dir.mkdir(parents=True, exist_ok=True)
        full_future = download_pool.submit(
            download_youtube_full,
            url,
            full_dir,
            max_file_mb=max_file_mb,
            max_duration=max_duration,
            timer=timer,
        )
        prefetcher.full_future = full_future
        timer.log("full-video background download started")

    prefetcher = ChunkPrefetcher(
        url=url,
        work_dir=work_dir,
        ranges=ranges,
        full_future=full_future,
        frame_settings=frame_settings,
        cache=cache,
        timer=timer,
        prefetch_depth=prefetch_depth,
    )

    results: list[dict[str, Any]] = []
    buffer_states: dict[int, str] = {}
    analysis_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="chunk-analysis") if ahead_analysis else None
    analysis_futures: dict[int, Future[dict[str, Any]]] = {}
    playback_zero = time.perf_counter()

    def wait_for_chunk_time(chunk: VideoChunk) -> None:
        if allow_early_narration:
            return
        due_at = playback_zero + chunk.start_seconds
        now = time.perf_counter()
        if now - due_at > max_live_lag_seconds:
            return
        if now < due_at:
            time.sleep(due_at - now)

    def analyze_prepared_chunk(chunk_index: int) -> dict[str, Any]:
        buffer_states[chunk_index] = "analyzing"
        chunk_for_analysis = prefetcher.get(chunk_index)
        result_for_analysis = analyze_chunk(
            api_key=api_key,
            chunk=chunk_for_analysis,
            model=model,
            fps=fps,
            model_settings=model_settings,
            frame_settings=frame_settings,
            presentation=presentation,
            on_token=None,
            timer=timer,
            cache=cache,
        )
        result_for_analysis["buffer_state"] = "ready"
        buffer_states[chunk_index] = "ready"
        return result_for_analysis

    prefetcher.prefetch(0)

    for index, (start, end) in enumerate(ranges):
        chunk = prefetcher.get(index)
        buffer_states[index] = buffer_states.get(index, "prepared")
        wait_for_chunk_time(chunk)
        timer.log(
            f"api stream start chunk {index + 1}/{len(ranges)}: "
            f"{format_ts(start)}-{format_ts(end)} "
            f"({len(chunk.frames)} frames, {total_mb(chunk.frames):.2f} MB)"
        )

        full_download_started_by_token = False

        def on_token(token: str) -> None:
            nonlocal full_download_started_by_token
            if not full_download_started_by_token:
                full_download_started_by_token = True
                start_full_download_once()
                prefetcher.prefetch_window(index + 1)
                if analysis_pool:
                    for future_index in range(index + 1, min(len(ranges), index + 1 + prefetch_depth)):
                        if future_index not in analysis_futures:
                            buffer_states[future_index] = "prepared"
                            analysis_futures[future_index] = analysis_pool.submit(
                                analyze_prepared_chunk,
                                future_index,
                            )
            if not json_output:
                print(token, end="", flush=True)

        if not json_output and index > 0:
            print(" ", end="", flush=True)

        chunk_started = time.perf_counter()
        if index in analysis_futures:
            result = analysis_futures.pop(index).result()
            if result.get("analysis"):
                on_token(result["analysis"])
        else:
            result = analyze_chunk(
                api_key=api_key,
                chunk=chunk,
                model=model,
                fps=fps,
                model_settings=model_settings,
                frame_settings=frame_settings,
                presentation=presentation,
                on_token=on_token,
                timer=timer,
                cache=cache,
            )
        if not full_download_started_by_token:
            prefetcher.prefetch_window(index + 1)
            if analysis_pool:
                for future_index in range(index + 1, min(len(ranges), index + 1 + prefetch_depth)):
                    if future_index not in analysis_futures:
                        buffer_states[future_index] = "prepared"
                        analysis_futures[future_index] = analysis_pool.submit(
                            analyze_prepared_chunk,
                            future_index,
                        )
        if not full_download_started_by_token:
            start_full_download_once()
        result["buffer_state"] = "played"
        buffer_states[index] = "played"
        timer.log(
            f"stream chunk {index + 1}/{len(ranges)} done: "
            f"{result.get('latency_ms', 0)} ms (wall {time.perf_counter() - chunk_started:.1f}s)"
        )
        results.append(result)

    prefetcher.close()
    if analysis_pool:
        analysis_pool.shutdown(wait=False, cancel_futures=True)
    download_pool.shutdown(wait=False)
    return results


def split_video(
    video_path: Path,
    work_dir: Path,
    *,
    chunk_seconds: int,
    duration: float,
    frame_settings: FrameSettings,
    cache: CacheOptions | None,
    timer: StageTimer,
) -> list[VideoChunk]:
    chunks: list[VideoChunk] = []
    start = 0.0
    index = 0
    while start < duration - 0.25:
        end = min(start + chunk_seconds, duration)
        path = cut_video_segment(
            video_path,
            work_dir,
            index=index,
            start=start,
            end=end,
            timer=timer,
        )
        chunk = VideoChunk(index=index, start_seconds=start, end_seconds=end, path=path)
        frames = extract_frames_from_chunk(
            chunk,
            work_dir / "frames" / f"chunk_{index:03d}",
            settings=frame_settings,
            timer=timer,
            cache=cache,
        )
        chunks.append(VideoChunk(index=index, start_seconds=start, end_seconds=end, path=path, frames=frames))
        start = end
        index += 1
    return chunks


def run_chunked_analysis(
    *,
    api_key: str,
    chunks: list[VideoChunk],
    model: str,
    fps: float,
    frame_settings: FrameSettings,
    model_settings: ModelSettings,
    presentation: bool,
    json_output: bool,
    cache: CacheOptions | None,
    timer: StageTimer,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    total = len(chunks)
    for chunk in chunks:
        timer.log(f"chunk {chunk.index + 1}/{total} request")

        def on_token(token: str) -> None:
            if not json_output:
                print(token, end="", flush=True)

        if not json_output and chunk.index > 0:
            print(" ", end="", flush=True)

        results.append(
            analyze_chunk(
                api_key=api_key,
                chunk=chunk,
                model=model,
                fps=fps,
                model_settings=model_settings,
                frame_settings=frame_settings,
                presentation=presentation,
                on_token=on_token,
                timer=timer,
                cache=cache,
            )
        )
    return results


def run_single_analysis(
    *,
    api_key: str,
    frames: tuple[Path, ...],
    model: str,
    prompt: str,
    fps: float,
    model_settings: ModelSettings,
    json_output: bool,
    timer: StageTimer,
) -> dict[str, Any]:
    def on_token(token: str) -> None:
        if not json_output:
            print(token, end="", flush=True)

    return analyze_with_dashscope(
        api_key=api_key,
        frames=frames,
        model=model,
        prompt=prompt,
        fps=fps,
        settings=model_settings,
        on_token=on_token,
        timer=timer,
    )


def compact_metadata(info: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "description": info.get("description"),
        "channel": info.get("channel") or info.get("uploader"),
        "duration_seconds": info.get("duration"),
        "upload_date": info.get("upload_date"),
        "view_count": info.get("view_count"),
        "webpage_url": info.get("webpage_url") or info.get("original_url"),
        "categories": info.get("categories") or [],
        "tags": (info.get("tags") or [])[:20],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Download a YouTube URL and analyze it with Qwen Cloud video understanding.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=USAGE,
    )
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--api-key", help="Qwen Cloud / DashScope API key")
    parser.add_argument(
        "--model",
        default=os.getenv("QWEN_VIDEO_MODEL", DEFAULT_MODEL),
        help=f"Qwen vision model (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--fps",
        type=float,
        default=float(os.getenv("QWEN_VIDEO_FPS", DEFAULT_FPS)),
        help=f"Frame sampling rate metadata for Qwen image-list video input (default: {DEFAULT_FPS})",
    )
    parser.add_argument(
        "--frame-count",
        type=int,
        default=int(os.getenv("QWEN_FRAME_COUNT", DEFAULT_FRAME_COUNT)),
        help=f"Maximum sampled frames per chunk (default: {DEFAULT_FRAME_COUNT})",
    )
    parser.add_argument(
        "--frame-width",
        type=int,
        default=int(os.getenv("QWEN_FRAME_WIDTH", DEFAULT_FRAME_WIDTH)),
        help=f"Maximum extracted frame width in pixels (default: {DEFAULT_FRAME_WIDTH})",
    )
    parser.add_argument(
        "--frame-format",
        choices=["jpg", "webp"],
        default=os.getenv("QWEN_FRAME_FORMAT", DEFAULT_FRAME_FORMAT),
        help=f"Extracted frame format (default: {DEFAULT_FRAME_FORMAT})",
    )
    parser.add_argument(
        "--max-pixels",
        type=int,
        default=int(os.getenv("QWEN_MAX_PIXELS", DEFAULT_MAX_PIXELS)),
        help=f"Maximum total pixels across frames per chunk (default: {DEFAULT_MAX_PIXELS})",
    )
    parser.add_argument(
        "--mode",
        choices=["live", "chunked", "single"],
        default="live",
        help="live=pipeline streaming (default), chunked=split after full download, single=one call",
    )
    parser.add_argument(
        "--presentation",
        action="store_true",
        help="Continuous live narration (default in live mode)",
    )
    parser.add_argument(
        "--chunk-seconds",
        type=int,
        default=int(os.getenv("QWEN_CHUNK_SECONDS", DEFAULT_CHUNK_SECONDS)),
        help=f"Segment length after the first clip (default: {DEFAULT_CHUNK_SECONDS})",
    )
    parser.add_argument(
        "--first-chunk-seconds",
        type=int,
        default=int(os.getenv("QWEN_FIRST_CHUNK_SECONDS", DEFAULT_FIRST_CHUNK_SECONDS)),
        help=f"First segment length for fast start (default: {DEFAULT_FIRST_CHUNK_SECONDS})",
    )
    parser.add_argument(
        "--prefetch-depth",
        type=int,
        default=int(os.getenv("QWEN_PREFETCH_DEPTH", "3")),
        help="Number of chunks to keep prepared ahead in live mode (default: 3)",
    )
    parser.add_argument(
        "--ahead-analysis",
        action="store_true",
        help="Analyze future prepared chunks in the background and buffer narration until due",
    )
    parser.add_argument(
        "--allow-early-narration",
        action="store_true",
        help="Emit narration as soon as it is ready instead of holding for the chunk timestamp",
    )
    parser.add_argument(
        "--max-live-lag-seconds",
        type=float,
        default=float(os.getenv("QWEN_MAX_LIVE_LAG_SECONDS", "2")),
        help="Scheduler lag threshold before narration is treated as late (default: 2)",
    )
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=int(os.getenv("QWEN_MAX_TOKENS", DEFAULT_MAX_TOKENS)),
        help=f"Maximum output tokens per chunk (default: {DEFAULT_MAX_TOKENS})",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=float(os.getenv("QWEN_TEMPERATURE", DEFAULT_TEMPERATURE)),
        help=f"Sampling temperature (default: {DEFAULT_TEMPERATURE})",
    )
    parser.add_argument(
        "--top-p",
        type=float,
        default=float(os.getenv("QWEN_TOP_P", DEFAULT_TOP_P)),
        help=f"Nucleus sampling top_p (default: {DEFAULT_TOP_P})",
    )
    parser.add_argument(
        "--enable-thinking",
        action="store_true",
        help="Enable model thinking/reasoning mode; disabled by default for live latency",
    )
    parser.add_argument(
        "--thinking-budget",
        type=int,
        default=int(os.getenv("QWEN_THINKING_BUDGET")) if os.getenv("QWEN_THINKING_BUDGET") else None,
        help="Optional thinking token budget when supported",
    )
    parser.add_argument(
        "--endpoint-region",
        choices=sorted(DASHSCOPE_REGION_BASES),
        default=os.getenv("DASHSCOPE_REGION"),
        help="DashScope region endpoint shortcut",
    )
    parser.add_argument(
        "--dashscope-base-url",
        default=os.getenv("DASHSCOPE_BASE_URL"),
        help="Explicit DashScope base URL; overrides --endpoint-region",
    )
    parser.add_argument(
        "--benchmark-endpoints",
        action="store_true",
        help="Measure TCP/TLS connection latency to known DashScope endpoints and cache the fastest",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(os.getenv("QWEN_CACHE_DIR", str(Path(__file__).with_name(".youtube_qwen_cache")))),
        help="Persistent cache directory for metadata, sections, frames, and model outputs",
    )
    parser.add_argument("--no-cache", action="store_true", help="Disable all persistent cache reads/writes")
    parser.add_argument("--refresh-cache", action="store_true", help="Ignore cached values and overwrite them")
    parser.add_argument(
        "--no-stream",
        action="store_true",
        help="Disable token streaming (not recommended for live use)",
    )
    parser.add_argument("--max-duration", type=int, default=None, metavar="SECONDS")
    parser.add_argument("--max-file-mb", type=int, default=LOCAL_FILE_LIMIT_MB)
    parser.add_argument("--prompt", default=None, help="Custom prompt for single mode only")
    parser.add_argument("--json", action="store_true", help="Emit JSON payload at end (stdout stays streamed)")
    parser.add_argument("--keep-video", action="store_true")
    return parser


def print_timing_summary(timer: StageTimer) -> None:
    timer.log("timing summary:")
    for name, elapsed in timer.marks:
        timer.log(f"  - {name}: {elapsed:.2f}s")
    if timer.first_token_at is not None:
        timer.log(f"  - time-to-first-token: {timer.first_token_at:.2f}s")
    timer.log(f"  - total: {timer.elapsed():.2f}s")


def main(argv: list[str] | None = None) -> int:
    load_project_env()
    args = build_parser().parse_args(argv)
    if args.no_stream:
        raise SystemExit("--no-stream is not supported in live mode; remove it for presentation use.")
    api_key = resolve_api_key(args.api_key)
    timer = StageTimer()
    presentation = args.presentation or args.mode == "live"
    video_id = safe_video_id(args.url)
    cache = CacheOptions(
        cache_dir=args.cache_dir,
        no_cache=args.no_cache,
        refresh_cache=args.refresh_cache,
        video_id=video_id,
    )
    frame_settings = validate_frame_settings(
        FrameSettings(
            frame_count=args.frame_count,
            frame_width=args.frame_width,
            frame_format=args.frame_format,
            fps=args.fps,
            max_pixels=args.max_pixels,
        )
    )
    model_settings = ModelSettings(
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
        enable_thinking=args.enable_thinking,
        thinking_budget=args.thinking_budget if args.thinking_budget is not None and args.thinking_budget >= 0 else None,
        dashscope_base_url=args.dashscope_base_url,
        endpoint_region=args.endpoint_region,
    )
    if args.benchmark_endpoints:
        benchmark = benchmark_dashscope_endpoints(cache.cache_dir, timer)
        fastest = benchmark.get("fastest")
        if fastest and not args.dashscope_base_url and not args.endpoint_region:
            model_settings = ModelSettings(
                max_tokens=model_settings.max_tokens,
                temperature=model_settings.temperature,
                top_p=model_settings.top_p,
                enable_thinking=model_settings.enable_thinking,
                thinking_budget=model_settings.thinking_budget,
                dashscope_base_url=fastest["base_url"],
                endpoint_region=None,
            )

    timer.log(f"job start: url={args.url} mode={args.mode}")

    with tempfile.TemporaryDirectory(prefix="youtube-qwen-") as tmp:
        work_dir = Path(tmp)
        metadata_info = fetch_youtube_metadata(args.url, timer, cache=cache)
        if metadata_info.get("id") and metadata_info["id"] != cache.video_id:
            cache = CacheOptions(
                cache_dir=cache.cache_dir,
                no_cache=cache.no_cache,
                refresh_cache=cache.refresh_cache,
                video_id=str(metadata_info["id"]),
            )
        metadata = compact_metadata(metadata_info)

        chunk_results: list[dict[str, Any]] = []
        single_result: dict[str, Any] | None = None
        video_path: Path | None = None

        if args.mode == "live":
            timer.mark("live_start")
            chunk_results = run_live_pipeline(
                url=args.url,
                api_key=api_key,
                metadata=metadata_info,
                work_dir=work_dir,
                model=args.model,
                fps=args.fps,
                frame_settings=frame_settings,
                model_settings=model_settings,
                chunk_seconds=args.chunk_seconds,
                first_chunk_seconds=args.first_chunk_seconds,
                prefetch_depth=args.prefetch_depth,
                ahead_analysis=args.ahead_analysis,
                allow_early_narration=args.allow_early_narration,
                max_live_lag_seconds=args.max_live_lag_seconds,
                presentation=presentation,
                json_output=args.json,
                max_file_mb=args.max_file_mb,
                max_duration=args.max_duration,
                cache=cache,
                timer=timer,
            )
            if not args.json:
                print("\n", flush=True)
        elif args.mode == "chunked":
            timer.log("full download start")
            video_path, metadata_info = download_youtube_full(
                args.url,
                work_dir,
                max_file_mb=args.max_file_mb,
                max_duration=args.max_duration,
                timer=timer,
            )
            metadata = compact_metadata(metadata_info)
            duration = float(metadata.get("duration_seconds") or probe_duration(video_path))
            chunk_dir = work_dir / "chunks"
            chunk_dir.mkdir(parents=True, exist_ok=True)
            chunks = split_video(
                video_path,
                chunk_dir,
                chunk_seconds=args.chunk_seconds,
                duration=duration,
                frame_settings=frame_settings,
                cache=cache,
                timer=timer,
            )
            chunk_results = run_chunked_analysis(
                api_key=api_key,
                chunks=chunks,
                model=args.model,
                fps=args.fps,
                frame_settings=frame_settings,
                model_settings=model_settings,
                presentation=presentation,
                json_output=args.json,
                cache=cache,
                timer=timer,
            )
            if not args.json:
                print("\n", flush=True)
        else:
            timer.log("full download start")
            video_path, metadata_info = download_youtube_full(
                args.url,
                work_dir,
                max_file_mb=args.max_file_mb,
                max_duration=args.max_duration,
                timer=timer,
            )
            metadata = compact_metadata(metadata_info)
            duration = float(metadata.get("duration_seconds") or probe_duration(video_path))
            single_chunk = VideoChunk(index=0, start_seconds=0, end_seconds=duration, path=video_path)
            frames = extract_frames_from_chunk(
                single_chunk,
                work_dir / "single-frames",
                settings=frame_settings,
                timer=timer,
                cache=cache,
            )
            single_result = run_single_analysis(
                api_key=api_key,
                frames=frames,
                model=args.model,
                prompt=args.prompt or SINGLE_PROMPT,
                fps=args.fps,
                model_settings=model_settings,
                json_output=args.json,
                timer=timer,
            )
            if not args.json:
                print("\n", flush=True)

        timer.marks.append(("analysis_done", timer.elapsed()))

        payload: dict[str, Any] = {
            "source_url": args.url,
            "video_metadata": metadata,
            "mode": args.mode,
            "presentation": presentation,
            "settings": {
                "model": args.model,
                "fps": args.fps,
                "chunk_seconds": args.chunk_seconds,
                "first_chunk_seconds": args.first_chunk_seconds,
                "frame_count": args.frame_count,
                "frame_width": args.frame_width,
                "frame_format": args.frame_format,
                "max_pixels": args.max_pixels,
                "prefetch_depth": args.prefetch_depth,
                "ahead_analysis": args.ahead_analysis,
                "allow_early_narration": args.allow_early_narration,
                "max_live_lag_seconds": args.max_live_lag_seconds,
                "max_tokens": args.max_tokens,
                "temperature": args.temperature,
                "top_p": args.top_p,
                "enable_thinking": args.enable_thinking,
                "thinking_budget": args.thinking_budget,
                "dashscope_base_url": openai_compatible_base(model_settings),
                "cache_dir": str(cache.cache_dir),
                "cache_enabled": not cache.no_cache,
                "prompt_version": PROMPT_VERSION,
            },
            "timing": {
                "total_seconds": round(timer.elapsed(), 2),
                "time_to_first_token_seconds": round(timer.first_token_at, 2) if timer.first_token_at else None,
                "marks": [{"name": n, "elapsed_seconds": round(e, 2)} for n, e in timer.marks],
            },
        }
        if video_path:
            payload["video_file_mb"] = round(mb(video_path), 2)
        if chunk_results:
            payload["chunks"] = chunk_results
            payload["analysis"] = " ".join(c["analysis"] for c in chunk_results)
        elif single_result:
            payload["qwen"] = single_result
            payload["analysis"] = single_result["analysis"]

        if args.keep_video and video_path:
            kept = Path.cwd() / video_path.name
            kept.write_bytes(video_path.read_bytes())
            payload["kept_video_path"] = str(kept.resolve())
            timer.log(f"kept source video at {kept.resolve()}")

        print_timing_summary(timer)
        if args.json:
            print(json.dumps(payload, indent=2, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
