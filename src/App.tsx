import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { checkAndInstallUpdates } from "./lib/appUpdater";
import { ensureApiKeysLoaded } from "./lib/apiConfig";
import {
  buildInterviewCoachPrompt,
  coerceInterviewCoachJson,
  formatInterviewCoachJson,
  runMockInterviewPrompt,
} from "./lib/interviewAiEngine";
import { tauriErrorMessage } from "./lib/tauriError";

type TranscriptPayload = {
  text: string;
  is_final: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
};

/** Join final + streaming partial for the textarea. Do not trim — trim breaks trailing spaces while typing. */
function composeLiveTranscript(finalText: string, partial: string): string {
  if (!partial) return finalText;
  if (!finalText) return partial;
  return `${finalText} ${partial}`;
}

/** Inner limits — keep in sync with `src-tauri/tauri.conf.json` window `minWidth` / `minHeight`. */
const WINDOW_MIN_INNER = { width: 340, height: 260 };
const WINDOW_DEFAULT_INNER = { width: 600, height: 600 };

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function App() {
  const [isListening, setIsListening] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [captureMode, setCaptureMode] = useState("Idle");
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isWindowCompact, setIsWindowCompact] = useState(false);
  const savedInnerLogicalSizeRef = useRef<{ width: number; height: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const toggleWindowCompact = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const appWindow = getCurrentWindow();
      if (isWindowCompact) {
        const restore = savedInnerLogicalSizeRef.current ?? WINDOW_DEFAULT_INNER;
        await appWindow.setSize(new LogicalSize(restore.width, restore.height));
        setIsWindowCompact(false);
      } else {
        const inner = await appWindow.innerSize();
        const factor = await appWindow.scaleFactor();
        savedInnerLogicalSizeRef.current = {
          width: inner.width / factor,
          height: inner.height / factor,
        };
        await appWindow.setSize(
          new LogicalSize(WINDOW_MIN_INNER.width, WINDOW_MIN_INNER.height),
        );
        setIsWindowCompact(true);
      }
    } catch (e) {
      console.error("[window compact]", e);
    }
  }, [isWindowCompact]);

  useEffect(() => {
    void checkAndInstallUpdates();
    void ensureApiKeysLoaded();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    const bindTranscriptEvent = async () => {
      unlisten = await listen<TranscriptPayload>("transcript-event", (event) => {
        const payload = event.payload;
        if (!payload?.text) return;

        if (payload.is_final) {
          setTranscript((prev) => `${prev} ${payload.text}`.trim());
          setPartialTranscript("");
        } else {
          setPartialTranscript(payload.text.trim());
        }
      });
    };

    void bindTranscriptEvent();

    return () => {
      if (unlisten) {
        void unlisten();
      }
      void invoke("stop_system_audio_transcription");
    };
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [transcript, partialTranscript, chatMessages, isSending]);

  const startListening = async () => {
    try {
      setErrorMessage("");
      setCaptureMode("Starting system loopback capture...");
      await invoke("start_system_audio_transcription");
      setIsListening(true);
      setCaptureMode("System audio capture active");
    } catch (error) {
      const message = tauriErrorMessage(error, "Failed to start listening.");
      setErrorMessage(message);
      setIsListening(false);
      setCaptureMode("Idle");
    }
  };

  const stopListening = async () => {
    await invoke("stop_system_audio_transcription");
    setIsListening(false);
    setCaptureMode("Stopped");
  };

  const clearTranscript = () => {
    setTranscript("");
    setPartialTranscript("");
    setChatMessages([]);
    setErrorMessage("");
    console.log("[Transcript Cleared]");
  };

  const sendToAi = async () => {
    const snapshot = composeLiveTranscript(transcript, partialTranscript).trim();
    if (!snapshot) {
      setErrorMessage(
        "Add what the recruiter said (listen, type, or paste), then send to AI.",
      );
      return;
    }
    setErrorMessage("");
    const userId = crypto.randomUUID();
    setChatMessages((prev) => [...prev, { id: userId, role: "user", content: snapshot }]);
    setTranscript("");
    setPartialTranscript("");
    setIsSending(true);
    try {
      const prompt = buildInterviewCoachPrompt(snapshot);
      const { data, model } = await runMockInterviewPrompt<unknown>(prompt);
      const coach = coerceInterviewCoachJson(data);
      const assistantText = formatInterviewCoachJson(coach);
      setChatMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantText,
          model,
        },
      ]);
      console.log("[Send To AI]", snapshot, model);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "AI request failed. Check API keys in .env.";
      setErrorMessage(message);
      console.error("[Send To AI]", err);
    } finally {
      setIsSending(false);
    }
  };

  const hasTranscript =
    transcript.trim().length > 0 || partialTranscript.trim().length > 0;
  const showEmptyState = chatMessages.length === 0 && !hasTranscript;

  const liveTranscriptText = composeLiveTranscript(transcript, partialTranscript);

  return (
    <div className="flex h-full max-h-[calc(100vh-30px)] w-full flex-col overflow-hidden text-slate-100">
      <Header
        isListening={isListening}
        captureMode={captureMode}
        isWindowCompact={isWindowCompact}
        onToggleWindowCompact={toggleWindowCompact}
      />

      <main className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto px-4 pb-6 pt-3"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {showEmptyState && <EmptyState />}

            {chatMessages.map((msg) =>
              msg.role === "user" ? (
                <UserBubble
                  key={msg.id}
                  value={msg.content}
                  readOnly
                  isPartialActive={false}
                  onChange={() => {}}
                />
              ) : (
                <AiBubble key={msg.id} text={msg.content} model={msg.model} />
              ),
            )}

            {isSending && <TypingBubble />}

            <UserBubble
              value={liveTranscriptText}
              readOnly={false}
              isPartialActive={partialTranscript.length > 0}
              placeholder="Live transcript appears here while listening. If capture is not working, type or paste what you heard, then Send to AI."
              onChange={(next) => {
                setTranscript(next);
                setPartialTranscript("");
              }}
            />
          </div>
        </div>
      </main>

      {errorMessage && (
        <ErrorBanner
          message={errorMessage}
          onDismiss={() => setErrorMessage("")}
        />
      )}

      <Composer
        isListening={isListening}
        isSending={isSending}
        canSend={liveTranscriptText.trim().length > 0}
        onStart={startListening}
        onStop={stopListening}
        onSend={sendToAi}
        onClear={clearTranscript}
      />
    </div>
  );
}

