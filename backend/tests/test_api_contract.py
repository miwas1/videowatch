from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, override_settings
from PIL import Image

from reader.models import GeneratedArtifact, ProcessingJob, ReadingBlock, StoredAsset, TimelineMoment, UserApiToken, VideoChunk
from reader.models import VideoSession
from reader.services.jobs import run_next_job
from reader.services.media_ingest import YouTubeAccessError, is_youtube_access_error


TOKEN = "test-token"


def drain_jobs() -> None:
    while run_next_job() is not None:
        pass


def png_frame() -> SimpleUploadedFile:
    image = Image.new("RGB", (96, 54), color=(30, 30, 30))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return SimpleUploadedFile("frame.png", buffer.getvalue(), content_type="image/png")


def webm_audio() -> SimpleUploadedFile:
    return SimpleUploadedFile("audio.webm", b"webm-audio-placeholder", content_type="audio/webm")


def create_user_token(user, raw_token: str) -> str:
    UserApiToken.objects.create(user=user, token_hash=hashlib.sha256(raw_token.encode("utf-8")).hexdigest())
    return raw_token


def test_youtube_access_error_detection_requires_access_gate_signal() -> None:
    assert is_youtube_access_error("ERROR: [youtube] abc: Sign in to confirm you're not a bot")
    assert is_youtube_access_error("ERROR: [youtube] abc: Use --cookies-from-browser or --cookies for authenticated access")
    assert not is_youtube_access_error("ERROR: [youtube] abc: requested format is not available; see cookie docs for examples")


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


class ChunkReadyRunner:
    def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
        chunk.status = VideoChunk.Status.READY
        chunk.latency_ms = 25
        chunk.save(update_fields=["status", "latency_ms", "updated_at"])
        ReadingBlock.objects.create(
            session=chunk.session,
            chunk=chunk,
            order=0,
            kind=ReadingBlock.Kind.VISUAL_CONTEXT,
            heading="Captured frame",
            body="The recorded segment displays current visual context.",
            start_seconds=chunk.start_seconds,
            end_seconds=chunk.end_seconds,
            source_evidence=["captured frame"],
            confidence=0.8,
        )
        return {}


class TranscriptAwareRunner:
    def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
        assert "spoken hammer safety tip" in chunk.transcript_text
        chunk.status = VideoChunk.Status.READY
        chunk.latency_ms = 25
        chunk.save(update_fields=["status", "latency_ms", "updated_at"])
        ReadingBlock.objects.create(
            session=chunk.session,
            chunk=chunk,
            order=0,
            kind=ReadingBlock.Kind.EXPLANATION,
            heading="Audio-backed instruction",
            body="The transcript says a spoken hammer safety tip.",
            start_seconds=chunk.start_seconds,
            end_seconds=chunk.end_seconds,
            source_evidence=["audio transcript"],
            confidence=0.85,
        )
        return {}


