# CUS Interview Assistant

Local interview coach (Tauri v2 + React) with **offline speech-to-text** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`whisper-rs`) and system-audio capture via `cpal`.

## Prerequisites (Windows)

1. **Rust** — [rustup](https://rustup.rs/)
2. **Node.js** — LTS for the Vite frontend
3. **Visual Studio Build Tools** — “Desktop development with C++” workload
4. **CMake** — `winget install Kitware.CMake` or [cmake.org](https://cmake.org/download/)
5. **LLVM / libclang** (required to compile `whisper-rs`) — `winget install LLVM.LLVM`, then ensure `LIBCLANG_PATH` points at the LLVM `bin` folder if bindgen cannot find `libclang.dll`

## Whisper model (required, offline)

Download a GGML English model into `src-tauri/models/whisper/`:

- [ggml-base.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin) (recommended)
- [ggml-tiny.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin) (faster, less accurate)

See `src-tauri/models/whisper/README.md` for layout details.

## AI API keys (for “Send to AI” only)

STT is fully local. Cloud keys are only used for interview coaching:

Set at least one in `src-tauri/.env`:

- `VITE_GEMINI_API_KEY`
- `VITE_GROQ_API_KEY`
- `VITE_MISTRAL_API_KEY`
- `VITE_OPENROUTER_API_KEY`

## Development

```bash
npm install
npm run tauri dev
```

On launch the app loads Whisper and starts system-audio listening. Final phrases are emitted as Tauri events (`stt-result`) after ~1.5s of silence.

### Windows build notes

- `src-tauri/.cargo/config.toml` sets `LIBCLANG_PATH` for bindgen (adjust if LLVM is installed elsewhere).
- `src-tauri/third_party/whisper-rs-sys` is a small patched copy of `whisper-rs-sys` so MSVC builds succeed (enum + glibc layout fixes).
- If you previously set `WHISPER_DONT_GENERATE_BINDINGS` in your shell, remove it: `Remove-Item Env:WHISPER_DONT_GENERATE_BINDINGS -ErrorAction SilentlyContinue`
- First compile of Whisper takes several minutes; later `tauri dev` starts much faster.

## Removed: Vosk

Vosk binaries and `src-tauri/vosk/` are no longer used. You may delete `src-tauri/vosk/` and `src-tauri/models/vosk-model/` locally to reclaim disk space.
