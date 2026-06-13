# Project Map
_Generated: 2026-06-12 23:05 | Staleness: timestamps_

## Directory Structure
./ - Concept-stage project for DescribeOps, an installable browser accessibility agent for video and web content.
docs/superpowers-optimized/plans/ - Implementation plans intended for agentic execution.

## Key Files
idea.md - Product thesis for DescribeOps as a universal AI accessibility layer for video, browser access, review, and offline playback.
stack.md - Proposed open-source stack: browser automation, media ingestion, Qwen multimodal agents, transcription, memory, TTS, and accessibility validation.
docs/superpowers-optimized/plans/2026-06-12-describeops-qwen-browser-agent.md - Ten-phase implementation plan aligned to Qwen Cloud hackathon tracks and submission requirements.

## Critical Constraints
- User requires current library documentation to be fetched before implementation decisions.
- Product must be installable on computers now, with browser extension as the primary user surface.
- Agent layer must take full advantage of Qwen Cloud capabilities, not only local open-source models.
- Avoid bypassing access controls, DRM, or unauthorized video extraction; process only content the user owns or has permission to access.
- Git exists, but Windows/WSL safe-directory blocked hash lookup; use timestamp staleness until safe.directory is configured.

## Hot Files
idea.md, stack.md, docs/superpowers-optimized/plans/2026-06-12-describeops-qwen-browser-agent.md
