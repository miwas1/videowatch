# Qwen Hackathon Submission Checklist

Primary track: Track 4, Autopilot Agent.

Secondary tracks: Track 3 Agent Society, Track 1 MemoryAgent, Track 5 EdgeAgent.

## Required public links

| Requirement | Repo or release location |
| --- | --- |
| Public repository | Repository root with Apache-2.0 `LICENSE`. |
| Text feature description | `README.md` and `docs/architecture/qwen-hackathon-alignment.md`. |
| Architecture diagram | `README.md` Mermaid diagram and `docs/architecture/qwen-hackathon-alignment.md`. |
| Alibaba Cloud proof | `docs/deployment/alibaba-cloud-proof.md` and `/health` output. |
| Qwen Cloud integration proof | `services/api/src/describeops_api/gateway.py` and health model routing output. |
| 3-minute demo video | Public video URL added to this file before submission. |
| Public install page | `docs/install/index.html`. |
| Benchmarks | `docs/benchmarks/agent-society-baseline.md`. |
| Security/privacy notes | `docs/architecture/compliance-and-permissions.md` and `docs/architecture/threat-model.md`. |

## Demo path

1. Open the install page and show browser extension plus companion downloads.
2. Load the extension and open a page with an embedded video.
3. Scan the page and show detected media, headings, captions, text, and inaccessible regions.
4. Check native companion health and local tool support.
5. Create or show a Qwen-backed job with frame, transcript, OCR, speech-gap, and page evidence.
6. Show Qwen Agent Society output and one QA warning.
7. Edit a cue, accept it, and save wording as memory.
8. Show Memory audit with source, scope, confidence, and Forget control.
9. Show Playback and exports: WebVTT, QA report, offline package, and queued offline sync.
10. Show `/health` running with Alibaba Cloud marker and Qwen configured state.

## Final pre-submit checks

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run test:python` passes.
- `npm run test:rust` passes.
- `npm run build` produces extension and companion frontend assets.
- `/health` output has no secret values.
- Release page includes the extension ZIP and companion installers.
- Demo video is public and close to 3 minutes.
