from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from PIL import Image, ImageDraw

from reader.services.qwen import QwenClient


class Command(BaseCommand):
    help = "Run a small live Qwen multimodal smoke test without printing secrets."

    def handle(self, *args, **options):
        if not settings.DASHSCOPE_API_KEY:
            raise CommandError("DASHSCOPE_API_KEY or QWEN_API_KEY is not configured.")

        with tempfile.TemporaryDirectory(prefix="describeops-qwen-smoke-") as tmp:
            frames = []
            for index in range(4):
                path = Path(tmp) / f"frame-{index}.png"
                image = Image.new("RGB", (640, 360), color=(18 + index * 8, 24, 32))
                draw = ImageDraw.Draw(image)
                draw.text((32, 48), "Video Reading View", fill=(240, 240, 240))
                draw.text((32, 96), "Code shown: api = NinjaAPI()", fill=(120, 220, 255))
                draw.text((32, 144), f"Frame {index + 1}: preserve examples.", fill=(255, 220, 120))
                image.save(path)
                frames.append(SimpleNamespace(file=SimpleNamespace(path=str(path)), mime_type="image/png"))
            result = QwenClient().multimodal_json(
                model=settings.QWEN_VISUAL_MODEL,
                system_prompt="Return valid JSON only.",
                user_prompt=(
                    "Read this video frame accurately. Return JSON with keys "
                    "visible_text, code, and confidence. Preserve the displayed code exactly."
                ),
                frames=frames,
                max_tokens=300,
                fallback_models=settings.QWEN_VISUAL_FALLBACK_MODELS,
            )

        visible_text = result.content.get("visible_text", "")
        code = result.content.get("code", "")
        confidence = result.content.get("confidence", "")
        self.stdout.write(
            self.style.SUCCESS(
                f"Qwen smoke ok: model={result.model}, request_id={result.request_id}, "
                f"visible_text={visible_text!r}, code={code!r}, confidence={confidence!r}"
            )
        )
