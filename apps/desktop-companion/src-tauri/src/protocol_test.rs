use crate::protocol::{
    decode_native_message, encode_native_message, handle_request, NativeRequest, NativeResponse,
    MAX_INCOMING_BYTES,
};
use serde_json::json;
use std::{fs, path::PathBuf};
use uuid::Uuid;

fn use_temp_storage() {
    let path = std::env::temp_dir().join(format!("describeops-test-{}", Uuid::new_v4()));
    std::env::set_var("DESCRIBEOPS_STORAGE_DIR", path);
}

#[test]
fn round_trips_length_prefixed_native_messages() {
    let request = NativeRequest {
        id: "req_health".to_string(),
        method: "health".to_string(),
        params: json!({}),
    };

    let encoded = encode_native_message(&request).expect("encode request");
    let decoded: NativeRequest = decode_native_message(&encoded).expect("decode request");

    assert_eq!(decoded.id, "req_health");
    assert_eq!(decoded.method, "health");
}

#[test]
fn rejects_oversized_native_messages() {
    let oversized = vec![b'a'; MAX_INCOMING_BYTES + 1];

    let error = decode_native_message::<NativeRequest>(&oversized).expect_err("must reject");

    assert!(error.to_string().contains("oversized"));
}

#[test]
fn returns_health_version_tools_and_storage_path() {
    use_temp_storage();

    let response = handle_request(NativeRequest {
        id: "req_health".to_string(),
        method: "health".to_string(),
        params: json!({}),
    })
    .expect("health response");

    match response {
        NativeResponse::Ok { id, result, .. } => {
            assert_eq!(id, "req_health");
            assert_eq!(result["status"], "ok");
            assert!(result["version"].as_str().unwrap().starts_with("0.1."));
            assert!(result["supportedTools"]
                .as_array()
                .unwrap()
                .contains(&json!("ffmpeg")));
            assert!(result["storagePath"]
                .as_str()
                .unwrap()
                .contains("describeops-test-"));
        }
        NativeResponse::Err { error, .. } => panic!("expected ok response: {error:?}"),
    }
}

#[test]
fn malformed_requests_return_user_safe_error_envelopes() {
    let response = handle_request(NativeRequest {
        id: "req_bad".to_string(),
        method: "unknown".to_string(),
        params: json!({ "raw": "details" }),
    })
    .expect("error response");

    match response {
        NativeResponse::Err { id, error, .. } => {
            assert_eq!(id, "req_bad");
            assert_eq!(error.code, "UNSUPPORTED_METHOD");
            assert!(!error.message.contains("raw"));
            assert!(error.diagnostics.is_some());
        }
        NativeResponse::Ok { .. } => panic!("expected error response"),
    }
}

#[test]
fn local_file_import_returns_metadata_without_uploading() {
    let file = temp_file("metadata.txt");
    fs::write(&file, "describeops").expect("write temp file");

    let response = handle_request(NativeRequest {
        id: "req_file".to_string(),
        method: "localFileMetadata".to_string(),
        params: json!({ "path": file }),
    })
    .expect("metadata response");

    match response {
        NativeResponse::Ok { result, .. } => {
            assert_eq!(result["fileName"], "metadata.txt");
            assert_eq!(result["uploaded"], false);
            assert_eq!(result["sizeBytes"], 11);
        }
        NativeResponse::Err { error, .. } => panic!("expected ok response: {error:?}"),
    }
}

#[test]
fn queue_job_and_artifact_directory_use_local_storage() {
    use_temp_storage();

    let queued = handle_request(NativeRequest {
        id: "req_queue".to_string(),
        method: "queueJob".to_string(),
        params: json!({ "source": "e2e" }),
    })
    .expect("queue response");

    let job_id = match queued {
        NativeResponse::Ok { result, .. } => result["jobId"].as_str().unwrap().to_string(),
        NativeResponse::Err { error, .. } => panic!("expected ok response: {error:?}"),
    };

    let artifact = handle_request(NativeRequest {
        id: "req_artifact".to_string(),
        method: "createArtifactDirectory".to_string(),
        params: json!({ "jobId": job_id }),
    })
    .expect("artifact response");

    match artifact {
        NativeResponse::Ok { result, .. } => {
            assert_eq!(result["uploaded"], false);
            assert!(result["artifactPath"]
                .as_str()
                .unwrap()
                .contains("artifacts"));
        }
        NativeResponse::Err { .. } => panic!("expected ok response"),
    }
}

#[test]
fn yt_dlp_metadata_probe_requires_authorization() {
    let response = handle_request(NativeRequest {
        id: "req_ytdlp".to_string(),
        method: "ytDlpMetadataProbe".to_string(),
        params: json!({ "url": "https://example.test/video" }),
    })
    .expect("yt-dlp response");

    match response {
        NativeResponse::Err { error, .. } => {
            assert_eq!(error.code, "YTDLP_METADATA_FAILED");
            assert!(!error.message.contains("https://example.test"));
        }
        NativeResponse::Ok { .. } => panic!("expected unauthorized error response"),
    }
}

fn temp_file(name: &str) -> PathBuf {
    let path = std::env::temp_dir()
        .join("describeops-tests")
        .join(Uuid::new_v4().to_string())
        .join(name);
    fs::create_dir_all(path.parent().unwrap()).expect("create temp parent");
    path
}
