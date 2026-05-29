import { useCallback, useEffect, useRef, useState } from "react";

/** Coalesce rapid partials so the main tree is not re-rendered on every STT event. */
const PARTIAL_THROTTLE_MS = 48;

function buildTranscript(committed: string, partial: string): string {
  const p = partial.trim();
  if (!committed && !p) return "";
  if (!p) return committed;
  if (!committed) return p;
  return `${committed} ${p}`;
}

export function useSttTranscript() {
  const committedRef = useRef("");
  const partialRef = useRef("");
  const hasTranscriptRef = useRef(false);
  const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [committed, setCommitted] = useState("");
  const [partial, setPartialDisplay] = useState("");
  const [transcript, setTranscript] = useState("");
  const [hasTranscript, setHasTranscript] = useState(false);

  const publish = useCallback((nextCommitted: string, nextPartial: string) => {
    const nextTranscript = buildTranscript(nextCommitted, nextPartial);
    const nextHas = nextTranscript.trim().length > 0;
    setCommitted(nextCommitted);
    setPartialDisplay(nextPartial);
    setTranscript(nextTranscript);
    if (hasTranscriptRef.current !== nextHas) {
      hasTranscriptRef.current = nextHas;
      setHasTranscript(nextHas);
    }
  }, []);

  const flushNow = useCallback(() => {
    if (throttleRef.current) {
      clearTimeout(throttleRef.current);
      throttleRef.current = null;
    }
    publish(committedRef.current, partialRef.current);
  }, [publish]);

  const schedulePartialFlush = useCallback(() => {
    if (throttleRef.current) return;
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null;
      publish(committedRef.current, partialRef.current);
    }, PARTIAL_THROTTLE_MS);
  }, [publish]);

  const setPartial = useCallback(
    (text: string) => {
      partialRef.current = text;
      if (!text) flushNow();
      else schedulePartialFlush();
    },
    [flushNow, schedulePartialFlush],
  );

  const appendCommitted = useCallback(
    (text: string) => {
      if (!text) return;
      const prev = committedRef.current;
      committedRef.current = (prev ? `${prev} ${text}` : text).trim();
      partialRef.current = "";
      flushNow();
    },
    [flushNow],
  );

  const clearTranscript = useCallback(() => {
    committedRef.current = "";
    partialRef.current = "";
    hasTranscriptRef.current = false;
    flushNow();
  }, [flushNow]);

  const applyUserEdit = useCallback(
    (next: string) => {
      committedRef.current = next;
      partialRef.current = "";
      flushNow();
    },
    [flushNow],
  );

  const clearPartial = useCallback(() => {
    partialRef.current = "";
    flushNow();
  }, [flushNow]);

  const getSnapshot = useCallback(
    () => buildTranscript(committedRef.current, partialRef.current).trim(),
    [],
  );

  useEffect(
    () => () => {
      if (throttleRef.current) clearTimeout(throttleRef.current);
    },
    [],
  );

  return {
    committed,
    partial,
    transcript,
    hasTranscript,
    committedRef,
    partialRef,
    setPartial,
    appendCommitted,
    clearTranscript,
    clearPartial,
    applyUserEdit,
    getSnapshot,
  };
}
