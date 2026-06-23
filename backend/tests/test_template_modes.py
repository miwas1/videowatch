from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from django.test import Client, override_settings

from reader.models import GeneratedArtifact, ReadingBlock, TimelineMoment, VideoChunk, VideoSession
from reader.services.agents import AgentSocietyRunner, SYNTHESIS_PROFILES
from reader.services.artifact_builder import WORKFLOW_LABELS, WORKFLOW_TO_ARTIFACT_TYPE, build_artifact_from_session
from reader.services.qwen import QwenResponseError, QwenResult


TOKEN = "template-test-token"
TEMPLATES = tuple(WORKFLOW_TO_ARTIFACT_TYPE)


class ImmediateThread:
    def __init__(self, target: Any, daemon: bool = False) -> None:
        self.target = target
        self.daemon = daemon

    def start(self) -> None:
        self.target()


def seed_session(*, status: str = VideoSession.Status.READY) -> VideoSession:
    session = VideoSession.objects.create(
        title="Accessible systems tutorial",
        source_url="https://example.com/video",
        duration_seconds=90,
        status=status,
        pipeline_stage=VideoSession.PipelineStage.READY if status == VideoSession.Status.READY else VideoSession.PipelineStage.FAILED,
        expected_chunk_count=1,
    )
    chunk = VideoChunk.objects.create(
        session=session,
        chunk_index=0,
        start_seconds=0,
        end_seconds=30,
        transcript_text="The presenter explains memory and demonstrates a command.",
        status=VideoChunk.Status.READY,
    )
    for order, kind in enumerate((ReadingBlock.Kind.INTRO, ReadingBlock.Kind.CODE, ReadingBlock.Kind.VISUAL_CONTEXT, ReadingBlock.Kind.TAKEAWAY)):
        ReadingBlock.objects.create(
            session=session,
            chunk=chunk,
            order=order,
            kind=kind,
            heading=f"{kind.replace('_', ' ').title()} section",
            body="cargo run" if kind == ReadingBlock.Kind.CODE else f"Detailed {kind} evidence from the video.",
            start_seconds=order * 5,
            end_seconds=order * 5 + 4,
            source_evidence=["frame", "transcript"],
            confidence=0.91,
        )
    TimelineMoment.objects.create(
        session=session,
        chunk=chunk,
        timestamp_seconds=8,
        label="Command demonstrated",
        detail="The terminal command is visible.",
        importance=5,
    )
    return session


@pytest.mark.django_db
@pytest.mark.parametrize("workflow_template", TEMPLATES)
def test_every_template_persists_synthesized_sections(workflow_template: str) -> None:
    session = seed_session()
    synthesis = {
        "title": f"{WORKFLOW_LABELS[workflow_template]} result",
        "summary": f"Summary for {workflow_template}",
        "sections": [
            {
                "heading": f"{WORKFLOW_LABELS[workflow_template]} primary section",
                "body": f"Template-specific body for {workflow_template}",
                "start_seconds": 2,
                "end_seconds": 18,
                "kind": "code" if workflow_template == "tutorial_extraction" else "explanation",
            }
        ],
    }

    artifact = build_artifact_from_session(session, workflow_template, synthesis)

    assert artifact.artifact_type == WORKFLOW_TO_ARTIFACT_TYPE[workflow_template]
    assert artifact.workflow_template == workflow_template
    assert WORKFLOW_LABELS[workflow_template] in artifact.markdown
    assert synthesis["sections"][0]["heading"] in artifact.markdown
    assert synthesis["sections"][0]["body"] in artifact.markdown
    assert artifact.payload["sections"] == synthesis["sections"]


@pytest.mark.django_db
@pytest.mark.parametrize("workflow_template", TEMPLATES)
def test_every_template_has_a_distinct_nonempty_fallback(workflow_template: str) -> None:
    session = seed_session()
    artifact = build_artifact_from_session(session, workflow_template)

    assert artifact.markdown.strip()
    assert WORKFLOW_LABELS[workflow_template].split(" /")[0] in artifact.markdown or session.title in artifact.markdown


