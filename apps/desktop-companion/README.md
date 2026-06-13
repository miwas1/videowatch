# DescribeOps Desktop Companion

Tauri desktop companion and Chrome Native Messaging host for DescribeOps.

## Responsibilities

- Register native host `com.describeops.native`.
- Receive Chrome native messaging stdio frames.
- Validate request IDs, methods, and JSON payloads.
- Return user-safe error envelopes with optional diagnostics.
- Report health, version, supported tools, FFmpeg status, SQLite cache availability, and storage path.
- Store weak-network queue jobs locally.
- Read local file metadata without uploading content.

## Native Messaging Protocol

Chrome sends and receives UTF-8 JSON messages with a 32-bit native-endian length prefix. The host rejects malformed and oversized messages before dispatching actions.

Supported methods:

- `health`
- `localFileMetadata`
- `ffmpegProbe`
- `ffmpegExtractAudio`
- `ffmpegSlice`
- `ytDlpMetadataProbe`
- `createArtifactDirectory`
- `queueJob`

## Build and Test

```bash
npm --prefix apps/desktop-companion install
npm --prefix apps/desktop-companion run build:ui
cargo test --manifest-path apps/desktop-companion/src-tauri/Cargo.toml --lib
cargo build --manifest-path apps/desktop-companion/src-tauri/Cargo.toml --bin describeops-native-host
npm --prefix apps/desktop-companion run build
```

The Tauri webview runtime is built through the `tauri-app` feature in the package scripts.

## Developer Registration

Windows:

```powershell
apps\desktop-companion\scripts\register-native-host.ps1 -HostPath apps\desktop-companion\src-tauri\target\debug\describeops-native-host.exe -ExtensionId <chrome-extension-id>
```

Linux:

```bash
apps/desktop-companion/scripts/register-native-host.sh apps/desktop-companion/src-tauri/target/debug/describeops-native-host <chrome-extension-id> chrome
```

macOS uses the same manifest format under `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; generate it from the Linux script logic or the release installer.
