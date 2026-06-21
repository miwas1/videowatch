from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from reader.services.media_ingest import timed_transcript_from_vtt


def fetch_transcript_for_url(url: str) -> dict[str, Any]:
    try:
        import yt_dlp
    except ImportError as exc:
        raise RuntimeError("yt-dlp is required for transcript fetching.") from exc

    with tempfile.TemporaryDirectory(prefix="describeops-transcript-") as tmp:
        work_dir = Path(tmp)
        ydl_opts: dict[str, Any] = {
            "skip_download": True,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en", "en.*"],
            "subtitlesformat": "vtt",
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info is None:
                raise RuntimeError("Could not extract video metadata.")
            ydl.download([url])

        vtt_paths = sorted(work_dir.glob("*.vtt"))
        segments = deduplicate_segments(timed_transcript_from_vtt(vtt_paths))
        full_text = " ".join(seg["text"] for seg in segments)

        return {
            "url": url,
            "video_id": info.get("id", ""),
            "title": info.get("title", ""),
            "duration_seconds": info.get("duration"),
            "segments": segments,
            "full_text": full_text,
            "segment_count": len(segments),
        }


def deduplicate_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not segments:
        return []
    # YouTube auto-captions produce cascading lines where each new line
    # contains the previous line plus new words. Keep only the longest
    # version of overlapping text within a time window.
    deduped: list[dict[str, Any]] = []
    for seg in segments:
        text = seg["text"].strip()
        if not text:
            continue
        # If previous segment's text is a substring of this one (cascading), replace it
        if deduped and text.startswith(deduped[-1]["text"][:20]):
            if len(text) > len(deduped[-1]["text"]):
                deduped[-1] = {"start": deduped[-1]["start"], "end": seg["end"], "text": text}
            continue
        # If this segment's text is a substring of the previous one, skip it
        if deduped and deduped[-1]["text"].endswith(text[-20:]):
            continue
        # Skip near-duplicate short segments
        if deduped and abs(seg["start"] - deduped[-1]["start"]) < 0.05:
            if len(text) > len(deduped[-1]["text"]):
                deduped[-1] = {"start": deduped[-1]["start"], "end": seg["end"], "text": text}
            continue
        deduped.append({"start": seg["start"], "end": seg["end"], "text": text})
    return deduped
