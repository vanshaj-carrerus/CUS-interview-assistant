import { pickRecorderMimeType } from "./audioCapture";

/** Minimum bytes for a valid segment (skip near-empty / header-only blobs). */
export const MIN_SEGMENT_BYTES = 1200;

export type ChunkedRecorderHandle = {
  stop: () => void;
};

/**
 * Records complete media files by stopping the MediaRecorder each interval.
 * Unlike `start(timeslice)`, every segment includes a valid container header (WebM/OGG).
 */
export function startChunkedRecorder(
  stream: MediaStream,
  intervalMs: number,
  onSegment: (blob: Blob) => void,
): ChunkedRecorderHandle {
  const mimeType = pickRecorderMimeType();
  const audioOnly = new MediaStream(stream.getAudioTracks());
  let stopped = false;
  let activeRecorder: MediaRecorder | null = null;
  let segmentTimer: ReturnType<typeof setTimeout> | null = null;

  const startSegment = () => {
    if (stopped) return;

    const recorder = mimeType
      ? new MediaRecorder(audioOnly, { mimeType })
      : new MediaRecorder(audioOnly);

    recorder.ondataavailable = (event) => {
      if (event.data.size >= MIN_SEGMENT_BYTES) {
        onSegment(event.data);
      }
    };

    activeRecorder = recorder;
    recorder.start();
  };

  const endSegment = () => {
    const recorder = activeRecorder;
    activeRecorder = null;
    if (!recorder || recorder.state === "inactive") return;
    try {
      recorder.stop();
    } catch {
      // Ignore stop races.
    }
  };

  const scheduleNextSegment = () => {
    if (stopped) return;
    segmentTimer = setTimeout(() => {
      endSegment();
      startSegment();
      scheduleNextSegment();
    }, intervalMs);
  };

  startSegment();
  scheduleNextSegment();

  return {
    stop: () => {
      stopped = true;
      if (segmentTimer) {
        clearTimeout(segmentTimer);
        segmentTimer = null;
      }
      endSegment();
    },
  };
}
