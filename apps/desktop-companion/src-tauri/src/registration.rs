use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const HOST_NAME: &str = "com.describeops.native";

pub fn host_manifest(host_binary: &Path, extension_id: &str) -> Value {
    json!({
        "name": HOST_NAME,
        "description": "DescribeOps native companion",
        "path": host_binary.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{extension_id}/")]
    })
}

pub fn user_manifest_path(home: &Path, browser: &str) -> PathBuf {
    match browser {
        "chrome-macos" => home
            .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")),
        "chrome-linux" => home
            .join(".config/google-chrome/NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")),
        "chromium-linux" => home
            .join(".config/chromium/NativeMessagingHosts")
            .join(format!("{HOST_NAME}.json")),
        _ => home.join(format!("{HOST_NAME}.json")),
    }
}