function Header({
  isListening,
  captureMode,
  isWindowCompact,
  onToggleWindowCompact,
}: {
  isListening: boolean;
  captureMode: string;
  isWindowCompact: boolean;
  onToggleWindowCompact: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/5 bg-surface/40 px-4 py-3 backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-3">
        <div className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-linear-to-br from-primary to-secondary shadow-lg shadow-primary/25">
          <SparkleIcon className="size-5 text-white" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-tight tracking-tight text-white">
            CUS Interview Assistant
          </h1>
          <p className="truncate text-[11px] leading-tight text-slate-400">
            {captureMode}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isTauriRuntime() && (
          <button
            type="button"
            onClick={() => {
              void onToggleWindowCompact();
            }}
            title={
              isWindowCompact
                ? "Restore window size"
                : "Shrink window to minimum size"
            }
            aria-label={
              isWindowCompact
                ? "Restore window size"
                : "Shrink window to minimum size"
            }
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-200 transition hover:bg-white/10 active:scale-[0.97]"
          >
            {isWindowCompact ? (
              <RestoreWindowIcon className="size-4" />
            ) : (
              <MinimizeWindowIcon className="size-4" />
            )}
          </button>
        )}
        <span
          className={
            "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide " +
            (isListening
              ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
              : "border-white/10 bg-white/5 text-slate-300")
          }
        >
          {isListening ? (
            <>
              <span className="listening-dot" />
              Listening
            </>
          ) : (
            <>
              <span className="size-1.5 rounded-full bg-slate-500" />
              Idle
            </>
          )}
        </span>
      </div>
    </header>
  );
}

