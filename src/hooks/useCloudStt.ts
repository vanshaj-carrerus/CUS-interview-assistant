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

function captureModeLabel(
  source: SttAudioSource,
  phase: "idle" | "picking" | "ready" | "listening",
): string {
  if (phase === "idle") return "Idle";
  if (phase === "picking") {
    return source === "microphone"
      ? "Allow microphone access…"
      : "Pick interview tab — enable Share audio (once)";
  }
  if (phase === "listening") {
    return source === "microphone"
      ? "Groq Whisper · microphone"
      : "Groq Whisper · tab/system audio";
  }
  return source === "microphone" ? "Microphone ready" : "Tab audio connected";
}

function isStreamAlive(stream: MediaStream | null): boolean {
  if (!stream) return false;
  return stream.getAudioTracks().some((t) => t.readyState === "live");
}

export function useCloudStt({ getEditorBridge, onCaptureActive, onError }: UseCloudSttOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isAudioReady, setIsAudioReady] = useState(false);
  const [captureMode, setCaptureMode] = useState("Idle");

  const streamRef = useRef<MediaStream | null>(null);
  const chunkedRecorderRef = useRef<ChunkedRecorderHandle | null>(null);
  const listeningRef = useRef(false);
  const stopRecorderRef = useRef<() => void>(() => {});
  const apiKeyRef = useRef<string | null>(null);
  const promptContextRef = useRef("");
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef(false);

  const stopRecorder = useCallback(() => {
    chunkedRecorderRef.current?.stop();
    chunkedRecorderRef.current = null;
    listeningRef.current = false;
    setIsListening(false);
    onCaptureActive?.(false);

    const bridge = getEditorBridge();
    bridge?.clearPartial();
    bridge?.setHearingSpeech(false);

    const source = sttAudioSource();
    if (isStreamAlive(streamRef.current)) {
      setCaptureMode(captureModeLabel(source, "ready"));
    }
  }, [getEditorBridge, onCaptureActive]);

  stopRecorderRef.current = stopRecorder;

  const releaseAudioCapture = useCallback(() => {
    abortRef.current = true;
    stopRecorder();
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    apiKeyRef.current = null;
    promptContextRef.current = "";
    queueRef.current = Promise.resolve();
    setIsAudioReady(false);
    setCaptureMode("Idle");
  }, [stopRecorder]);

  const ensureAudioCapture = useCallback(async () => {
    await ensureSttKeyLoaded();
    const apiKey = groqApiKey();
    if (!apiKey) {
      const message =
        "Missing Groq API key. Run: npm run env:sync or set VITE_GROQ_API_KEY in src-tauri/.env.";
      onError?.(message);
      throw new Error(message);
    }
    apiKeyRef.current = apiKey;

    if (isStreamAlive(streamRef.current)) {
      setIsAudioReady(true);
      const source = sttAudioSource();
      if (!listeningRef.current) {
        setCaptureMode(captureModeLabel(source, "ready"));
      }
      return;
    }

    if (streamRef.current) {
      stopMediaStream(streamRef.current);
      streamRef.current = null;
      setIsAudioReady(false);
    }

    const source = sttAudioSource();
    setCaptureMode(captureModeLabel(source, "picking"));

    try {
      const stream = await acquireSttAudioStream(source);
      streamRef.current = stream;

      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          setIsAudioReady(false);
          stopRecorderRef.current();
          stopMediaStream(streamRef.current);
          streamRef.current = null;
          setCaptureMode("Idle");
          onError?.(
            "Audio capture ended. Open the app again or click Listen to reconnect.",
          );
        };
      }

      setIsAudioReady(true);
      setCaptureMode(captureModeLabel(source, "ready"));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not access audio for transcription.";
      onError?.(message);
      setCaptureMode("Idle");
      throw err;
    }
  }, [onError, stopRecorder]);

  const enqueueChunk = useCallback(
    (blob: Blob) => {
      const apiKey = apiKeyRef.current;
      if (!apiKey || !listeningRef.current) return;

      queueRef.current = queueRef.current
        .then(async () => {
          if (!listeningRef.current || abortRef.current) return;

          const bridge = getEditorBridge();
          bridge?.setHearingSpeech(true);

          const text = await transcribeAudioBlob(
            blob,
            apiKey,
            promptContextRef.current,
          );
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
    if (listeningRef.current) return;

    if (!isStreamAlive(streamRef.current)) {
      await ensureAudioCapture();
    }

    const stream = streamRef.current;
    if (!stream) return;

    abortRef.current = false;
    if (!apiKeyRef.current) {
      const apiKey = groqApiKey();
      if (!apiKey) {
        onError?.("Missing Groq API key.");
        return;
      }
      apiKeyRef.current = apiKey;
    }

    promptContextRef.current = "";
    queueRef.current = Promise.resolve();

    chunkedRecorderRef.current = startChunkedRecorder(stream, CHUNK_MS, enqueueChunk);

    listeningRef.current = true;
    setIsListening(true);
    onCaptureActive?.(true);
    setCaptureMode(captureModeLabel(sttAudioSource(), "listening"));
  }, [ensureAudioCapture, enqueueChunk, onCaptureActive, onError]);

  const stopListening = useCallback(async () => {
    if (!listeningRef.current) return;
    abortRef.current = true;
    stopRecorder();
    setCaptureMode("Stopped");
    window.setTimeout(() => {
      setCaptureMode((mode) => {
        if (mode !== "Stopped") return mode;
        return isStreamAlive(streamRef.current)
          ? captureModeLabel(sttAudioSource(), "ready")
          : "Idle";
      });
    }, 1200);
  }, [stopRecorder]);

  return {
    isListening,
    isAudioReady,
    captureMode,
    ensureAudioCapture,
    startListening,
    stopListening,
    releaseAudioCapture,
  };
}
