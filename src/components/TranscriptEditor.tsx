import {
  memo,
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from "react";
import { useSttTranscript } from "../hooks/useSttTranscript";
import type { CloudSttEditorBridge } from "../hooks/useCloudStt";

export type TranscriptEditorHandle = CloudSttEditorBridge & {
  getSnapshot: () => string;
  clear: () => void;
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
        setPartial,
        appendCommitted,
        setHearingSpeech,
      }),
      [
        getSnapshot,
        clearTranscript,
        clearPartial,
        setPartial,
        appendCommitted,
      ],
    );

    useEffect(() => {
      onHasTranscriptChange?.(hasTranscript);
    }, [hasTranscript, onHasTranscriptChange]);

    useEffect(() => {
      if (!isListening) {
        setHearingSpeech(false);
        clearPartial();
      }
    }, [isListening, clearPartial]);

    useEffect(
      () => () => {
        if (hearingTimerRef.current) clearTimeout(hearingTimerRef.current);
      },
      [],
    );

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
