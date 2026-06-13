# Agent Society Baseline Benchmark

Phase 6 includes a deterministic benchmark harness at `services/agent-core`.

## Compared Modes

- `BaselineAgent`: single-agent draft with no evidence-linked conflict resolution.
- `AgentSociety`: specialist pipeline with scene claims, transcript alignment, QA rejection, reviewer routing, memory constraints, and publisher output.

## Metrics

- Unsupported claims.
- On-screen text recall.
- Reviewer edits per minute.
- Cue timing overlap.
- Processing cost proxy.

## Current Fixture Result

The test fixture verifies measurable improvement on at least three metrics:

- Unsupported claims decrease because QA rejects claims without valid evidence references.
- On-screen text recall improves because supported frame OCR evidence is carried into cue generation.
- Reviewer edits per minute decrease because uncertainty is routed deliberately instead of making every cue require review.

Run:

```bash
uv run --project services/agent-core pytest
```
