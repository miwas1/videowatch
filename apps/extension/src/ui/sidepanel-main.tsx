import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DownloadIcon,
  ExclamationTriangleIcon,
  CheckCircledIcon,
  PlayIcon,
  ReaderIcon,
  ReloadIcon
} from "@radix-ui/react-icons";
import { DescribeOpsApi, composeCaptureNotes, composeTranscriptText } from "./backend-api";
import { loadSettings } from "./storage";
import type {
  ArtifactResponse,
  CapturedAudioChunk,
  CapturedFrame,
  CapturedRange,
  DetectedMedia,
  ExtensionSettings,
  HealthResponse,
  PanelStage,
  PageAccessibilitySnapshot,
  ReadingDocumentResponse,
  RuntimeResponse,
  SessionResponse,
  TranscriptResponse
} from "../types";
import "./styles.css";

const INITIAL_EVENT_POLL_MS = 2000;
const MAX_EVENT_POLL_MS = 30000;
const CHUNK_READY_TIMEOUT_MS = 240000;

function SidePanel() {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [snapshot, setSnapshot] = useState<PageAccessibilitySnapshot | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState("");
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [documentPayload, setDocumentPayload] = useState<ReadingDocumentResponse | null>(null);
  const [stage, setStage] = useState<PanelStage>("idle");
  const [status, setStatus] = useState("Scan the active tab to find a video.");
  const [error, setError] = useState("");
  const [chunkIndex, setChunkIndex] = useState(0);
  const [capturedRanges, setCapturedRanges] = useState<CapturedRange[]>([]);
  const [autoCapturing, setAutoCapturing] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [finalArtifact, setFinalArtifact] = useState<ArtifactResponse | null>(null);
  const [progressText, setProgressText] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const autoCaptureRef = useRef(false);
  const chunkIndexRef = useRef(0);
  const selectedMediaIdRef = useRef("");
  const sessionRef = useRef<SessionResponse | null>(null);
  const snapshotRef = useRef<PageAccessibilitySnapshot | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const api = useMemo(() => (settings ? new DescribeOpsApi(settings) : null), [settings]);
  const focusedMedia = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.media.find((item) => item.id === selectedMediaId) ?? snapshot.media.find((item) => item.isFocused) ?? snapshot.media[0] ?? null;
  }, [selectedMediaId, snapshot]);

  useEffect(() => {
    let alive = true;
    loadSettings().then((loaded) => {
      if (!alive) return;
      setSettings(loaded);
      void checkHealth(loaded);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    autoCaptureRef.current = autoCapturing;
  }, [autoCapturing]);

  useEffect(() => {
    chunkIndexRef.current = chunkIndex;
  }, [chunkIndex]);

  useEffect(() => {
    selectedMediaIdRef.current = selectedMediaId;
  }, [selectedMediaId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  // Task 4: Per-agent progress via SSE polling
  useEffect(() => {
    if (stage !== "upload" || !session || !api) return;
    const eventsApi = api;
    const sessionId = session.id;
    let cancelled = false;
    let lastEventId = 0;
    let retryDelayMs = INITIAL_EVENT_POLL_MS;

    async function pollEvents() {
      while (!cancelled) {
        try {
          const text = await eventsApi.getEvents(sessionId, lastEventId);
          const lines = text.split("\n");
          for (const line of lines) {
            if (cancelled) break;
            if (line.startsWith("data:")) {
              const data = line.slice(5).trim();
              try {
                const event = JSON.parse(data) as { id?: number; type?: string; message?: string; payload?: Record<string, unknown> };
                if (event.id && event.id > lastEventId) lastEventId = event.id;
                if (event.type) {
                  const label = sseEventLabel(event.type, event.message, event.payload);
                  setProgressText(label);
                }
              } catch {
                // Not JSON, treat as plain text event
                if (data) setProgressText(data);
              }
            }
          }
          retryDelayMs = INITIAL_EVENT_POLL_MS;
        } catch {
          if (cancelled) break;
          setProgressText(`Connection interrupted. Retrying in ${Math.round(retryDelayMs / 1000)}s...`);
          await wait(retryDelayMs);
          retryDelayMs = Math.min(MAX_EVENT_POLL_MS, retryDelayMs * 2);
          continue;
        }
        if (cancelled) break;
        await wait(INITIAL_EVENT_POLL_MS);
      }
    }

    pollEvents();
    return () => { cancelled = true; };
  }, [api, stage, session]);

  async function checkHealth(nextSettings = settings) {
    if (!nextSettings) return;
    try {
      const result = await new DescribeOpsApi(nextSettings).health();
      setHealth(result);
    } catch {
      setHealth(null);
    }
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
  }

  async function ensureTranscript(url: string): Promise<TranscriptResponse | null> {
    if (!api || transcript?.url === url || settings?.captureDetail === "media") return transcript;
    try {
      const result = await api.fetchTranscript(url);
      setTranscript(result);
      return result;
    } catch {
      return null;
    }
  }

  function mediaFromSnapshot(nextSnapshot: PageAccessibilitySnapshot | null): DetectedMedia | null {
    if (!nextSnapshot) return null;
    return nextSnapshot.media.find((item) => item.id === selectedMediaIdRef.current) ?? nextSnapshot.media.find((item) => item.isFocused) ?? nextSnapshot.media[0] ?? null;
  }

  async function createOrReuseSession(nextSnapshot = snapshotRef.current, media = mediaFromSnapshot(nextSnapshot)) {
    if (!api || !nextSnapshot || !media) return null;
    if (sessionRef.current) return sessionRef.current;
    setStage("session");
    setStatus("Creating a DescribeOps backend session.");
    const created = await api.createSession(nextSnapshot, media.id);
    sessionRef.current = created;
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

  function seekVideo(seconds: number) {
    chrome.runtime.sendMessage({ name: "SEEK_VIDEO_REQUESTED", seconds });
  }

  async function captureAndAnalyze(overrideStart?: number, overrideEnd?: number, overrideChunkIndex?: number) {
    const activeSnapshot = snapshotRef.current;
    const activeMedia = mediaFromSnapshot(activeSnapshot);
    if (!api || !activeSnapshot || !activeMedia) {
      await scanActiveTab();
      return false;
    }
    if (!settings) {
      setStatus("Capture settings are still loading.");
      return false;
    }

    try {
      setError("");
      const activeSession = await createOrReuseSession(activeSnapshot, activeMedia);
      if (!activeSession) return false;

      setStage("capture");
      startTimer();
      const start = overrideStart ?? Math.max(0, Math.floor(activeMedia.currentTime ?? 0));
      const end = overrideEnd ?? (start + (settings?.chunkSeconds ?? 30));
      const activeChunkIndex = overrideChunkIndex ?? chunkIndexRef.current;
      const frameCount = settings?.framesPerChunk ?? 4;
      setStatus(`Watching ${formatClock(start)} - ${formatClock(end)}.`);
      setProgressText(`Extracting audio and ${frameCount} frames for ${formatClock(start)} - ${formatClock(end)}.`);

      const frameResponse = await chrome.runtime.sendMessage({
        name: "CAPTURE_MULTI_FRAMES_REQUESTED",
        mediaId: activeMedia.id,
        startSeconds: start,
        endSeconds: end,
        frameCount,
        captureDetail: settings.captureDetail,
        screenshotFallback: settings.screenshotFallback
      }) as RuntimeResponse<CapturedFrame[]>;

      if (!frameResponse.ok) {
        fail("Frame capture failed.", frameResponse.message);
        stopTimer();
        return false;
      }

      setProgressText(`Recording audio for ${formatClock(start)} - ${formatClock(end)}.`);
      const audioChunks: CapturedAudioChunk[] = [];
      const audioResponse = await chrome.runtime.sendMessage({
        name: "CAPTURE_AUDIO_CHUNK_REQUESTED",
        mediaId: activeMedia.id,
        startSeconds: start,
        endSeconds: end
      }) as RuntimeResponse<CapturedAudioChunk | null>;
      if (audioResponse.ok && audioResponse.payload) {
        audioChunks.push(audioResponse.payload);
      } else if (!audioResponse.ok) {
        setProgressText(`Audio unavailable for this chunk; continuing with frames and captions.`);
      }

      let transcriptSource = transcript;
      if (settings.captureDetail !== "media" && activeMedia.source && !transcriptSource) {
        transcriptSource = await ensureTranscript(activeMedia.source);
      }
      const transcriptSlice = settings.captureDetail !== "media" ? getTranscriptForRange(start, end, transcriptSource) : "";

      setStage("upload");
      setProgressText("Uploading chunk to the backend.");
      setStatus(`Sending ${formatClock(start)} - ${formatClock(end)} for analysis.`);
      try {
        await api.uploadChunkAsync({
          sessionId: activeSession.id,
          chunkIndex: activeChunkIndex,
          startSeconds: start,
          endSeconds: end,
          transcriptText: transcriptSlice || composeTranscriptText(activeSnapshot, settings.captureDetail),
          captureNotes: composeCaptureNotes(activeSnapshot, activeMedia.id, frameResponse.payload[0], settings.captureDetail),
          frames: frameResponse.payload,
          audioChunks
        });
      } finally {
        releaseCapturedFrames(frameResponse.payload);
        releaseCapturedAudio(audioChunks);
      }

      const newRange: CapturedRange = { start, end, chunkIndex: activeChunkIndex };
      setCapturedRanges((prev) => [...prev, newRange]);
      chunkIndexRef.current = Math.max(chunkIndexRef.current, activeChunkIndex + 1);
      setChunkIndex(chunkIndexRef.current);
      setStatus(`Chunk ${activeChunkIndex + 1} queued. Synthesizing chunk notes.`);

      await waitForChunkReady(activeSession.id, activeChunkIndex);
      const nextDocument = await api.getDocument(activeSession.id);
      setDocumentPayload(nextDocument);
      await refreshFinalArtifact(activeSession.id);
      stopTimer();
      setProgressText("");
      setStage("review");
      setStatus(`Chunk ${activeChunkIndex + 1} analyzed.`);
      return true;
    } catch (caught) {
      stopTimer();
      setProgressText("");
      fail("Capture and analysis failed.", String(caught));
      return false;
    }
  }

  function getTranscriptForRange(start: number, end: number, source = transcript): string {
    if (!source?.segments.length) return "";
    const relevant = source.segments.filter(
      (seg) => seg.end >= start && seg.start <= end
    );
    return relevant.map((seg) => `[${formatClock(seg.start)}] ${seg.text}`).join("\n");
  }

  async function waitForChunkReady(sessionId: string, activeChunkIndex: number) {
    if (!api) return;
    const deadline = Date.now() + CHUNK_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const chunks = await api.getChunks(sessionId);
      const current = chunks.find((chunk) => chunk.chunk_index === activeChunkIndex);
      if (current?.status === "ready") {
        setProgressText(`Chunk ${activeChunkIndex + 1} ready. Refreshing document...`);
        return;
      }
      if (current?.status === "failed") {
        throw new Error(current.error_message || `Chunk ${activeChunkIndex + 1} failed during analysis.`);
      }
      const status = current?.status || "queued";
      setProgressText(`Analyzing chunk ${activeChunkIndex + 1} (${status})...`);
      await wait(2000);
    }
    throw new Error("Chunk analysis timed out. Confirm the backend worker is running.");
  }

  async function refreshFinalArtifact(sessionId: string) {
    if (!api) return null;
    const artifacts = await api.getArtifacts(sessionId);
    const nextArtifact = selectPrimaryArtifact(artifacts);
    setFinalArtifact(nextArtifact);
    return nextArtifact;
  }

  async function startAutoCapture() {
    if (!api) return;
    setAutoCapturing(true);
    autoCaptureRef.current = true;
    try {
      const response = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" }) as RuntimeResponse<PageAccessibilitySnapshot>;
      if (!response.ok) {
        fail("Could not scan the active tab.", response.message);
        return;
      }

      snapshotRef.current = response.payload;
      setSnapshot(response.payload);
      const media = mediaFromSnapshot(response.payload);
      if (!media || !media.duration) {
        fail("Capture needs a video duration.", "The active media did not expose a usable duration.");
        return;
      }
      selectedMediaIdRef.current = media.id;
      setSelectedMediaId(media.id);

      const activeSession = await createOrReuseSession(response.payload, media);
      if (!activeSession) return;
      const cachedArtifact = await refreshFinalArtifact(activeSession.id);
      if (activeSession.status === "ready" && cachedArtifact) {
        setDocumentPayload(await api.getDocument(activeSession.id));
        setStage("review");
        setStatus("Stored analysis found. Final synthesis applied.");
        setProgressText("");
        return;
      }

      const chunkSeconds = settings?.chunkSeconds ?? 30;
      const capturedEnd = capturedRanges.length ? Math.max(...capturedRanges.map((range) => range.end)) : 0;
      let nextChunkIndex = chunkIndexRef.current;
      let completedAllChunks = true;

      for (let start = capturedEnd; start < media.duration && autoCaptureRef.current; start += chunkSeconds) {
        const end = Math.min(start + chunkSeconds, media.duration);
        setStatus(`Watching ${formatClock(start)} - ${formatClock(end)}.`);
        const ok = await captureAndAnalyze(start, end, nextChunkIndex);
        if (!ok || !autoCaptureRef.current) {
          completedAllChunks = false;
          break;
        }
        nextChunkIndex += 1;
      }

      if (autoCaptureRef.current && completedAllChunks) {
        setStatus("All chunks captured. Synthesizing final document.");
        await synthesizeSession(sessionRef.current?.id);
        setStatus("Final synthesis applied.");
      }
    } finally {
      if (autoCaptureRef.current) {
        autoCaptureRef.current = false;
        setAutoCapturing(false);
      } else {
        setAutoCapturing(false);
      }
    }
  }

  async function synthesizeSession(sessionId: string | undefined) {
    if (!api || !sessionId) return;
    setStage("upload");
    setProgressText("Synthesizing all ready chunks...");
    try {
      const result = await api.synthesize(sessionId);
      const nextDocument = await api.getDocument(sessionId);
      setDocumentPayload(nextDocument);
      if (result.artifact) {
        setFinalArtifact(result.artifact);
      } else {
        await refreshFinalArtifact(sessionId);
      }
      setStage("review");
      setProgressText("");
      setStatus("Final synthesis applied.");
    } catch (caught) {
      fail("Synthesis failed.", String(caught));
    }
  }

  async function exportDocument() {
    if (!api || !session) return;
    try {
      const markdown = finalArtifact?.markdown || await api.exportMarkdown(session.id);
      const blob = new Blob([markdown], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${finalArtifact?.title || session.title || "reading-document"}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus("Document exported as Markdown.");
    } catch (caught) {
      fail("Export failed.", String(caught));
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
        <HealthPill health={health} />
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

      <section className="control-grid compact" aria-label="Capture controls">
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
            <button type="button" className="button primary" onClick={startAutoCapture} disabled={!api || !focusedMedia || isBusy(stage) || autoCapturing}>
              <PlayIcon aria-hidden="true" />
              Capture
            </button>
            <button type="button" className="button primary" onClick={exportDocument} disabled={!session || isBusy(stage)}>
              <DownloadIcon aria-hidden="true" />
              Export
            </button>
          </div>
        </div>
      </section>

      {isBusy(stage) ? <SkeletonReview /> : null}

      <ActivityPanel
        stage={stage}
        status={status}
        error={error}
        progressText={progressText}
        elapsedSeconds={elapsedSeconds}
        capturedRanges={capturedRanges}
        documentPayload={documentPayload}
        finalArtifact={finalArtifact}
      />

      <FinalArtifactReview artifact={finalArtifact} />

      <TranscriptSection transcript={transcript} onSeek={seekVideo} />
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
        <p>Scan the current page to find playable video, captions, transcript hints, and selectable page context.</p>
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
        <Metric label="Length" value={focusedMedia.duration ? formatClock(focusedMedia.duration) : "Unknown"} />
        <Metric label="Captions" value={focusedMedia.hasCaptions || snapshot.liveCaptionText.length ? "Seen" : "None"} />
      </div>
    </section>
  );
}

function ActivityPanel({
  stage,
  status,
  error,
  progressText,
  elapsedSeconds,
  capturedRanges,
  documentPayload,
  finalArtifact
}: {
  stage: PanelStage;
  status: string;
  error: string;
  progressText: string;
  elapsedSeconds: number;
  capturedRanges: CapturedRange[];
  documentPayload: ReadingDocumentResponse | null;
  finalArtifact: ArtifactResponse | null;
}) {
  const lines = buildActivityLines({
    stage,
    status,
    error,
    progressText,
    elapsedSeconds,
    capturedRanges,
    documentPayload,
    finalArtifact
  });

  return (
    <section className="activity-console" aria-labelledby="activity-console-title" aria-live="polite">
      <div className="section-heading">
        <div>
          <p className="label">Status</p>
          <h2 id="activity-console-title">Capture console</h2>
        </div>
        <span className="badge">{stage === "error" ? "attention" : isBusy(stage) ? "running" : "ready"}</span>
      </div>
      <ol>
        {lines.map((line, index) => (
          <li key={`${line}-${index}`}>
            <span>{">"}</span>
            <code>{line}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FinalArtifactReview({ artifact }: { artifact: ArtifactResponse | null }) {
  if (!artifact) return null;
  const sections = artifact.payload.sections ?? [];
  return (
    <section className="final-artifact" aria-labelledby="final-artifact-title">
      <div className="section-heading">
        <div>
          <p className="label">Final document</p>
          <h2 id="final-artifact-title">{artifact.title || "Synthesized document"}</h2>
        </div>
        <span className="badge">{artifact.workflow_template.replace(/_/g, " ")}</span>
      </div>
      {artifact.summary ? <p className="artifact-summary">{artifact.summary}</p> : null}
      {sections.length > 0 ? (
        <div className="artifact-section-list">
          {sections.map((section, index) => (
            <article className="artifact-section" key={`${section.heading}-${index}`}>
              <header>
                <h3>{section.heading || `Section ${index + 1}`}</h3>
                <span>{formatClock(section.start_seconds)}-{formatClock(section.end_seconds)}</span>
              </header>
              <p>{section.body}</p>
            </article>
          ))}
        </div>
      ) : (
        <pre className="artifact-markdown">{artifact.markdown}</pre>
      )}
    </section>
  );
}

function TranscriptSection({
  transcript,
  onSeek
}: {
  transcript: TranscriptResponse | null;
  onSeek: (seconds: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);

  if (!transcript || !transcript.segments.length) return null;

  return (
    <section className="transcript-section" aria-label="Video transcript">
      <button
        type="button"
        className="section-heading"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
      >
        <h2>Transcript ({transcript.segments.length} segments)</h2>
        <span>{collapsed ? "Show" : "Hide"}</span>
      </button>
      {!collapsed && (
        <div className="transcript-list">
          {transcript.segments.map((seg, index) => (
            <div key={index} className="transcript-entry">
              <button
                type="button"
                className="transcript-time"
                onClick={() => onSeek(seg.start)}
                aria-label={`Seek to ${formatClock(seg.start)}`}
              >
                {formatClock(seg.start)}
              </button>
              <span>{seg.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function sseEventLabel(type: string, message?: string, payload?: Record<string, unknown>): string {
  if (message) return message;
  const chunkIndex = typeof payload?.chunk_index === "number" ? Number(payload.chunk_index) + 1 : null;
  const workflow = typeof payload?.workflow_template === "string" ? payload.workflow_template.replace(/_/g, " ") : "";
  const labels: Record<string, string> = {
    "chunk.accepted": "Chunk accepted by agents...",
    "chunk.analyzing": "Agents are analyzing...",
    "chunk.ready": "Chunk analysis complete!",
    "document.updated": "Document updated!",
    "document.synthesizing": "Synthesizing document...",
    "agent.visual": "Visual agent processing...",
    "agent.text": "Text agent processing...",
    "agent.final": "Final agent processing..."
  };
  if (type === "job.queued") return "Queued backend analysis job.";
  if (type === "job.started") return "Backend analysis job started.";
  if (type === "job.succeeded") return "Backend analysis job finished.";
  if (type === "chunk.accepted" && chunkIndex) return `Chunk ${chunkIndex} accepted.`;
  if (type === "audio.extracting" && chunkIndex) return `Extracting audio for chunk ${chunkIndex}.`;
  if (type === "audio.transcribing" && chunkIndex) return `Transcribing audio for chunk ${chunkIndex}.`;
  if (type === "audio.transcribed" && chunkIndex) return `Audio transcript ready for chunk ${chunkIndex}.`;
  if (type === "audio.skipped" && chunkIndex) return `Audio transcription skipped for chunk ${chunkIndex}.`;
  if (type === "audio.failed" && chunkIndex) return `Audio transcription failed for chunk ${chunkIndex}; continuing.`;
  if (type === "chunk.analyzing" && chunkIndex) return `Analyzing chunk ${chunkIndex}.`;
  if (type === "document.updated" && chunkIndex) return `Reading document updated from chunk ${chunkIndex}.`;
  if (type === "session.synthesizing") return workflow ? `Synthesizing ${workflow}.` : "Synthesizing final document.";
  if (type === "session.synthesized") return workflow ? `${workflow} synthesis complete.` : "Final synthesis complete.";
  if (type === "artifact.ready") return workflow ? `${workflow} artifact ready.` : "Artifact ready.";
  if (type === "session.ready") return "Session ready.";
  return labels[type] || `Processing: ${type}...`;
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

function buildActivityLines({
  stage,
  status,
  error,
  progressText,
  elapsedSeconds,
  capturedRanges,
  documentPayload,
  finalArtifact
}: {
  stage: PanelStage;
  status: string;
  error: string;
  progressText: string;
  elapsedSeconds: number;
  capturedRanges: CapturedRange[];
  documentPayload: ReadingDocumentResponse | null;
  finalArtifact: ArtifactResponse | null;
}): string[] {
  const lines: string[] = [];
  if (stage === "idle") {
    lines.push("ready");
  } else if (stage === "scan") {
    lines.push("scanning active tab");
  } else if (stage === "session") {
    lines.push("opening backend session");
  } else if (stage === "capture") {
    lines.push("extracting audio");
  } else if (stage === "upload") {
    lines.push("synthesizing");
  } else if (stage === "review") {
    lines.push("reviewing generated output");
  } else if (stage === "error") {
    lines.push("attention required");
  }

  if (status) lines.push(status.toLowerCase());
  if (progressText) lines.push(progressText.toLowerCase());
  if (isBusy(stage)) lines.push(`elapsed ${formatClock(elapsedSeconds)}`);

  for (const range of capturedRanges.slice(-5)) {
    lines.push(`watched ${formatClock(range.start)} - ${formatClock(range.end)}; chunk ${range.chunkIndex + 1} sent`);
  }

  if (documentPayload) {
    lines.push(`reading document updated; ${documentPayload.blocks.length} blocks available`);
  }
  if (finalArtifact) {
    lines.push("final synthesis applied and displayed");
  }
  if (error) {
    lines.push(error.toLowerCase());
  }

  return [...new Set(lines)].slice(-9);
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

function selectPrimaryArtifact(artifacts: ArtifactResponse[]): ArtifactResponse | null {
  return artifacts.find((artifact) => artifact.workflow_template === "reading_document") ?? artifacts[0] ?? null;
}

function releaseCapturedFrames(frames: CapturedFrame[]): void {
  for (const frame of frames) {
    frame.dataUrl = "";
  }
}

function releaseCapturedAudio(chunks: CapturedAudioChunk[]): void {
  for (const chunk of chunks) {
    chunk.dataUrl = "";
  }
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>
);
