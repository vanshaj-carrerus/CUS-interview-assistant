# CUS Interview Assistant

Local interview coach (Tauri v2 + React) with **offline speech-to-text** via [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`whisper-rs`) and system-audio capture via `cpal`.

**Security:** For users outside your org, use the **hosted API** model — secrets stay on `server/`, not in the installer. See **[SECURITY.md](SECURITY.md)**.

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

### Git LFS (repository includes bundled models)

Whisper `.bin` files are stored with [Git LFS](https://git-lfs.com/) (GitHub rejects them as normal Git blobs).

**One-time on your machine:**

```powershell
winget install GitHub.GitLFS
git lfs install
```

**Clone or pull models:**

```bash
git clone https://github.com/vanshaj-carrerus/CUS-interview-assistant.git
cd CUS-interview-assistant
git lfs pull
```

If models are missing after clone, run `git lfs pull` in the repo root.

## Authentication and API (production)

```text
Desktop app  ──HTTPS──►  Your hosted server/  ──►  MongoDB Atlas
     │                         │
     └── Whisper (local)       └── AI keys, JWT, admin secrets
```

1. **Deploy** the Node API in `server/` (see [server/README.md](server/README.md)). Put all secrets in `server/.env` on the host.
2. **Build** the desktop app with only the public API URL:

   ```powershell
   cp src-tauri/.env.example src-tauri/.env
   # Edit: VITE_API_URL=https://api.yourcompany.com
   npm run tauri:build:production
   ```

3. **Control access:** set `ALLOW_REGISTRATION=false` on the server; create users via seed or MongoDB. Enable AI per user with `aiAllowed: true` (Atlas or admin `PATCH`).

Users sign in inside the app. They only receive a **session token** — not database or AI credentials.

### Turning on AI for a session

1. User signs in (`aiAllowed` is reset to `false` on every sign-in).
2. You set `aiAllowed: true` in MongoDB or via admin API while they use the app (polls every ~22s and on window focus).
3. Sign-out clears `sessionId` so another user can sign in. Only one user may be signed in at a time.

## Development

### Option A — Remote API (recommended, same as production)

```bash
npm install
npm run server:install
cp server/.env.example server/.env
# edit server/.env

cp src-tauri/.env.example src-tauri/.env
# VITE_API_URL=http://localhost:3001

npm run server:dev    # terminal 1
npm run tauri dev     # terminal 2
```

### Option B — Embedded API (local only, not for release)

```bash
cp src-tauri/backend.env.example src-tauri/backend.env
# edit backend.env (MongoDB + JWT + AI keys)
npm run tauri dev
# Do not set VITE_API_URL
```

On launch the app loads Whisper and starts system-audio listening. Final phrases are emitted as Tauri events (`stt-result`) after ~1.5s of silence.

### Windows build notes

- `src-tauri/.cargo/config.toml` sets `LIBCLANG_PATH` for bindgen (adjust if LLVM is installed elsewhere).
- `src-tauri/third_party/whisper-rs-sys` is a small patched copy of `whisper-rs-sys` so MSVC builds succeed (enum + glibc layout fixes).
- If you previously set `WHISPER_DONT_GENERATE_BINDINGS` in your shell, remove it: `Remove-Item Env:WHISPER_DONT_GENERATE_BINDINGS -ErrorAction SilentlyContinue`
- First compile of Whisper takes several minutes; later `tauri dev` starts much faster.

### Release build (Windows, with updater signing)

`tauri.conf.json` has `createUpdaterArtifacts: true`, so a full build needs the **same** private key as GitHub (`TAURI_SIGNING_PRIVATE_KEY` secret).

1. Set `VITE_API_URL` in `src-tauri/.env` (HTTPS for real users).
2. Put your minisign private key at **`%USERPROFILE%\.tauri\myapp.key`**, or set `TAURI_PRIVATE_KEY_FILE`.
3. Run:

   ```powershell
   npm run tauri:build:signed
   ```

   Unsigned production build:

   ```powershell
   npm run tauri:build:production
   ```

Do **not** commit `myapp.key` or `server/.env` / `src-tauri/backend.env`.

## Removed: Vosk

Vosk binaries and `src-tauri/vosk/` are no longer used. You may delete `src-tauri/vosk/` and `src-tauri/models/vosk-model/` locally to reclaim disk space.
