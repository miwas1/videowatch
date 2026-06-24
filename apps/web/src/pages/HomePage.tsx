import { useEffect, useState } from "react";
import { ArrowRightIcon, CheckIcon, Link2Icon } from "@radix-ui/react-icons";
import { PresetRail } from "@/components/PresetRail";
import { api } from "@/api/client";
import { useHealth } from "@/hooks/useHealth";
import { relativeTime } from "@/lib/format";
import type { SessionListItem } from "@/api/types";

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
    api.listSessions(10, 0).then(setSessions).catch(() => setSessions([]));
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

  function scrollToWorkspace() {
    document.querySelector("#workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => document.querySelector<HTMLInputElement>("#video-url")?.focus(), 550);
  }

  return (
    <main className="home-page">
      <header className="site-header">
        <a className="site-header__brand" href="#home" aria-label="DescribeOps home">
          Describe<span>Ops</span>
        </a>
        <nav className="site-header__nav" aria-label="Primary navigation">
          <a href="#workspace">Workspace</a>
          <a href="#workflows">Workflows</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <div className="site-header__actions">
          <div className="site-header__health" title={checking ? "Checking service" : health?.ok ? `Service online · ${health.visual_model}` : "Service unavailable"}>
            <span className={`health-dot ${checking ? "health-dot--unknown" : health?.ok ? "health-dot--ok" : "health-dot--error"}`} />
            <span>{checking ? "Checking" : health?.ok ? "System online" : "Offline"}</span>
          </div>
          <button className="btn btn--dark site-header__cta" type="button" onClick={scrollToWorkspace}>Start a check</button>
        </div>
      </header>

      <section className="landing-hero" id="home">
        <div className="landing-hero__eyebrow hero-reveal">Video accessibility, without the manual trawl</div>
        <h1 className="landing-hero__title hero-reveal hero-reveal--2">
          Make every frame<br />
          <em>understandable.</em>
        </h1>
        <p className="landing-hero__copy hero-reveal hero-reveal--3">
          DescribeOps turns complex video into structured reading, audio-description scripts, and accessibility evidence.
        </p>
        <button className="landing-hero__link hero-reveal hero-reveal--4" type="button" onClick={scrollToWorkspace}>
          Check a video <ArrowRightIcon aria-hidden="true" />
        </button>

        <div className="landing-hero__signal" aria-hidden="true">
          <div className="signal-frame signal-frame--one"><span>VISUAL</span><b>01</b></div>
          <div className="signal-frame signal-frame--two"><span>AUDIO</span><b>02</b></div>
          <div className="signal-frame signal-frame--three"><span>CONTEXT</span><b>03</b></div>
          <div className="signal-caption">SEE&nbsp;&nbsp;·&nbsp;&nbsp;HEAR&nbsp;&nbsp;·&nbsp;&nbsp;READ</div>
        </div>
        <div className="landing-hero__index" aria-hidden="true">01 / 04</div>
      </section>

      <section className="workspace-section" id="workspace">
        <div className="section-heading">
          <p className="section-kicker">Start here</p>
          <h2>One link.<br /><em>Useful access.</em></h2>
          <p>Paste a public video URL, choose the output people need, and let the analysis run.</p>
        </div>

        <form className="ingest-form" onSubmit={(e) => void handleSubmit(e)}>
          <label htmlFor="video-url" className="ingest-form__label">Public video URL</label>
          <div className="ingest-form__row">
            <Link2Icon className="ingest-form__icon" aria-hidden="true" />
            <input
              id="video-url"
              type="url"
              className="ingest-form__input"
              placeholder="Paste a YouTube or video URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              aria-describedby={error ? "ingest-error" : "ingest-hint"}
            />
            <button className="btn btn--primary ingest-form__submit" type="submit" disabled={submitting || !url.trim()}>
              {submitting ? "Starting…" : <>Analyze video <ArrowRightIcon aria-hidden="true" /></>}
            </button>
          </div>
          <p id="ingest-hint" className="ingest-form__hint">We analyze speech, on-screen action, and context together.</p>
          {error && <p id="ingest-error" className="ingest-form__error" role="alert">{error}</p>}
        </form>
      </section>

      <section className="workflows-section" id="workflows" aria-label="Choose workflow preset">
        <div className="section-heading section-heading--row">
          <div>
            <p className="section-kicker">Choose an output</p>
            <h2>Built for the way<br />people <em>use</em> video.</h2>
          </div>
          <p>Each workflow reshapes the same source for a specific accessibility, learning, or documentation need.</p>
        </div>
        <PresetRail selected={preset} onChange={setPreset} />
      </section>

      <section className="method-section" id="how-it-works">
        <div className="method-section__visual" aria-hidden="true">
          <div className="method-poster">
            <div className="method-poster__stamp">D/O — 2026</div>
            <p>Raw video</p>
            <div className="method-poster__wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
            <strong>becomes<br /><em>clear.</em></strong>
            <span>Speech + frames + time</span>
          </div>
        </div>
        <div className="method-section__content">
          <p className="section-kicker">How it works</p>
          <h2>Context, not just<br /><em>captions.</em></h2>
          <p className="method-section__intro">DescribeOps reads what is said and what is shown, then connects each insight to the moment it came from.</p>
          <ol className="method-list">
            <li><span>01</span><div><strong>Listen</strong><p>Capture spoken content, terminology, and intent.</p></div></li>
            <li><span>02</span><div><strong>Look</strong><p>Identify interfaces, gestures, diagrams, and scene changes.</p></div></li>
            <li><span>03</span><div><strong>Structure</strong><p>Build a timestamped, editable output with evidence.</p></div></li>
          </ol>
        </div>
      </section>

      {sessions.length > 0 && (
        <section className="recent-section" aria-label="Recent jobs">
          <div className="section-heading section-heading--row">
            <div><p className="section-kicker">Your workspace</p><h2>Recent work.</h2></div>
            <p>Continue an analysis or open a completed accessibility output.</p>
          </div>
          <ul className="job-list">
            {sessions.map((s, index) => (
              <li key={s.id} className="job-item">
                <button className="job-item__btn" type="button" onClick={() => onOpenSession(s.id, s.workflow_template || "reading_document", s.status === "ready" && s.artifact_count > 0 ? "review" : "processing")}>
                  <span className="job-item__index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="job-item__title">{s.title || s.page_title || s.source_url || "Untitled"}</span>
                  <span className={`job-item__status job-item__status--${s.status}`}>{s.status}</span>
                  <span className="job-item__meta">{s.ready_chunk_count}/{s.chunk_count} chunks · {relativeTime(s.updated_at)}</span>
                  <ArrowRightIcon aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="final-cta">
        <p className="section-kicker">Access starts with understanding</p>
        <h2>Ready to make the<br />invisible <em>clear?</em></h2>
        <button className="btn final-cta__button" type="button" onClick={scrollToWorkspace}>Start a video check <ArrowRightIcon aria-hidden="true" /></button>
        <p className="final-cta__note"><CheckIcon aria-hidden="true" /> Editable outputs · timestamped evidence · export-ready</p>
      </section>

      <footer className="site-footer">
        <a className="site-header__brand" href="#home">Describe<span>Ops</span></a>
        <p>Video context for everyone.</p>
        <p>© 2026 DescribeOps</p>
      </footer>
    </main>
  );
}
