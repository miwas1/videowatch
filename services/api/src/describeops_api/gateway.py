from __future__ import annotations

import os
import time
from enum import StrEnum
from typing import Any

import httpx
from pydantic import BaseModel

from .config import load_root_env


class ModelPurpose(StrEnum):
    TEXT_REASONING = "text_reasoning"
    MULTIMODAL_FRAME_ANALYSIS = "multimodal_frame_analysis"
    OCR_ASSISTANCE = "ocr_assistance"
    QA_SCORING = "qa_scoring"
    SUMMARIZATION = "summarization"


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
        multimodal_model = os.getenv("QWEN_MULTIMODAL_MODEL", "qwen3.7-plus")
        qa_model = os.getenv("QWEN_QA_MODEL", text_model)
        return cls(
            api_key=os.getenv("DASHSCOPE_API_KEY"),
            base_url=os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            models={
                ModelPurpose.TEXT_REASONING: text_model,
                ModelPurpose.MULTIMODAL_FRAME_ANALYSIS: multimodal_model,
                ModelPurpose.OCR_ASSISTANCE: os.getenv("QWEN_OCR_MODEL", multimodal_model),
                ModelPurpose.QA_SCORING: qa_model,
                ModelPurpose.SUMMARIZATION: os.getenv("QWEN_SUMMARY_MODEL", "qwen-plus-latest"),
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
            raise RuntimeError("DASHSCOPE_API_KEY is required for Qwen Cloud calls")

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

    def _post_with_retry(self, *, payload: dict[str, Any], trace_id: str) -> httpx.Response:
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
