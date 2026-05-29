import { invoke } from "@tauri-apps/api/core";

/** Groq Whisper chunk STT. Set `VITE_GROQ_API_KEY` in `src-tauri/.env`. */
export type SttAudioSource = "display" | "microphone";

let runtimeGroqKey: string | undefined;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeKey(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

function fromVite(): string | undefined {
  return normalizeKey(import.meta.env.VITE_GROQ_API_KEY);
}

export function groqApiKey(): string | undefined {
  return fromVite() ?? runtimeGroqKey;
}

/** `display` = tab/system audio via screen share (matches legacy loopback). `microphone` = mic only. */
export function sttAudioSource(): SttAudioSource {
  const raw = import.meta.env.VITE_STT_AUDIO_SOURCE?.trim().toLowerCase();
  return raw === "microphone" ? "microphone" : "display";
}

export async function ensureSttKeyLoaded(): Promise<void> {
  const viteKey = fromVite();
  if (viteKey) {
    runtimeGroqKey = viteKey;
    return;
  }

  if (!isTauriRuntime()) return;
  if (runtimeGroqKey) return;

  try {
    const keys = await invoke<Record<string, string>>("get_api_keys");
    const key = normalizeKey(keys.VITE_GROQ_API_KEY);
    if (key) runtimeGroqKey = key;
  } catch {
    // Retry on next Listen — e.g. after .env is added without restarting Vite.
  }
}
