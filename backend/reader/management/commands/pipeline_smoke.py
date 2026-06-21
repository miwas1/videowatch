from __future__ import annotations

import tempfile
from pathlib import Path

from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError
from PIL import Image, ImageDraw

from reader.models import FrameAsset, VideoChunk, VideoSession
from reader.services.agents import AgentSocietyRunner
from reader.services.qwen import QwenConfigurationError, QwenResponseError


class Command(BaseCommand):
    help = "Run a live end-to-end Qwen agent-society smoke test against a synthetic captured video chunk."

    def add_arguments(self, parser):
        parser.add_argument("--keep", action="store_true", help="Keep the smoke-test session in the local database.")

    def handle(self, *args, **options):
        session = VideoSession.objects.create(
            title="Pipeline smoke: Django Ninja video reading",
            source_url="https://example.com/synthetic-video",
            settings={"smoke": True},
        )
        chunk = VideoChunk.objects.create(
            session=session,
            chunk_index=0,
            start_seconds=0,
            end_seconds=30,
            transcript_text="The presenter creates a Django Ninja API and shows the exact api = NinjaAPI() code.",
            capture_notes="Synthetic smoke frames show title text and code text.",
        )

        try:
            self._attach_frames(chunk)
            result = AgentSocietyRunner().process_chunk(chunk)
        except (QwenConfigurationError, QwenResponseError) as exc:
            if not options["keep"]:
                session.delete()
            raise CommandError(str(exc)) from exc
        except Exception as exc:
            if not options["keep"]:
                session.delete()
            raise CommandError(f"Pipeline smoke failed: {exc}") from exc

        block_count = len(result["blocks"])
        timeline_count = len(result["timeline"])
        if block_count == 0:
            if not options["keep"]:
                session.delete()
            raise CommandError("Pipeline smoke produced no reading blocks.")

        session_id = str(session.id)
        if not options["keep"]:
            session.delete()
        self.stdout.write(
            self.style.SUCCESS(
                f"Pipeline smoke ok: session={session_id}, blocks={block_count}, timeline={timeline_count}"
            )
        )

    def _attach_frames(self, chunk: VideoChunk) -> None:
        with tempfile.TemporaryDirectory(prefix="describeops-pipeline-smoke-") as tmp:
            for index in range(4):
                path = Path(tmp) / f"frame-{index}.png"
                image = Image.new("RGB", (640, 360), color=(20, 24 + index * 8, 34))
                draw = ImageDraw.Draw(image)
                draw.text((32, 48), "Build a Django Ninja Backend", fill=(245, 245, 245))
                draw.text((32, 96), "Step: create api = NinjaAPI()", fill=(120, 225, 255))
                draw.text((32, 144), "Keep examples, code, and context.", fill=(255, 225, 130))
                image.save(path)
                data = path.read_bytes()
                FrameAsset.objects.create(
                    chunk=chunk,
                    file=ContentFile(data, name=f"smoke/{chunk.id}/frame-{index}.png"),
                    mime_type="image/png",
                    checksum=f"smoke-{chunk.id}-{index}",
                    width=640,
                    height=360,
                    byte_size=len(data),
                )

