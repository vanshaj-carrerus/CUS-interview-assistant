# Security model

## Production (external users)

The **desktop installer must not contain**:

- MongoDB connection strings or passwords
- `JWT_SECRET` (token signing)
- AI provider API keys (`GEMINI_*`, `GROQ_*`, etc.)
- `INTERVIEW_ADMIN_SECRET`

Those live only in **`server/.env`** on infrastructure you control (VPS, Railway, Fly.io, etc.).

The app ships with:

- `VITE_API_URL` — public HTTPS base URL of your API (baked at build time, not a secret)
- Local Whisper models for offline speech-to-text

Users authenticate with **email + password** and receive a **session JWT**. They cannot access server secrets. AI coaching runs only when **`aiAllowed`** is true on their account (set by you in MongoDB or via admin API).

### Build a safe installer

1. Deploy `server/` with `server/.env` (see `server/.env.example`).
2. In `src-tauri/.env`, set only:

   ```env
   VITE_API_URL=https://api.yourcompany.com
   ```

3. Build:

   ```powershell
   npm run tauri:build:production
   ```

   Or signed:

   ```powershell
   npm run tauri:build:signed
   ```

Release builds default to `https://www.custech.co` when `VITE_API_URL` is unset. They **fail** if client-side `VITE_*_API_KEY` variables are set.

### Controlling who can use the app

| Control | Where |
|--------|--------|
| Who can sign in | Accounts in MongoDB (`users` collection) |
| Open registration | `ALLOW_REGISTRATION=false` on server (recommended for external users) |
| Who gets AI coaching | `aiAllowed: true` per user (MongoDB or `PATCH .../ai-allowed` with `x-admin-secret`) |
| One session per account | Sign-in rotates `sessionId`; other devices are logged out |

### Server hardening checklist

- HTTPS only in production
- Strong `JWT_SECRET` and `INTERVIEW_ADMIN_SECRET`
- `ALLOW_REGISTRATION=false` unless you want public sign-up
- Restrict MongoDB Atlas user permissions and IP allowlist
- Set `CORS_ORIGINS` when `NODE_ENV=production` (see `server/.env.example`)
- Rotate keys if a build ever shipped with secrets by mistake

## Local development

Two supported options:

**A — Remote API (matches production)**

```env
# src-tauri/.env
VITE_API_URL=http://localhost:3001
```

```bash
npm run server:dev   # secrets in server/.env
npm run tauri dev
```

**B — Embedded API (convenience only, not for shipping)**

```bash
cp src-tauri/backend.env.example src-tauri/backend.env
# edit backend.env — never commit
npm run tauri dev
```

Do not use option B for installers distributed outside your org.

## What users can and cannot extract

| Asset | In installer? | Risk if extracted |
|-------|----------------|-------------------|
| `VITE_API_URL` | Yes | Low — public endpoint |
| User JWT after login | In memory / localStorage | Session for that user only |
| MongoDB / AI keys | **No** (production build) | N/A |
| Whisper models | Yes | Low — public STT models |

Anyone can call your public API; protect it with auth, `aiAllowed`, rate limits, and HTTPS.
