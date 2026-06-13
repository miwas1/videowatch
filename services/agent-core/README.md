# DescribeOps Agent Core

Qwen-Agent-oriented orchestration for DescribeOps phase 6.

## Specialist Agents

- Intake Agent: classifies route and permission assumptions.
- Scene Analyst Agent: turns frame observations into evidence-linked visual claims.
- Transcript Alignment Agent: places claims in speech gaps.
- Description Writer Agent: writes concise timed AD cues.
- Accessibility QA Agent: rejects unsupported visual claims and timing risks.
- Reviewer Routing Agent: escalates uncertainty and QA conflicts.
- Memory Agent: applies scoped user or organization style constraints.
- Publisher Agent: emits WebVTT, JSON-ready cues, audio script inputs, and compliance summary.

The local implementation is deterministic for tests and demos. `QwenAgentRuntime` exposes the Qwen-Agent configuration seam with DashScope model selection, memory token budget, and tool/function definitions for FFmpeg probes, OCR lookup, memory retrieval, and artifact writing.

## Local Commands

```bash
uv run --project services/agent-core pytest
```
