import type { SttAudioSource } from "../sttConfig";

const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

/** Chromium / WebView2 screen-share privacy controls (not in all TS libs). */
type DisplayMediaChromiumOptions = DisplayMediaStreamOptions & {
  selfBrowserSurface?: "include" | "exclude";
  systemAudio?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
  monitorTypeSurfaces?: "include" | "exclude";
  preferCurrentTab?: boolean;
};

export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime));
}

async function acquireDisplayAudioStream(): Promise<MediaStream> {
  const options: DisplayMediaChromiumOptions = {
    // Tiny video track keeps tab/system audio alive on Windows; audio is what we use.
    video: {
      width: 1,
      height: 1,
      frameRate: 1,
      displaySurface: "browser",
    },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    } as MediaTrackConstraints,
    // Do not offer this assistant app (localhost / Tauri) — avoids sharing our own UI + indicator.
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
    // Prefer tab/window capture; full-screen share shows a heavier OS indicator.
    monitorTypeSurfaces: "exclude",
    surfaceSwitching: "exclude",
    // Tab/window panes still offer "Share tab audio" / "Share system audio" where supported.
    systemAudio: "include",
  };

  const stream = await navigator.mediaDevices.getDisplayMedia(options);

  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      "No audio in this share. Pick your interview tab or window and enable “Share tab audio” or “Also share system audio”.",
    );
  }

  return stream;
}

async function acquireMicrophoneStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

export async function acquireSttAudioStream(
  source: SttAudioSource,
): Promise<MediaStream> {
  if (!navigator.mediaDevices) {
    throw new Error("Microphone / screen capture is not available in this environment.");
  }

  if (source === "microphone") {
    return acquireMicrophoneStream();
  }

  return acquireDisplayAudioStream();
}

export function createMediaRecorder(
  stream: MediaStream,
  onChunk: (chunk: Blob) => void,
): MediaRecorder {
  const mimeType = pickRecorderMimeType();
  const audioOnly = new MediaStream(stream.getAudioTracks());
  const recorder = mimeType
    ? new MediaRecorder(audioOnly, { mimeType })
    : new MediaRecorder(audioOnly);

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) onChunk(event.data);
  };

  return recorder;
}

export function stopMediaStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
