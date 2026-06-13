use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
};
use thiserror::Error;

#[derive(Debug)]
pub struct ToolStatus {
    pub available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("path is required")]
    MissingPath,
    #[error("local file does not exist")]
    MissingFile,
    #[error("local file path must point to a file")]
    NotAFile,
    #[error("file metadata failed: {0}")]
    Metadata(String),
    #[error("authorized must be true before probing a public URL")]
    Unauthorized,
    #[error("url is required")]
    MissingUrl,
    #[error("outputPath is required")]
    MissingOutputPath,
    #[error("startSeconds must be zero or greater")]
    InvalidStart,
    #[error("durationSeconds must be greater than zero")]
    InvalidDuration,
    #[error("tool command failed: {0}")]
    CommandFailed(String),
    #[error("tool output was not valid JSON: {0}")]
    InvalidJson(String),
}

pub fn supported_tools() -> Vec<&'static str> {
    vec![
        "ffmpeg",
        "ffmpeg-probe",
        "ffmpeg-extract-audio",
        "ffmpeg-slice",
        "yt-dlp-metadata-probe",
        "sqlite-cache",
        "local-file-import",
        "weak-network-queue",
    ]
}

pub fn detect_tool(binary: &str, args: &[&str]) -> ToolStatus {
    match Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(output) => {
            let combined = String::from_utf8_lossy(&output.stdout).to_string();
            ToolStatus {
                available: output.status.success(),
                version: combined.lines().next().map(str::to_string),
            }
        }
        Err(_) => ToolStatus {
            available: false,
            version: None,
        },
    }
}

pub fn local_file_metadata(params: &Value) -> Result<Value, ToolError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or(ToolError::MissingPath)?;
    let path = Path::new(path);
    if !path.exists() {
        return Err(ToolError::MissingFile);
    }
    if !path.is_file() {
        return Err(ToolError::NotAFile);
    }

    let metadata = fs::metadata(path).map_err(|error| ToolError::Metadata(error.to_string()))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "fileName": path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
        "sizeBytes": metadata.len(),
        "extension": path.extension().and_then(|ext| ext.to_str()).unwrap_or(""),
        "uploaded": false
    }))
}

pub fn ffmpeg_probe(params: &Value) -> Result<Value, ToolError> {
    let path = require_existing_file(params)?;
    run_json_command(
        "ffprobe",
        &[
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            path.to_string_lossy().as_ref(),
        ],
    )
}

pub fn ffmpeg_extract_audio(params: &Value) -> Result<Value, ToolError> {
    let input = require_existing_file(params)?;
    let output = require_output_path(params)?;
    run_status_command(
        "ffmpeg",
        &[
            "-y",
            "-i",
            input.to_string_lossy().as_ref(),
            "-vn",
            "-acodec",
            "pcm_s16le",
            output.to_string_lossy().as_ref(),
        ],
    )?;
    Ok(json!({ "outputPath": output.to_string_lossy(), "uploaded": false }))
}

pub fn ffmpeg_slice(params: &Value) -> Result<Value, ToolError> {
    let input = require_existing_file(params)?;
    let output = require_output_path(params)?;
    let start = params
        .get("startSeconds")
        .and_then(Value::as_f64)
        .ok_or(ToolError::InvalidStart)?;
    let duration = params
        .get("durationSeconds")
        .and_then(Value::as_f64)
        .ok_or(ToolError::InvalidDuration)?;
    if start < 0.0 {
        return Err(ToolError::InvalidStart);
    }
    if duration <= 0.0 {
        return Err(ToolError::InvalidDuration);
    }

    run_status_command(
        "ffmpeg",
        &[
            "-y",
            "-ss",
            &start.to_string(),
            "-t",
            &duration.to_string(),
            "-i",
            input.to_string_lossy().as_ref(),
            "-c",
            "copy",
            output.to_string_lossy().as_ref(),
        ],
    )?;
    Ok(json!({ "outputPath": output.to_string_lossy(), "uploaded": false }))
}

pub fn yt_dlp_metadata_probe(params: &Value) -> Result<Value, ToolError> {
    if params.get("authorized").and_then(Value::as_bool) != Some(true) {
        return Err(ToolError::Unauthorized);
    }
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .ok_or(ToolError::MissingUrl)?;

    run_json_command("yt-dlp", &["--dump-json", "--skip-download", url])
}

fn require_existing_file(params: &Value) -> Result<&Path, ToolError> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .ok_or(ToolError::MissingPath)?;
    let path = Path::new(path);
    if !path.exists() {
        return Err(ToolError::MissingFile);
    }
    if !path.is_file() {
        return Err(ToolError::NotAFile);
    }
    Ok(path)
}

fn require_output_path(params: &Value) -> Result<&Path, ToolError> {
    let output = params
        .get("outputPath")
        .and_then(Value::as_str)
        .ok_or(ToolError::MissingOutputPath)?;
    Ok(Path::new(output))
}

fn run_json_command(binary: &str, args: &[&str]) -> Result<Value, ToolError> {
    let output = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| ToolError::CommandFailed(error.to_string()))?;

    if !output.status.success() {
        return Err(ToolError::CommandFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| ToolError::InvalidJson(error.to_string()))
}

fn run_status_command(binary: &str, args: &[&str]) -> Result<(), ToolError> {
    let output = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| ToolError::CommandFailed(error.to_string()))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(ToolError::CommandFailed(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ))
    }
}
