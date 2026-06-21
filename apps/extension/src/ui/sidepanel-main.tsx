import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CheckCircledIcon,
  DownloadIcon,
  ExclamationTriangleIcon,
  GearIcon,
  OpenInNewWindowIcon,
  Pencil1Icon,
  PlayIcon,
  ReaderIcon,
  ReloadIcon,
  SpeakerLoudIcon,
  StopIcon,
  TimerIcon
} from "@radix-ui/react-icons";
import { DescribeOpsApi } from "./backend-api";
import { blocksToCues, readableKind } from "./cues";
import { loadSettings, saveSettings } from "./storage";
import type {
  CapturedFrame,
  CapturedRange,
  DetectedMedia,
  ExtensionSettings,
  HealthResponse,
  PanelStage,
  PageAccessibilitySnapshot,
  ReadingBlock,
  ReadingDocumentResponse,
  RuntimeResponse,
  SessionResponse,
  TranscriptResponse
} from "../types";
import "./styles.css";

function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [draftSettings, setDraftSettings] = useState<ExtensionSettings | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [snapshot, setSnapshot] = useState<PageAccessibilitySnapshot | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState("");
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [documentPayload, setDocumentPayload] = useState<ReadingDocumentResponse | null>(null);
  const [stage, setStage] = useState<PanelStage>("idle");
  const [status, setStatus] = useState("Scan the active tab to find a video.");
  const [error, setError] = useState("");
  const [chunkIndex, setChunkIndex] = useState(0);
  const [attached, setAttached] = useState(false);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [capturedRanges, setCapturedRanges] = useState<CapturedRange[]>([]);
  const [autoCapturing, setAutoCapturing] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [progressText, setProgressText] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const autoCaptureRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = useMemo(() => (settings ? new DescribeOpsApi(settings) : null), [settings]);
  const focusedMedia = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.media.find((item) => item.id === selectedMediaId) ?? snapshot.media.find((item) => item.isFocused) ?? snapshot.media[0] ?? null;
  }, [selectedMediaId, snapshot]);
  const cues = useMemo(() => blocksToCues(documentPayload?.blocks ?? [], documentPayload?.timeline ?? []), [documentPayload]);

  useEffect(() => {
    let alive = true;
    loadSettings().then((loaded) => {
      if (!alive) return;
      setSettings(loaded);
      setDraftSettings(loaded);
      void checkHealth(loaded);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    autoCaptureRef.current = autoCapturing;
  }, [autoCapturing]);

  async function checkHealth(nextSettings = settings) {
    if (!nextSettings) return;
    try {
      const result = await new DescribeOpsApi(nextSettings).health();
      setHealth(result);
    } catch {
      setHealth(null);
    }
  }

  async function persistSettings() {
    if (!draftSettings) return;
    const saved = await saveSettings(draftSettings);
    setSettings(saved);
    setDraftSettings(saved);
    await checkHealth(saved);
    setStatus("Connection settings saved.");
  }

  async function scanActiveTab() {
    setStage("scan");
    setError("");
    setStatus("Reading the active tab and ranking playable media.");
    const response = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" }) as RuntimeResponse<PageAccessibilitySnapshot>;
    if (!response.ok) {
      fail("Could not scan the active tab.", response.message);
      return;
    }
    const nextSnapshot = response.payload;
    setSnapshot(nextSnapshot);
    const media = nextSnapshot.media.find((item) => item.isFocused && item.kind !== "audio") ?? nextSnapshot.media[0];
    setSelectedMediaId(media?.id ?? "");
    setStage(media ? "idle" : "error");
    setStatus(media ? `${describePlatform(media)} detected: ${media.label}.` : "No playable video was found on this tab.");
    setError(media ? "" : "Start playback on the target page, then scan again.");

    if (media?.source && api) {
      fetchTranscriptQuietly(media.source);
    }
  }

  async function fetchTranscriptQuietly(url: string) {
    if (!api) return;
    try {
      const result = await api.fetchTranscript(url);
      setTranscript(result);
    } catch {
      // Transcript is best-effort
    }
  }

  async function createOrReuseSession() {
    if (!api || !snapshot || !focusedMedia) return null;
    if (session) return session;
    setStage("session");
    setStatus("Creating a DescribeOps backend session.");
    const created = await api.createSession(snapshot, focusedMedia.id);
    setSession(created);
    setStatus("Session created. Ready to capture.");
    return created;
  }

  function startTimer() {
    setElapsedSeconds(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
  }

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function captureAndAnalyze() {
    if (!api || !snapshot || !focusedMedia) {
      await scanActiveTab();
      return;
    }

    try {
      setError("");
      const activeSession = await createOrReuseSession();
      if (!activeSession) return;

      setStage("capture");
      startTimer();
      const start = Math.max(0, Math.floor(focusedMedia.currentTime ?? 0));
      const end = start + (settings?.chunkSeconds ?? 30);
      const frameCount = settings?.framesPerChunk ?? 4;
      setStatus(`Capturing ${frameCount} frames from ${formatClock(start)} to ${formatClock(end)}.`);
      setProgressText("Seeking video and capturing frames...");

      const frameResponse = await chrome.runtime.sendMessage({
        name: "CAPTURE_MULTI_FRAMES_REQUESTED",
        mediaId: focusedMedia.id,
        startSeconds: start,
        endSeconds: end,
        frameCount
      }) as RuntimeResponse<CapturedFrame[]>;

      if (!frameResponse.ok) {
        fail("Frame capture failed.", frameResponse.message);
        stopTimer();
        return;
      }

      const transcriptSlice = getTranscriptForRange(start, end);

      setStage("upload");
      setProgressText("Uploading frames to agent society...");
      setStatus(`Uploading ${frameResponse.payload.length} frames. Agents are analyzing.`);
      const uploaded = await api.uploadChunk({
        sessionId: activeSession.id,
        chunkIndex,
        startSeconds: start,
        endSeconds: end,
        transcriptText: transcriptSlice || transcriptFromSnapshot(snapshot),
        captureNotes: captureNotes(snapshot, focusedMedia, frameResponse.payload[0]),
        frames: frameResponse.payload
      });

      const newRange: CapturedRange = { start, end, chunkIndex };
      setCapturedRanges((prev) => [...prev, newRange]);
      setChunkIndex((value) => value + 1);
      stopTimer();
      setProgressText("");
      setStatus(uploaded.status === "ready" ? "Chunk analyzed. Reading document updated." : `Chunk accepted (${uploaded.status}). Refreshing...`);

      const nextDocument = await api.getDocument(activeSession.id);
      setDocumentPayload(nextDocument);
      setStage("review");
    } catch (caught) {
      stopTimer();
      setProgressText("");
      fail("Capture and analysis failed.", String(caught));
    }
  }

  function getTranscriptForRange(start: number, end: number): string {
    if (!transcript?.segments.length) return "";
    const relevant = transcript.segments.filter(
      (seg) => seg.end >= start && seg.start <= end
    );
    return relevant.map((seg) => `[${formatClock(seg.start)}] ${seg.text}`).join("\n");
  }

  async function startAutoCapture() {
    setAutoCapturing(true);
    autoCaptureRef.current = true;
    while (autoCaptureRef.current) {
      await captureAndAnalyze();
      if (!autoCaptureRef.current) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      // Re-scan to get updated currentTime
      const response = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" }) as RuntimeResponse<PageAccessibilitySnapshot>;
      if (!response.ok || !autoCaptureRef.current) break;
      setSnapshot(response.payload);
      const media = response.payload.media.find((item) => item.id === selectedMediaId) ?? response.payload.media[0];
      if (!media || media.currentTime === undefined) break;
      // Stop if video has ended
      if (media.duration && media.currentTime >= media.duration - 2) {
        setStatus("Video ended. Auto-capture complete.");
        break;
      }
    }
    setAutoCapturing(false);
    autoCaptureRef.current = false;
  }

  function stopAutoCapture() {
    autoCaptureRef.current = false;
    setAutoCapturing(false);
    setStatus("Auto-capture stopped.");
  }

  async function refreshDocument() {
    if (!api || !session) return;
    setStage("review");
    setStatus("Refreshing the reading document.");
    try {
      setDocumentPayload(await api.getDocument(session.id));
      setStatus("Reading document refreshed.");
    } catch (caught) {
      fail("Could not refresh the document.", String(caught));
    }
  }

  async function synthesizeDocument() {
    if (!api || !session) return;
    setStatus("Synthesizing full document from all chunks...");
    try {
      const result = await api.synthesize(session.id);
      if (result.summary) {
        setStatus(`Synthesis complete: ${result.summary.slice(0, 100)}...`);
      } else {
        setStatus("Synthesis finished.");
      }
      setDocumentPayload(await api.getDocument(session.id));
    } catch (caught) {
      fail("Synthesis failed.", String(caught));
    }
  }

  async function exportDocument() {
    if (!api || !session) return;
    try {
      const markdown = await api.exportMarkdown(session.id);
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${session.title || "reading-document"}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("Document exported as Markdown.");
    } catch (caught) {
      fail("Export failed.", String(caught));
    }
  }

  function openInTab() {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
  }

  async function attachPlayback() {
    if (!focusedMedia || cues.length === 0) return;
    const response = await chrome.runtime.sendMessage({
      name: "DESCRIPTIONS_ATTACH_REQUESTED",
      mediaId: focusedMedia.id,
      cues
    }) as RuntimeResponse<{ cueCount: number }>;
    if (!response.ok) {
      fail("Could not attach descriptions.", response.message);
      return;
    }
    setAttached(true);
    setStatus(`${response.payload.cueCount} spoken descriptions attached to the active video.`);
  }

  async function stopPlayback() {
    await chrome.runtime.sendMessage({ name: "DESCRIPTIONS_STOP_REQUESTED" });
    setAttached(false);
    setStatus("Spoken descriptions stopped.");
  }

  async function describeNow() {
    const response = await chrome.runtime.sendMessage({ name: "DESCRIBE_NOW_REQUESTED" }) as RuntimeResponse<{ text: string }>;
    setStatus(response.ok ? response.payload.text : response.message);
  }

  async function saveBlock(block: ReadingBlock, body: string) {
    if (!api) return;
    try {
      const response = await api.correctBlock(block.id, body, "Reviewer edit from browser extension side panel.");
      setDocumentPayload((current) => current ? {
        ...current,
        blocks: current.blocks.map((item) => item.id === block.id ? response.block : item)
      } : current);
      setEditingBlockId(null);
      setStatus("Reviewer correction saved.");
    } catch (caught) {
      fail("Could not save the correction.", String(caught));
    }
  }

  function fail(title: string, detail: string) {
    setStage("error");
    setStatus(title);
    setError(detail);
    stopTimer();
    setProgressText("");
  }

  const gapWarnings = useMemo(() => {
    if (capturedRanges.length < 2) return [];
    const sorted = [...capturedRanges].sort((a, b) => a.start - b.start);
    const gaps: { start: number; end: number }[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].end;
      const currStart = sorted[i].start;
      if (currStart - prevEnd > 5) {
        gaps.push({ start: prevEnd, end: currStart });
      }
    }
    return gaps;
  }, [capturedRanges]);

  return (
    <main className="panel-shell" aria-labelledby="panel-title">
      <header className="topbar">
        <div>
          <p className="eyebrow">DescribeOps</p>
          <h1 id="panel-title">Video reading layer</h1>
        </div>
        <div className="topbar-actions">
          <HealthPill health={health} />
          <button
            type="button"
            className="icon-button"
            onClick={openInTab}
            aria-label="Open in full tab"
            title="Open in full tab"
          >
            <OpenInNewWindowIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setShowConnectionSettings((value) => !value)}
            aria-label={showConnectionSettings ? "Hide connection settings" : "Show connection settings"}
            aria-pressed={showConnectionSettings}
            title={showConnectionSettings ? "Hide connection settings" : "Connection settings"}
          >
            <GearIcon aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="stage-rail" aria-label="Workflow progress">
        {(["scan", "session", "capture", "upload", "review"] as const).map((item) => (
          <span key={item} data-state={stageState(stage, item)}>{stageLabel(item)}</span>
        ))}
      </section>

      <p className={error ? "callout error" : "callout"} role="status" aria-live="polite">
        {error ? `${status} ${error}` : status}
      </p>

      {progressText && (
        <div className="progress-bar" aria-live="polite">
          <span className="progress-text">{progressText}</span>
          <span className="progress-elapsed">{formatClock(elapsedSeconds)}</span>
        </div>
      )}

      <section className={showConnectionSettings ? "control-grid" : "control-grid compact"} aria-label="Capture controls">
        <div className="primary-zone">
          <MediaSummary snapshot={snapshot} focusedMedia={focusedMedia} selectedMediaId={selectedMediaId} onSelect={setSelectedMediaId} />

          {capturedRanges.length > 0 && (
            <CoverageBar
              ranges={capturedRanges}
              duration={focusedMedia?.duration}
              gaps={gapWarnings}
            />
          )}

          <div className="action-row">
            <button type="button" className="button subtle" onClick={scanActiveTab} disabled={isBusy(stage) || autoCapturing}>
              <ReloadIcon aria-hidden="true" />
              Scan
            </button>
            <button type="button" className="button primary" onClick={captureAndAnalyze} disabled={!api || !focusedMedia || isBusy(stage) || autoCapturing}>
              <PlayIcon aria-hidden="true" />
              Capture
            </button>
            {autoCapturing ? (
              <button type="button" className="button danger" onClick={stopAutoCapture}>
                <StopIcon aria-hidden="true" />
                Stop auto
              </button>
            ) : (
              <button type="button" className="button accent" onClick={startAutoCapture} disabled={!api || !focusedMedia || isBusy(stage)}>
                <TimerIcon aria-hidden="true" />
                Auto
              </button>
            )}
          </div>
        </div>

        {showConnectionSettings ? (
          <ConnectionPanel
            settings={draftSettings}
            onChange={setDraftSettings}
            onSave={persistSettings}
            disabled={!draftSettings}
          />
        ) : null}
      </section>

      {isBusy(stage) ? <SkeletonReview /> : null}

      <section className="review-toolbar" aria-label="Playback and export controls">
        <div>
          <p className="label">Generated cues</p>
          <strong>{cues.length}</strong>
        </div>
        <button type="button" className="button primary" onClick={attached ? stopPlayback : attachPlayback} disabled={!cues.length || !focusedMedia}>
          {attached ? <StopIcon aria-hidden="true" /> : <SpeakerLoudIcon aria-hidden="true" />}
          {attached ? "Stop" : "Attach"}
        </button>
        <button type="button" className="button subtle" onClick={describeNow} disabled={!attached}>
          <ReaderIcon aria-hidden="true" />
          Now
        </button>
        <button type="button" className="button subtle" onClick={refreshDocument} disabled={!session || isBusy(stage)}>
          <ReloadIcon aria-hidden="true" />
          Refresh
        </button>
      </section>

      {documentPayload && (
        <section className="export-toolbar" aria-label="Document actions">
          <button type="button" className="button subtle" onClick={synthesizeDocument} disabled={!session || isBusy(stage)}>
            <ReaderIcon aria-hidden="true" />
            Synthesize
          </button>
          <button type="button" className="button primary" onClick={exportDocument} disabled={!session}>
            <DownloadIcon aria-hidden="true" />
            Export .md
          </button>
        </section>
      )}

      <DocumentReview
        documentPayload={documentPayload}
        editingBlockId={editingBlockId}
        onEdit={setEditingBlockId}
        onSave={saveBlock}
      />
    </main>
  );
}

