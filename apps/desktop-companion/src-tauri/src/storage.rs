use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("storage directory could not be created: {0}")]
    CreateDir(String),
    #[error("sqlite cache failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("jobId is required")]
    MissingJobId,
}

pub fn storage_dir() -> PathBuf {
    if let Ok(path) = std::env::var("DESCRIBEOPS_STORAGE_DIR") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("DescribeOps")
}

pub fn ensure_cache() -> Result<PathBuf, StorageError> {
    let dir = storage_dir();
    fs::create_dir_all(&dir).map_err(|error| StorageError::CreateDir(error.to_string()))?;
    let db_path = dir.join("jobs.sqlite3");
    let conn = Connection::open(&db_path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )?;
    ensure_column(&conn, "jobs", "payload", "TEXT NOT NULL DEFAULT '{}'")?;
    ensure_column(
        &conn,
        "jobs",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    Ok(db_path)
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StorageError> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    Ok(())
}

pub fn enqueue_job(payload: &Value) -> Result<Value, StorageError> {
    let db_path = ensure_cache()?;
    let conn = Connection::open(&db_path)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO jobs (id, status, payload) VALUES (?1, ?2, ?3)",
        params![id, "queued", payload.to_string()],
    )?;

    Ok(json!({
        "jobId": id,
        "status": "queued",
        "storagePath": storage_dir().to_string_lossy()
    }))
}

pub fn create_artifact_directory(params: &Value) -> Result<Value, StorageError> {
    let job_id = params
        .get("jobId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(StorageError::MissingJobId)?;
    let path = storage_dir().join("artifacts").join(job_id);
    fs::create_dir_all(&path).map_err(|error| StorageError::CreateDir(error.to_string()))?;
    Ok(json!({
        "jobId": job_id,
        "artifactPath": path.to_string_lossy(),
        "uploaded": false
    }))
}
