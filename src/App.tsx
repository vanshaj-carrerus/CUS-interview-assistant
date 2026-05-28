import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import "./App.css";
import {
  fetchUpdateAvailability,
  installPendingUpdate,
} from "./lib/appUpdater";
import {
  getStoredToken,
  logoutRemote,
  refreshCurrentUser,
  restoreSession,
  type AuthSession,
  type PublicUser,
} from "./lib/auth";
import { LoginScreen } from "./components/LoginScreen";
import {
  buildInterviewCoachPrompt,
  buildRefineCoachPrompt,
  coerceInterviewCoachJson,
  formatInterviewCoachJson,
  runMockInterviewPrompt,
  type CoachContext,
  type InterviewCoachJson,
  type RefineKind,
} from "./lib/interviewAiEngine";
import {
  clearStoredResume,
  loadStoredResume,
  formatResumePreview,
  readResumeFile,
  resumeCharCount,
  saveStoredResume,
  type StoredResume,
} from "./lib/resume";
import { tauriErrorMessage } from "./lib/tauriError";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
  /** Recruiter transcript this assistant reply is based on. */
  sourceTranscript?: string;
  coach?: InterviewCoachJson;
};

function findLastAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}

function getLastCoachTurn(messages: ChatMessage[]): {
  assistantId: string;
  transcript: string;
  coach: InterviewCoachJson | undefined;
} | null {
  const idx = findLastAssistantIndex(messages);
  if (idx === -1) return null;
  const assistant = messages[idx];
  const transcript = assistant.sourceTranscript?.trim();
  if (!transcript) return null;
  return {
    assistantId: assistant.id,
    transcript,
    coach: assistant.coach,
  };
}

type SttErrorPayload = {
  message: string;
};

/** Empty string lets the backend resolve bundled `models/whisper/*.bin`. */
const DEFAULT_WHISPER_MODEL_PATH = "";

/** Inner limits — keep in sync with `src-tauri/tauri.conf.json` window `minWidth` / `minHeight`. */
const WINDOW_MIN_INNER = { width: 340, height: 260 };
const WINDOW_DEFAULT_INNER = { width: 600, height: 600 };

