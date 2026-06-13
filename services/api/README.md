# DescribeOps API

FastAPI backend for DescribeOps phase 4 and phase 5.

## Capabilities

- Authenticated job APIs under `/v1/jobs`.
- Authorized asset upload with size limits.
- `/health` response that proves Alibaba Cloud runtime marker and Qwen configuration presence without leaking secrets.
- Qwen Cloud/DashScope OpenAI-compatible gateway with model routing, trace IDs, token usage, and latency tracking.
- Evidence bundle packaging for page snapshots, frame samples, transcript segments, OCR observations, speech gaps, memory constraints, uncertainty, and privacy redaction.
- Media preprocessing plan generation for FFmpeg scene-change sampling, low-bandwidth fixed-interval sampling, audio extraction, subtitle extraction, faster-whisper transcription, and OCR.

## Environment

The API loads the nearest ancestor `.env` file at startup, so local development can keep secrets in the repository root `.env`. Exported shell variables still win over `.env` values.

- `DESCRIBEOPS_API_TOKEN`: bearer token required by all `/v1/*` routes.
- `DASHSCOPE_API_KEY`: Qwen Cloud / Alibaba Model Studio API key.
- `DASHSCOPE_BASE_URL`: defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1`.
- `ALIBABA_CLOUD_DEPLOYMENT`: runtime marker shown by `/health`.
- `DESCRIBEOPS_MAX_UPLOAD_BYTES`: upload guardrail, default 25 MB.
- `QWEN_TEXT_MODEL`, `QWEN_MULTIMODAL_MODEL`, `QWEN_OCR_MODEL`, `QWEN_QA_MODEL`, `QWEN_SUMMARY_MODEL`: model router overrides.

Default routing uses current Alibaba Model Studio model choices: `qwen-max-latest` for reasoning and QA, `qwen3.7-plus` for multimodal frame/video/OCR assistance, and `qwen-plus-latest` for summarization. Override these only if your DashScope region exposes a different model catalog.

## Local Commands

```bash
uv run --project services/api pytest
uv run --project services/api uvicorn describeops_api.main:app --reload
```