class FallbackRunner:
    def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
        chunk.status = VideoChunk.Status.READY
        chunk.latency_ms = 25
        chunk.save(update_fields=["status", "latency_ms", "updated_at"])
        ReadingBlock.objects.create(
            session=chunk.session,
            chunk=chunk,
            order=0,
            kind=ReadingBlock.Kind.VISUAL_CONTEXT,
            heading="Frame-only fallback",
            body="Analysis continued even though audio transcription failed.",
            start_seconds=chunk.start_seconds,
            end_seconds=chunk.end_seconds,
            source_evidence=["captured frame"],
            confidence=0.75,
        )
        return {}


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_register_issues_account_token_and_me_returns_user() -> None:
    client = Client()

    response = client.post(
        "/api/v1/auth/register",
        data={"email": "Reader@Example.com", "password": "strong-pass-123"},
        content_type="application/json",
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["token"]
    assert payload["user"]["email"] == "reader@example.com"

    me_response = Client(HTTP_X_DESCRIBEOPS_TOKEN=payload["token"]).get("/api/v1/auth/me")
    assert me_response.status_code == 200
    assert me_response.json() == payload["user"]


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_user_tokens_only_see_owned_sessions() -> None:
    User = get_user_model()
    owner = User.objects.create_user(username="owner@example.com", email="owner@example.com", password="strong-pass-123")
    other = User.objects.create_user(username="other@example.com", email="other@example.com", password="strong-pass-123")
    owner_token = create_user_token(owner, "owner-token")

    own_session = VideoSession.objects.create(owner=owner, source_url="https://example.com/own", title="Own session")
    VideoSession.objects.create(owner=other, source_url="https://example.com/other", title="Other session")

    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=owner_token)
    list_response = client.get("/api/v1/sessions")
    assert list_response.status_code == 200
    assert [session["id"] for session in list_response.json()] == [str(own_session.id)]

    other_session = VideoSession.objects.get(owner=other)
    detail_response = client.get(f"/api/v1/sessions/{other_session.id}")
    assert detail_response.status_code == 404


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_service_token_can_still_see_all_sessions() -> None:
    User = get_user_model()
    owner = User.objects.create_user(username="owner@example.com", email="owner@example.com", password="strong-pass-123")
    other = User.objects.create_user(username="other@example.com", email="other@example.com", password="strong-pass-123")
    VideoSession.objects.create(owner=owner, source_url="https://example.com/own", title="Own session")
    VideoSession.objects.create(owner=other, source_url="https://example.com/other", title="Other session")

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).get("/api/v1/sessions")

    assert response.status_code == 200
    assert {session["title"] for session in response.json()} == {"Own session", "Other session"}


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
def test_async_chunk_upload_accepts_audio_and_records_assets() -> None:
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    create_response = client.post(
        "/api/v1/sessions",
        data={
            "source_url": "https://private.example.com/course/video",
            "title": "Private course clip",
            "duration_seconds": 90,
        },
        content_type="application/json",
    )
    assert create_response.status_code == 201
    session_id = create_response.json()["id"]

    upload_response = client.post(
        f"/api/v1/sessions/{session_id}/chunks/async",
        data={
            "chunk_index": "0",
            "start_seconds": "0",
            "end_seconds": "30",
            "transcript_text": "",
            "capture_notes": "Extension captured an authenticated video.",
            "frames": [png_frame()],
            "audio_chunks": [webm_audio()],
        },
    )

    assert upload_response.status_code == 202
    session = VideoSession.objects.get(id=session_id)
    assert session.source_fingerprint
    assert session.canonical_video_id
    assert StoredAsset.objects.filter(session=session, asset_type=StoredAsset.AssetType.FRAME).count() == 1
    audio_asset = StoredAsset.objects.get(session=session, asset_type=StoredAsset.AssetType.AUDIO_CHUNK)
    assert audio_asset.object_key.endswith(".webm")
    assert audio_asset.canonical_video_id == session.canonical_video_id
    assert ProcessingJob.objects.filter(session=session, job_type=ProcessingJob.JobType.CHUNK_ANALYSIS).count() == 1


@pytest.mark.django_db
@override_settings(
    DESCRIBEOPS_API_TOKEN=TOKEN,
    MEDIA_ROOT="/tmp/describeops-test-media",
    DASHSCOPE_API_KEY="configured",
    QWEN_AUDIO_TRANSCRIPTION_MODEL="fake-audio",
)
def test_async_audio_chunk_is_transcribed_and_used_before_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeAudioQwen:
        def transcribe_audio(self, *, data: bytes, filename: str, content_type: str, model: str | None = None):
            assert data == b"webm-audio-placeholder"
            assert filename.endswith(".webm")
            assert content_type == "audio/webm"
            return SimpleNamespace(
                model="fake-audio",
                content={"text": "spoken hammer safety tip", "raw": {"text": "spoken hammer safety tip"}},
                request_id="audio-request-1",
                latency_ms=12,
            )

    monkeypatch.setattr("reader.services.audio.QwenClient", FakeAudioQwen)
    monkeypatch.setattr("reader.services.agents.AgentSocietyRunner", lambda: TranscriptAwareRunner())

    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    create_response = client.post(
        "/api/v1/sessions",
        data={
            "source_url": "https://private.example.com/course/audio-video",
            "title": "Private audio clip",
            "duration_seconds": 30,
        },
        content_type="application/json",
    )
    assert create_response.status_code == 201
    session_id = create_response.json()["id"]

    upload_response = client.post(
        f"/api/v1/sessions/{session_id}/chunks/async",
        data={
            "chunk_index": "0",
            "start_seconds": "0",
            "end_seconds": "30",
            "transcript_text": "",
            "capture_notes": "Authenticated media capture.",
            "frames": [png_frame()],
            "audio_chunks": [webm_audio()],
        },
    )

    assert upload_response.status_code == 202
    drain_jobs()

    chunk = VideoChunk.objects.get(session_id=session_id, chunk_index=0)
    assert "[Audio transcript 00:00 - 00:30]" in chunk.transcript_text
    assert "spoken hammer safety tip" in chunk.transcript_text
    transcript_asset = StoredAsset.objects.get(session_id=session_id, asset_type=StoredAsset.AssetType.TRANSCRIPT)
    with default_storage.open(transcript_asset.object_key, "rb") as stored_file:
        transcript_payload = json.loads(stored_file.read().decode("utf-8"))
    assert transcript_payload["text"] == "spoken hammer safety tip"
    assert transcript_payload["audio_object_key"].endswith(".webm")
    session = VideoSession.objects.get(id=session_id)
    assert session.events.filter(event_type="audio.transcribed").exists()
    assert session.status == VideoSession.Status.READY


