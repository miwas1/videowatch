from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from django.conf import settings
from openai import OpenAI

from reader.models import FrameAsset


class QwenConfigurationError(RuntimeError):
    pass


class QwenResponseError(RuntimeError):
    pass


@dataclass(frozen=True)
class QwenResult:
    model: str
    content: dict[str, Any]
    raw_text: str
    latency_ms: int
    request_id: str


def normalize_dashscope_base(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/api/v1"):
        return base[: -len("/api/v1")] + "/compatible-mode/v1"
    if base.endswith("/compatible-mode/v1"):
        return base
    return base + "/compatible-mode/v1"


def stable_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def extract_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?", "", stripped).strip()
        stripped = re.sub(r"```$", "", stripped).strip()
    try:
        loaded = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if not match:
            raise QwenResponseError("Qwen returned non-JSON output.")
        try:
            loaded = json.loads(match.group(0))
        except json.JSONDecodeError as exc:
            raise QwenResponseError("Qwen returned malformed JSON output.") from exc
    if not isinstance(loaded, dict):
        raise QwenResponseError("Qwen response JSON must be an object.")
    return loaded


class QwenClient:
    def __init__(self) -> None:
        if not settings.DASHSCOPE_API_KEY:
            raise QwenConfigurationError("DASHSCOPE_API_KEY or QWEN_API_KEY is required.")
        self.client = OpenAI(
            api_key=settings.DASHSCOPE_API_KEY,
            base_url=normalize_dashscope_base(settings.DASHSCOPE_BASE_URL),
            timeout=240.0,
        )
        self._frame_cache: dict[str, str] = {}

    def multimodal_json(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        frames: list[FrameAsset],
        max_tokens: int | None = None,
        fallback_models: list[str] | None = None,
    ) -> QwenResult:
        content: list[dict[str, Any]] = [{"type": "text", "text": user_prompt}]
        if frames:
            image_urls = [self._frame_data_url(frame) for frame in frames]
            if len(image_urls) >= 4:
                content.insert(0, {"type": "video", "video": image_urls, "fps": 0.5})
            else:
                content = [{"type": "image_url", "image_url": {"url": url}} for url in image_urls] + content
        return self._json_completion(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": content},
            ],
            max_tokens=max_tokens,
            fallback_models=fallback_models,
        )

    def text_json(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        max_tokens: int | None = None,
        fallback_models: list[str] | None = None,
    ) -> QwenResult:
        return self._json_completion(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_tokens=max_tokens,
            fallback_models=fallback_models,
        )

    def transcribe_audio(
        self,
        *,
        data: bytes,
        filename: str,
        content_type: str,
        model: str | None = None,
    ) -> QwenResult:
        transcription_model = model or settings.QWEN_AUDIO_TRANSCRIPTION_MODEL
        if not transcription_model:
            raise QwenConfigurationError("QWEN_AUDIO_TRANSCRIPTION_MODEL or DASHSCOPE_AUDIO_TRANSCRIPTION_MODEL is required.")

        started = time.perf_counter()
        audio_file = BytesIO(data)
        audio_file.name = filename
        response = self.client.audio.transcriptions.create(
            model=transcription_model,
            file=(filename, audio_file, content_type or "application/octet-stream"),
        )
        latency_ms = round((time.perf_counter() - started) * 1000)
        raw_payload = response.model_dump(mode="json") if hasattr(response, "model_dump") else response
        text = ""
        if isinstance(raw_payload, dict):
            text = str(raw_payload.get("text") or raw_payload.get("transcript") or "").strip()
        elif isinstance(raw_payload, str):
            text = raw_payload.strip()
        if not text:
            text = str(getattr(response, "text", "") or "").strip()
        request_id = str(getattr(response, "id", "") or "")
        return QwenResult(
            model=transcription_model,
            content={"text": text, "raw": raw_payload},
            raw_text=text,
            latency_ms=latency_ms,
            request_id=request_id,
        )

    def _json_completion(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int | None,
        fallback_models: list[str] | None,
    ) -> QwenResult:
        models_to_try = [model]
        for fallback in fallback_models or []:
            if fallback not in models_to_try:
                models_to_try.append(fallback)

        last_error: Exception | None = None
        last_text = ""
        last_model = model
        last_latency_ms = 0
        last_request_id = ""
        for candidate in models_to_try:
            started = time.perf_counter()
            kwargs = {
                "model": candidate,
                "messages": messages,
                "max_tokens": max_tokens or settings.QWEN_MAX_TOKENS,
                "temperature": settings.QWEN_TEMPERATURE,
                "top_p": settings.QWEN_TOP_P,
                "extra_body": {"enable_thinking": False},
                "response_format": {"type": "json_object"},
            }
            try:
                response = self.client.chat.completions.create(**kwargs)
            except Exception as exc:
                last_error = exc
                try:
                    kwargs.pop("response_format", None)
                    response = self.client.chat.completions.create(**kwargs)
                except Exception as retry_exc:
                    last_error = retry_exc
                    continue

            choice = response.choices[0] if response.choices else None
            text = choice.message.content if choice and choice.message else ""
            last_text = text or last_text
            last_model = candidate
            last_latency_ms = round((time.perf_counter() - started) * 1000)
            last_request_id = getattr(response, "id", "") or ""
            if not text:
                last_error = QwenResponseError("Qwen returned an empty response.")
                continue
            try:
                content = extract_json_object(text)
            except QwenResponseError as exc:
                last_error = exc
                continue
            request_id = getattr(response, "id", "") or ""
            return QwenResult(
                model=candidate,
                content=content,
                raw_text=text,
                latency_ms=last_latency_ms,
                request_id=request_id,
            )

        if last_text:
            return QwenResult(
                model=last_model,
                content={"raw_text": last_text, "confidence": 0.2, "parse_error": str(last_error)},
                raw_text=last_text,
                latency_ms=last_latency_ms,
                request_id=last_request_id,
            )
        raise QwenResponseError(f"All configured Qwen models failed. Last error: {last_error}")

    def _frame_data_url(self, frame: FrameAsset) -> str:
        frame_id = str(frame.id)
        if frame_id in self._frame_cache:
            return self._frame_cache[frame_id]
        path = Path(frame.file.path)
        encoded = base64.b64encode(path.read_bytes()).decode("utf-8")
        data_url = f"data:{frame.mime_type};base64,{encoded}"
        self._frame_cache[frame_id] = data_url
        return data_url
