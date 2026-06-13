use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

use crate::{storage, tools};

pub const MAX_INCOMING_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OUTGOING_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NativeResponse {
    Ok {
        id: String,
        ok: bool,
        result: Value,
    },
    Err {
        id: String,
        ok: bool,
        error: NativeErrorEnvelope,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NativeErrorEnvelope {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<String>,
}

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("oversized native message")]
    Oversized,
    #[error("native message is missing a length prefix")]
    MissingPrefix,
    #[error("native message length prefix does not match payload")]
    LengthMismatch,
    #[error("native message serialization failed: {0}")]
    Serde(#[from] serde_json::Error),
}

pub fn encode_native_message<T: Serialize>(message: &T) -> Result<Vec<u8>, ProtocolError> {
    let payload = serde_json::to_vec(message)?;
    if payload.len() > MAX_OUTGOING_BYTES {
        return Err(ProtocolError::Oversized);
    }

    let mut encoded = Vec::with_capacity(payload.len() + 4);
    encoded.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub fn decode_native_message<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ProtocolError> {
    if bytes.len() > MAX_INCOMING_BYTES {
        return Err(ProtocolError::Oversized);
    }
    if bytes.len() < 4 {
        return Err(ProtocolError::MissingPrefix);
    }

    let expected = u32::from_ne_bytes(bytes[0..4].try_into().expect("four byte prefix")) as usize;
    let payload = &bytes[4..];
    if payload.len() != expected {
        return Err(ProtocolError::LengthMismatch);
    }

    Ok(serde_json::from_slice(payload)?)
}

pub fn handle_request(request: NativeRequest) -> Result<NativeResponse, ProtocolError> {
    if request.id.trim().is_empty() {
        return Ok(error_response(
            "",
            "INVALID_REQUEST",
            "DescribeOps received a malformed native request.",
            Some("request id is empty".to_string()),
        ));
    }

    let response = match request.method.as_str() {
        "health" => NativeResponse::Ok {
            id: request.id,
            ok: true,
            result: health_payload(),
        },
        "localFileMetadata" => match tools::local_file_metadata(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "LOCAL_FILE_METADATA_FAILED",
                "DescribeOps could not inspect that local file.",
                Some(error.to_string()),
            ),
        },
        "ffmpegProbe" => match tools::ffmpeg_probe(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "FFMPEG_PROBE_FAILED",
                "DescribeOps could not inspect that media file with FFmpeg.",
                Some(error.to_string()),
            ),
        },
        "ffmpegExtractAudio" => match tools::ffmpeg_extract_audio(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "FFMPEG_EXTRACT_AUDIO_FAILED",
                "DescribeOps could not extract audio from that media file.",
                Some(error.to_string()),
            ),
        },
        "ffmpegSlice" => match tools::ffmpeg_slice(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "FFMPEG_SLICE_FAILED",
                "DescribeOps could not create that local media slice.",
                Some(error.to_string()),
            ),
        },
        "ytDlpMetadataProbe" => match tools::yt_dlp_metadata_probe(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "YTDLP_METADATA_FAILED",
                "DescribeOps could not inspect that authorized public URL.",
                Some(error.to_string()),
            ),
        },
        "createArtifactDirectory" => match storage::create_artifact_directory(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "ARTIFACT_DIRECTORY_FAILED",
                "DescribeOps could not prepare local artifact storage.",
                Some(error.to_string()),
            ),
        },
        "queueJob" => match storage::enqueue_job(&request.params) {
            Ok(result) => NativeResponse::Ok {
                id: request.id,
                ok: true,
                result,
            },
            Err(error) => error_response(
                &request.id,
                "QUEUE_FAILED",
                "DescribeOps could not queue that job for weak-network mode.",
                Some(error.to_string()),
            ),
        },
        _ => error_response(
            &request.id,
            "UNSUPPORTED_METHOD",
            "DescribeOps does not support that companion action.",
            Some(format!("unsupported method: {}", request.method)),
        ),
    };

    Ok(response)
}

pub fn health_payload() -> Value {
    let storage_path = storage::storage_dir();
    let ffmpeg = tools::detect_tool("ffmpeg", &["-version"]);

    json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "supportedTools": tools::supported_tools(),
        "storagePath": storage_path.to_string_lossy(),
        "ffmpeg": {
            "available": ffmpeg.available,
            "version": ffmpeg.version,
            "remediation": if ffmpeg.available { Value::Null } else { json!("Install FFmpeg and make it available on PATH, then restart the DescribeOps companion.") }
        },
        "sqlite": {
            "available": storage::ensure_cache().is_ok()
        }
    })
}

fn error_response(
    id: &str,
    code: &str,
    message: &str,
    diagnostics: Option<String>,
) -> NativeResponse {
    NativeResponse::Err {
        id: id.to_string(),
        ok: false,
        error: NativeErrorEnvelope {
            code: code.to_string(),
            message: message.to_string(),
            diagnostics,
        },
    }
}