@pytest.mark.django_db
def test_regeneration_replaces_the_canonical_template_artifact() -> None:
    session = seed_session()
    first = build_artifact_from_session(session, "course_notes", {"summary": "first", "sections": []})
    second = build_artifact_from_session(session, "course_notes", {"summary": "second", "sections": []})

    assert first.id == second.id
    assert GeneratedArtifact.objects.filter(session=session, workflow_template="course_notes").count() == 1
    second.refresh_from_db()
    assert second.summary == "second"


class PromptCapturingQwen:
    def __init__(self) -> None:
        self.prompts: list[str] = []

    def text_json(self, **kwargs: Any) -> QwenResult:
        self.prompts.append(kwargs["user_prompt"])
        return QwenResult(
            kwargs["model"],
            {
                "title": "Synthesis",
                "summary": "Complete summary.",
                "sections": [{"heading": "Result", "body": "Body", "start_seconds": 0, "end_seconds": 30, "kind": "explanation"}],
            },
            "{}",
            12,
            "synthesis-request",
        )


@pytest.mark.django_db
@pytest.mark.parametrize("workflow_template", TEMPLATES)
@override_settings(QWEN_ENABLE_FINAL_REPORT_AGENT=True)
def test_every_template_changes_the_synthesis_brief(workflow_template: str) -> None:
    session = seed_session()
    qwen = PromptCapturingQwen()

    result = AgentSocietyRunner(qwen_client=qwen).synthesize_session(session, workflow_template)

    assert result["sections"]
    assert f"Requested workflow: {workflow_template}" in qwen.prompts[0]
    assert SYNTHESIS_PROFILES[workflow_template] in qwen.prompts[0]


class SuccessfulPipelineRunner:
    def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
        ReadingBlock.objects.create(
            session=chunk.session,
            chunk=chunk,
            order=chunk.chunk_index,
            kind=ReadingBlock.Kind.EXPLANATION,
            heading=f"Chunk {chunk.chunk_index + 1}",
            body="Complete source evidence.",
            start_seconds=chunk.start_seconds,
            end_seconds=chunk.end_seconds,
            source_evidence=["frame"],
            confidence=0.9,
        )
        chunk.status = VideoChunk.Status.READY
        chunk.save(update_fields=["status", "updated_at"])
        return {}

    def synthesize_session(self, session: VideoSession, workflow_template: str = "reading_document") -> dict[str, Any]:
        return {
            "title": f"{workflow_template} output",
            "summary": f"Summary for {workflow_template}",
            "sections": [
                {
                    "heading": WORKFLOW_LABELS[workflow_template],
                    "body": f"Generated {workflow_template} content.",
                    "start_seconds": 0,
                    "end_seconds": session.duration_seconds or 30,
                    "kind": "explanation",
                }
            ],
        }


def patch_pipeline(monkeypatch: pytest.MonkeyPatch, runner: Any) -> None:
    monkeypatch.setattr("reader.api.threading.Thread", ImmediateThread)
    monkeypatch.setattr(
        "reader.api.download_youtube_video",
        lambda url, work_dir, max_height: SimpleNamespace(
            video_path=Path("video.mp4"),
            metadata={"webpage_url": url, "title": "Template video", "duration_seconds": 60},
            subtitle_paths=[],
        ),
    )
    monkeypatch.setattr("reader.api.timed_transcript_from_vtt", lambda paths: [])
    monkeypatch.setattr("reader.api.extract_frames_for_chunk", lambda **kwargs: [])
    monkeypatch.setattr("reader.api.AgentSocietyRunner", lambda: runner)