function HealthPill({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return <span className="health bad"><ExclamationTriangleIcon aria-hidden="true" /> Offline</span>;
  }
  return (
    <span className={health.qwen_configured ? "health good" : "health warn"}>
      {health.qwen_configured ? <CheckCircledIcon aria-hidden="true" /> : <ExclamationTriangleIcon aria-hidden="true" />}
      {health.qwen_configured ? health.visual_model : "No Qwen key"}
    </span>
  );
}

function CoverageBar({
  ranges,
  duration,
  gaps
}: {
  ranges: CapturedRange[];
  duration: number | undefined;
  gaps: { start: number; end: number }[];
}) {
  const totalDuration = duration || Math.max(...ranges.map((r) => r.end), 60);
  return (
    <div className="coverage-bar" aria-label="Coverage timeline">
      <div className="coverage-track">
        {ranges.map((range, index) => (
          <div
            key={index}
            className="coverage-fill"
            style={{
              left: `${(range.start / totalDuration) * 100}%`,
              width: `${((range.end - range.start) / totalDuration) * 100}%`
            }}
          />
        ))}
        {gaps.map((gap, index) => (
          <div
            key={`gap-${index}`}
            className="coverage-gap"
            style={{
              left: `${(gap.start / totalDuration) * 100}%`,
              width: `${((gap.end - gap.start) / totalDuration) * 100}%`
            }}
            title={`Gap: ${formatClock(gap.start)} to ${formatClock(gap.end)}`}
          />
        ))}
      </div>
      <div className="coverage-meta">
        <span>{ranges.length} chunks captured</span>
        {gaps.length > 0 && <span className="gap-warn">{gaps.length} gap{gaps.length > 1 ? "s" : ""}</span>}
      </div>
    </div>
  );
}

