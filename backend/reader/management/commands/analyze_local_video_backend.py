from __future__ import annotations

import json
import math
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from reader.models import VideoChunk, VideoSession
from reader.services.agents import AgentSocietyRunner
from reader.services.artifacts import export_session_artifacts
from reader.services.events import emit_event
from reader.services.media_ingest import (
    attach_frame_file,
    copy_artifact,
    extract_audio,
    extract_frames_for_chunk,
    probe_duration,
    safe_slug,
    timed_transcript_from_vtt,
    transcript_for_range,
)


class Command(BaseCommand):
    help = "Analyze a local video through the Django backend pipeline and export document/code/audio/screenshot artifacts."

    def add_arguments(self, parser):
        parser.add_argument("video_path")
        parser.add_argument("--source-url", default="")
        parser.add_argument("--title", default="")
        parser.add_argument("--subtitle", action="append", default=[])
        parser.add_argument("--audio", default="")
        parser.add_argument("--output-dir", default="../outputs/backend-local-video")
        parser.add_argument("--chunk-seconds", type=int, default=45)
        parser.add_argument("--frame-count", type=int, default=6)
        parser.add_argument("--frame-width", type=int, default=640)

    def handle(self, *args, **options):
        video_path = Path(options["video_path"]).resolve()
        if not video_path.exists():
            raise CommandError(f"Video file not found: {video_path}")
        subtitles = [Path(path).resolve() for path in options["subtitle"] if Path(path).exists()]
        duration = probe_duration(video_path)
        title = options["title"] or video_path.stem
        output_root = Path(options["output_dir"]).resolve()
        output_dir = output_root / safe_slug(f"{video_path.stem}-{title}")
        output_dir.mkdir(parents=True, exist_ok=True)

        copied_video = copy_artifact(video_path, output_dir / "source" / video_path.name)
        if options["audio"]:
            audio_path = Path(options["audio"]).resolve()
            if not audio_path.exists():
                raise CommandError(f"Audio file not found: {audio_path}")
        else:
            audio_path = extract_audio(video_path, output_dir / "source" / f"{video_path.stem}.mp3")
        copied_audio = copy_artifact(audio_path, output_dir / "source" / audio_path.name)
        copied_subtitles = [copy_artifact(path, output_dir / "source" / path.name) for path in subtitles]

        session = VideoSession.objects.create(
            source_url=options["source_url"],
            title=title,
            page_title=title,
            duration_seconds=duration,
            settings={
                "ingest": "local_video_backend",
                "chunk_seconds": options["chunk_seconds"],
                "frame_count": options["frame_count"],
                "frame_width": options["frame_width"],
                "audio_path": str(copied_audio),
                "video_path": str(copied_video),
            },
        )
        emit_event(session, "session.created", {"session_id": str(session.id), "ingest": "local_video_backend"})
        session.status = VideoSession.Status.PROCESSING
        session.save(update_fields=["status", "updated_at"])

        transcript_segments = timed_transcript_from_vtt(copied_subtitles)
        runner = AgentSocietyRunner()
        total_chunks = math.ceil(duration / options["chunk_seconds"])
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
                capture_notes="Frames and audio extracted by backend local-video ingestion.",
            )
            frame_paths = extract_frames_for_chunk(
                video_path=video_path,
                output_dir=output_dir / "working_frames" / f"chunk-{index:03d}",
                start_seconds=start,
                end_seconds=end,
                frame_count=options["frame_count"],
                width=options["frame_width"],
            )
            for frame_path in frame_paths:
                attach_frame_file(chunk, frame_path)
            self.stdout.write(f"Chunk {index + 1}/{total_chunks}: {start:.0f}s-{end:.0f}s, {len(frame_paths)} frames")
            runner.process_chunk(chunk)

        session.status = VideoSession.Status.READY
        session.error_message = ""
        session.save(update_fields=["status", "error_message", "updated_at"])
        manifest = export_session_artifacts(session, output_dir, audio_path=copied_audio)
        manifest["source_video"] = str(copied_video)
        manifest["subtitle_files"] = [str(path) for path in copied_subtitles]
        (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        self.stdout.write(self.style.SUCCESS(f"Backend local-video analysis complete: {output_dir}"))
        self.stdout.write(f"Final report: {output_dir / 'final_report.md'}")
        self.stdout.write(f"Reading document: {output_dir / 'reading_document.md'}")
        self.stdout.write(f"Manifest: {output_dir / 'manifest.json'}")
