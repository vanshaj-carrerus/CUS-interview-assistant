import { useCallback, useRef, useState } from "react";
import { acquireSttAudioStream, stopMediaStream } from "../lib/cloudStt/audioCapture";
import { startChunkedRecorder, type ChunkedRecorderHandle } from "../lib/cloudStt/chunkedRecorder";
import { transcribeAudioBlob } from "../lib/cloudStt/groqWhisper";
import {
  ensureSttKeyLoaded,
  groqApiKey,
  sttAudioSource,
  type SttAudioSource,
} from "../lib/sttConfig";

/** ~2s segments — each is a complete WebM/OGG file for Groq Whisper. */
const CHUNK_MS = 2000;

export type CloudSttEditorBridge = {
  setPartial: (text: string) => void;
  appendCommitted: (text: string) => void;
  clearPartial: () => void;
  setHearingSpeech: (active: boolean) => void;
};

export type UseCloudSttOptions = {
  getEditorBridge: () => CloudSttEditorBridge | null;
  onCaptureActive?: (active: boolean) => void;
  onError?: (message: string) => void;
};

function captureModeLabel(source: SttAudioSource, streaming: boolean): string {
  if (!streaming) return "Idle";
  return source === "microphone"
    ? "Groq Whisper · microphone"
    : "Groq Whisper · tab/system audio";
}

export function useCloudStt({ getEditorBridge, onCaptureActive, onError }: UseCloudSttOptions) {
  const [isListening, setIsListening] = useState(false);
  const [captureMode, setCaptureMode] = useState("Idle");

  const streamRef = useRef<MediaStream | null>(null);
  const chunkedRecorderRef = useRef<ChunkedRecorderHandle | null>(null);
  const listeningRef = useRef(false);
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const apiKeyRef = useRef<string | null>(null);
  const promptContextRef = useRef("");
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef(false);

  const teardown = useCallback(() => {
    abortRef.current = true;

    chunkedRecorderRef.current?.stop();
    chunkedRecorderRef.current = null;

    stopMediaStream(streamRef.current);
    streamRef.current = null;
    apiKeyRef.current = null;
    promptContextRef.current = "";
    queueRef.current = Promise.resolve();

    listeningRef.current = false;
    setIsListening(false);
    onCaptureActive?.(false);

    const bridge = getEditorBridge();
    bridge?.clearPartial();
    bridge?.setHearingSpeech(false);
  }, [getEditorBridge, onCaptureActive]);

  const enqueueChunk = useCallback(
    (blob: Blob) => {
      const apiKey = apiKeyRef.current;
      if (!apiKey || !listeningRef.current) return;

      queueRef.current = queueRef.current
        .then(async () => {
          if (!listeningRef.current || abortRef.current) return;

          const bridge = getEditorBridge();
          bridge?.setHearingSpeech(true);

          const text = await transcribeAudioBlob(blob, apiKey, promptContextRef.current);
          if (!listeningRef.current || abortRef.current || !text) {
            bridge?.setPartial("");
            bridge?.setHearingSpeech(false);
            return;
          }

          bridge?.setPartial(text);
          bridge?.appendCommitted(text);
          bridge?.setPartial("");

          const prev = promptContextRef.current;
          promptContextRef.current = (prev ? `${prev} ${text}` : text).trim().slice(-500);

          bridge?.setHearingSpeech(false);
        })
        .catch((err) => {
          const message =
            err instanceof Error ? err.message : "Groq transcription failed.";
          onError?.(message);
          getEditorBridge()?.setPartial("");
          getEditorBridge()?.setHearingSpeech(false);
        });
    },
    [getEditorBridge, onError],
  );

  const startListening = useCallback(async () => {
    await ensureSttKeyLoaded();
    const apiKey = groqApiKey();
    if (!apiKey) {
      const message =
        "Missing Groq API key. Run: npm run env:sync  (pulls from GitHub Actions secrets). " +
        "Requires gh auth login. Or set VITE_GROQ_API_KEY in src-tauri/.env manually.";
      onError?.(message);
      throw new Error(message);
    }

    if (listeningRef.current) return;

    abortRef.current = false;
    apiKeyRef.current = apiKey;
    promptContextRef.current = "";
    queueRef.current = Promise.resolve();

    const source = sttAudioSource();
    setCaptureMode(
      source === "microphone" ? "Starting Groq · microphone…" : "Pick screen/tab with audio…",
    );

    let stream: MediaStream;
    try {
      stream = await acquireSttAudioStream(source);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not access audio for transcription.";
      onError?.(message);
      setCaptureMode("Idle");
      throw err;
    }

    streamRef.current = stream;

    chunkedRecorderRef.current = startChunkedRecorder(stream, CHUNK_MS, enqueueChunk);

    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        if (listeningRef.current) void stopRef.current();
      };
    }

    listeningRef.current = true;
    setIsListening(true);
    onCaptureActive?.(true);
    setCaptureMode(captureModeLabel(source, true));
  }, [enqueueChunk, onCaptureActive, onError]);

  const stopListening = useCallback(async () => {
    if (!listeningRef.current) return;
    teardown();
    setCaptureMode("Stopped");
    window.setTimeout(() => {
      setCaptureMode((mode) => (mode === "Stopped" ? "Idle" : mode));
    }, 1200);
  }, [teardown]);

  stopRef.current = stopListening;

  return {
    isListening,
    captureMode,
    startListening,
    stopListening,
  };
}
