Place Vosk Windows native binaries in this folder:

- `libvosk.lib` (required at link time)
- `libvosk.dll` (required at runtime)

Quick setup:

1. Download a Vosk Windows release binary package.
2. Copy `libvosk.lib` and `libvosk.dll` into this `src-tauri/vosk` directory.
3. Run `cargo clean` once if linker cache is stale.
4. Start app again with `npm run tauri dev`.
