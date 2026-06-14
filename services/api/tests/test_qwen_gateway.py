import json

import httpx
import pytest

from describeops_api.chunking import (
    ChunkRetryQueue,
    RealtimeReconnectState,
    build_chunk_memory,
    build_section_memory,
    plan_video_chunks,
    retrieve_question_context,
)
from describeops_api.gateway import ModelPurpose, QwenConfigError, QwenGateway
from describeops_api.schemas import QwenTimelineEvent, QwenTtsRequest, QwenVisualChunkRequest


def test_qwen_api_key_is_configured_for_ai_jobs(monkeypatch):
    monkeypatch.delenv("QWEN_API_KEY", raising=False)
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    gateway = QwenGateway.from_env(client=httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200))))

    with pytest.raises(QwenConfigError) as error:
        gateway.chat(
            purpose=ModelPurpose.TEXT_REASONING,
            messages=[{"role": "user", "content": "hello"}],
            trace_id="trc_missing",
        )

    assert error.value.code == "CONFIG_ERROR"
    assert "QWEN_API_KEY" in str(error.value)


def test_model_router_selects_purpose_specific_models(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")
    monkeypatch.setenv("QWEN_TEXT_MODEL", "qwen-plus-latest")
    monkeypatch.setenv("QWEN_MULTIMODAL_MODEL", "qwen3.7-plus")

    gateway = QwenGateway.from_env()

    assert gateway.model_for(ModelPurpose.TEXT_REASONING) == "qwen-plus-latest"
    assert gateway.model_for(ModelPurpose.MULTIMODAL_FRAME_ANALYSIS) == "qwen3.7-plus"


def test_model_router_uses_current_qwen_defaults(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")
    monkeypatch.delenv("QWEN_TEXT_MODEL", raising=False)
    monkeypatch.delenv("QWEN_MULTIMODAL_MODEL", raising=False)
    monkeypatch.delenv("QWEN_OCR_MODEL", raising=False)
    monkeypatch.delenv("QWEN_QA_MODEL", raising=False)
    monkeypatch.delenv("QWEN_SUMMARY_MODEL", raising=False)

    gateway = QwenGateway.from_env()

    assert gateway.model_for(ModelPurpose.TEXT_REASONING) == "qwen-max-latest"
    assert gateway.model_for(ModelPurpose.MULTIMODAL_FRAME_ANALYSIS) == "qwen-vl-max-latest"
    assert gateway.model_for(ModelPurpose.OCR_ASSISTANCE) == "qwen-vl-max-latest"
    assert gateway.model_for(ModelPurpose.QA_SCORING) == "qwen-max-latest"
    assert gateway.model_for(ModelPurpose.SUMMARIZATION) == "qwen-plus-latest"


def test_openai_compatible_adapter_tracks_usage_and_trace(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")

    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
                "model": "qwen-plus",
            },
        )

    gateway = QwenGateway.from_env(
        client=httpx.Client(transport=httpx.MockTransport(handler))
    )

    result = gateway.chat(
        purpose=ModelPurpose.TEXT_REASONING,
        messages=[{"role": "user", "content": "Summarize"}],
        trace_id="trc_test",
    )

    assert requests[0].url.path.endswith("/chat/completions")
    assert requests[0].headers["authorization"] == "Bearer sk-test"
    assert requests[0].headers["x-describeops-trace-id"] == "trc_test"
    assert result.content == "ok"
    assert result.usage.totalTokens == 5


def test_gateway_retries_transient_rate_limit_response(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "retry ok"}}],
                "usage": {"total_tokens": 1},
                "model": "qwen-plus",
            },
        )

    gateway = QwenGateway.from_env(
        client=httpx.Client(transport=httpx.MockTransport(handler))
    )

    result = gateway.chat(
        purpose=ModelPurpose.TEXT_REASONING,
        messages=[{"role": "user", "content": "Retry"}],
        trace_id="trc_retry",
    )

    assert result.content == "retry ok"
    assert calls == 2


def test_backend_can_make_basic_qwen_health_call(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"total_tokens": 2},
                "model": "qwen-plus",
            },
        )

    gateway = QwenGateway.from_env(client=httpx.Client(transport=httpx.MockTransport(handler)))

    health = gateway.health_check(trace_id="trc_health")

    assert health["status"] == "ok"
    assert health["latencyMs"] < gateway.timeout_seconds * 1000


