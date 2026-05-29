import {
  memo,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSttTranscript } from "../hooks/useSttTranscript";

export type TranscriptEditorHandle = {
  getSnapshot: () => string;
  clear: () => void;
  clearPartial: () => void;
};

type UserBubbleProps = {
  value: string;
  readOnly?: boolean;
  isPartialActive: boolean;
  isTranscribing?: boolean;
  livePartial?: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
};

type TranscriptEditorProps = {
  isListening: boolean;
  canUseAi: boolean;
  placeholder: string;
  onSubmit?: () => void;
  onHasTranscriptChange?: (has: boolean) => void;
  UserBubble: (props: UserBubbleProps) => ReactNode;
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const TranscriptEditor = memo(
  forwardRef<TranscriptEditorHandle, TranscriptEditorProps>(function TranscriptEditor(
    { isListening, canUseAi, placeholder, onSubmit, onHasTranscriptChange, UserBubble },
    ref,
  ) {
    const {
      partial,
      transcript,
      hasTranscript,
      setPartial,
      appendCommitted,
      clearTranscript,
      clearPartial,
      applyUserEdit,
      getSnapshot,
    } = useSttTranscript();

    const [isHearingSpeech, setIsHearingSpeech] = useState(false);
    const hearingRef = useRef(false);
    const hearingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const setHearingSpeech = (active: boolean) => {
      hearingRef.current = active;
      if (!active) {
        if (hearingTimerRef.current) {
          clearTimeout(hearingTimerRef.current);
          hearingTimerRef.current = null;
        }
        setIsHearingSpeech(false);
        return;
      }
      if (hearingTimerRef.current) return;
      hearingTimerRef.current = setTimeout(() => {
        hearingTimerRef.current = null;
        setIsHearingSpeech(hearingRef.current);
      }, 32);
    };

    useImperativeHandle(
      ref,
      () => ({
        getSnapshot,
        clear: clearTranscript,
        clearPartial,
      }),
      [getSnapshot, clearTranscript, clearPartial],
    );

    useEffect(() => {
      onHasTranscriptChange?.(hasTranscript);
    }, [hasTranscript, onHasTranscriptChange]);

    useEffect(() => {
      if (!isTauriRuntime()) return;

      let sttUnlisten: UnlistenFn | null = null;
      let partialUnlisten: UnlistenFn | null = null;
      let listeningUnlisten: UnlistenFn | null = null;

      const setup = async () => {
        sttUnlisten = await listen<string>("stt-result", (event) => {
          const text = event.payload?.trim();
          setPartial("");
          setHearingSpeech(false);
          if (text) appendCommitted(text);
        });

        partialUnlisten = await listen<string>("stt-partial", (event) => {
          const text = event.payload?.trim();
          setPartial(text ?? "");
        });

        listeningUnlisten = await listen<{ active: boolean }>("stt-listening", (event) => {
          setHearingSpeech(!!event.payload?.active);
        });
      };

      void setup();

      return () => {
        if (sttUnlisten) void sttUnlisten();
        if (partialUnlisten) void partialUnlisten();
        if (listeningUnlisten) void listeningUnlisten();
        if (hearingTimerRef.current) clearTimeout(hearingTimerRef.current);
      };
    }, [appendCommitted, setPartial]);

    useEffect(() => {
      if (!isListening) {
        setHearingSpeech(false);
        clearPartial();
      }
    }, [isListening, clearPartial]);

    return UserBubble({
      value: transcript,
      readOnly: false,
      isPartialActive: isListening && (isHearingSpeech || !!partial),
      isTranscribing: isListening && isHearingSpeech && !partial,
      livePartial: partial,
      placeholder,
      onChange: (next) => {
        applyUserEdit(next);
        setHearingSpeech(false);
      },
      onSubmit: canUseAi ? onSubmit : undefined,
    });
  }),
);
