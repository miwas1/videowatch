# DescribeOps Extension

Chromium Manifest V3 browser surface for DescribeOps.

## Surfaces

- Popup: quick status and side-panel launch.
- Side panel: Detect, Generate, Review, Playback, and Settings workflow tabs.
- Content script: scans video/audio, embedded players, headings, landmarks, visible text, captions, transcript hints, and canvas regions that need visual sampling.
- Service worker: routes content-script messages and connects to the native host `com.describeops.native`.

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
