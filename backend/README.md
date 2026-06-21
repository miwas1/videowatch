# DescribeOps Backend

Django Ninja backend for turning extension-captured video context into a context-preserving reading document.

The live chunk path uses `qwen3.6-flash` by default for lower latency. Accuracy-focused fallbacks/refinement can use
`qwen3.6-plus` through `QWEN_*_FALLBACK_MODELS` and `QWEN_JUDGE_MODEL`.

Export commands also run a final session-level report agent. By default `QWEN_FINAL_MODEL=qwen3.7-max` assembles the
polished `final_report.md` from extracted text, code examples, screenshots, audio references, timeline moments, and
agent evidence. If that model is unavailable in the configured Model Studio region, the backend falls back through
`QWEN_FINAL_FALLBACK_MODELS` (`qwen3-max,qwen3.5-plus,qwen3.6-plus`) and still writes a deterministic fallback report if
the final agent cannot complete.

## Local commands

```bash
uv run python manage.py check
uv run pytest
uv run python manage.py qwen_smoke
uv run python manage.py pipeline_smoke
uv run python manage.py runserver 127.0.0.1:8000
```

## Main endpoints

- `POST /api/v1/sessions`
- `POST /api/v1/sessions/{session_id}/chunks`
- `GET /api/v1/sessions/{session_id}/document`
- `GET /api/v1/sessions/{session_id}/timeline`
- `GET /api/v1/sessions/{session_id}/events`
- `PATCH /api/v1/reading-blocks/{block_id}`
