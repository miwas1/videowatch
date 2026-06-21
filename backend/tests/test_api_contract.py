from __future__ import annotations

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, override_settings
from PIL import Image

from reader.models import ReadingBlock, TimelineMoment, VideoChunk
from reader.models import VideoSession


TOKEN = "test-token"


def png_frame() -> SimpleUploadedFile:
    image = Image.new("RGB", (96, 54), color=(30, 30, 30))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return SimpleUploadedFile("frame.png", buffer.getvalue(), content_type="image/png")


class ImmediateRunner:
    def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
        chunk.status = VideoChunk.Status.READY
        chunk.latency_ms = 25
        chunk.save(update_fields=["status", "latency_ms", "updated_at"])
        chunk.session.status = chunk.session.Status.READY
        chunk.session.save(update_fields=["status", "updated_at"])
        block = ReadingBlock.objects.create(
            session=chunk.session,
            chunk=chunk,
            order=0,
            kind=ReadingBlock.Kind.CODE,
            heading="Displayed function",
            body="```python\ndef describe_video():\n    return document\n```",
            start_seconds=chunk.start_seconds,
            end_seconds=chunk.end_seconds,
            source_evidence=["captured frame"],
            confidence=0.9,
        )
        moment = TimelineMoment.objects.create(
            session=chunk.session,
            chunk=chunk,
            timestamp_seconds=chunk.start_seconds,
            label="Code appears",
            detail="The video displays a Python function.",
            importance=5,
        )
        return {"blocks": [block], "timeline": [moment]}


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN, MEDIA_ROOT="/tmp/describeops-test-media")
def test_session_chunk_document_and_correction_flow(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("reader.api.AgentSocietyRunner", lambda: ImmediateRunner())
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)

    create_response = client.post(
        "/api/v1/sessions",
        data={
            "source_url": "https://example.com/watch?v=django",
            "title": "Build a Django Ninja API",
            "duration_seconds": 1800,
        },
        content_type="application/json",
    )
    assert create_response.status_code == 201
    session_id = create_response.json()["id"]

    upload_response = client.post(
        f"/api/v1/sessions/{session_id}/chunks",
        data={
            "chunk_index": "0",
            "start_seconds": "0",
            "end_seconds": "30",
            "transcript_text": "Now we create the API object.",
            "capture_notes": "Code editor is visible.",
            "process_now": "true",
            "frames": [png_frame()],
        },
    )
    assert upload_response.status_code == 201
    chunk_payload = upload_response.json()
    assert chunk_payload["status"] == "ready"
    assert chunk_payload["frame_count"] == 1
    assert chunk_payload["blocks"][0]["kind"] == "code"

    document_response = client.get(f"/api/v1/sessions/{session_id}/document")
    assert document_response.status_code == 200
    document = document_response.json()
    assert document["session"]["status"] == "ready"
    assert document["blocks"][0]["body"].startswith("```python")
    assert document["timeline"][0]["label"] == "Code appears"

    block_id = document["blocks"][0]["id"]
    correction_response = client.patch(
        f"/api/v1/reading-blocks/{block_id}",
        data={"body": "The function returns a reading document.", "note": "Make it prose."},
        content_type="application/json",
    )
    assert correction_response.status_code == 200
    assert correction_response.json()["block"]["is_user_edited"] is True


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN, MEDIA_ROOT="/tmp/describeops-test-media")
def test_url_ingest_marks_session_ready_only_after_all_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    observed_statuses: list[str] = []

    class ImmediateThread:
        def __init__(self, target: Any, daemon: bool = False) -> None:
            self.target = target
            self.daemon = daemon

        def start(self) -> None:
            self.target()

    class ChunkOnlyRunner:
        def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
            chunk.status = VideoChunk.Status.READY
            chunk.save(update_fields=["status", "updated_at"])
            chunk.session.refresh_from_db()
            observed_statuses.append(chunk.session.status)
            return {}

    monkeypatch.setattr("threading.Thread", ImmediateThread)
    monkeypatch.setattr(
        "reader.api.download_youtube_video",
        lambda url, work_dir, max_height: SimpleNamespace(
            video_path=Path("video.mp4"),
            metadata={
                "webpage_url": url,
                "title": "Two chunk video",
                "duration_seconds": 60,
            },
            subtitle_paths=[],
        ),
    )
    monkeypatch.setattr("reader.api.timed_transcript_from_vtt", lambda subtitle_paths: [])
    monkeypatch.setattr("reader.api.extract_frames_for_chunk", lambda **kwargs: [])
    monkeypatch.setattr("reader.api.AgentSocietyRunner", lambda: ChunkOnlyRunner())

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).post(
        "/api/v1/ingest/from-url",
        data={"url": "https://example.com/watch?v=two-chunks", "chunk_seconds": 30},
        content_type="application/json",
    )

    assert response.status_code == 202
    session = VideoSession.objects.get(id=response.json()["session_id"])
    assert observed_statuses == [VideoSession.Status.PROCESSING, VideoSession.Status.PROCESSING]
    assert session.status == VideoSession.Status.READY
    assert session.chunks.count() == 2


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_auth_required_for_api() -> None:
    response = Client().post("/api/v1/sessions", data={}, content_type="application/json")
    assert response.status_code == 401


@pytest.mark.django_db
@override_settings(DEBUG=True, DESCRIBEOPS_API_TOKEN=TOKEN, DESCRIBEOPS_ALLOW_DEBUG_EXTENSION_AUTH=True)
def test_debug_extension_origin_can_create_session_without_token() -> None:
    response = Client(HTTP_ORIGIN="chrome-extension://describeops-local").post(
        "/api/v1/sessions",
        data={
            "source_url": "https://example.com/watch?v=django",
            "title": "Build a Django Ninja API",
            "duration_seconds": 1800,
        },
        content_type="application/json",
    )
    assert response.status_code == 201


@pytest.mark.django_db
@override_settings(DEBUG=True, DESCRIBEOPS_API_TOKEN=TOKEN, DESCRIBEOPS_ALLOW_DEBUG_EXTENSION_AUTH=True)
def test_debug_local_document_read_without_origin_or_token() -> None:
    session = VideoSession.objects.create(
        source_url="https://example.com/watch?v=django",
        title="Build a Django Ninja API",
        page_title="Example",
        duration_seconds=1800,
    )

    response = Client().get(f"/api/v1/sessions/{session.id}/document")

    assert response.status_code == 200


def test_health_prefers_accuracy_first_visual_model(settings) -> None:
    settings.DASHSCOPE_API_KEY = "configured"
    client = Client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["visual_model"] == "qwen3.6-flash"