type SendToAiOptions = {
  snapshot?: string;
  /** Skip empty-state error toast (auto-send paths). */
  silent?: boolean;
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function bootWhisperStt(): Promise<void> {
  await invoke("initialize_whisper", { modelPath: DEFAULT_WHISPER_MODEL_PATH });
  await invoke("start_interview_listening");
}

function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [captureMode, setCaptureMode] = useState("Idle");
  const [committedTranscript, setCommittedTranscript] = useState("");
  const [livePartial, setLivePartial] = useState("");
  const [isHearingSpeech, setIsHearingSpeech] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isWindowCompact, setIsWindowCompact] = useState(false);
  const [whisperReady, setWhisperReady] = useState(false);
  const [resume, setResume] = useState<StoredResume | null>(() => loadStoredResume());
  const [resumePanelOpen, setResumePanelOpen] = useState(false);
  const [resumePaste, setResumePaste] = useState("");
  const [resumeBusy, setResumeBusy] = useState(false);
  const [latestUpdateVersion, setLatestUpdateVersion] = useState<string | null>(
    null,
  );
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const resumeFileInputRef = useRef<HTMLInputElement>(null);
  const savedInnerLogicalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const committedTranscriptRef = useRef(committedTranscript);
  const livePartialRef = useRef(livePartial);
  const isListeningRef = useRef(isListening);
  const isSendingRef = useRef(isSending);
  const sendToAiRef = useRef<(options?: SendToAiOptions) => Promise<void>>(async () => {});
  const scrollRef = useRef<HTMLDivElement>(null);

  const transcript = useMemo(() => {
    const committed = committedTranscript;
    const partial = livePartial.trim();
    if (!partial) return committed;
    if (!committed) return partial;
    return /\s$/.test(committed) ? `${committed}${partial}` : `${committed} ${partial}`;
  }, [committedTranscript, livePartial]);

  useEffect(() => {
    committedTranscriptRef.current = committedTranscript;
  }, [committedTranscript]);

  useEffect(() => {
    livePartialRef.current = livePartial;
  }, [livePartial]);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    isSendingRef.current = isSending;
  }, [isSending]);
  const coachContext = useMemo<CoachContext>(
    () => (resume?.text ? { resumeText: resume.text } : {}),
    [resume?.text],
  );
  const coachContextRef = useRef(coachContext);
  useEffect(() => {
    coachContextRef.current = coachContext;
  }, [coachContext]);

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
    void restoreSession()
      .then((session) => setAuthSession(session))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (!authSession?.user || authSession.user.aiAllowed) return;

    const poll = () => {
      void refreshCurrentUser().then((user) => {
        if (!user) {
          setAuthSession(null);
          return;
        }
        setAuthSession((prev) => (prev ? { ...prev, user } : null));
      });
    };

    poll();
    const id = window.setInterval(poll, 22_000);
    return () => window.clearInterval(id);
  }, [authSession?.token, authSession?.user?.aiAllowed]);

  /** Pick up admin changes to aiAllowed, or detect revoked / superseded session. */
  useEffect(() => {
    if (!authSession) return;

    const sync = () => {
      void refreshCurrentUser().then((user) => {
        if (!user) {
          setAuthSession(null);
          return;
        }
        setAuthSession((prev) => (prev ? { ...prev, user } : null));
      });
    };

    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [authSession?.token]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void fetchUpdateAvailability().then((result) => {
      if (result.available && result.latestVersion) {
        setLatestUpdateVersion(result.latestVersion);
      }
    });
  }, []);

  const installUpdate = useCallback(async () => {
    if (!latestUpdateVersion || isUpdating) return;
    setErrorMessage("");
    setIsUpdating(true);
    setUpdateProgress(0);
    try {
      await installPendingUpdate((percent) => setUpdateProgress(percent));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Update failed. Try again later.";
      setErrorMessage(message);
      setIsUpdating(false);
      setUpdateProgress(null);
    }
  }, [latestUpdateVersion, isUpdating]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let sttUnlisten: UnlistenFn | null = null;
    let partialUnlisten: UnlistenFn | null = null;
    let listeningUnlisten: UnlistenFn | null = null;
    let errorUnlisten: UnlistenFn | null = null;

    const setup = async () => {
      try {
        setCaptureMode("Loading local Whisper model…");
        await bootWhisperStt();
        setWhisperReady(true);
        setIsListening(true);
        setCaptureMode("Local Whisper · system audio");
        setErrorMessage("");
      } catch (error) {
        const message = tauriErrorMessage(
          error,
          "Failed to initialize local speech recognition.",
        );
        setErrorMessage(message);
        setWhisperReady(false);
        setIsListening(false);
        setCaptureMode("Idle");
      }

      sttUnlisten = await listen<string>("stt-result", (event) => {
        const text = event.payload?.trim();
        setLivePartial("");
        setIsHearingSpeech(false);
        if (!text) return;
        setCommittedTranscript((prev) => (prev ? `${prev} ${text}` : text).trim());
      });

      partialUnlisten = await listen<string>("stt-partial", (event) => {
        const text = event.payload?.trim();
        if (!text) {
          setLivePartial("");
          return;
        }
        setLivePartial(text);
      });

      listeningUnlisten = await listen<{ active: boolean }>("stt-listening", (event) => {
        setIsHearingSpeech(!!event.payload?.active);
      });

      errorUnlisten = await listen<SttErrorPayload>("stt-error", (event) => {
        const message = event.payload?.message?.trim();
        if (!message) return;
        setErrorMessage(message);
      });
    };

    void setup();

    return () => {
      if (sttUnlisten) void sttUnlisten();
      if (partialUnlisten) void partialUnlisten();
      if (listeningUnlisten) void listeningUnlisten();
      if (errorUnlisten) void errorUnlisten();
      void invoke("stop_interview_listening");
    };
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [transcript, chatMessages, isSending]);

  const startListening = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      setErrorMessage("");
      setCaptureMode("Starting local Whisper capture…");
      if (!whisperReady) {
        await invoke("initialize_whisper", { modelPath: DEFAULT_WHISPER_MODEL_PATH });
        setWhisperReady(true);
      }
      await invoke("start_interview_listening");
      setIsListening(true);
      setCaptureMode("Local Whisper · system audio");
    } catch (error) {
      const message = tauriErrorMessage(error, "Failed to start listening.");
      setErrorMessage(message);
      setIsListening(false);
      setCaptureMode("Idle");
    }
  }, [whisperReady]);

  const stopListening = useCallback(async () => {
    if (!isTauriRuntime()) return;
    await invoke("stop_interview_listening");
    setIsListening(false);
    setIsHearingSpeech(false);
    setLivePartial("");
    setCaptureMode("Stopped");
  }, []);

  const clearAll = useCallback(() => {
    setCommittedTranscript("");
    setLivePartial("");
    setIsHearingSpeech(false);
    setChatMessages([]);
    setErrorMessage("");
  }, []);

  const applyResume = useCallback((text: string, fileName: string) => {
    const next = { text: text.trim(), fileName: fileName.trim() || "Resume" };
    if (!next.text) return;
    saveStoredResume(next.text, next.fileName);
    setResume(next);
    setResumePaste("");
    setResumePanelOpen(false);
    setErrorMessage("");
  }, []);

  const removeResume = useCallback(() => {
    clearStoredResume();
    setResume(null);
    setResumePaste("");
    setResumePanelOpen(false);
  }, []);

  const onResumeFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setResumeBusy(true);
      setErrorMessage("");
      try {
        const text = await readResumeFile(file);
        applyResume(text, file.name);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not read resume file.";
        setErrorMessage(message);
      } finally {
        setResumeBusy(false);
        if (resumeFileInputRef.current) resumeFileInputRef.current.value = "";
      }
    },
    [applyResume],
  );

  const savePastedResume = useCallback(() => {
    const text = resumePaste.trim();
    if (!text) {
      setErrorMessage(
        "Paste your resume text first, or upload a PDF, DOCX, TXT, or MD file.",
      );
      return;
    }
    applyResume(text, "Pasted resume");
  }, [resumePaste, applyResume]);

  const appendAssistantReply = useCallback(
    (snapshot: string, coach: InterviewCoachJson, model: string) => {
      const assistantText = formatInterviewCoachJson(coach);
      setChatMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantText,
          model,
          sourceTranscript: snapshot,
          coach,
        },
      ]);
    },
    [],
  );

  const replaceAssistantReply = useCallback(
    (assistantId: string, coach: InterviewCoachJson, model: string) => {
      const assistantText = formatInterviewCoachJson(coach);
      setChatMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: assistantText,
                model,
                coach,
              }
            : msg,
        ),
      );
    },
    [],
  );

  const requestCoach = useCallback(async (prompt: string) => {
    const { data, model } = await runMockInterviewPrompt<unknown>(prompt);
    const coach = coerceInterviewCoachJson(data);
    return { coach, model };
  }, []);

  const canUseAi = !!authSession?.user?.aiAllowed;

  const sendToAi = useCallback(
    async (options?: SendToAiOptions) => {
      if (!canUseAi) {
        if (!options?.silent) {
          setErrorMessage(
            authSession
              ? "Your account does not have AI interview access yet. Contact an administrator."
              : "Please sign in to use AI interview coaching.",
          );
        }
        return;
      }
      const snapshot = (
        options?.snapshot ??
        [committedTranscriptRef.current, livePartialRef.current]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" ")
      ).trim();
      if (!snapshot) {
        if (!options?.silent) {
          setErrorMessage(
            "Add what the recruiter said (listen, type, or paste), then send to AI.",
          );
        }
        return;
      }
      if (isSendingRef.current) return;

      setErrorMessage("");
      const userId = crypto.randomUUID();
      setChatMessages((prev) => [...prev, { id: userId, role: "user", content: snapshot }]);
      setCommittedTranscript("");
      setLivePartial("");
      setIsHearingSpeech(false);
      setIsSending(true);
      try {
        const prompt = buildInterviewCoachPrompt(
          snapshot,
          coachContextRef.current,
        );
        const { coach, model } = await requestCoach(prompt);
        appendAssistantReply(snapshot, coach, model);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "AI request failed. Check API keys in .env.";
        setErrorMessage(message);
        if (!getStoredToken()) {
          setAuthSession(null);
        }
      } finally {
        setIsSending(false);
      }
    },
    [requestCoach, appendAssistantReply, canUseAi, authSession],
  );

  useEffect(() => {
    sendToAiRef.current = sendToAi;
  }, [sendToAi]);

  const regenerateLastAnswer = useCallback(async () => {
    if (!canUseAi) return;
    const turn = getLastCoachTurn(chatMessages);
    if (!turn || isSending) return;
    setErrorMessage("");
    setIsSending(true);
    try {
      const prompt = buildInterviewCoachPrompt(
        turn.transcript,
        coachContextRef.current,
      );
      const { coach, model } = await requestCoach(prompt);
      replaceAssistantReply(turn.assistantId, coach, model);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "AI request failed. Check API keys in .env.";
      setErrorMessage(message);
      if (!getStoredToken()) {
        setAuthSession(null);
      }
    } finally {
      setIsSending(false);
    }
  }, [canUseAi, chatMessages, isSending, requestCoach, replaceAssistantReply]);

  const refineLastAnswer = useCallback(
    async (kind: RefineKind) => {
      if (!canUseAi) return;
      const turn = getLastCoachTurn(chatMessages);
      if (!turn?.coach || isSending) return;
      setErrorMessage("");
      setIsSending(true);
      try {
        const prompt = buildRefineCoachPrompt(
          turn.transcript,
          turn.coach,
          kind,
          coachContextRef.current,
        );
        const { coach, model } = await requestCoach(prompt);
        replaceAssistantReply(turn.assistantId, coach, model);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "AI request failed. Check API keys in .env.";
        setErrorMessage(message);
        if (!getStoredToken()) {
          setAuthSession(null);
        }
      } finally {
        setIsSending(false);
      }
    },
    [canUseAi, chatMessages, isSending, requestCoach, replaceAssistantReply],
  );

  const handleSignOut = useCallback(async () => {
    await logoutRemote();
    setAuthSession(null);
    setChatMessages([]);
    setCommittedTranscript("");
    setLivePartial("");
    setErrorMessage("");
  }, []);

  const hasTranscript = transcript.trim().length > 0;
  const lastAssistantIndex = findLastAssistantIndex(chatMessages);
  const lastCoachTurn = getLastCoachTurn(chatMessages);
  const canRegenerate = !!lastCoachTurn && !isSending;
  const canRefine = !!lastCoachTurn?.coach && !isSending;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key === "Enter" && !e.shiftKey) {
        if (hasTranscript && !isSending && canUseAi) {
          e.preventDefault();
          void sendToAi();
        }
        return;
      }

      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        if (isListening) void stopListening();
        else void startListening();
        return;
      }

      if (e.key === "C" && e.shiftKey) {
        e.preventDefault();
        clearAll();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    hasTranscript,
    isSending,
    isListening,
    canUseAi,
    sendToAi,
    clearAll,
    startListening,
    stopListening,
  ]);
  const showEmptyState = chatMessages.length === 0 && !hasTranscript;

  if (authLoading) {
    return (
      <div className="flex h-full min-h-[calc(100vh-30px)] items-center justify-center text-slate-400">
        <SpinnerIcon className="size-6 animate-spin" />
      </div>
    );
  }

  if (!authSession) {
    return (
      <LoginScreen
        onAuthenticated={(session) => {
          setAuthSession(session);
          setErrorMessage("");
        }}
      />
    );
  }

  return (
    <div className="flex h-full max-h-[calc(100vh-30px)] w-full flex-col overflow-hidden text-slate-100">
      <Header
        user={authSession.user}
        onSignOut={handleSignOut}
        isListening={isListening}
        captureMode={captureMode}
        aiAllowed={canUseAi}
        isWindowCompact={isWindowCompact}
        onToggleWindowCompact={toggleWindowCompact}
        resume={resume}
        resumePanelOpen={resumePanelOpen}
        resumePaste={resumePaste}
        resumeBusy={resumeBusy}
        resumeFileInputRef={resumeFileInputRef}
        onToggleResumePanel={() => setResumePanelOpen((open) => !open)}
        onResumePasteChange={setResumePaste}
        onResumeFile={(file) => void onResumeFile(file)}
        onSavePastedResume={savePastedResume}
        onRemoveResume={removeResume}
        latestUpdateVersion={latestUpdateVersion}
        isUpdating={isUpdating}
        updateProgress={updateProgress}
        onInstallUpdate={() => void installUpdate()}
      />

      <main className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto px-4 pb-6 pt-3"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {showEmptyState && <EmptyState aiAllowed={canUseAi} />}

            {!canUseAi && <AiAccessBanner />}

            {chatMessages.map((msg, index) =>
              msg.role === "user" ? (
                <UserBubble
                  key={msg.id}
                  value={msg.content}
                  readOnly
                  isPartialActive={false}
                  onChange={() => {}}
                />
              ) : (
                <AiBubble
                  key={msg.id}
                  text={msg.content}
                  model={msg.model}
                  isLast={index === lastAssistantIndex}
                  canRegenerate={canRegenerate}
                  canRefine={canRefine}
                  onRegenerate={() => void regenerateLastAnswer()}
                  onRefine={(kind) => void refineLastAnswer(kind)}
                />
              ),
            )}

            {isSending && <TypingBubble />}

            <UserBubble
              value={transcript}
              readOnly={false}
              isPartialActive={isListening && (isHearingSpeech || !!livePartial)}
              isTranscribing={isListening && isHearingSpeech && !livePartial}
              livePartial={livePartial}
              placeholder={
                canUseAi
                  ? "Speech appears here as it is transcribed. Edit if needed, then Send to AI (Ctrl+Enter) when ready — nothing is sent automatically."
                  : "Listening and typing work, but AI coaching requires access from an administrator."
              }
              onChange={(next) => {
                setCommittedTranscript(next);
                setLivePartial("");
                setIsHearingSpeech(false);
              }}
              onSubmit={canUseAi ? () => void sendToAi() : undefined}
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
        canSend={hasTranscript && canUseAi}
        aiAllowed={canUseAi}
        onStart={startListening}
        onStop={stopListening}
        onSend={sendToAi}
        onClear={clearAll}
      />
    </div>
  );
}