function MediaSummary({
  snapshot,
  focusedMedia,
  selectedMediaId,
  onSelect
}: {
  snapshot: PageAccessibilitySnapshot | null;
  focusedMedia: DetectedMedia | null;
  selectedMediaId: string;
  onSelect: (id: string) => void;
}) {
  if (!snapshot) {
    return (
      <section className="empty-state" aria-label="No scan yet">
        <ReaderIcon aria-hidden="true" />
        <h2>No tab scanned</h2>
        <p>Scan the current page to find playable video, captions, transcript hints, and visible text.</p>
      </section>
    );
  }

  if (!focusedMedia) {
    return (
      <section className="empty-state" aria-label="No video found">
        <ExclamationTriangleIcon aria-hidden="true" />
        <h2>No video found</h2>
        <p>Start playback or open a page with a video, then scan again.</p>
      </section>
    );
  }

  return (
    <section className="media-panel" aria-label="Detected media">
      <div className="media-heading">
        <div>
          <p className="label">{describePlatform(focusedMedia)}</p>
          <h2>{focusedMedia.label}</h2>
        </div>
        <span className={focusedMedia.isPlaying ? "dot live" : "dot"} aria-label={focusedMedia.isPlaying ? "Playing" : "Paused"} />
      </div>

      {snapshot.media.length > 1 && (
        <label className="field compact">
          <span>Detected media</span>
          <select value={selectedMediaId} onChange={(event) => onSelect(event.currentTarget.value)}>
            {snapshot.media.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
      )}

      <div className="metric-grid">
        <Metric label="Time" value={formatClock(focusedMedia.currentTime ?? 0)} />
        <Metric label="Length" value={focusedMedia.duration ? formatClock(focusedMedia.duration) : "Unknown"} />
        <Metric label="Captions" value={focusedMedia.hasCaptions || snapshot.liveCaptionText.length ? "Seen" : "None"} />
      </div>
    </section>
  );
}

function ConnectionPanel({
  settings,
  onChange,
  onSave,
  disabled
}: {
  settings: ExtensionSettings | null;
  onChange: (settings: ExtensionSettings) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  return (
    <section className="connection-panel" aria-label="Backend connection">
      <div className="section-heading">
        <h2>Connection</h2>
        <GearIcon aria-hidden="true" />
      </div>
      <label className="field">
        <span>Backend URL</span>
        <input
          type="url"
          value={settings?.apiBaseUrl ?? ""}
          onChange={(event) => settings && onChange({ ...settings, apiBaseUrl: event.currentTarget.value })}
        />
      </label>
      <label className="field">
        <span>API token</span>
        <input
          type="password"
          value={settings?.apiToken ?? ""}
          onChange={(event) => settings && onChange({ ...settings, apiToken: event.currentTarget.value })}
          placeholder="Optional in debug mode"
        />
      </label>
      <label className="field">
        <span>Chunk seconds</span>
        <input
          type="number"
          min={8}
          max={120}
          value={settings?.chunkSeconds ?? 30}
          onChange={(event) => settings && onChange({ ...settings, chunkSeconds: Number(event.currentTarget.value) })}
        />
      </label>
      <label className="field">
        <span>Frames per chunk</span>
        <input
          type="number"
          min={1}
          max={8}
          value={settings?.framesPerChunk ?? 4}
          onChange={(event) => settings && onChange({ ...settings, framesPerChunk: Number(event.currentTarget.value) })}
        />
      </label>
      <button type="button" className="button subtle" onClick={onSave} disabled={disabled}>
        <CheckCircledIcon aria-hidden="true" />
        Save
      </button>
    </section>
  );
}

function DocumentReview({
  documentPayload,
  editingBlockId,
  onEdit,
  onSave
}: {
  documentPayload: ReadingDocumentResponse | null;
  editingBlockId: string | null;
  onEdit: (id: string | null) => void;
  onSave: (block: ReadingBlock, body: string) => void;
}) {
  if (!documentPayload) {
    return (
      <section className="empty-state document-empty" aria-label="No document generated">
        <ReaderIcon aria-hidden="true" />
        <h2>No reading document yet</h2>
        <p>Capture a chunk to generate context-preserving blocks, timeline moments, and spoken cues.</p>
      </section>
    );
  }

  return (
    <section className="document-review" aria-labelledby="document-title">
      <div className="section-heading">
        <h2 id="document-title">Reading document</h2>
        <span className="badge">{documentPayload.session.status}</span>
      </div>
      <Timeline moments={documentPayload.timeline} />
      <div className="block-list">
        {documentPayload.blocks.map((block) => (
          <ReviewBlock
            key={block.id}
            block={block}
            editing={editingBlockId === block.id}
            onEdit={() => onEdit(block.id)}
            onCancel={() => onEdit(null)}
            onSave={(body) => onSave(block, body)}
          />
        ))}
      </div>
    </section>
  );
}

function ReviewBlock({
  block,
  editing,
  onEdit,
  onCancel,
  onSave
}: {
  block: ReadingBlock;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [draft, setDraft] = useState(block.body);

  useEffect(() => {
    setDraft(block.body);
  }, [block.body]);

  return (
    <article className="review-block">
      <header>
        <div>
          <p className="label">{readableKind(block.kind)} at {formatClock(block.start_seconds)}</p>
          <h3>{block.heading || "Untitled block"}</h3>
        </div>
        <span className="confidence">{Math.round(block.confidence * 100)}%</span>
      </header>
      {editing ? (
        <div className="edit-box">
          <label className="field">
            <span>Block text</span>
            <textarea value={draft} onChange={(event) => setDraft(event.currentTarget.value)} rows={7} />
          </label>
          <div className="action-row">
            <button type="button" className="button primary" onClick={() => onSave(draft)}>
              <CheckCircledIcon aria-hidden="true" />
              Save
            </button>
            <button type="button" className="button subtle" onClick={onCancel}>
              <StopIcon aria-hidden="true" />
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className={block.kind === "code" ? "block-body code-block" : "block-body"}>{block.body}</p>
          <div className="block-footer">
            {block.is_user_edited ? <span className="edited">Reviewer edited</span> : <span>Source evidence {block.source_evidence.length}</span>}
            <button type="button" className="icon-button" onClick={onEdit} aria-label={`Edit ${block.heading || "reading block"}`}>
              <Pencil1Icon aria-hidden="true" />
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function Timeline({ moments }: { moments: ReadingDocumentResponse["timeline"] }) {
  if (!moments.length) return null;
  return (
    <ol className="timeline">
      {moments.slice(0, 10).map((moment) => (
        <li key={moment.id}>
          <time>{formatClock(moment.timestamp_seconds)}</time>
          <span>{moment.label}</span>
        </li>
      ))}
    </ol>
  );
}

function SkeletonReview() {
  return (
    <section className="skeleton-stack" aria-label="Loading document">
      <span />
      <span />
      <span />
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function stageState(current: PanelStage, item: PanelStage): "done" | "active" | "waiting" | "failed" {
  const order: PanelStage[] = ["scan", "session", "capture", "upload", "review"];
  if (current === "error") return "failed";
  const currentIndex = order.indexOf(current);
  const itemIndex = order.indexOf(item);
  if (current === item) return "active";
  if (currentIndex > itemIndex || current === "review") return "done";
  return "waiting";
}

function stageLabel(stage: PanelStage): string {
  const labels: Record<PanelStage, string> = {
    idle: "Idle",
    scan: "Scan",
    session: "Session",
    capture: "Capture",
    upload: "Upload",
    review: "Review",
    error: "Error"
  };
  return labels[stage];
}

function isBusy(stage: PanelStage): boolean {
  return stage === "scan" || stage === "session" || stage === "capture" || stage === "upload";
}

function transcriptFromSnapshot(snapshot: PageAccessibilitySnapshot): string {
  return [
    ...snapshot.liveCaptionText.map((item) => `Live caption: ${item}`),
    ...snapshot.transcriptText.map((item) => `Transcript: ${item}`),
    ...snapshot.visibleText.slice(0, 12).map((item) => `Visible text: ${item}`)
  ].join("\n");
}

function captureNotes(snapshot: PageAccessibilitySnapshot, media: DetectedMedia, frame: CapturedFrame): string {
  return [
    `Platform: ${snapshot.platform}`,
    `Page title: ${snapshot.title}`,
    `Media: ${media.label}`,
    `Media kind: ${media.kind}`,
    `Frame: ${frame.note}`,
    `Headings: ${snapshot.headings.slice(0, 6).join(" | ") || "none"}`,
    `Captions detected: ${snapshot.captions.join(" | ") || "none"}`
  ].join("\n");
}

function describePlatform(media: DetectedMedia): string {
  const labels: Record<DetectedMedia["platform"], string> = {
    youtube: "YouTube video",
    tiktok: "TikTok video",
    instagram: "Instagram video",
    twitter: "X video",
    facebook: "Facebook video",
    vimeo: "Vimeo video",
    twitch: "Twitch stream",
    generic: media.kind === "embedded-player" ? "Embedded player" : "Video"
  };
  return labels[media.platform];
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>
);
