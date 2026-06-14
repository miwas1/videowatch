from __future__ import annotations

import json
import os
import time
from enum import StrEnum
from typing import Any

import httpx
from pydantic import BaseModel

from .config import load_root_env
from .schemas import (
    QwenChunkAnalysisResponse,
    QwenTtsRequest,
    QwenTtsResult,
    QwenVisualChunkRequest,
)


class ModelPurpose(StrEnum):
    TEXT_REASONING = "text_reasoning"
    MULTIMODAL_FRAME_ANALYSIS = "multimodal_frame_analysis"
    OCR_ASSISTANCE = "ocr_assistance"
    QA_SCORING = "qa_scoring"
    SUMMARIZATION = "summarization"


VIDEO_DESCRIPTION_SYSTEM = (
    "You are an audio-description agent for blind and low-vision users. "
    "You will receive structured context about ONE video that is currently in focus on a web page "
    "(its title, platform, live captions, transcript snippets, and on-screen text). "
    "Write concise spoken audio descriptions of THAT video only. "
    "Rules: (1) Describe the video content, not the web page. "
    "Never mention navigation, menus, buttons, comments, ads, 'skip navigation', subscribe prompts, or page chrome. "
    "(2) Do not repeat spoken dialogue that captions already cover; describe visual context that fills gaps. "
    "(3) Keep each cue under 18 words, plain and direct. "
    "(4) For short-form social clips (TikTok, Reels, Shorts), give one brief orientation of what the clip shows. "
    "(5) If you genuinely have no video signal, return an empty cues array rather than guessing about the page. "
    "Return ONLY strict JSON: "
    '{"summary":"one sentence about the video","cues":['
    '{"start":0.0,"end":4.0,"text":"...","importance":"high"}]}.'
)

FRAME_LIST_SYSTEM = (
    "You are narrating video frames for blind and low-vision users. "
    "Describe visible action only, in present tense, using full-video timestamps when useful. "
    "Do not mention page chrome, controls, comments, recommendations, or browser UI. "
    "Do not claim to hear audio. Keep the result speakable and concise."
)

MIN_QWEN_SEQUENCE_IMAGES = 4
MAX_QWEN_SEQUENCE_IMAGES = 8000


class TokenUsage(BaseModel):
    promptTokens: int = 0
    completionTokens: int = 0
    totalTokens: int = 0


class QwenResult(BaseModel):
    content: str
    model: str
    traceId: str
    latencyMs: int
    usage: TokenUsage


class QwenConfigError(RuntimeError):
    code = "CONFIG_ERROR"


def parse_description_payload(content: str) -> dict[str, Any]:
    """Parse Qwen output into {'summary', 'cues'}, tolerating markdown fences."""
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if "\n" in text:
            text = text.split("\n", 1)[1]
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    data = json.loads(text)
    cues = data.get("cues") if isinstance(data, dict) else None
    if not isinstance(cues, list):
        raise ValueError("Qwen response did not include a cues array")
    return {"summary": str(data.get("summary", "")).strip(), "cues": cues}


