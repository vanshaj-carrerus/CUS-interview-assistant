import { useEffect, useRef, useState } from "react";
import "./App.css";

type TranscriberOutput = string | { text?: string };
type TranscriberFn = (audio: Float32Array, options?: Record<string, unknown>) => Promise<TranscriberOutput>;
type PipelineFactory = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<TranscriberFn>;
type TransformersModule = { pipeline: PipelineFactory };
type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

function App() {
  const [isListening, setIsListening] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [includeSystemAudio, setIncludeSystemAudio] = useState(true);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const [captureMode, setCaptureMode] = useState("Idle");
  const [transcript, setTranscript] = useState("");
  const [aiResponse, setAiResponse] = useState(
    "Click 'Send To AI' after you capture the recruiter question.",
  );
  const [errorMessage, setErrorMessage] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const transcriberRef = useRef<TranscriberFn | null>(null);
  const processingRef = useRef(false);
  const chunkQueueRef = useRef<Blob[]>([]);

  const getTranscriber = async (): Promise<TranscriberFn> => {
    if (transcriberRef.current) return transcriberRef.current;

    setIsLoadingModel(true);
    setCaptureMode("Loading transcription model...");
    const transformers = (await import("@xenova/transformers")) as unknown as TransformersModule;
    const transcriber = await transformers.pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny.en",
      { quantized: true },
    );
    transcriberRef.current = transcriber;
    setIsLoadingModel(false);
    setCaptureMode("Model ready");
    return transcriber;
  };

  const decodeBlobToMono16k = async (blob: Blob): Promise<Float32Array> => {
    const rawBuffer = await blob.arrayBuffer();
    const AudioContextCtor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
    if (!AudioContextCtor) throw new Error("AudioContext is not supported on this system.");
    const decodeContext = new AudioContextCtor();
    const decoded = await decodeContext.decodeAudioData(rawBuffer.slice(0));
    const offlineContext = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start(0);
    const rendered = await offlineContext.startRendering();
    decodeContext.close();
    return rendered.getChannelData(0).slice();
  };

  const transcribeBlob = async (blob: Blob) => {
    try {
      const transcriber = await getTranscriber();
      const mono16k = await decodeBlobToMono16k(blob);
      if (mono16k.length < 1600) return;

      const result = await transcriber(mono16k, {
        chunk_length_s: 12,
        stride_length_s: 2,
      });
      const text = (typeof result === "string" ? result : result.text ?? "").trim();
      if (!text) return;
      setTranscript((prev) => `${prev} ${text}`.trim());
      console.log("[Transcript]", text);
      setCaptureMode("Listening and transcribing");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transcription error";
      setErrorMessage(`Transcription failed: ${message}`);
      setCaptureMode("Error while transcribing");
      console.error("[Transcription Error]", error);
    }
  };

  const processQueue = async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    while (chunkQueueRef.current.length > 0) {
      const next = chunkQueueRef.current.shift();
      if (next) {
        await transcribeBlob(next);
      }
    }
    processingRef.current = false;
  };

  const cleanupStreams = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    systemStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioContextRef.current?.close();
    micStreamRef.current = null;
    systemStreamRef.current = null;
    audioContextRef.current = null;
  };

  useEffect(() => {
    return () => cleanupStreams();
  }, []);

  const startListening = async () => {
    try {
      setErrorMessage("");
      setCaptureMode("Preparing audio capture...");
      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      let insidePcStream: MediaStream | null = null;
      if (includeSystemAudio) {
        insidePcStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        if (!insidePcStream.getAudioTracks().length) {
          throw new Error(
            "System audio not shared. Re-start and enable the 'Share audio' option in picker.",
          );
        }
      }

      const AudioContextCtor = window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("AudioContext is not supported on this system.");
      }

      const audioContext = new AudioContextCtor();
      const destination = audioContext.createMediaStreamDestination();
      const micSource = audioContext.createMediaStreamSource(microphoneStream);
      micSource.connect(destination);

      if (insidePcStream) {
        const systemSource = audioContext.createMediaStreamSource(insidePcStream);
        systemSource.connect(destination);
      }

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(destination.stream, { mimeType });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunkQueueRef.current.push(event.data);
          void processQueue();
        }
      };
      recorder.onerror = () => {
        setErrorMessage("Recorder error occurred while capturing audio.");
      };

      recorder.start(3000);
      recorderRef.current = recorder;
      micStreamRef.current = microphoneStream;
      systemStreamRef.current = insidePcStream;
      audioContextRef.current = audioContext;
      setIsListening(true);
      setCaptureMode(includeSystemAudio ? "Mic + System audio capture active" : "Mic capture active");
    } catch (error) {
      cleanupStreams();
      const message = error instanceof Error ? error.message : "Failed to start listening.";
      setErrorMessage(message);
      setIsListening(false);
      setCaptureMode("Idle");
    }
  };

  const stopListening = () => {
    cleanupStreams();
    setIsListening(false);
    setCaptureMode("Stopped");
  };

  const clearTranscript = () => {
    setTranscript("");
    setAiResponse("Click 'Send To AI' after you capture the recruiter question.");
    setErrorMessage("");
    console.log("[Transcript Cleared]");
  };

  const sendToAi = async () => {
    const cleanTranscript = transcript.trim();
    if (!cleanTranscript) {
      setErrorMessage("Capture some speech first, then send it to AI.");
      return;
    }
    setIsSending(true);
    const mockedAnswer = `AI Draft Answer:\n- Key question heard: "${cleanTranscript.slice(0, 180)}${cleanTranscript.length > 180 ? "..." : ""}"\n- Suggested response: Highlight your approach, tools, impact, and one concrete example.`;
    await new Promise((resolve) => setTimeout(resolve, 450));
    setAiResponse(mockedAnswer);
    setIsSending(false);
    console.log("[Send To AI]", cleanTranscript);
  };

  return (
    <main className="assistant-shell">
      <header className="top-bar">
        <div className="brand">
          <img src="/logo.png" className="logo app-logo" alt="CUS logo" />
          <div>
            <h1>CUS Interview Assistant</h1>
            <p className="subheading">Live voice capture and AI answer drafting</p>
          </div>
        </div>
        <span className={`status-pill ${isListening ? "status-live" : "status-idle"}`}>
          {isListening ? "Listening Live" : "Idle"}
        </span>
      </header>

      <p className="subheading small-note">Capture mode: {captureMode}</p>
      {errorMessage && <p className="warning">{errorMessage}</p>}

      <section className="controls">
        <label className="toggle">
          <input
            type="checkbox"
            checked={includeSystemAudio}
            disabled={isListening}
            onChange={(event) => setIncludeSystemAudio(event.currentTarget.checked)}
          />
          Capture system audio (inside PC) too
        </label>

        <button type="button" onClick={startListening} disabled={isListening || isLoadingModel}>
          {isLoadingModel ? "Loading model..." : "Start Listening"}
        </button>
        <button type="button" onClick={stopListening} disabled={!isListening}>
          Stop Listening
        </button>
        <button type="button" onClick={sendToAi} disabled={isSending}>
          {isSending ? "Sending..." : "Send To AI"}
        </button>
        <button type="button" onClick={clearTranscript}>
          Clear
        </button>
      </section>

      <section className="panels">
        <article className="panel">
          <h2>Live Transcript</h2>
          <p className="panel-content">{transcript || "No speech captured yet."}</p>
        </article>

        <article className="panel">
          <h2>AI Suggested Answer</h2>
          <p className="panel-content">{aiResponse}</p>
        </article>
      </section>
    </main>
  );
}

export default App;