function AiAccessBanner() {
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-[13px] leading-relaxed text-amber-100">
      AI coaching is turned off until an administrator allows you to use it for your
      account. While this session is open. Each new sign-in clears AI
      access; only one device can be signed in at a time. Signing out clears AI
      again for next time.
    </div>
  );
}

function Header({
  user,
  onSignOut,
  aiAllowed,
  isListening,
  captureMode,
  isWindowCompact,
  onToggleWindowCompact,
  resume,
  resumePanelOpen,
  resumePaste,
  resumeBusy,
  resumeFileInputRef,
  onToggleResumePanel,
  onResumePasteChange,
  onResumeFile,
  onSavePastedResume,
  onRemoveResume,
  latestUpdateVersion,
  isUpdating,
  updateProgress,
  onInstallUpdate,
}: {
  user: PublicUser;
  onSignOut: () => void | Promise<void>;
  aiAllowed: boolean;
  isListening: boolean;
  captureMode: string;
  isWindowCompact: boolean;
  onToggleWindowCompact: () => void;
  resume: StoredResume | null;
  resumePanelOpen: boolean;
  resumePaste: string;
  resumeBusy: boolean;
  resumeFileInputRef: RefObject<HTMLInputElement | null>;
  onToggleResumePanel: () => void;
  onResumePasteChange: (value: string) => void;
  onResumeFile: (file: File | null) => void;
  onSavePastedResume: () => void;
  onRemoveResume: () => void;
  latestUpdateVersion: string | null;
  isUpdating: boolean;
  updateProgress: number | null;
  onInstallUpdate: () => void;
}) {
  return (
    <header className="relative shrink-0 border-b border-white/5 bg-surface/25 backdrop-blur-lg">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
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
          <span
            className={
              "hidden max-w-28 truncate rounded-full border px-2 py-1 text-[10px] font-medium sm:inline " +
              (aiAllowed
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                : "border-amber-400/30 bg-amber-500/10 text-amber-200")
            }
            title={user.email}
          >
            {aiAllowed ? "AI enabled" : "AI pending"}
          </span>

          <button
            type="button"
            onClick={onSignOut}
            className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/10"
          >
            Sign out
          </button>

          {latestUpdateVersion && (
            <button
              type="button"
              onClick={onInstallUpdate}
              disabled={isUpdating}
              className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/25 active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
            >
              {isUpdating ? (
                <>
                  <SpinnerIcon className="size-3.5 animate-spin" />
                  {updateProgress != null
                    ? `Updating ${updateProgress}%`
                    : "Updating…"}
                </>
              ) : (
                <>
                  <DownloadIcon className="size-3.5 shrink-0" />
                  Update v{latestUpdateVersion}
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onToggleResumePanel}
            aria-expanded={resumePanelOpen}
            className={
              "inline-flex max-w-36 items-center gap-1.5 truncate rounded-full border px-2.5 py-1 text-[11px] font-medium transition hover:bg-white/10 active:scale-[0.98] sm:max-w-44" +
              (resume
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-white/10 bg-white/5 text-slate-300")
            }
          >
            <DocumentIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {resume ? resume.fileName : "Resume"}
            </span>
          </button>

        {isTauriRuntime() && (
          <button
            type="button"
            onClick={() => {
              void onToggleWindowCompact();
            }}
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
      </div>

      {resumePanelOpen && (
        <div className="border-t border-white/5 px-4 py-3">
          <p className="text-[12px] leading-relaxed text-slate-400">
            Optional: upload PDF, DOCX, TXT, or MD, or paste text. The AI uses
            this for experience and project questions only.
          </p>

          {resume && (
            <div className="mt-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2">
              <p className="text-[12px] font-medium text-primary">
                Resume loaded for AI
              </p>
              <p className="mt-0.5 truncate text-[11px] text-slate-300">
                {resume.fileName} ·{" "}
                {resumeCharCount(resume.text).toLocaleString()} characters
              </p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">
                {formatResumePreview(resume.text)}
              </p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={resumeFileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.text,.markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
              className="hidden"
              onChange={(e) => onResumeFile(e.currentTarget.files?.[0] ?? null)}
            />
            <button
              type="button"
              disabled={resumeBusy}
              onClick={() => resumeFileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-[12px] font-medium text-slate-200 ring-1 ring-white/10 transition hover:bg-white/10 disabled:opacity-50"
            >
              {resumeBusy ? (
                <SpinnerIcon className="size-3.5 animate-spin" />
              ) : (
                <UploadIcon className="size-3.5" />
              )}
              {resume ? "Replace resume" : "Upload resume"}
            </button>
            {resume && (
              <button
                type="button"
                onClick={onRemoveResume}
                className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/10 px-3 py-1.5 text-[12px] font-medium text-rose-200 ring-1 ring-rose-400/30 transition hover:bg-rose-500/20"
              >
                <TrashIcon className="size-3.5" />
                Delete resume
              </button>
            )}
          </div>
          <textarea
            value={resumePaste}
            onChange={(e) => onResumePasteChange(e.currentTarget.value)}
            placeholder="Or paste resume text here…"
            rows={4}
            spellCheck={false}
            className="mt-3 block w-full resize-y rounded-xl border border-white/10 bg-surface-2/50 px-3 py-2 text-[13px] leading-relaxed text-slate-100 placeholder:text-slate-500 backdrop-blur-md focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onSavePastedResume}
              disabled={!resumePaste.trim()}
              className="rounded-full bg-linear-to-br from-primary to-secondary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground shadow-md shadow-primary/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resume ? "Replace with paste" : "Save pasted resume"}
            </button>
          </div>
        </div>
      )}
    </header>
  );
}

function EmptyState({ aiAllowed }: { aiAllowed: boolean }) {
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
          to capture system audio with local Whisper (text updates live as you
          hear it), or type or paste the recruiter question. When you are ready,
          use{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Send to AI
          </span>{" "}
          — nothing is sent until you do
          {!aiAllowed
            ? " once an administrator enables AI access for your account"
            : ""}
          . Optionally add your resume via{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Resume
          </span>{" "}
          so experience questions use your real background. Shortcuts:{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Ctrl+Enter
          </span>{" "}
          send,{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Ctrl+L
          </span>{" "}
          listen,{" "}
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-slate-200">
            Ctrl+Shift+C
          </span>{" "}
          clear all.
        </p>
      </div>
    </div>
  );
}

function UserBubble({
  value,
  readOnly,
  isPartialActive,
  isTranscribing,
  livePartial,
  onChange,
  onSubmit,
  placeholder = "Transcript will appear here…",
}: {
  value: string;
  readOnly?: boolean;
  isPartialActive: boolean;
  isTranscribing?: boolean;
  livePartial?: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
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
              {isTranscribing
                ? "transcribing…"
                : livePartial
                  ? "updating…"
                  : "hearing speech…"}
            </span>
          )}
          <span>{readOnly ? "You · sent" : "You"}</span>
          <div className="grid size-6 place-items-center rounded-full bg-white/10 text-[10px] font-semibold text-slate-200">
            U
          </div>
        </div>
        <div className="group rounded-2xl rounded-tr-sm bg-linear-to-br from-primary/25 to-primary/10 p-px shadow-lg shadow-primary/10 ring-1 ring-primary/30">
          {readOnly ? (
            <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-surface-2/50 px-4 py-3 text-[14px] leading-relaxed text-slate-100 backdrop-blur-md">
              {value}
            </p>
          ) : (
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.currentTarget.value)}
              onKeyDown={(e) => {
                const mod = e.ctrlKey || e.metaKey;
                if (mod && e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit?.();
                }
              }}
              placeholder={placeholder}
              spellCheck={false}
              rows={3}
              className={
                "block min-h-22 w-full resize-y rounded-2xl rounded-tr-sm bg-surface-2/50 px-4 py-3 text-[14px] leading-relaxed text-slate-100 placeholder:text-slate-500 backdrop-blur-md focus:outline-none " +
                (livePartial ? "ring-1 ring-emerald-400/25" : "")
              }
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
        <div className="rounded-2xl rounded-tl-sm border border-white/5 bg-surface-2/45 px-4 py-3 backdrop-blur-md">
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

function AiBubble({
  text,
  model: _model,
  isLast,
  canRegenerate,
  canRefine,
  onRegenerate,
  onRefine,
}: {
  text: string;
  model?: string;
  isLast?: boolean;
  canRegenerate?: boolean;
  canRefine?: boolean;
  onRegenerate?: () => void;
  onRefine?: (kind: RefineKind) => void;
}) {
  const body = text.trim() ? text : "(No text in AI response.)";
  const showActions = isLast && (canRegenerate || canRefine);

  return (
    <div className="flex w-full min-w-0 justify-start">
      <div className="flex max-w-[88%] min-w-0 flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-2 pl-1 text-[11px] text-slate-400">
          <div className="grid size-6 place-items-center rounded-full bg-linear-to-br from-primary to-secondary text-[10px] font-bold text-white">
            <SparkleIcon className="size-3" />
          </div>
          <span>Assistant</span>
        </div>
        <div className="w-full min-w-0 rounded-2xl rounded-tl-sm border border-white/5 bg-surface-2/45 px-4 py-3 text-[14px] leading-relaxed text-slate-100 shadow-lg shadow-black/15 backdrop-blur-md">
          <p
            className="whitespace-pre-wrap wrap-break-word text-slate-100"
            aria-live="polite"
          >
            {body}
          </p>
          {showActions && (
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/5 pt-3">
              {canRegenerate && (
                <RefineButton label="Regenerate" onClick={() => onRegenerate?.()} />
              )}
              {canRefine && (
                <>
                  <RefineButton
                    label="Shorter"
                    onClick={() => onRefine?.("shorter")}
                  />
                  <RefineButton
                    label="More technical"
                    onClick={() => onRefine?.("technical")}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RefineButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 active:scale-[0.98]"
    >
      {label}
    </button>
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
  aiAllowed,
  onStart,
  onStop,
  onSend,
  onClear,
}: {
  isListening: boolean;
  isSending: boolean;
  canSend: boolean;
  aiAllowed: boolean;
  onStart: () => void;
  onStop: () => void;
  onSend: () => void;
  onClear: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-white/5 bg-surface/30 px-3 py-3 backdrop-blur-xl">
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
          aria-label="Clear all"
        >
          <TrashIcon className="size-4" />
          <span className="hidden sm:inline">Clear all</span>
        </button>

        <button
          type="button"
          onClick={onSend}
          disabled={isSending || !canSend || !aiAllowed}
          title={
            !aiAllowed
              ? "Sign in with AI access enabled to send to AI"
              : undefined
          }
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
              {aiAllowed ? "Send to AI" : "AI locked"}
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

function DocumentIcon({ className }: IconProps) {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

function UploadIcon({ className }: IconProps) {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  );
}

function DownloadIcon({ className }: IconProps) {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

export default App;
