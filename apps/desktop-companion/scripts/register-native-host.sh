#!/usr/bin/env bash
set -euo pipefail

host_path="${1:?Usage: register-native-host.sh /absolute/path/describeops-native-host chrome-extension-id [chrome|chromium]}"
extension_id="${2:?Usage: register-native-host.sh /absolute/path/describeops-native-host chrome-extension-id [chrome|chromium]}"
browser="${3:-chrome}"

host_path="$(realpath "$host_path")"
if [[ ! -x "$host_path" ]]; then
  echo "Native host binary is not executable: $host_path" >&2
  exit 1
fi

case "$browser" in
  chrome)
    target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome/NativeMessagingHosts"
    ;;
  chromium)
    target_dir="${XDG_CONFIG_HOME:-$HOME/.config}/chromium/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported browser '$browser'. Use chrome or chromium." >&2
    exit 1
    ;;
esac

escaped_host_path="${host_path//\\/\\\\}"
escaped_host_path="${escaped_host_path//\"/\\\"}"
escaped_extension_id="${extension_id//\"/}"

mkdir -p "$target_dir"
cat > "$target_dir/com.describeops.native.json" <<JSON
{
  "name": "com.describeops.native",
  "description": "DescribeOps native companion",
  "path": "$escaped_host_path",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$escaped_extension_id/"]
}
JSON

echo "Registered DescribeOps native host for $browser at $target_dir/com.describeops.native.json"
