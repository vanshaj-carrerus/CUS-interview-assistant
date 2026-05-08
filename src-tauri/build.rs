use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    if env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let vosk_dir = manifest_dir.join("vosk");

    println!("cargo:rerun-if-changed={}", vosk_dir.display());

    if vosk_dir.exists() {
        println!("cargo:rustc-link-search=native={}", vosk_dir.display());
    }

    // Support common upstream naming (`vosk.lib`/`vosk.dll`) by mirroring
    // them to the names expected by the `vosk` crate on Windows.
    let lib_path = vosk_dir.join("libvosk.lib");
    let alt_lib_path = vosk_dir.join("vosk.lib");
    if !lib_path.exists() && alt_lib_path.exists() {
        let _ = fs::copy(&alt_lib_path, &lib_path);
    }

    let dll_src = vosk_dir.join("libvosk.dll");
    let alt_dll_src = vosk_dir.join("vosk.dll");
    if !dll_src.exists() && alt_dll_src.exists() {
        let _ = fs::copy(&alt_dll_src, &dll_src);
    }

    if !lib_path.exists() {
        panic!(
            "Missing Vosk import library: {}. Place libvosk.lib (or vosk.lib) in src-tauri/vosk.",
            lib_path.display()
        );
    }

    // Copy runtime DLLs next to produced binaries for `cargo run` / `tauri dev`.
    let profile_dir = manifest_dir
        .join("target")
        .join(env::var("PROFILE").unwrap_or_else(|_| "debug".to_string()));
    if let Ok(entries) = fs::read_dir(&vosk_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dll = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("dll"))
                .unwrap_or(false);
            if is_dll {
                if let Some(file_name) = path.file_name() {
                    let dll_dst = profile_dir.join(file_name);
                    let _ = fs::copy(path, dll_dst);
                }
            }
        }
    }
}