@pytest.mark.django_db
@pytest.mark.parametrize("workflow_template", TEMPLATES)
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_autopilot_completes_every_template(monkeypatch: pytest.MonkeyPatch, workflow_template: str) -> None:
    patch_pipeline(monkeypatch, SuccessfulPipelineRunner())
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)

    response = client.post(
        "/api/v1/ingest/from-url",
        data={"url": "https://example.com/video", "workflow_template": workflow_template, "chunk_seconds": 30},
        content_type="application/json",
    )

    assert response.status_code == 202
    session_id = response.json()["session_id"]
    progress = client.get(f"/api/v1/sessions/{session_id}/progress").json()
    artifacts = client.get(f"/api/v1/sessions/{session_id}/artifacts").json()
    assert progress == {
        **progress,
        "status": "ready",
        "step": "ready",
        "percent": 100,
        "total_chunks": 2,
        "ready_chunks": 2,
        "failed_chunks": 0,
        "artifact_ready": True,
        "artifact_required": True,
    }
    assert len(artifacts) == 1
    assert artifacts[0]["workflow_template"] == workflow_template
    assert f"Generated {workflow_template} content." in artifacts[0]["markdown"]


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_autopilot_generates_all_requested_output_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_pipeline(monkeypatch, SuccessfulPipelineRunner())
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    response = client.post(
        "/api/v1/ingest/from-url",
        data={
            "url": "https://example.com/video",
            "workflow_template": "course_notes",
            "output_targets": ["audio_description", "research_digest", "course_notes"],
        },
        content_type="application/json",
    )
    artifacts = client.get(f"/api/v1/sessions/{response.json()['session_id']}/artifacts").json()
    assert {artifact["workflow_template"] for artifact in artifacts} == {"course_notes", "audio_description", "research_digest"}


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_invalid_workflow_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    response = client.post(
        "/api/v1/ingest/from-url",
        data={"url": "https://example.com/video", "workflow_template": "not-real"},
        content_type="application/json",
    )
    assert response.status_code == 400
    assert "Unsupported workflow" in response.json()["detail"]


class FailingSynthesisRunner(SuccessfulPipelineRunner):
    def synthesize_session(self, session: VideoSession, workflow_template: str = "reading_document") -> dict[str, Any]:
        raise QwenResponseError("Final synthesis unavailable")


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_synthesis_failure_is_visible_and_retry_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_pipeline(monkeypatch, FailingSynthesisRunner())
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    response = client.post(
        "/api/v1/ingest/from-url",
        data={"url": "https://example.com/video", "workflow_template": "research_digest"},
        content_type="application/json",
    )
    session_id = response.json()["session_id"]
    failed = client.get(f"/api/v1/sessions/{session_id}/progress").json()
    assert failed["status"] == "failed"
    assert failed["synthesis_error"] == "Final synthesis unavailable"
    assert failed["artifact_ready"] is False

    monkeypatch.setattr("reader.api.AgentSocietyRunner", lambda: SuccessfulPipelineRunner())
    retry = client.post(
        f"/api/v1/sessions/{session_id}/retry-synthesis",
        data={"workflow_template": "research_digest"},
        content_type="application/json",
    )
    assert retry.status_code == 202
    recovered = client.get(f"/api/v1/sessions/{session_id}/progress").json()
    assert recovered["status"] == "ready"
    assert recovered["artifact_ready"] is True


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_progress_uses_expected_chunk_count() -> None:
    session = VideoSession.objects.create(
        status=VideoSession.Status.PROCESSING,
        pipeline_stage=VideoSession.PipelineStage.ANALYZING,
        expected_chunk_count=4,
    )
    VideoChunk.objects.create(session=session, chunk_index=0, start_seconds=0, end_seconds=30, status=VideoChunk.Status.READY)
    progress = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).get(f"/api/v1/sessions/{session.id}/progress").json()
    assert progress["total_chunks"] == 4
    assert progress["ready_chunks"] == 1
    assert progress["percent"] == 28
