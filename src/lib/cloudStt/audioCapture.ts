import type { SttAudioSource } from "../sttConfig";

const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];

export function pickRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return RECORDER_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime));
}

async function acquireDisplayAudioStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // Video must stay enabled (do not stop the track) or system/tab audio often ends on Windows.
    video: { width: 1, height: 1, frameRate: 1 },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  if (stream.getAudioTracks().length === 0) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      "No audio track in screen share. Enable “Share system audio” or “Share tab audio”, then try again.",
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
