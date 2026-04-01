// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn server_script_path() -> Result<String, String> {
    let manifest_dir = env!("CARGO_MANIFEST_DIR"); // …/src-tauri
    let path = std::path::Path::new(manifest_dir)
        .parent()
        .ok_or("could not resolve project root")?
        .join("server")
        .join("index.js");
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![greet, server_script_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
