use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    },
};

fn normalize_env_value(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Reads `VITE_GROQ_API_KEY` from `src-tauri/.env` (works even when Vite was started before the key existed).
fn groq_key_from_dotenv_file() -> Option<String> {
    let env_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env");
    let content = std::fs::read_to_string(env_path).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() == "VITE_GROQ_API_KEY" {
            return normalize_env_value(value);
        }
    }
    None
}

fn groq_key_for_runtime() -> Option<String> {
    if let Ok(key) = std::env::var("GROQ_API_KEY") {
        if let Some(normalized) = normalize_env_value(&key) {
            return Some(normalized);
        }
    }
    if let Some(key) = groq_key_from_dotenv_file() {
        return Some(key);
    }
    option_env!("GROQ_API_KEY").and_then(|key| normalize_env_value(key))
}

#[tauri::command]
fn get_api_keys() -> HashMap<String, String> {
    let mut keys = HashMap::new();
    if let Some(key) = groq_key_for_runtime() {
        keys.insert("VITE_GROQ_API_KEY".to_string(), key);
    }
    keys
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            eprintln!("[api] Using remote CUS Tech API (VITE_API_URL / https://www.custech.co).");

            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            window.set_content_protected(true)?;

            #[cfg(target_os = "windows")]
            {
                let hwnd_raw = window.hwnd()?.0 as isize;
                unsafe {
                    let hwnd = HWND(hwnd_raw as _);
                    let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_TOOLWINDOW.0 as isize);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_keys])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
