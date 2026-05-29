# CUS Interview Assistant

Interview coach (Tauri v2 + React) with **Groq Whisper** speech-to-text: the frontend records ~2 second audio chunks and sends them to Groq’s `whisper-large-v3-turbo` API (very fast on Groq hardware). Audio is captured in the browser via `getDisplayMedia` / `getUserMedia`.

**Security:** Interview **AI coaching** runs on your hosted `server/` (JWT, MongoDB, model keys). The **Groq API key** is only used client-side for live transcription — set it in `src-tauri/.env` at build time (see below).

## Prerequisites (Windows)

1. **Rust** — [rustup](https://rustup.rs/)
2. **Node.js** — LTS for the Vite frontend
3. **Visual Studio Build Tools** — “Desktop development with C++” workload (for Tauri)

## Speech-to-text (Groq)

1. Create an API key at [Groq Console](https://console.groq.com/).
2. Add it as a **GitHub repository secret**: `VITE_GROQ_API_KEY` or `GROQ_API_KEY` (Settings → Secrets and variables → Actions).
3. **Local dev** — sync secrets into `src-tauri/.env` (gitignored):

   ```powershell
   winget install GitHub.cli   # once
   gh auth login
   npm run env:sync            # downloads dev.env from Actions using repo secrets
   npm run tauri:dev           # sync + tauri dev
   ```

   `env:sync` runs the `dev-env-export` workflow and writes `src-tauri/.env`. Re-run with `npm run env:sync -- -Force` to refresh.

4. **Audio source** (optional):
   - `VITE_STT_AUDIO_SOURCE=display` (default) — share your interview **tab or screen with system audio**.
   - `VITE_STT_AUDIO_SOURCE=microphone` — microphone only.

Click **Listen**, pick the tab/window with audio when prompted. Every ~2 seconds a chunk is transcribed and appended to the transcript (latest chunk also flashes as a live partial while Groq responds).

## Authentication and API (production)

```text
Desktop app  ──HTTPS──►  Your hosted server/  ──►  MongoDB Atlas
     │                         │
     └── Groq Whisper (STT)    └── AI keys, JWT, admin secrets
```

1. **Deploy** the Node API in `server/` (see [server/README.md](server/README.md)).
2. **Build** the desktop app (local or CI):

   ```powershell
   cp src-tauri/.env.example src-tauri/.env
   # VITE_API_URL=https://api.yourcompany.com
   # VITE_GROQ_API_KEY=...
   npm run tauri:build:production
   ```

   **GitHub Actions:** add repository secret `VITE_GROQ_API_KEY` or `GROQ_API_KEY` (same value). The release workflow injects it into the Vite build so the installed app has STT without a local `.env`.

3. Enable AI per user with `aiAllowed: true` on the server.

## Development

```bash
npm install
gh auth login
npm run env:sync      # pulls VITE_GROQ_API_KEY from GitHub secrets → src-tauri/.env

npm run server:dev    # terminal 1 (if using remote API)
npm run tauri:dev     # terminal 2 (or: npm run tauri dev after env:sync)
```

To use a local API URL, set `VITE_API_URL=http://localhost:3001` in `src-tauri/.env` before or after `env:sync` (sync preserves your existing `VITE_API_URL`).

Press **Listen** to start chunk transcription. **Send to AI** (Ctrl+Enter) only when you are ready — nothing is auto-sent.

## Removed: local Whisper / cpal / Deepgram

The desktop app no longer bundles whisper.cpp or uses Deepgram. You may delete `src-tauri/models/whisper/` and `src-tauri/third_party/whisper-rs-sys/` locally to reclaim disk space.