@pytest.mark.django_db
@override_settings(
    DESCRIBEOPS_API_TOKEN=TOKEN,
    MEDIA_ROOT="/tmp/describeops-test-media",
    DASHSCOPE_API_KEY="configured",
    QWEN_AUDIO_TRANSCRIPTION_MODEL="fake-audio",
)
def test_audio_transcription_failure_does_not_block_chunk_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    class FailingAudioQwen:
        def transcribe_audio(self, **kwargs):
            raise RuntimeError("audio service unavailable")

    monkeypatch.setattr("reader.services.audio.QwenClient", FailingAudioQwen)
    monkeypatch.setattr("reader.services.agents.AgentSocietyRunner", lambda: FallbackRunner())

    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    create_response = client.post(
        "/api/v1/sessions",
        data={
            "source_url": "https://private.example.com/course/fallback-video",
            "title": "Private fallback clip",
            "duration_seconds": 30,
        },
        content_type="application/json",
    )
    assert create_response.status_code == 201
    session_id = create_response.json()["id"]

    upload_response = client.post(
        f"/api/v1/sessions/{session_id}/chunks/async",
        data={
            "chunk_index": "0",
            "start_seconds": "0",
            "end_seconds": "30",
            "frames": [png_frame()],
            "audio_chunks": [webm_audio()],
        },
    )

    assert upload_response.status_code == 202
    drain_jobs()

    session = VideoSession.objects.get(id=session_id)
    chunk = VideoChunk.objects.get(session=session, chunk_index=0)
    assert chunk.status == VideoChunk.Status.READY
    assert session.status == VideoSession.Status.READY
    assert not StoredAsset.objects.filter(session=session, asset_type=StoredAsset.AssetType.TRANSCRIPT).exists()
    assert session.events.filter(event_type="audio.failed").exists()


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_create_session_reuses_ready_canonical_artifacts() -> None:
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    payload = {
        "source_url": "https://private.example.com/course/reused-video",
        "title": "Reusable private lesson",
        "duration_seconds": 120,
    }
    first_response = client.post("/api/v1/sessions", data=payload, content_type="application/json")
    assert first_response.status_code == 201
    first_session = VideoSession.objects.get(id=first_response.json()["id"])
    first_session.status = VideoSession.Status.READY
    first_session.pipeline_stage = VideoSession.PipelineStage.READY
    first_session.save(update_fields=["status", "pipeline_stage", "updated_at"])
    artifact = GeneratedArtifact.objects.create(
        session=first_session,
        artifact_type=GeneratedArtifact.ArtifactType.READING_DOCUMENT,
        workflow_template="reading_document",
        title="Reusable private lesson",
        summary="Cached summary.",
        markdown="# Cached artifact",
        payload={"sections": []},
    )
    StoredAsset.objects.create(
        canonical_video=first_session.canonical_video,
        session=first_session,
        artifact=artifact,
        asset_type=StoredAsset.AssetType.FINAL_ARTIFACT,
        object_key="final/source-session/reading_document.md",
        content_type="text/markdown",
        checksum="a" * 64,
        byte_size=18,
    )

    second_response = client.post("/api/v1/sessions", data=payload, content_type="application/json")

    assert second_response.status_code == 201
    second_session = VideoSession.objects.get(id=second_response.json()["id"])
    assert second_session.status == VideoSession.Status.READY
    copied_artifact = second_session.artifacts.get(workflow_template="reading_document")
    assert copied_artifact.markdown == "# Cached artifact"
    reused_asset = second_session.stored_assets.get(asset_type=StoredAsset.AssetType.FINAL_ARTIFACT)
    assert reused_asset.object_key == "final/source-session/reading_document.md"
    assert reused_asset.metadata["reused_from_session_id"] == str(first_session.id)


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN, MEDIA_ROOT="/tmp/describeops-test-media")
def test_url_ingest_marks_session_ready_only_after_all_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    observed_statuses: list[str] = []

    class ChunkOnlyRunner:
        def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
            chunk.status = VideoChunk.Status.READY
            chunk.save(update_fields=["status", "updated_at"])
            chunk.session.refresh_from_db()
            observed_statuses.append(chunk.session.status)
            return {}

    monkeypatch.setattr(
        "reader.services.jobs.download_youtube_video",
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
        data={"url": "https://example.com/watch?v=two-chunks", "chunk_seconds": 30, "auto_synthesize": False},
        content_type="application/json",
    )

    assert response.status_code == 202
    drain_jobs()
    session = VideoSession.objects.get(id=response.json()["session_id"])
    assert observed_statuses == [VideoSession.Status.PROCESSING, VideoSession.Status.PROCESSING]
    assert session.status == VideoSession.Status.READY
    assert session.chunks.count() == 2


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_url_ingest_classifies_youtube_access_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_download(*args: Any, **kwargs: Any) -> None:
        raise YouTubeAccessError("YouTube blocked the server download.")

    monkeypatch.setattr("reader.services.jobs.download_youtube_video", fail_download)

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).post(
        "/api/v1/ingest/from-url",
        data={"url": "https://www.youtube.com/watch?v=1nVGaNbvuXg"},
        content_type="application/json",
    )

    assert response.status_code == 202
    run_next_job()
    progress = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).get(f"/api/v1/sessions/{response.json()['session_id']}/progress").json()
    assert progress["status"] == "failed"
    assert progress["ingest_error_code"] == "youtube_access_required"
    assert progress["error_message"] == "YouTube blocked the server download."


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_async_chunk_marks_regular_session_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("reader.services.agents.AgentSocietyRunner", lambda: ChunkReadyRunner())
    client = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN)
    session = VideoSession.objects.create(
        source_url="https://example.com/watch?v=django",
        title="Build a Django Ninja API",
        status=VideoSession.Status.PROCESSING,
        pipeline_stage=VideoSession.PipelineStage.ANALYZING,
    )

    response = client.post(
        f"/api/v1/sessions/{session.id}/chunks/async",
        data={
            "chunk_index": "0",
            "start_seconds": "0",
            "end_seconds": "15",
            "frames": [png_frame()],
        },
    )

    assert response.status_code == 202
    run_next_job()
    session.refresh_from_db()
    assert session.status == VideoSession.Status.READY
    assert session.pipeline_stage == VideoSession.PipelineStage.READY


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN, MEDIA_ROOT="/tmp/describeops-test-media")
def test_file_ingest_processes_uploaded_video(monkeypatch: pytest.MonkeyPatch) -> None:
    class ChunkOnlyRunner:
        def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
            chunk.status = VideoChunk.Status.READY
            chunk.save(update_fields=["status", "updated_at"])
            return {}

    monkeypatch.setattr("reader.api.probe_duration", lambda path: 61)
    monkeypatch.setattr("reader.api.extract_frames_for_chunk", lambda **kwargs: [])
    monkeypatch.setattr("reader.api.AgentSocietyRunner", lambda: ChunkOnlyRunner())

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).post(
        "/api/v1/ingest/from-file",
        data={
            "video": SimpleUploadedFile("lesson.mp4", b"not-a-real-video", content_type="video/mp4"),
            "workflow_template": "reading_document",
            "chunk_seconds": "30",
            "auto_synthesize": "false",
        },
    )

    assert response.status_code == 202
    drain_jobs()
    session = VideoSession.objects.get(id=response.json()["session_id"])
    assert session.status == VideoSession.Status.READY
    assert session.settings["source_type"] == "upload"
    assert session.settings["filename"] == "lesson.mp4"
    assert session.chunks.count() == 3


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_cancel_session_marks_queued_jobs_canceled() -> None:
    session = VideoSession.objects.create(
        status=VideoSession.Status.PROCESSING,
        pipeline_stage=VideoSession.PipelineStage.DOWNLOADING,
        settings={"workflow_template": "reading_document"},
    )
    ProcessingJob.objects.create(session=session, job_type=ProcessingJob.JobType.URL_INGEST, payload={})

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).post(f"/api/v1/sessions/{session.id}/cancel", data={}, content_type="application/json")

    assert response.status_code == 202
    session.refresh_from_db()
    assert session.status == VideoSession.Status.FAILED
    assert session.settings["cancel_requested"] is True
    assert session.error_message == "Canceled by user."
    assert session.processing_jobs.get().status == ProcessingJob.Status.CANCELED


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_retry_failed_url_session_requeues_ingest() -> None:
    session = VideoSession.objects.create(
        source_url="https://example.com/video",
        status=VideoSession.Status.FAILED,
        pipeline_stage=VideoSession.PipelineStage.FAILED,
        settings={
            "workflow_template": "reading_document",
            "chunk_seconds": 30,
            "frame_count": 4,
            "frame_width": 640,
            "max_height": 360,
            "auto_synthesize": True,
            "output_targets": ["reading_document"],
            "ingest_error_code": "youtube_access_required",
            "cancel_requested": True,
        },
        error_message="YouTube blocked the server download.",
    )

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).post(f"/api/v1/sessions/{session.id}/retry", data={}, content_type="application/json")

    assert response.status_code == 202
    session.refresh_from_db()
    assert session.status == VideoSession.Status.PROCESSING
    assert session.pipeline_stage == VideoSession.PipelineStage.DOWNLOADING
    assert session.settings["cancel_requested"] is False
    assert session.settings["ingest_error_code"] == ""
    job = session.processing_jobs.get()
    assert job.job_type == ProcessingJob.JobType.URL_INGEST
    assert job.payload["url"] == "https://example.com/video"


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_delete_session_removes_session() -> None:
    session = VideoSession.objects.create(source_url="https://example.com/video")

    response = Client(HTTP_X_DESCRIBEOPS_TOKEN=TOKEN).delete(f"/api/v1/sessions/{session.id}")

    assert response.status_code == 200
    assert not VideoSession.objects.filter(id=session.id).exists()


