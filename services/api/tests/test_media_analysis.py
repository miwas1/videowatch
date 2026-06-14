from __future__ import annotations

from types import SimpleNamespace

from describeops_api.media_analysis import analyze_media_job
from describeops_api.schemas import JobCreateRequest, JobRecord


class FakeGateway:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def describe_frame_list(self, **kwargs):
        self.calls.append(kwargs)
        chunk_id = kwargs["chunk_id"]
        return SimpleNamespace(
            content=f"[00:00] A presenter points to the key visual for {chunk_id}.",
            model="qwen-test",
            latencyMs=12,
            usage=SimpleNamespace(model_dump=lambda: {"totalTokens": 8}),
        )


def test_media_analysis_chunks_any_direct_media_into_playback_cues(monkeypatch):
    monkeypatch.setenv("QWEN_FIRST_CHUNK_SECONDS", "6")
    monkeypatch.setenv("QWEN_CHUNK_SECONDS", "30")
    gateway = FakeGateway()
    stages: list[str] = []
    job = JobRecord.create(
        JobCreateRequest(
            source="browser",
            mode="low_bandwidth",
            snapshot={
                "url": "https://example.test/watch",
                "title": "Demo lesson",
                "media": [
                    {
                        "id": "video-0",
                        "kind": "video",
                        "label": "Demo lesson",
                        "duration": 40,
                        "hasCaptions": True,
                        "source": "https://cdn.example.test/demo.mp4",
                        "platform": "generic",
                        "isFocused": True,
                    }
                ],
            },
            analysisRequest={
                "mediaId": "video-0",
                "sourceKind": "direct_url",
                "videoUrl": "https://cdn.example.test/demo.mp4",
                "pageUrl": "https://example.test/watch",
                "title": "Demo lesson",
                "duration": 40,
                "platform": "generic",
                "detailLevel": "balanced",
            },
        )
    )

    result = analyze_media_job(
        job,
        gateway=gateway,  # type: ignore[arg-type]
        on_progress=lambda stage, *_args: stages.append(stage),
    )

    assert len(gateway.calls) == 3
    assert all(isinstance(call["frames"], str) for call in gateway.calls)
    assert result.qwen_payload is not None
    assert len(result.qwen_payload["cues"]) == 3
    assert result.artifacts[0]["kind"] == "media-analysis-summary"
    assert result.artifacts[1]["kind"] == "chunk-timeline"
    assert "resolving_media" in stages
    assert stages[-1] == "complete"


def test_media_analysis_does_not_send_page_url_as_one_frame_sequence(monkeypatch):
    monkeypatch.setenv("QWEN_FIRST_CHUNK_SECONDS", "6")
    monkeypatch.setenv("QWEN_CHUNK_SECONDS", "30")
    gateway = FakeGateway()
    job = JobRecord.create(
        JobCreateRequest(
            source="browser",
            mode="low_bandwidth",
            snapshot={
                "url": "https://www.youtube.com/watch?v=C08zzUwcckI",
                "title": "Tricia becomes Peter's Mom",
                "platform": "youtube",
                "media": [
                    {
                        "id": "video-0",
                        "kind": "embedded-player",
                        "label": "Tricia becomes Peter's Mom",
                        "duration": 40,
                        "source": "https://www.youtube.com/watch?v=C08zzUwcckI",
                        "platform": "youtube",
                        "isFocused": True,
                    }
                ],
            },
            analysisRequest={
                "mediaId": "video-0",
                "sourceKind": "embedded_player",
                "videoUrl": "https://www.youtube.com/watch?v=C08zzUwcckI",
                "pageUrl": "https://www.youtube.com/watch?v=C08zzUwcckI",
                "title": "Tricia becomes Peter's Mom",
                "duration": 40,
                "platform": "youtube",
                "detailLevel": "balanced",
            },
        )
    )

    result = analyze_media_job(job, gateway=gateway)  # type: ignore[arg-type]

    assert gateway.calls == []
    assert result.qwen_payload is not None
    assert len(result.qwen_payload["cues"]) == 3
    assert all(
        chunk["transport"] == "snapshot-fallback"
        for chunk in result.qwen_payload["chunks"]
    )
