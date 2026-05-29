fn main() {
    println!("cargo::rustc-check-cfg=cfg(remote_api_only)");
    println!("cargo:rustc-cfg=remote_api_only");
    tauri_build::build();
}