function EmptyState() {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-linear-to-br from-primary/20 to-secondary/20 ring-1 ring-white/10">
        <SparkleIcon className="size-7 text-primary" />
      </div>
      <div>
        <h2 className="text-base font-semibold text-white">
          Ready when you are
        </h2>
        <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-slate-400">
          Use{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Listen
          </span>{" "}
          to capture system audio, or type or paste the recruiter question in
          the box below if transcription is unavailable. Then use{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Send to AI
          </span>{" "}
          for a drafted answer.
        </p>
      </div>
    </div>
  );
}

function UserBubble({
  value,
  readOnly,
  isPartialActive,
  onChange,
  placeholder = "Transcript will appear here…",
}: {
  value: string;
  readOnly?: boolean;
  isPartialActive: boolean;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  return (
    <div className="flex justify-end">
      <div className="flex max-w-[88%] flex-col items-end gap-1">
        <div className="flex items-center gap-2 pr-1 text-[11px] text-slate-400">
          {isPartialActive && (
            <span className="inline-flex items-center gap-1 text-emerald-300/80">
              <span className="listening-dot size-1.5!" />
              capturing…
            </span>
          )}
          <span>{readOnly ? "You · sent" : "You"}</span>
          <div className="grid size-6 place-items-center rounded-full bg-white/10 text-[10px] font-semibold text-slate-200">
            U
          </div>
        </div>
        <div className="group rounded-2xl rounded-tr-sm bg-linear-to-br from-primary/25 to-primary/10 p-px shadow-lg shadow-primary/10 ring-1 ring-primary/30">
          {readOnly ? (
            <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-surface-2/80 px-4 py-3 text-[14px] leading-relaxed text-slate-100">
              {value}
            </p>
          ) : (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.currentTarget.value)}
              placeholder={placeholder}
              spellCheck={false}
              rows={3}
              className="block min-h-22 w-full resize-y rounded-2xl rounded-tr-sm bg-surface-2/80 px-4 py-3 text-[14px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus:outline-none"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[88%] flex-col items-start gap-1">
        <div className="flex items-center gap-2 pl-1 text-[11px] text-slate-400">
          <div className="grid size-6 place-items-center rounded-full bg-linear-to-br from-primary to-secondary text-[10px] font-bold text-white">
            <SparkleIcon className="size-3" />
          </div>
          <span>Assistant</span>
        </div>
        <div className="rounded-2xl rounded-tl-sm border border-white/5 bg-surface-2/70 px-4 py-3 backdrop-blur">
          <div className="flex items-center gap-1.5">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AiBubble({ text }: { text: string; model?: string }) {
  const body = text.trim() ? text : "(No text in AI response.)";
  return (
    <div className="flex w-full min-w-0 justify-start">
      <div className="flex max-w-[88%] min-w-0 flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-2 pl-1 text-[11px] text-slate-400">
          <div className="grid size-6 place-items-center rounded-full bg-linear-to-br from-primary to-secondary text-[10px] font-bold text-white"> 
            <SparkleIcon className="size-3" />
          </div>
          <span>Assistant</span>
        </div>
        <div className="w-full min-w-0 rounded-2xl rounded-tl-sm border border-white/5 bg-surface-2/70 px-4 py-3 text-[14px] leading-relaxed text-slate-100 shadow-lg shadow-black/20 backdrop-blur">
          <p
            className="whitespace-pre-wrap wrap-break-word text-slate-100"
            aria-live="polite"
          >
            {body}
          </p>
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="mx-4 mb-2 flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
      <AlertIcon className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md p-1 text-rose-200/70 hover:bg-white/5 hover:text-rose-100"
        aria-label="Dismiss"
      >
        <CloseIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Composer({
  isListening,
  isSending,
  canSend,
  onStart,
  onStop,
  onSend,
  onClear,
}: {
  isListening: boolean;
  isSending: boolean;
  canSend: boolean;
  onStart: () => void;
  onStop: () => void;
  onSend: () => void;
  onClear: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-white/5 bg-surface/60 px-3 py-3 backdrop-blur-xl">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        <button
          type="button"
          onClick={isListening ? onStop : onStart}
          className={
            "group inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-medium transition active:scale-[0.98] " +
            (isListening
              ? "bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/40 hover:bg-rose-500/25"
              : "bg-white/5 text-slate-200 ring-1 ring-white/10 hover:bg-white/10")
          }
        >
          {isListening ? (
            <>
              <StopIcon className="size-4" />
              Stop
            </>
          ) : (
            <>
              <MicIcon className="size-4" />
              Listen
            </>
          )}
        </button>

        <div className="flex-1" />

        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-2 text-[13px] font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 active:scale-[0.98]"
          aria-label="Clear conversation"
        >
          <TrashIcon className="size-4" />
          <span className="hidden sm:inline">Clear</span>
        </button>

        <button
          type="button"
          onClick={onSend}
          disabled={isSending || !canSend}
          className="group inline-flex cursor-pointer items-center gap-2 rounded-full bg-linear-to-br from-primary to-secondary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-lg shadow-primary/25 transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:hover:brightness-100"
        >
          {isSending ? (
            <>
              <SpinnerIcon className="size-4 animate-spin" />
              Sending
            </>
          ) : (
            <>
              <SendIcon className="size-4" />
              Send to AI
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Inline icons (kept local to avoid extra dependencies)
 * ──────────────────────────────────────────────────────────────────────── */

type IconProps = { className?: string };

function SparkleIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function MicIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  );
}

function StopIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SendIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  );
}

function TrashIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

function SpinnerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="3"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlertIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="m12 2 10 18H2L12 2Z" />
      <path d="M12 9v5" />
      <circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CloseIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** Titlebar-style minimize (shrinks to configured minimum inner size). */
function MinimizeWindowIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12h14" />
    </svg>
  );
}

function RestoreWindowIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M8 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2" />
      <rect x="10" y="4" width="10" height="10" rx="2" />
    </svg>
  );
}

export default App;
