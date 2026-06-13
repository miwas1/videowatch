pub mod protocol;
pub mod registration;
pub mod storage;
pub mod tools;

#[cfg(test)]
mod protocol_test;

#[cfg(feature = "tauri-app")]
#[tauri::command]
fn health() -> serde_json::Value {
    protocol::health_payload()
}

#[cfg(feature = "tauri-app")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![health])
        .run(tauri::generate_context!())
        .expect("failed to run DescribeOps companion");
}
