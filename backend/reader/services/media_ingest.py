from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.files.base import ContentFile
from PIL import Image

from reader.models import FrameAsset, VideoChunk, VideoSession


@dataclass(frozen=True)
class DownloadedVideo:
    video_path: Path
    metadata: dict[str, Any]
    subtitle_paths: list[Path]


def safe_slug(value: str, fallback: str = "video") -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned[:80] or fallback


def run_command(command: list[str]) -> None:
    subprocess.run(command, check=True, capture_output=True)


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


def download_youtube_video(url: str, work_dir: Path, *, max_height: int = 360) -> DownloadedVideo:
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError("yt-dlp is required for backend YouTube ingestion.") from exc

    work_dir.mkdir(parents=True, exist_ok=True)
    ydl_opts: dict[str, Any] = {
        "format": f"bv*[height<={max_height}][ext=mp4]+ba[ext=m4a]/b[height<={max_height}][ext=mp4]/b",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en.*"],
        "subtitlesformat": "vtt",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info is None:
            raise RuntimeError("yt-dlp returned no metadata.")
        video_path = Path(ydl.prepare_filename(info))
        if video_path.suffix != ".mp4" and video_path.with_suffix(".mp4").exists():
            video_path = video_path.with_suffix(".mp4")
    if not video_path.exists():
        candidates = sorted(work_dir.glob(f"{info.get('id', '*')}.*"))
        candidates = [path for path in candidates if path.suffix.lower() in {".mp4", ".webm", ".mkv"}]
        if not candidates:
            raise RuntimeError("Downloaded video file was not found.")
        video_path = candidates[0]

    subtitle_paths = sorted(path for path in work_dir.glob(f"{info.get('id', '*')}*.vtt") if path.is_file())
    metadata = {
        "id": info.get("id"),
        "title": info.get("title"),
        "channel": info.get("channel") or info.get("uploader"),
        "duration_seconds": info.get("duration") or probe_duration(video_path),
        "webpage_url": info.get("webpage_url") or url,
    }
    return DownloadedVideo(video_path=video_path, metadata=metadata, subtitle_paths=subtitle_paths)


def extract_audio(video_path: Path, target_path: Path) -> Path:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "96k",
            str(target_path),
        ]
    )
    return target_path


def extract_frames_for_chunk(
    *,
    video_path: Path,
    output_dir: Path,
    start_seconds: float,
    end_seconds: float,
    frame_count: int,
    width: int,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    for existing in output_dir.glob("frame-*.jpg"):
        existing.unlink()
    duration = max(0.25, end_seconds - start_seconds)
    fps = max(1.0 / duration, frame_count / duration)
    pattern = output_dir / "frame-%03d.jpg"
    run_command(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start_seconds:.3f}",
            "-i",
            str(video_path),
            "-t",
            f"{duration:.3f}",
            "-vf",
            f"fps={fps:.6f},scale=w='min({width},iw)':h=-2",
            "-frames:v",
            str(frame_count),
            "-q:v",
            "3",
            str(pattern),
        ]
    )
    return sorted(output_dir.glob("frame-*.jpg"))


def attach_frame_file(chunk: VideoChunk, source_path: Path) -> FrameAsset:
    data = source_path.read_bytes()
    checksum = hashlib.sha256(data).hexdigest()
    with Image.open(source_path) as image:
        width, height = image.size
    return FrameAsset.objects.create(
        chunk=chunk,
        file=ContentFile(data, name=f"{chunk.session_id}/{chunk.chunk_index:05d}/{source_path.name}"),
        mime_type="image/jpeg",
        checksum=checksum,
        width=width,
        height=height,
        byte_size=len(data),
    )


def transcript_from_vtt(paths: list[Path]) -> str:
    import re
    if not paths:
        return ""
    lines: list[str] = []
    seen: set[str] = set()
    for path in paths:
        for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if not line or line == "WEBVTT" or "-->" in line or line.isdigit() or line.startswith(("Kind:", "Language:")):
                continue
            clean = re.sub(r"<[^>]+>", "", line)
            if clean and clean not in seen:
                seen.add(clean)
                lines.append(clean)
    return " ".join(lines)


def timed_transcript_from_vtt(paths: list[Path]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    if not paths:
        return segments
    for path in paths:
        current_start: float | None = None
        current_end: float | None = None
        text_lines: list[str] = []
        for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if not line or line == "WEBVTT" or line.isdigit() or line.startswith(("Kind:", "Language:")):
                if current_start is not None and text_lines:
                    segments.append(
                        {
                            "start": current_start,
                            "end": current_end if current_end is not None else current_start,
                            "text": " ".join(text_lines),
                        }
                    )
                current_start = None
                current_end = None
                text_lines = []
                continue
            if "-->" in line:
                start_raw, end_raw = line.split("-->", 1)
                current_start = parse_vtt_timestamp(start_raw.strip())
                current_end = parse_vtt_timestamp(end_raw.split()[0].strip())
                text_lines = []
                continue
            if current_start is not None:
                import re
                clean = re.sub(r"<[^>]+>", "", line)
                if clean:
                    text_lines.append(clean)
        if current_start is not None and text_lines:
            segments.append(
                {
                    "start": current_start,
                    "end": current_end if current_end is not None else current_start,
                    "text": " ".join(text_lines),
                }
            )
    return segments


def parse_vtt_timestamp(value: str) -> float:
    timestamp = value.replace(",", ".")
    parts = timestamp.split(":")
    try:
        if len(parts) == 3:
            hours = float(parts[0])
            minutes = float(parts[1])
            seconds = float(parts[2])
            return hours * 3600 + minutes * 60 + seconds
        if len(parts) == 2:
            minutes = float(parts[0])
            seconds = float(parts[1])
            return minutes * 60 + seconds
    except ValueError:
        return 0.0
    return 0.0


def transcript_for_range(segments: list[dict[str, Any]], *, start_seconds: float, end_seconds: float) -> str:
    texts = [
        str(segment["text"])
        for segment in segments
        if float(segment.get("end") or 0) >= start_seconds and float(segment.get("start") or 0) <= end_seconds
    ]
    return " ".join(texts)


def transcript_slice(transcript: str, *, max_chars: int = 6000) -> str:
    return transcript[:max_chars]


def create_session_from_download(download: DownloadedVideo, *, settings_payload: dict[str, Any]) -> VideoSession:
    return VideoSession.objects.create(
        source_url=download.metadata.get("webpage_url") or "",
        title=download.metadata.get("title") or "",
        page_title=download.metadata.get("title") or "",
        duration_seconds=float(download.metadata.get("duration_seconds") or 0),
        settings=settings_payload,
    )


def copy_artifact(source: Path, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return target