def test_sends_sampled_frames_and_transcript_chunk_to_qwen_json_contract(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": (
                                '{"events":[{"start":10.2,"end":14.8,"type":"visual_action",'
                                '"description":"She pours milk into the flour.","importance":"high"}],'
                                '"chunk_summary":"The instructor begins preparing pancake batter."}'
                            )
                        }
                    }
                ],
                "usage": {"total_tokens": 10},
                "model": "qwen-vl",
            },
        )

    gateway = QwenGateway.from_env(client=httpx.Client(transport=httpx.MockTransport(handler)))
    response = gateway.analyze_visual_chunk(
        QwenVisualChunkRequest(
            video_id="demo-001",
            chunk_id="chunk-0001",
            start=0,
            end=30,
            frames=["frame_000.jpg", "frame_005.jpg", "frame_010.jpg"],
            transcript=[{"start": 2.1, "end": 5.4, "text": "Today we are making pancakes."}],
            ocr=[{"time": 12.0, "text": "Add two cups of flour"}],
        ),
        trace_id="trc_chunk",
    )

    sent = json.loads(requests[0].content)["messages"][1]["content"]
    assert "frame_005.jpg" in sent
    assert response.events[0].description == "She pours milk into the flour."
    assert response.events[0].importance == "high"


def test_raw_unstructured_qwen_text_cannot_enter_playback_engine(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "She pours milk into the flour."}}],
                "usage": {"total_tokens": 3},
                "model": "qwen-vl",
            },
        )

    gateway = QwenGateway.from_env(client=httpx.Client(transport=httpx.MockTransport(handler)))

    with pytest.raises(ValueError):
        gateway.analyze_visual_chunk(
            QwenVisualChunkRequest(
                video_id="demo-001",
                chunk_id="chunk-0001",
                start=0,
                end=30,
                frames=["frame_000.jpg"],
            ),
            trace_id="trc_bad_chunk",
        )


def test_qwen_tts_creates_playable_audio_contract(monkeypatch):
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=b"mp3-bytes")

    gateway = QwenGateway.from_env(client=httpx.Client(transport=httpx.MockTransport(handler)))

    audio = gateway.synthesize_tts(
        QwenTtsRequest(text="She pours milk into the flour.", voice="default", speed=1.05),
        trace_id="trc_tts",
    )

    assert audio.status == "ready"
    assert audio.durationMs > 0
    assert audio.format == "audio/mpeg"
    assert audio.audioBytes == b"mp3-bytes"


def test_realtime_session_reconnects_cleanly():
    state = RealtimeReconnectState()

    message = state.disconnected()
    state.reconnected()

    assert message == "Reconnecting accessibility assistant..."
    assert state.reconnectAttempts == 1
    assert state.status == "connected"


def test_qwen_rate_limit_queue_does_not_duplicate_chunks():
    queue = ChunkRetryQueue()

    first_backoff = queue.mark_rate_limited("chunk-0001")
    second_backoff = queue.mark_rate_limited("chunk-0001")

    assert queue.queued == ["chunk-0001"]
    assert "chunk-0001" in queue.retryable
    assert second_backoff > first_backoff


def test_qwen_timeout_keeps_partial_timeline_usable():
    queue = ChunkRetryQueue()

    state = queue.mark_timeout("chunk-0007")

    assert state["spinner"] == "stopped"
    assert state["partialTimelineUsable"] is True
    assert state["retryable"] is True
    assert queue.queued == ["chunk-0007"]


def test_long_video_uses_chunking_and_timeline_memory():
    chunks = plan_video_chunks(30 * 60, chunk_seconds=45, overlap_seconds=5)

    assert chunks[0].start == 0
    assert chunks[1].start == 40
    assert chunks[-1].end == 1800

    event = QwenTimelineEvent(
        start=670.2,
        end=681.5,
        type="ocr",
        description="The presenter shows the DATABASE_URL field.",
        importance="high",
    )
    memories = [
        build_chunk_memory(
            chunk_id="chunk-0012",
            start=660,
            end=720,
            summary="The presenter explains database configuration.",
            events=[event],
            ocr_keywords=["DATABASE_URL", "Save settings"],
        )
    ]
    section = build_section_memory(2, memories)
    context = retrieve_question_context(
        current_time=675,
        chunks=memories,
        sections=[section],
        question="What does DATABASE_URL mean?",
    )

    assert context["nearby_chunk_summaries"] == ["The presenter explains database configuration."]
    assert context["matching_ocr"] == ["DATABASE_URL"]
    assert "database configuration" in context["global_video_summary"]
