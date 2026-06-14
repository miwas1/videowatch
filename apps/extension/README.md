# DescribeOps Extension

Chromium Manifest V3 browser surface for DescribeOps.

## Surfaces

- Popup: quick launch into the video assistant.
- Side panel: scan the active tab, choose description level, enable reading/action/dialogue options, start Direct Video Mode, ask for the current description, and start Tab Capture Mode for protected/custom players.
- Content script: scans video/audio, embedded players, headings, landmarks, visible text, captions, transcript hints, and canvas regions; injects the playback overlay; syncs audio-description cues to media time; supports `Alt+Shift+D`.
- Offscreen document: redeems the user-authorized `tabCapture` stream, samples frames/audio levels, identifies quiet gaps, and returns compact evidence for fallback descriptions.
- Service worker: routes side-panel commands to the active tab, exposes the keyboard command, starts/stops `tabCapture`, manages the offscreen document, and connects to the native host `com.describeops.native`.

## MVP Flow

1. Open a page with a video.
2. Open DescribeOps and click **Scan video**.
3. Choose Minimal, Balanced, or Detailed descriptions.
4. Start accessibility mode.
5. The content script attaches to the active media element, injects the overlay, and plays generated cues with browser speech synthesis.
6. Press `Alt+Shift+D` or **Ask now** for the current visual summary.

When the local FastAPI backend at `http://127.0.0.1:8000` is available, the side panel uses `/v1/jobs` artifacts. If it is offline, the extension falls back to deterministic local cues from browser-visible evidence so Direct Video Mode remains usable.

For pages without an accessible media element, click **Start tab capture fallback** after scanning. Chrome asks for user-invoked tab capture permission, the offscreen document samples the active tab for a short evidence window, and the side panel creates a spoken fallback timeline from those samples.

## Build

```bash
npm --prefix apps/extension run build
```

Load `apps/extension/dist` as an unpacked extension in Chromium.

## Release Install Page

The public user install page is `docs/install/index.html`. For release builds, publish:

- `describeops-extension.zip` containing the built extension files.
- Companion installers produced by the Tauri build.
- Release notes that explain native host registration for `com.describeops.native`.

Developer builds still use Chrome or Chromium's Load unpacked flow with `apps/extension/dist`.

## Test

```bash
npm run test
npm run test:e2e
```

The E2E tests use a persistent Chromium context because Chromium extension APIs are not available in a regular ephemeral browser context.
