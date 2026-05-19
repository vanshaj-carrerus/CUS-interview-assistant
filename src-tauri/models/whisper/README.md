# Whisper GGML models (local, offline)

Place a Whisper **GGML** model file in this folder before building or running the app.

If this repo stores models with Git LFS, fetch the real binaries (not the ~130-byte pointer stubs):

```bash
git lfs pull --include="src-tauri/models/whisper/*.bin"
```

Recommended downloads (English):

- [ggml-base.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin) (~142 MB, better accuracy)
- [ggml-tiny.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin) (~75 MB, faster)

Example layout:

```
src-tauri/models/whisper/ggml-base.en.bin
```

The build script copies this folder to `target/<profile>/models/whisper/` for local runs. Release bundles include `models/whisper/` via `tauri.conf.json`.
