#!/usr/bin/env bash
set -euo pipefail

BROWSER="${1:-chrome}"
PROBE_URL="${2:-https://www.youtube.com/watch?v=1nVGaNbvuXg}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_FILE="${ROOT_DIR}/secrets/youtube-cookies.txt"

mkdir -p "$(dirname "$OUT_FILE")"

cd "${ROOT_DIR}/backend"
uv run python -m yt_dlp \
  --cookies-from-browser "$BROWSER" \
  --cookies "$OUT_FILE" \
  --skip-download \
  --no-playlist \
  "$PROBE_URL"

chmod 600 "$OUT_FILE"
echo "Wrote $OUT_FILE"
