import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEFAULT_API_URL } from "./src/api/defaults";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const tauriEnvDir = path.join(repoRoot, "src-tauri");

const host = process.env.TAURI_DEV_HOST;
const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const isTauriRelease = isTauri && process.env.TAURI_ENV_DEBUG !== "true";
let apiUrl = process.env.VITE_API_URL?.trim() ?? "";

if (isTauriRelease && !apiUrl) {
  apiUrl = DEFAULT_API_URL;
  process.env.VITE_API_URL = DEFAULT_API_URL;
}

/** Client-side interview AI keys — must not ship in production installers. */
const CLIENT_AI_SECRET_KEYS = [
  "VITE_GEMINI_API_KEY",
  "VITE_MISTRAL_API_KEY",
  "VITE_OPENROUTER_API_KEY",
] as const;

if (isTauriRelease) {
  for (const key of CLIENT_AI_SECRET_KEYS) {
    if (process.env[key]?.trim()) {
      throw new Error(
        `${key} must not be set for production desktop builds. ` +
          "AI keys belong in server/.env only.",
      );
    }
  }
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, tauriEnvDir, "VITE_");
  // CI sets VITE_GROQ_API_KEY via GITHUB_ENV (no committed .env); merge process.env explicitly.
  const groqApiKey =
    env.VITE_GROQ_API_KEY?.trim() || process.env.VITE_GROQ_API_KEY?.trim() || "";

  if (isTauriRelease && !groqApiKey) {
    throw new Error(
      "VITE_GROQ_API_KEY is required for production desktop builds (Groq STT). " +
        "Set GitHub secret VITE_GROQ_API_KEY or GROQ_API_KEY before tagging a release.",
    );
  }

  return {
  plugins: [react(), tailwindcss()],
  envDir: tauriEnvDir,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    __REMOTE_API_ONLY__: JSON.stringify(isTauriRelease || !!apiUrl),
    "import.meta.env.VITE_GROQ_API_KEY": JSON.stringify(groqApiKey),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore src-tauri except .env so Groq key edits trigger a reload after restart.
      ignored: ["**/src-tauri/**", "!**/src-tauri/.env"],
    },
  },
};
});
