import { useEffect, useState } from "react";
import { ArrowRightIcon, CheckIcon, Link2Icon, UploadIcon } from "@radix-ui/react-icons";
import { PresetRail } from "@/components/PresetRail";
import { api } from "@/api/client";
import { useHealth } from "@/hooks/useHealth";
import { relativeTime } from "@/lib/format";
import type { AuthUser, SessionListItem } from "@/api/types";

type Props = {
  currentUser: AuthUser;
  onLogout: () => void;
  onSessionStarted: (sessionId: string, workflowTemplate: string) => void;
  onOpenSession: (sessionId: string, workflowTemplate: string, destination: "processing" | "review") => void;
};

export function HomePage({ currentUser, onLogout, onSessionStarted, onOpenSession }: Props) {
  const [url, setUrl] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [sourceMode, setSourceMode] = useState<"url" | "upload" | "capture">("url");
  const [preset, setPreset] = useState("reading_document");
  const [submitting, setSubmitting] = useState(false);
  const [actionSessionId, setActionSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const { health, checking } = useHealth();
  const urlKind = describeUrl(url);

  useEffect(() => {
    void refreshSessions();
    const interval = setInterval(() => { void refreshSessions(); }, 15000);
    return () => clearInterval(interval);
  }, []);

  async function refreshSessions() {
    try {
      setSessions(await api.listSessions(10, 0));
    } catch {
      setSessions([]);
    }
  }

  async function handleUrlSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    if (!isHttpUrl(trimmedUrl)) {
      setError("Enter a full video URL that starts with http:// or https://.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.ingestUrl({ url: trimmedUrl, workflow_template: preset });
      onSessionStarted(result.session_id, preset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start processing");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleFileSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!videoFile) {
      setError("Choose a video file to upload.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.ingestFile({ video: videoFile, workflow_template: preset });
      onSessionStarted(result.session_id, preset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload video");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelSession(sessionId: string) {
    setActionSessionId(sessionId);
    setActionError(null);
    try {
      await api.cancelSession(sessionId);
      await refreshSessions();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not cancel job");
    } finally {
      setActionSessionId(null);
    }
  }

  async function deleteSession(sessionId: string) {
    if (!window.confirm("Delete this job and all its outputs? This cannot be undone.")) return;
    setActionSessionId(sessionId);
    setActionError(null);
    try {
      await api.deleteSession(sessionId);
      await refreshSessions();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not delete job");
    } finally {
      setActionSessionId(null);
    }
  }

  function scrollToWorkspace() {
    document.querySelector("#workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      const target = sourceMode === "upload" ? "#video-file" : "#video-url";
      document.querySelector<HTMLInputElement>(target)?.focus();
    }, 550);
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
          <div className="site-header__account" title={currentUser.email}>
            <span>{currentUser.email}</span>
            <button type="button" onClick={onLogout}>Sign out</button>
          </div>
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
          <h2>Bring a video.<br /><em>Leave with access.</em></h2>
          <p>Paste a public URL, upload a media file, or capture from a page you can already open in your browser.</p>
        </div>

        <div className="ingest-panel">
          <div className="source-tabs" role="tablist" aria-label="Video source">
            <button className={`source-tab ${sourceMode === "url" ? "source-tab--active" : ""}`} type="button" role="tab" aria-selected={sourceMode === "url"} onClick={() => { setSourceMode("url"); setError(null); }}>URL</button>
            <button className={`source-tab ${sourceMode === "upload" ? "source-tab--active" : ""}`} type="button" role="tab" aria-selected={sourceMode === "upload"} onClick={() => { setSourceMode("upload"); setError(null); }}>Upload</button>
            <button className={`source-tab ${sourceMode === "capture" ? "source-tab--active" : ""}`} type="button" role="tab" aria-selected={sourceMode === "capture"} onClick={() => { setSourceMode("capture"); setError(null); }}>Browser</button>
          </div>

          {sourceMode === "url" && (
            <form className="ingest-form" noValidate onSubmit={(e) => void handleUrlSubmit(e)}>
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
              <p id="ingest-hint" className="ingest-form__hint">Best for public YouTube, Vimeo, social, or direct video links.</p>
              {urlKind === "youtube" && (
                <p className="ingest-form__notice">
                  Some YouTube videos require browser access. If this job stops at download, use browser capture from the open video page.
                </p>
              )}
              {error && <p id="ingest-error" className="ingest-form__error" role="alert">{error}</p>}
            </form>
          )}

          {sourceMode === "upload" && (
            <form className="ingest-form" noValidate onSubmit={(e) => void handleFileSubmit(e)}>
              <label htmlFor="video-file" className="ingest-form__label">Video file</label>
              <div className="ingest-form__row ingest-form__row--file">
                <UploadIcon className="ingest-form__icon" aria-hidden="true" />
                <input
                  id="video-file"
                  type="file"
                  className="ingest-form__input ingest-form__input--file"
                  accept="video/mp4,video/webm,video/quicktime,.mp4,.m4v,.mov,.webm,.mkv"
                  onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
                  required
                  aria-describedby={error ? "ingest-error" : "upload-hint"}
                />
                <button className="btn btn--primary ingest-form__submit" type="submit" disabled={submitting || !videoFile}>
                  {submitting ? "Uploading…" : <>Upload video <ArrowRightIcon aria-hidden="true" /></>}
                </button>
              </div>
              <p id="upload-hint" className="ingest-form__hint">{videoFile ? `${videoFile.name} · ${formatFileSize(videoFile.size)}` : "Supports MP4, WebM, MOV, M4V, and MKV files."}</p>
              {error && <p id="ingest-error" className="ingest-form__error" role="alert">{error}</p>}
            </form>
          )}

          {sourceMode === "capture" && (
            <div className="capture-callout">
              <p className="ingest-form__label">Browser capture</p>
              <h3>Use this for private, logged-in, embedded, or social videos.</h3>
              <p>Open the video where you normally watch it, launch the DescribeOps extension, choose this workflow, and send captured chunks to your workspace.</p>
              <a className="btn btn--secondary" href="#how-it-works">See capture flow <ArrowRightIcon aria-hidden="true" /></a>
            </div>
          )}
        </div>
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
                <div className="job-item__row">
                  <button className="job-item__open" type="button" onClick={() => onOpenSession(s.id, s.workflow_template || "reading_document", s.status === "ready" && s.artifact_count > 0 ? "review" : "processing")}>
                    <span className="job-item__index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="job-item__title">{s.title || s.page_title || displayUrl(s.source_url) || "Untitled"}</span>
                    <span className={`job-item__status job-item__status--${s.status}`}>{s.status}</span>
                    <span className="job-item__meta">{s.ready_chunk_count}/{s.chunk_count} chunks · {relativeTime(s.updated_at)}</span>
                    <ArrowRightIcon aria-hidden="true" />
                  </button>
                  <div className="job-item__actions" aria-label={`Actions for ${s.title || s.page_title || "job"}`}>
                    {s.status === "processing" && (
                      <button className="job-action" type="button" onClick={() => void cancelSession(s.id)} disabled={actionSessionId === s.id}>Cancel</button>
                    )}
                    <button className="job-action job-action--danger" type="button" onClick={() => void deleteSession(s.id)} disabled={actionSessionId === s.id}>Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {actionError && <p className="ingest-form__error" role="alert">{actionError}</p>}
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

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function describeUrl(value: string): "youtube" | "generic" | "empty" {
  if (!value.trim()) return "empty";
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "youtu.be" ? "youtube" : "generic";
  } catch {
    return "generic";
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function displayUrl(value: string): string {
  if (!value || value.startsWith("upload://")) return value.replace("upload://", "");
  try {
    const u = new URL(value);
    return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.slice(0, 40) : "");
  } catch {
    return value.slice(0, 50);
  }
}
