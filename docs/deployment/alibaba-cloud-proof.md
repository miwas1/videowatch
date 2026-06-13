# Alibaba Cloud Deployment Proof

DescribeOps phase 4 is designed to run the FastAPI backend on Alibaba Cloud and call Qwen Cloud / DashScope only from the backend.

## Runtime Proof

The backend exposes:

```text
GET /health
```

Expected non-secret fields:

```json
{
  "service": "describeops-api",
  "version": "0.1.0",
  "cloud": {
    "provider": "alibaba-cloud",
    "deployment": "ecs-demo"
  },
  "qwen": {
    "configured": true,
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "models": {
      "text_reasoning": "qwen-max-latest",
      "multimodal_frame_analysis": "qwen3.7-plus",
      "ocr_assistance": "qwen3.7-plus",
      "qa_scoring": "qwen-max-latest",
      "summarization": "qwen-plus-latest"
    }
  }
}
```

The response proves Qwen configuration presence without returning `DASHSCOPE_API_KEY`.

## Deployment Shape

- Runtime: Alibaba Cloud ECS, Container Service, or Function Compute custom container.
- Container: `services/api/Dockerfile`.
- Secrets:
  - `DASHSCOPE_API_KEY`
  - `DESCRIBEOPS_API_TOKEN`
- Runtime marker:
  - `ALIBABA_CLOUD_DEPLOYMENT=ecs-demo` or the deployed service name.

## Qwen Cloud Integration Proof

Code path:

- `services/api/src/describeops_api/gateway.py`
- Uses `DASHSCOPE_API_KEY`.
- Calls the OpenAI-compatible DashScope endpoint `/compatible-mode/v1/chat/completions`.
- Adds `X-DescribeOps-Trace-Id` for request tracing.
- Captures returned token usage and model name for cost tracking.

## Recording Checklist

- Show Alibaba Cloud service/container running.
- Show environment variables with secret values redacted.
- Call `/health`.
- Create a job with `POST /v1/jobs`.
- Trigger `POST /v1/jobs/{id}/analyze`.
- Show Qwen trace/log entry with secret redacted.
