import { invoke } from "@tauri-apps/api/core";
import { usesRemoteApi } from "../api/http";

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

/** @deprecated Client-side AI keys are not used in production. Interview AI runs on the server. */
export function apiKey(key: ApiKeyName): string | undefined {
  if (usesRemoteApi()) return undefined;
  return fromVite(key) ?? runtimeKeys?.[key];
}

/** @deprecated */
export function hasAnyApiKey(): boolean {
  if (usesRemoteApi()) return false;
  return API_KEY_NAMES.some((name) => !!apiKey(name));
}

/**
 * Legacy path for local-only experiments. Production builds use the remote API;
 * AI keys must not be loaded into the desktop app.
 */
export async function ensureApiKeysLoaded(): Promise<void> {
  if (usesRemoteApi()) return;
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
