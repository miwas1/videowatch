import { useState } from "react";
import { PresetRail } from "@/components/PresetRail";
import { api } from "@/api/client";
import { useHealth } from "@/hooks/useHealth";
import { relativeTime } from "@/lib/format";
import type { SessionListItem } from "@/api/types";
import { useEffect } from "react";

type Props = {
  onSessionStarted: (sessionId: string, workflowTemplate: string) => void;
  onOpenSession: (sessionId: string, workflowTemplate: string, destination: "processing" | "review") => void;
};

export function HomePage({ onSessionStarted, onOpenSession }: Props) {
  const [url, setUrl] = useState("");
  const [preset, setPreset] = useState("reading_document");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const { health, checking } = useHealth();

  useEffect(() => {
    api.listSessions(10, 0)
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.ingestUrl({ url: url.trim(), workflow_template: preset });
      onSessionStarted(result.session_id, preset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start processing");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="home-page">
      <header className="home-page__header">
        <h1 className="home-page__logo">DescribeOps</h1>
        <p className="home-page__sub">AI video accessibility — reading documents, audio descriptions, and more.</p>
        <div className="home-page__health" aria-live="polite">
          {checking ? (
            <span className="health-dot health-dot--unknown" />
          ) : health?.ok ? (
            <span className="health-dot health-dot--ok" title={`Backend: ${health.visual_model}`} />
          ) : (
            <span className="health-dot health-dot--error" title="Backend unreachable" />
          )}
        </div>
      </header>

      <section className="home-page__ingest">
        <form className="ingest-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="video-url" className="ingest-form__label">Video URL</label>
          <div className="ingest-form__row">
            <input
              id="video-url"
              type="url"
              className="ingest-form__input"
              placeholder="https://www.youtube.com/watch?v=..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              autoFocus
              aria-describedby={error ? "ingest-error" : undefined}
            />
            <button
              className="btn btn--primary ingest-form__submit"
              type="submit"
              disabled={submitting || !url.trim()}
            >
              {submitting ? "Starting…" : "Process"}
            </button>
          </div>
          {error && (
            <p id="ingest-error" className="ingest-form__error" role="alert">{error}</p>
          )}
        </form>
      </section>

      <section className="home-page__presets" aria-label="Choose workflow preset">
        <PresetRail selected={preset} onChange={setPreset} />
      </section>

      {sessions.length > 0 && (
        <section className="home-page__recent" aria-label="Recent jobs">
          <h2 className="home-page__section-title">Recent</h2>
          <ul className="job-list">
            {sessions.map((s) => (
              <li key={s.id} className="job-item">
                <button
                  className="job-item__btn"
                  type="button"
                  onClick={() => onOpenSession(
                    s.id,
                    s.workflow_template || "reading_document",
                    s.status === "ready" && s.artifact_count > 0 ? "review" : "processing",
                  )}
                >
                  <span className="job-item__title">{s.title || s.page_title || s.source_url || "Untitled"}</span>
                  <span className={`job-item__status job-item__status--${s.status}`}>{s.status}</span>
                  <span className="job-item__meta">
                    {s.ready_chunk_count}/{s.chunk_count} chunks · {relativeTime(s.updated_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
