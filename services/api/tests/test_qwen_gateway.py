import httpx

from describeops_api.gateway import ModelPurpose, QwenGateway


def test_model_router_selects_purpose_specific_models(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    monkeypatch.setenv("QWEN_TEXT_MODEL", "qwen-plus-latest")
    monkeypatch.setenv("QWEN_MULTIMODAL_MODEL", "qwen3.7-plus")

    gateway = QwenGateway.from_env()

    assert gateway.model_for(ModelPurpose.TEXT_REASONING) == "qwen-plus-latest"
    assert gateway.model_for(ModelPurpose.MULTIMODAL_FRAME_ANALYSIS) == "qwen3.7-plus"


def test_model_router_uses_current_qwen_defaults(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
    monkeypatch.delenv("QWEN_TEXT_MODEL", raising=False)
    monkeypatch.delenv("QWEN_MULTIMODAL_MODEL", raising=False)
    monkeypatch.delenv("QWEN_OCR_MODEL", raising=False)
    monkeypatch.delenv("QWEN_QA_MODEL", raising=False)
    monkeypatch.delenv("QWEN_SUMMARY_MODEL", raising=False)

    gateway = QwenGateway.from_env()

    assert gateway.model_for(ModelPurpose.TEXT_REASONING) == "qwen-max-latest"
    assert gateway.model_for(ModelPurpose.MULTIMODAL_FRAME_ANALYSIS) == "qwen3.7-plus"
    assert gateway.model_for(ModelPurpose.OCR_ASSISTANCE) == "qwen3.7-plus"
    assert gateway.model_for(ModelPurpose.QA_SCORING) == "qwen-max-latest"
    assert gateway.model_for(ModelPurpose.SUMMARIZATION) == "qwen-plus-latest"


def test_openai_compatible_adapter_tracks_usage_and_trace(monkeypatch):
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")

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
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-test")
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
