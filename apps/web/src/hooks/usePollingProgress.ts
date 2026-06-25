import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { SessionProgress } from "@/api/types";

const DONE_STATES = new Set(["ready", "failed"]);
const POLL_MS = 2500;
const MAX_ERROR_POLL_MS = 30000;

export function usePollingProgress(sessionId: string | null) {
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);
  const visibleRef = useRef(!document.hidden);
  const errorDelayRef = useRef(POLL_MS * 2);

  const fetchOnce = useCallback(async (id: string) => {
    if (!visibleRef.current) return;
    try {
      const data = await api.getProgress(id);
      if (!activeRef.current) return;
      setProgress(data);
      setError(null);
      errorDelayRef.current = POLL_MS * 2;
      if (!DONE_STATES.has(data.status) || (data.status === "ready" && data.artifact_required && !data.artifact_ready)) {
        timerRef.current = setTimeout(() => { void fetchOnce(id); }, POLL_MS);
      }
    } catch (e) {
      if (!activeRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to fetch progress");
      const nextDelay = errorDelayRef.current;
      timerRef.current = setTimeout(() => { void fetchOnce(id); }, nextDelay);
      errorDelayRef.current = Math.min(MAX_ERROR_POLL_MS, nextDelay * 2);
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    activeRef.current = true;
    void fetchOnce(sessionId);

    function onVisibility() {
      visibleRef.current = !document.hidden;
      if (!document.hidden && sessionId) {
        if (timerRef.current) clearTimeout(timerRef.current);
        void fetchOnce(sessionId);
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      activeRef.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionId, fetchOnce, version]);

  const retry = useCallback(() => {
    setProgress(null);
    setError(null);
    errorDelayRef.current = POLL_MS * 2;
    setVersion((current) => current + 1);
  }, []);

  return { progress, error, retry };
}