class QwenGateway:
    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        models: dict[ModelPurpose, str],
        client: httpx.Client | None = None,
        timeout_seconds: float = 30,
        max_retries: int = 2,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.models = models
        self.client = client or httpx.Client(timeout=timeout_seconds)
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries

    @classmethod
    def from_env(cls, client: httpx.Client | None = None) -> "QwenGateway":
        load_root_env()
        text_model = os.getenv("QWEN_TEXT_MODEL", "qwen-max-latest")
        multimodal_model = os.getenv("QWEN_MULTIMODAL_MODEL", "qwen3.6-flash")
        qa_model = os.getenv("QWEN_QA_MODEL", text_model)
        return cls(
            api_key=os.getenv("QWEN_API_KEY") or os.getenv("DASHSCOPE_API_KEY"),
            base_url=os.getenv(
                "DASHSCOPE_BASE_URL",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
            ),
            models={
                ModelPurpose.TEXT_REASONING: text_model,
                ModelPurpose.MULTIMODAL_FRAME_ANALYSIS: multimodal_model,
                ModelPurpose.OCR_ASSISTANCE: os.getenv(
                    "QWEN_OCR_MODEL", multimodal_model
                ),
                ModelPurpose.QA_SCORING: qa_model,
                ModelPurpose.SUMMARIZATION: os.getenv(
                    "QWEN_SUMMARY_MODEL", "qwen-plus-latest"
                ),
            },
            client=client,
            timeout_seconds=float(os.getenv("QWEN_TIMEOUT_SECONDS", "30")),
            max_retries=int(os.getenv("QWEN_MAX_RETRIES", "2")),
        )

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def model_for(self, purpose: ModelPurpose) -> str:
        return self.models[purpose]

    def chat(
        self,
        *,
        purpose: ModelPurpose,
        messages: list[dict[str, Any]],
        trace_id: str,
        tools: list[dict[str, Any]] | None = None,
    ) -> QwenResult:
        if not self.api_key:
            raise QwenConfigError("QWEN_API_KEY is required for Qwen Cloud calls")

        model = self.model_for(purpose)
        payload: dict[str, Any] = {"model": model, "messages": messages}
        if tools:
            payload["tools"] = tools

        started = time.monotonic()
        response = self._post_with_retry(payload=payload, trace_id=trace_id)
        response.raise_for_status()
        data = response.json()
        usage = data.get("usage") or {}
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return QwenResult(
            content=content,
            model=data.get("model", model),
            traceId=trace_id,
            latencyMs=round((time.monotonic() - started) * 1000),
            usage=TokenUsage(
                promptTokens=usage.get("prompt_tokens", 0),
                completionTokens=usage.get("completion_tokens", 0),
                totalTokens=usage.get("total_tokens", 0),
            ),
        )

    def health_check(self, *, trace_id: str = "trc_qwen_health") -> dict[str, Any]:
        started = time.monotonic()
        result = self.chat(
            purpose=ModelPurpose.TEXT_REASONING,
            messages=[
                {
                    "role": "system",
                    "content": "Return a short readiness acknowledgement.",
                },
                {"role": "user", "content": "health_check"},
            ],
            trace_id=trace_id,
        )
        return {
            "status": "ok" if result.content else "error",
            "model": result.model,
            "traceId": result.traceId,
            "latencyMs": round((time.monotonic() - started) * 1000),
        }

    def describe_video(
        self, context: dict[str, Any], *, trace_id: str
    ) -> dict[str, Any]:
        """Ask Qwen to describe the focused video. Returns {'summary', 'cues'}."""
        result = self.chat(
            purpose=ModelPurpose.TEXT_REASONING,
            messages=[
                {"role": "system", "content": VIDEO_DESCRIPTION_SYSTEM},
                {"role": "user", "content": json.dumps(context, separators=(",", ":"))},
            ],
            trace_id=trace_id,
        )
        return parse_description_payload(result.content)

    def analyze_visual_chunk(
        self, chunk: QwenVisualChunkRequest, *, trace_id: str
    ) -> QwenChunkAnalysisResponse:
        result = self.chat(
            purpose=ModelPurpose.MULTIMODAL_FRAME_ANALYSIS,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Analyze this accessibility video chunk. Return only JSON matching "
                        '{"events":[{"start":0,"end":1,"type":"visual_action","description":"...","importance":"high"}],'
                        '"chunk_summary":"..."}'
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(chunk.model_dump(), separators=(",", ":")),
                },
            ],
            trace_id=trace_id,
        )
        return QwenChunkAnalysisResponse.model_validate_json(result.content)

    def describe_frame_list(
        self,
        *,
        video_id: str,
        chunk_id: str,
        start: float,
        end: float,
        frames: list[str] | str,
        prompt: str,
        fps: float,
        trace_id: str,
    ) -> QwenResult:
        """Analyze sampled frames using Qwen's frame-list video content shape."""
        if isinstance(frames, list) and not (
            MIN_QWEN_SEQUENCE_IMAGES <= len(frames) <= MAX_QWEN_SEQUENCE_IMAGES
        ):
            raise ValueError(
                "Qwen video frame-list input requires 4 to 8000 sequence images"
            )
        content: list[dict[str, Any]] = [
            {"type": "video", "video": frames, "fps": fps},
            {
                "type": "text",
                "text": (
                    f"Video {video_id}, {chunk_id}, full-video time {start:.1f}s to {end:.1f}s.\n"
                    f"{prompt}"
                ),
            },
        ]
        return self.chat(
            purpose=ModelPurpose.MULTIMODAL_FRAME_ANALYSIS,
            messages=[
                {"role": "system", "content": FRAME_LIST_SYSTEM},
                {"role": "user", "content": content},
            ],
            trace_id=trace_id,
        )

    def synthesize_tts(
        self, request: QwenTtsRequest, *, trace_id: str
    ) -> QwenTtsResult:
        if not self.api_key:
            raise QwenConfigError("QWEN_API_KEY is required for Qwen TTS calls")

        started = time.monotonic()
        response = self.client.post(
            f"{self.base_url}/audio/speech",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "X-DescribeOps-Trace-Id": trace_id,
            },
            json={
                "model": os.getenv("QWEN_TTS_MODEL", "qwen-tts-latest"),
                "input": request.text,
                "voice": request.voice,
                "speed": request.speed,
            },
        )
        response.raise_for_status()
        content_type = response.headers.get("content-type", "audio/mpeg").split(";")[0]
        if content_type not in {"audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"}:
            content_type = "audio/mpeg"
        return QwenTtsResult(
            status="ready",
            durationMs=max(1, round((time.monotonic() - started) * 1000)),
            format=content_type,  # type: ignore[arg-type]
            audioBytes=response.content,
        )

    def _post_with_retry(
        self, *, payload: dict[str, Any], trace_id: str
    ) -> httpx.Response:
        last_response: httpx.Response | None = None
        for attempt in range(self.max_retries + 1):
            response = self.client.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "X-DescribeOps-Trace-Id": trace_id,
                },
                json=payload,
            )
            if response.status_code not in {408, 429, 500, 502, 503, 504}:
                return response
            last_response = response
            if attempt < self.max_retries:
                time.sleep(0.05 * (attempt + 1))
        return last_response or response
        return last_response or response
