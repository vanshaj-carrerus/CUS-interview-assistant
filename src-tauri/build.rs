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
    println!("cargo::rustc-check-cfg=cfg(remote_api_only)");
    println!("cargo:rustc-cfg=remote_api_only");

    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));

    tauri_build::build();

    let models_src = manifest_dir.join("models").join("whisper");
    println!("cargo:rerun-if-changed={}", models_src.display());

    let profile_dir = manifest_dir.join("target").join(
        env::var("PROFILE").unwrap_or_else(|_| "debug".to_string()),
    );
    let models_dst = profile_dir.join("models").join("whisper");
    if models_src.exists() {
        let _ = copy_dir_all(&models_src, &models_dst);
    }
}
