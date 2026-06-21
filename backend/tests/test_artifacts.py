from __future__ import annotations

from typing import Any

import pytest

from reader.models import AgentRun, ReadingBlock, TimelineMoment, VideoChunk, VideoSession
from reader.services.artifacts import FinalReportAgent, export_session_artifacts
from reader.services.qwen import QwenResult


class DeterministicFinalQwen:
    def text_json(self, **kwargs: Any) -> QwenResult:
        assert "code/snippet-001-00-04.py" in kwargs["user_prompt"]
        payload = {
            "report_markdown": (
                "# Polished Final Report\n\n"
                "The final agent combines the teaching flow with the extracted code artifact.\n\n"
                "- Code: [snippet](code/snippet-001-00-04.py)"
            ),
            "code_references": [
                {
                    "path": "code/snippet-001-00-04.py",
                    "language": "python",
                    "reason": "Primary displayed example.",
                }
            ],
            "screenshot_references": [],
            "quality_flags": [],
            "confidence": 0.93,
        }
        return QwenResult(kwargs["model"], payload, "{}", 31, "final-req-1")


@pytest.mark.django_db
def test_export_session_artifacts_writes_final_report_from_final_agent(tmp_path, settings) -> None:
    settings.QWEN_FINAL_MODEL = "qwen3.7-max"
    session = VideoSession.objects.create(
        title="Accessible Django walkthrough",
        source_url="https://example.com/watch",
        duration_seconds=120,
    )
    chunk = VideoChunk.objects.create(session=session, chunk_index=0, start_seconds=4, end_seconds=30)
    ReadingBlock.objects.create(
        session=session,
        chunk=chunk,
        order=0,
        kind=ReadingBlock.Kind.CODE,
        heading="Displayed function",
        body="```python\ndef describe_video():\n    return document\n```",
        start_seconds=4,
        end_seconds=18,
        source_evidence=["editor frame"],
        confidence=0.9,
    )
    TimelineMoment.objects.create(
        session=session,
        chunk=chunk,
        timestamp_seconds=4,
        label="Code appears",
        detail="A Python helper is visible.",
        importance=5,
    )

    manifest = export_session_artifacts(
        session,
        tmp_path,
        final_report_agent=FinalReportAgent(qwen_client=DeterministicFinalQwen()),
    )

    assert (tmp_path / "reading_document.md").exists()
    final_report = tmp_path / "final_report.md"
    assert final_report.exists()
    assert "Polished Final Report" in final_report.read_text(encoding="utf-8")
    assert manifest["final_report"] == str(final_report)
    assert manifest["final_report_model"] == "qwen3.7-max"
    assert manifest["final_report_request_id"] == "final-req-1"
    assert manifest["final_report_confidence"] == 0.93
    final_run = AgentRun.objects.get(chunk=chunk, role="final_report")
    assert final_run.model == "qwen3.7-max"
    assert final_run.confidence == 0.93
