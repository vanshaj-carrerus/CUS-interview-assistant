/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_GROQ_API_KEY?: string;
  /** `display` (default) = screen/tab audio; `microphone` = mic only */
  readonly VITE_STT_AUDIO_SOURCE?: string;
  /** Whisper language: `hi` (default, Hinglish) or `en` */
  readonly VITE_STT_LANGUAGE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
