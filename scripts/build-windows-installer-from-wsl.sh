#!/usr/bin/env bash
set -euo pipefail

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "powershell.exe was not found. Run this script from WSL on Windows." >&2
  exit 1
fi

if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath was not found. This script needs WSL path conversion." >&2
  exit 1
fi

repo_windows_path="$(wslpath -w "$(pwd)")"

cat <<'NOTE'
Building the Windows installer by delegating to Windows PowerShell.

Required on Windows:
- Node.js 24+ and npm 11+
- Rust stable MSVC toolchain
- Microsoft C++ Build Tools with "Desktop development with C++"
- WebView2 Runtime
- NSIS if you want a setup .exe bundle

If Windows npm has trouble with a UNC WSL path, copy this repo to a Windows
drive such as C:\dev\describeops and rerun the same npm commands there.
NOTE

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\
  Set-StrictMode -Version Latest; \
  \$ErrorActionPreference = 'Stop'; \
  Set-Location -LiteralPath '${repo_windows_path}'; \
  npm install; \
  npm --prefix apps\\desktop-companion install; \
  npm --prefix apps\\desktop-companion run build; \
  Write-Host ''; \
  Write-Host 'Windows bundles are under:'; \
  Write-Host 'apps\\desktop-companion\\src-tauri\\target\\release\\bundle'; \
"
