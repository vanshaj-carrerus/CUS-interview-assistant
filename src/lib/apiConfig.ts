import { invoke } from "@tauri-apps/api/core";

export const API_KEY_NAMES = [
  "VITE_GEMINI_API_KEY",
  "VITE_GROQ_API_KEY",
  "VITE_MISTRAL_API_KEY",
  "VITE_OPENROUTER_API_KEY",
] as const;

export type ApiKeyName = (typeof API_KEY_NAMES)[number];

let runtimeKeys: Partial<Record<ApiKeyName, string>> | null = null;
let loadPromise: Promise<void> | null = null;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function fromVite(key: ApiKeyName): string | undefined {
  const v = import.meta.env[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** API key from Vite build env or Rust runtime (compile-time / app config `.env`). */
export function apiKey(key: ApiKeyName): string | undefined {
  return fromVite(key) ?? runtimeKeys?.[key];
}

export function hasAnyApiKey(): boolean {
  return API_KEY_NAMES.some((name) => !!apiKey(name));
}

/** Load keys from the Tauri backend when the Vite bundle has none (e.g. CI release without embed). */
export async function ensureApiKeysLoaded(): Promise<void> {
  if (API_KEY_NAMES.some((name) => fromVite(name))) return;
  if (!isTauriRuntime()) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const keys = await invoke<Record<string, string>>("get_api_keys");
        runtimeKeys = keys as Partial<Record<ApiKeyName, string>>;
      } catch {
        runtimeKeys = {};
      }
    })();
  }
  await loadPromise;
}
