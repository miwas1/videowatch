from __future__ import annotations

import json
import math
import shutil
import tempfile
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from reader.models import VideoChunk, VideoSession
from reader.services.agents import AgentSocietyRunner
from reader.services.artifacts import export_session_artifacts
from reader.services.events import emit_event
from reader.services.media_ingest import (
    attach_frame_file,
    copy_artifact,
    create_session_from_download,
    download_youtube_video,
    extract_audio,
    extract_frames_for_chunk,
    safe_slug,
    timed_transcript_from_vtt,
    transcript_for_range,
)


class Command(BaseCommand):
    help = "Analyze a YouTube video through the Django backend pipeline and export document/code/audio/screenshot artifacts."

    def add_arguments(self, parser):
        parser.add_argument("url")
        parser.add_argument("--output-dir", default="")
        parser.add_argument("--chunk-seconds", type=int, default=45)
        parser.add_argument("--frame-count", type=int, default=6)
        parser.add_argument("--frame-width", type=int, default=640)
        parser.add_argument("--max-height", type=int, default=360)
        parser.add_argument("--keep-session", action="store_true")

    def handle(self, *args, **options):
        url = options["url"]
        output_root = Path(options["output_dir"] or "outputs/backend-youtube").resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        runner = AgentSocietyRunner()

        with tempfile.TemporaryDirectory(prefix="describeops-backend-youtube-") as tmp:
            work_dir = Path(tmp)
            self.stdout.write("Downloading video and captions through backend ingest...")
            download = download_youtube_video(url, work_dir / "download", max_height=options["max_height"])
            slug = safe_slug(f"{download.metadata.get('id') or 'youtube'}-{download.metadata.get('title') or 'video'}")
            output_dir = output_root / slug
            output_dir.mkdir(parents=True, exist_ok=True)

            self.stdout.write("Extracting audio artifact...")
            audio_path = extract_audio(download.video_path, work_dir / "audio" / f"{download.metadata.get('id') or 'audio'}.mp3")
            copied_video = copy_artifact(download.video_path, output_dir / "source" / download.video_path.name)
            copied_audio = copy_artifact(audio_path, output_dir / "source" / audio_path.name)
            for subtitle in download.subtitle_paths:
                copy_artifact(subtitle, output_dir / "source" / subtitle.name)

            session = create_session_from_download(
                download,
                settings_payload={
                    "ingest": "youtube_backend",
                    "chunk_seconds": options["chunk_seconds"],
                    "frame_count": options["frame_count"],
                    "frame_width": options["frame_width"],
                    "audio_path": str(copied_audio),
                    "video_path": str(copied_video),
                },
            )
            emit_event(session, "session.created", {"session_id": str(session.id), "ingest": "youtube_backend"})
            transcript_segments = timed_transcript_from_vtt(download.subtitle_paths)
            duration = float(download.metadata.get("duration_seconds") or 0)
            if duration <= 0:
                raise CommandError("Could not determine video duration.")

            total_chunks = math.ceil(duration / options["chunk_seconds"])
            session.status = VideoSession.Status.PROCESSING
            session.save(update_fields=["status", "updated_at"])
            self.stdout.write(f"Created backend session {session.id}; processing {total_chunks} chunks...")

            for index in range(total_chunks):
                start = index * options["chunk_seconds"]
                end = min(start + options["chunk_seconds"], duration)
                chunk = VideoChunk.objects.create(
                    session=session,
                    chunk_index=index,
                    start_seconds=start,
                    end_seconds=end,
                    transcript_text=transcript_for_range(transcript_segments, start_seconds=start, end_seconds=end),
                    capture_notes=(
                        "Frames extracted by backend YouTube ingestion. Audio was extracted separately "
                        "and captions were attached when YouTube provided them."
                    ),
                )
                frame_paths = extract_frames_for_chunk(
                    video_path=download.video_path,
                    output_dir=work_dir / "frames" / f"chunk-{index:03d}",
                    start_seconds=start,
                    end_seconds=end,
                    frame_count=options["frame_count"],
                    width=options["frame_width"],
                )
                for frame_path in frame_paths:
                    attach_frame_file(chunk, frame_path)
                self.stdout.write(f"Chunk {index + 1}/{total_chunks}: {start:.0f}s-{end:.0f}s, {len(frame_paths)} frames")
                runner.process_chunk(chunk)

            manifest = export_session_artifacts(session, output_dir, audio_path=copied_audio)
            manifest["source_video"] = str(copied_video)
            manifest["subtitle_files"] = [str(output_dir / "source" / path.name) for path in download.subtitle_paths]
            (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

            if not options["keep_session"]:
                # Keep the backend database session by default because the user asked to use
                # the backend. This flag remains for future cleanup workflows.
                pass

        self.stdout.write(self.style.SUCCESS(f"Backend YouTube analysis complete: {output_dir}"))
        self.stdout.write(f"Final report: {output_dir / 'final_report.md'}")
        self.stdout.write(f"Reading document: {output_dir / 'reading_document.md'}")
        self.stdout.write(f"Manifest: {output_dir / 'manifest.json'}")
