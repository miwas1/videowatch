from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from reader.models import AgentRun, ReadingBlock, TimelineMoment, VideoChunk, VideoSession
from reader.services.agents import AgentSocietyRunner
from reader.services.qwen import QwenResult


@dataclass
class DeterministicQwen:
    calls: int = 0

    def multimodal_json(self, **kwargs: Any) -> QwenResult:
        self.calls += 1
        role_payload = {
            "observations": ["[00:06] The presenter opens a Django Ninja router file."],
            "visual_context": ["A code editor is visible."],
            "on_screen_text": ["api = NinjaAPI(...)"],
            "confidence": 0.91,
        }
        return QwenResult(kwargs["model"], role_payload, "{}", 12, f"req-{self.calls}")

    def text_json(self, **kwargs: Any) -> QwenResult:
        self.calls += 1
        if "Judge the collaborating agents" in kwargs["user_prompt"]:
            payload = {
                "accepted_blocks": [
                    {
                        "kind": "summary",
                        "heading": "Router setup",
                        "body": "The video shows the API router being wired into Django while preserving the exact `NinjaAPI` example.",
                        "start_seconds": 6,
                        "end_seconds": 30,
                        "source_evidence": ["api = NinjaAPI(...)"],
                        "confidence": 0.88,
                    },
                    {
                        "kind": "code",
                        "heading": "Displayed code",
                        "body": "```python\napi = NinjaAPI(title=\"DescribeOps Video Reading API\")\n```",
                        "start_seconds": 12,
                        "end_seconds": 18,
                        "source_evidence": ["on-screen code"],
                        "confidence": 0.84,
                    },
                ],
                "timeline": [
                    {
                        "timestamp_seconds": 12,
                        "label": "NinjaAPI initialization",
                        "detail": "The editor displays the API object creation.",
                        "importance": 5,
                    }
                ],
                "confidence": 0.87,
            }
        else:
            payload = {
                "examples": ["The router initialization is used as the concrete example."],
                "demo_steps": ["Open API file", "Create NinjaAPI instance"],
                "confidence": 0.82,
            }
        return QwenResult(kwargs["model"], payload, "{}", 10, f"req-{self.calls}")


@pytest.mark.django_db
def test_agent_society_creates_reading_document_without_summary_kind() -> None:
    session = VideoSession.objects.create(title="Django Ninja tutorial", source_url="https://example.com/video")
    chunk = VideoChunk.objects.create(session=session, chunk_index=0, start_seconds=6, end_seconds=30)

    runner = AgentSocietyRunner(qwen_client=DeterministicQwen())
    result = runner.process_chunk(chunk)

    chunk.refresh_from_db()
    assert chunk.status == VideoChunk.Status.READY
    assert AgentRun.objects.filter(chunk=chunk).count() == 5
    assert ReadingBlock.objects.filter(chunk=chunk).count() == 2
    assert TimelineMoment.objects.filter(chunk=chunk).count() == 1
    assert [block.kind for block in result["blocks"]] == ["explanation", "code"]
    assert "summary" not in {block.kind for block in result["blocks"]}

