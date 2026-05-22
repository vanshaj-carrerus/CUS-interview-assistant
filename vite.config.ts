import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;
const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const isTauriRelease = isTauri && process.env.TAURI_ENV_DEBUG !== "true";
const apiUrl = process.env.VITE_API_URL?.trim() ?? "";

const CLIENT_SECRET_KEYS = [
  "VITE_GEMINI_API_KEY",
  "VITE_GROQ_API_KEY",
  "VITE_MISTRAL_API_KEY",
  "VITE_OPENROUTER_API_KEY",
] as const;

if (isTauriRelease) {
  if (!apiUrl) {
    throw new Error(
      "Release builds require VITE_API_URL in src-tauri/.env (your hosted API). " +
        "Run: npm run tauri:build:production. See SECURITY.md.",
    );
  }
  for (const key of CLIENT_SECRET_KEYS) {
    if (process.env[key]?.trim()) {
      throw new Error(
        `${key} must not be set for production desktop builds. ` +
          "AI keys belong in server/.env only.",
      );
    }
  }
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  // Keep env variables next to Tauri config.
  envDir: "src-tauri",
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    __REMOTE_API_ONLY__: JSON.stringify(isTauriRelease || !!apiUrl),
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
