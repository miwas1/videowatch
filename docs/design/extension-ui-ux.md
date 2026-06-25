# DescribeOps Extension UI/UX Contract

## Product Shape

DescribeOps is a permissioned accessibility browser layer for video. The extension should feel like a working assistive instrument, not a marketing page and not a generic chatbot panel.

The primary surface is the Chrome side panel. The popup is only a launcher and connection checkpoint.

## User Flow

1. Detect the current tab and rank the video the user is most likely watching.
2. Create a backend session with page title, media title, duration, URL, and extension capture settings.
3. Capture a short chunk using the current video time, visible captions, live transcript hints, readable page text, and one frame image.
4. Upload the chunk to `/api/v1/sessions/{session_id}/chunks`.
5. Render the generated reading document and timeline.
6. Let the user attach spoken descriptions to the active page video.
7. Let reviewers edit generated reading blocks and sync corrections with `PATCH /api/v1/reading-blocks/{block_id}`.

## Interaction States

- Empty: no scan yet, no media found, or no generated document.
- Loading: skeleton rows and a staged progress rail while scanning, capturing, uploading, and rendering.
- Error: inline panel with retry action and backend error detail.
- Ready: document blocks, timeline, confidence, and attach-playback controls.
- Edited: saved blocks display a reviewer mark without losing their source timing.

## Visual Direction

- Palette: zinc/stone neutral base with one controlled teal accent.
- Typography: high-end sans stack using Geist/Satoshi/Cabinet-style fallbacks, no serif UI.
- Layout: asymmetric side-panel composition with a dense left status rail and larger document review area.
- Motion: CSS transform/opacity only, subtle breathing status dots and skeleton shimmer, reduced-motion safe.
- Accessibility: labeled controls, `aria-live` status regions, visible focus rings, no icon-only buttons without labels.

## Backend Contract

- Health: `GET /health`, unauthenticated.
- Auth header for account/service callers: `X-DescribeOps-Token`. The installed Chrome extension does not send this header.
- Create session: `POST /api/v1/sessions`.
- Upload chunk: multipart `POST /api/v1/sessions/{session_id}/chunks`.
- Read document: `GET /api/v1/sessions/{session_id}/document`.
- Correct block: `PATCH /api/v1/reading-blocks/{block_id}`.

The production browser extension is preconfigured for `https://videowatch.platinexsolutions.com.ng` and does not ask users to enter a backend URL or API token. Chrome extension origins can create sessions and upload capture chunks without a token.
