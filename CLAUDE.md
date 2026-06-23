# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DescribeOps** — an AI accessibility pipeline that transforms videos into context-preserving reading documents with audio descriptions. Three main parts:

- **Chrome Extension** (`apps/extension/`) — React + TypeScript, built with Vite. Detects video on any page, captures frames, surfaces the generated reading document in a side panel.
- **Django Ninja Backend** (`backend/`) — REST API + SSE event stream. Receives chunk uploads, runs Qwen multimodal agents, persists results, serves the reading document.
- **Standalone script** (`youtube_qwen_analyze.py`) — direct Qwen pipeline without the full stack.

## Commands

### Web app (`apps/web/`)

```bash
npm install            # install from apps/web/ or root workspace
npm run dev            # Vite dev server on port 5174 (proxies /api → Django 8000)
npm run build          # typecheck + Vite → dist/ (deployable to Amplify / Vercel / etc.)
npm run typecheck      # tsc --noEmit
```

Environment variables (`.env` in `apps/web/` or at build time):
```
VITE_API_BASE_URL=https://your-backend.example.com   # empty = relative URLs (dev proxy)
VITE_API_TOKEN=your-token                             # X-DescribeOps-Token header
```

### Extension (root or `apps/extension/`)

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # Vite → dist/
npm test               # Vitest
npm run verify         # typecheck + test + build
```

### Backend (`backend/`)

```bash
uv sync                                    # install deps (or: pip install -e ".[dev]")
uv run python manage.py check              # Django system check
uv run python manage.py runserver 127.0.0.1:8000
uv run pytest                              # all tests
uv run pytest tests/test_api_contract.py   # single file
uv run python manage.py qwen_smoke         # verify Qwen API config
uv run python manage.py pipeline_smoke     # end-to-end smoke test
```

## Architecture

### Data flow

```
Web app / Extension → POST /api/v1/ingest/from-url (workflow_template, auto_synthesize=true)
                    → Django downloads via yt-dlp + extracts frames with FFmpeg
                    → VideoChunks created; AgentSocietyRunner processes each chunk
                    → ReadingBlocks + TimelineMoments written to DB
                    → When all chunks ready: synthesize_session() → GeneratedArtifact created
                    → Web app polls GET /api/v1/sessions/{id}/progress
                    → Review: GET /api/v1/sessions/{id}/document + /artifacts
                    → Export: GET /api/v1/sessions/{id}/export/markdown or artifact .markdown field
```

Extension flow: Browser page → content-script detects media → side panel → chunk upload → same pipeline (no auto_synthesize).

### Backend modules (`backend/reader/`)

| File | Role |
|---|---|
| `models.py` | `VideoSession`, `VideoChunk`, `FrameAsset`, `AgentRun`, `ReadingBlock`, `TimelineMoment`, `SessionEvent`, `UserCorrection`, `GeneratedArtifact` |
| `api.py` | Django Ninja router — all `/api/v1/` endpoints incl. `GET /sessions`, `/progress`, `/chunks`, `/artifacts`, `POST /artifacts` |
| `services/agents.py` | `AgentSocietyRunner` — orchestrates Qwen agents per chunk, writes DB records |
| `services/qwen.py` | `QwenClient` — wraps DashScope API, model selection, retries |
| `services/artifact_builder.py` | `build_artifact_from_session()` — renders `GeneratedArtifact` for each of the 10 workflow presets |
| `services/artifacts.py` | Parses raw Qwen output into structured `ReadingBlock`/`TimelineMoment` dicts |
| `services/media_ingest.py` | yt-dlp download, FFmpeg frame extraction |
| `services/transcript.py` | Transcript fetch/parse |
| `services/export.py` | Markdown export |

### Web app (`apps/web/src/`)

| Path | Role |
|---|---|
| `App.tsx` | Top-level view router: `home` → `processing` → `review` |
| `pages/HomePage.tsx` | URL input, preset rail, recent jobs |
| `pages/ProcessingPage.tsx` | Polls progress, transitions to review on `artifact_ready` |
| `pages/ReviewPage.tsx` | Tabbed review: document, timeline, evidence, export |
| `api/client.ts` | All backend API calls; reads `VITE_API_BASE_URL` + `VITE_API_TOKEN` |
| `lib/presets.ts` | 10 workflow preset definitions |
| `hooks/usePollingProgress.ts` | Polls `/progress` until `status=ready && artifact_ready` |
| `components/ExportPanel.tsx` | Downloads existing artifacts; triggers artifact regeneration |

### Extension entry points (`apps/extension/src/`)

| Entry | Purpose |
|---|---|
| `service-worker.ts` | Background message routing, tab capture |
| `content/detector.ts` | Video/platform detection injected into every page |
| `ui/sidepanel-main.tsx` | Main working panel (session, document, review) |
| `ui/popup-main.tsx` | Settings/config popup |
| `ui/backend-api.ts` | Typed fetch client for the Django backend |
| `types.ts` | Shared types (`VideoPlatform`, `ReadingBlock`, `SessionResponse`, etc.) |

### Agent society

`AgentSocietyRunner.process_chunk()` sends each `VideoChunk`'s frames + transcript to Qwen in a single multipart request. Results are parsed by `artifacts.py` and written as `ReadingBlock` rows (kinds: `intro`, `explanation`, `example`, `code`, `visual_context`, `quote`, `demo_step`, `timestamp_anchor`, `takeaway`). A final `synthesize_session()` call runs `qwen3.7-max` over the full set to produce the finished document.

## Environment Variables

Loaded from `.env` (repo root or `backend/`):

```
DASHSCOPE_API_KEY=          # Qwen/DashScope API key
DESCRIBEOPS_API_TOKEN=      # Extension → backend auth (X-DescribeOps-Token header)
QWEN_VISUAL_MODEL=          # default: qwen3.6-flash
QWEN_TEXT_MODEL=            # default: qwen3.6-plus
QWEN_FINAL_MODEL=           # default: qwen3.7-max
DJANGO_SECRET_KEY=
DJANGO_DEBUG=
DJANGO_ALLOWED_HOSTS=
```

## Key Constraints

- Python 3.12+ required.
- The extension targets Chrome 116+ (Manifest V3); `sidePanel` API is the main UI surface.
- Auth between extension and backend is a static bearer token (`X-DescribeOps-Token`), checked by `ExtensionTokenAuth` in `api.py`.
- Media files, frames, and DB (`db.sqlite3`) are gitignored; the `media/` and `outputs/` directories are local-only.
