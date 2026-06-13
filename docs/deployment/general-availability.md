# DescribeOps General Availability Checklist

Use this checklist before making a public release or hackathon judging build generally available.

## Required release artifacts

- Browser extension ZIP built from `apps/extension/dist`.
- Tauri companion installers:
  - Windows MSI.
  - macOS DMG.
  - Linux AppImage or Debian package.
- FastAPI container image for `services/api`.
- Public install page at `docs/install/index.html`.
- Architecture, compliance, benchmark, and demo documents in `docs/`.

## Environment

Start from `.env.sample` and map values in the deployment platform.

- Keep `DESCRIBEOPS_API_TOKEN`, `DASHSCOPE_API_KEY`, and model routing variables server-side only.
- Use only non-secret `VITE_*` values in browser or static assets.
- Set `ALIBABA_CLOUD_DEPLOYMENT` to the Alibaba Cloud runtime name used in proof material.
- Set `DESCRIBEOPS_MAX_UPLOAD_BYTES` to a value the cloud runtime and storage layer can safely accept.

## Build commands

```bash
npm install
npm run typecheck
npm run test
npm run test:python
npm run test:rust
npm run build
```

Build the FastAPI image from the repository root:

```bash
docker build -f services/api/Dockerfile -t describeops-api:0.1.0 .
```

Build the Tauri companion from `apps/desktop-companion`:

```bash
npm --prefix apps/desktop-companion run build
```

Linux builders must have Tauri's native WebKitGTK stack installed first. On Debian/Ubuntu:

```bash
sudo apt-get install -y libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

## Smoke tests

- Load the extension release ZIP or unpacked `apps/extension/dist` in Chromium.
- Confirm the side panel opens and the Detect tab scans a video page.
- Confirm the Review tab can edit, accept, reject, and remember a cue.
- Confirm the Playback tab shows WebVTT/QA exports and offline queue state.
- Confirm Settings can forget a saved memory preference.
- Confirm native companion health returns version, tools, and storage path.
- Confirm `/health` reports Alibaba Cloud deployment marker and Qwen configured state without leaking `DASHSCOPE_API_KEY`.
- Confirm memory can be saved, listed, and deleted through `/v1/memory/preferences`.

## Public release notes

Include:

- Supported browsers: desktop Chromium and Google Chrome.
- Supported companion platforms: Windows, macOS, and Linux builds that were actually produced.
- Native messaging host name: `com.describeops.native`.
- Privacy boundary: DescribeOps processes only authorized content and does not bypass DRM, paywalls, or private access controls.
- Known limitation: full multimodal generation requires Qwen Cloud credentials and backend availability.
