# DescribeOps Threat Model

## Assets

- Qwen/DashScope credentials.
- User media samples, transcripts, screenshots, frame samples, reviewer notes, and memory preferences.
- Native companion storage, offline packages, and queue state.
- Extension permissions and native messaging channel.
- Published accessibility artifacts: WebVTT, cue JSON, TTS audio, QA reports, and offline packages.

## Trust boundaries

- Web page to content script: page content is untrusted and can be adversarial.
- Content script to service worker: only typed DescribeOps messages are accepted.
- Service worker to native host: Chrome Native Messaging is available only to the extension origin registered in the host manifest.
- Native host to local tools: commands are allowlisted and must use argument arrays.
- Native host to cloud API: only authorized samples and metadata are uploaded.
- API to Qwen Cloud: server-side only, with no client-side credentials.

## Main risks and controls

| Risk | Control |
| --- | --- |
| Overbroad browser collection | User-triggered capture, visible side-panel state, minimal permissions, no background scraping. |
| Native messaging abuse | Registered host allowlist, length-prefixed schema validation, message size limits, stderr-only diagnostics. |
| Shell injection through local tools | No shell interpolation from page-controlled input; use allowlisted commands and per-job directories. |
| Secret exposure | Keep `DASHSCOPE_API_KEY` and API tokens unprefixed and server-side; `/health` reports configured state only. |
| Upload of unauthorized content | Consent gate, compliance copy, size limits, file-type checks before production release. |
| Model hallucination | Evidence-linked claims, QA rejection, confidence scores, and human review routing for risky cues. |
| Unsafe memory recall | Scope memories by user/org/job, expire content facts, soft-delete preferences, exclude deleted or low-confidence memories. |
| Weak-network data loss | Local queue, offline package cache, retry status, and sync review action. |

## Security checklist

- Extension manifest declares a narrow single purpose.
- Extension bundle contains no remotely hosted JavaScript.
- Content capture is user-triggered and bounded to visible/authorized content.
- Native host manifest includes only expected extension origins.
- Native host rejects malformed or oversized messages.
- API requires bearer auth on all `/v1/*` routes.
- API upload size limits are enforced.
- Logs include trace IDs but no tokens, cookies, or API keys.
- Memory export/delete controls are visible in Settings or API.

## Residual risks

- Production file-type malware scanning is not implemented in the prototype.
- Browser extension store review, code signing, and notarization are release-process requirements outside local tests.
- Full screen-reader validation still requires a manual NVDA/VoiceOver pass before public launch.
