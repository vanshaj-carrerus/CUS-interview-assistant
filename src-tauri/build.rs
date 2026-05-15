use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

fn main() {
    tauri_build::build();

    if env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows") {
        return;
    }

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let vosk_dir = manifest_dir.join("vosk");
    let models_src = manifest_dir.join("models").join("vosk-model");
    let model_marker = models_src
        .join("vosk-model-small-en-us-0.15")
        .join("am")
        .join("final.mdl");

    println!("cargo:rerun-if-changed={}", vosk_dir.display());
    println!("cargo:rerun-if-changed={}", models_src.display());

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

    if !model_marker.exists() {
        panic!(
            "Missing Vosk speech model at {}. Extract vosk-model-small-en-us-0.15 into src-tauri/models/vosk-model/.",
            model_marker.display()
        );
    }

    // Copy runtime DLLs and speech model next to produced binaries for `cargo run` / `tauri dev`.
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

    let models_dst = profile_dir.join("models").join("vosk-model");
    if models_src.exists() {
        let _ = copy_dir_all(&models_src, &models_dst);
    }
}
