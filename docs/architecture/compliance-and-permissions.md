# Compliance and Permissions

DescribeOps only processes content that the user owns, licenses, administers, or is explicitly authorized to make accessible.

## Content Boundary

- Do not bypass DRM, paywalls, login restrictions, or platform access controls.
- Do not extract hidden video URLs from services where doing so would violate terms or technical access controls.
- Do not process third-party media unless the user has permission to create accessibility derivatives.
- Public URL metadata probes through `yt-dlp` are limited to authorized content and metadata checks.
- Local file import reads metadata locally by default and does not upload content until the user creates an authorized job.

## Browser Permissions

- The extension uses Manifest V3.
- Content scripts collect page accessibility evidence only for browser-visible content.
- Content scripts cannot directly talk to native messaging; messages route through the service worker, matching Chrome's native messaging model.
- `nativeMessaging` is reserved for the service worker bridge to `com.describeops.native`.
- Capture or upload flows must be user-triggered and explain what data leaves the device.

## Local Companion Safety

- Native messages are length-prefixed JSON with request IDs.
- Oversized or malformed messages are rejected.
- Error envelopes show user-safe messages and keep diagnostics separate.
- Local tools are allowlisted. Shell interpolation from page-controlled input is not allowed.
- FFmpeg and yt-dlp integration must use argument arrays, size limits, and per-job directories.

## Qwen Cloud and Alibaba Cloud

- Qwen Cloud credentials are never stored in the extension.
- The Alibaba Cloud backend owns Qwen/DashScope calls, request tracing, retry policy, and cost controls.
- Evidence bundles must exclude cookies, secrets, tokens, and unrelated personal data.

## Review and Hallucination Risk

- Unsupported visual claims are routed to QA and human review instead of being silently published.
- Reviewer edits can become memory only after explicit user confirmation.
- Job-specific visual facts are not reused across unrelated content.