@pytest.mark.django_db
@override_settings(DESCRIBEOPS_API_TOKEN=TOKEN)
def test_auth_required_for_api() -> None:
    response = Client().post("/api/v1/sessions", data={}, content_type="application/json")
    assert response.status_code == 401


@pytest.mark.django_db
@override_settings(DEBUG=False, DESCRIBEOPS_API_TOKEN=TOKEN)
def test_extension_origin_can_create_session_without_token_by_default() -> None:
    response = Client(HTTP_ORIGIN="chrome-extension://describeops-installed").post(
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
@override_settings(DEBUG=False, DESCRIBEOPS_API_TOKEN=TOKEN)
def test_extension_origin_can_stream_session_events_without_token_by_default() -> None:
    session = VideoSession.objects.create(
        source_url="https://example.com/watch?v=django",
        title="Build a Django Ninja API",
    )

    response = Client(HTTP_ORIGIN="chrome-extension://describeops-installed").get(
        f"/api/v1/sessions/{session.id}/events?after=0",
        HTTP_ACCEPT="text/event-stream",
    )

    assert response.status_code == 200
    assert response["Content-Type"] == "text/event-stream"


@pytest.mark.django_db
@override_settings(DEBUG=False, DESCRIBEOPS_API_TOKEN=TOKEN)
def test_extension_origin_auth_is_always_tokenless() -> None:
    response = Client(HTTP_ORIGIN="chrome-extension://describeops-installed").post(
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
