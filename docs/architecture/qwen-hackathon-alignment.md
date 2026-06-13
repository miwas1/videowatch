# Qwen Hackathon Alignment

DescribeOps is designed as an installable browser accessibility agent that uses Qwen Cloud for multimodal reasoning, memory-aware workflows, and multi-agent review.

## Track Mapping

| Track | DescribeOps feature | Evidence artifact |
| --- | --- | --- |
| Track 4 Autopilot Agent | Browser detects inaccessible content, companion queues local jobs, backend automates analysis and review routing. | Extension detector, native bridge, demo script, future FastAPI job API. |
| Track 3 Agent Society | Specialist agents split intake, scene analysis, transcript alignment, writing, QA, reviewer routing, memory, and publishing. | `services/agent-core` placeholder and Phase 6 plan. |
| Track 1 MemoryAgent | Reviewer preferences and organization style rules are retrieved, audited, and forgotten when stale or deleted. | Phase 7 memory controls and settings UX plan. |
| Track 5 EdgeAgent | Desktop companion keeps local cache, media metadata, queueing, weak-network mode, and offline playback assets. | Tauri companion, SQLite cache, FFmpeg detection, local file import. |

## Judging Criteria

### Technical Depth and Engineering

- Manifest V3 extension separates content scripts, service worker, popup, and side panel.
- Native messaging follows Chrome stdio framing with strict request IDs, schema validation, size limits, and safe error envelopes.
- Tauri companion owns local file paths, SQLite queue/cache, tool detection, and OS native host registration.
- Future backend isolates Qwen Cloud/DashScope credentials from browser clients.

### Innovation and AI Creativity

- Qwen is not used as a simple text generator. The planned agent society uses multimodal observations, transcript windows, tool calls, memory retrieval, QA rejection, and reviewer escalation.
- The product combines browser sensing, media evidence packaging, accessibility-specific timing constraints, and human-in-the-loop correction.

### Problem Value and Impact

- DescribeOps targets inaccessible video and page content in schools, employers, training portals, internal tools, and public learning pages.
- The user surface is installable and works where users already watch videos, rather than requiring URL-only ingestion.

### Presentation and Documentation

- Root README contains setup, license, architecture, tracks, and deployment proof location.
- Demo script is capped to a three-minute narrative.
- Compliance documentation makes the authorized-content boundary explicit.

## Required Submission Artifact Mapping

| Required artifact | Repository location |
| --- | --- |
| Public open-source repository with license | `LICENSE`, `README.md` |
| Alibaba Cloud proof | `docs/deployment/alibaba-cloud-proof.md` in Phase 4 |
| Architecture diagram | `README.md` and `docs/architecture` |
| Public 3-minute demo video | `docs/demo/three-minute-demo-script.md` |
| Text description and feature list | `README.md` |
| Track identification | `README.md`, this file |
