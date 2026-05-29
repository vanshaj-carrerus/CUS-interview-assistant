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

/** Whisper ISO-639-1 code. Default `hi` for Hinglish interviews. Override with VITE_STT_LANGUAGE=en|hi */
export function sttLanguage(): string {
  const raw = import.meta.env.VITE_STT_LANGUAGE?.trim().toLowerCase();
  if (raw === "en" || raw === "english") return "en";
  if (raw === "hi" || raw === "hindi") return "hi";
  return "hi";
}

const HINGLISH_STYLE_PROMPT =
  "Mainly Hindi speech, standard conversation, including occasional English technical words like coding, interview, resume, React, project, and experience.";

const ENGLISH_STYLE_PROMPT =
  "Clear English interview speech, including technical terms.";

/** Style guide + optional prior transcript tail for Whisper (max 500 chars). */
export function buildWhisperPrompt(rollingContext?: string): string {
  const style = sttLanguage() === "hi" ? HINGLISH_STYLE_PROMPT : ENGLISH_STYLE_PROMPT;
  const tail = rollingContext?.trim();
  const combined = tail ? `${style} ${tail}` : style;
  return combined.slice(-500);
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
