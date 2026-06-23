import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { SessionProgress } from "@/api/types";

const DONE_STATES = new Set(["ready", "failed"]);
const POLL_MS = 2500;

export function usePollingProgress(sessionId: string | null) {
  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(true);

  const fetchOnce = useCallback(async (id: string) => {
    try {
      const data = await api.getProgress(id);
      if (!activeRef.current) return;
      setProgress(data);
      setError(null);
      if (!DONE_STATES.has(data.status) || (data.status === "ready" && data.artifact_required && !data.artifact_ready)) {
        timerRef.current = setTimeout(() => { void fetchOnce(id); }, POLL_MS);
      }
    } catch (e) {
      if (!activeRef.current) return;
      setError(e instanceof Error ? e.message : "Failed to fetch progress");
      timerRef.current = setTimeout(() => { void fetchOnce(id); }, POLL_MS * 2);
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    activeRef.current = true;
    void fetchOnce(sessionId);
    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [sessionId, fetchOnce, version]);

  const retry = useCallback(() => {
    setProgress(null);
    setError(null);
    setVersion((current) => current + 1);
  }, []);

  return { progress, error, retry };
}
