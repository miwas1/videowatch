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
import { DescribeOpsApi, composeCaptureNotes, composeTranscriptText } from "./backend-api";
import { blocksToCues, readableKind } from "./cues";
import { loadSettings, saveSettings } from "./storage";
import type {
  ArtifactResponse,
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

const INITIAL_EVENT_POLL_MS = 2000;
const MAX_EVENT_POLL_MS = 30000;
const CHUNK_READY_TIMEOUT_MS = 240000;

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
  const [urlInput, setUrlInput] = useState("");
  const [capturedRanges, setCapturedRanges] = useState<CapturedRange[]>([]);
  const [autoCapturing, setAutoCapturing] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [captureConfirmed, setCaptureConfirmed] = useState(false);
  const [finalArtifact, setFinalArtifact] = useState<ArtifactResponse | null>(null);
  const [progressText, setProgressText] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const autoCaptureRef = useRef(false);
  const autoStartedRef = useRef(false);
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

  useEffect(() => {
    chunkIndexRef.current = chunkIndex;
  }, [chunkIndex]);

  useEffect(() => {
    selectedMediaIdRef.current = selectedMediaId;
    setCaptureConfirmed(false);
  }, [selectedMediaId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (!settings?.autoCapture || !captureConfirmed || autoStartedRef.current || autoCapturing || isBusy(stage) || !api || !snapshot || !focusedMedia) {
      return;
    }
    autoStartedRef.current = true;
    setStatus("Auto mode enabled. Starting capture.");
    void startAutoCapture();
  }, [api, autoCapturing, captureConfirmed, focusedMedia, settings?.autoCapture, snapshot, stage]);

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
                const event = JSON.parse(data) as { id?: number; type?: string; message?: string };
                if (event.id && event.id > lastEventId) lastEventId = event.id;
                if (event.type) {
                  const label = sseEventLabel(event.type, event.message);
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

  async function persistSettings() {
    if (!draftSettings) return;
    const saved = await saveSettings(draftSettings);
    setSettings(saved);
    setDraftSettings(saved);
    setCaptureConfirmed(false);
    await checkHealth(saved);
    setStatus("Capture settings saved.");
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
    if (!settings || !captureConfirmed) {
      setStatus("Review capture details before uploading.");
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
      setStatus(`Capturing ${frameCount} frames from ${formatClock(start)} to ${formatClock(end)}.`);
      setProgressText("Seeking video and capturing frames...");

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

      let transcriptSource = transcript;
      if (settings.captureDetail !== "media" && activeMedia.source && !transcriptSource) {
        transcriptSource = await ensureTranscript(activeMedia.source);
      }
      const transcriptSlice = settings.captureDetail !== "media" ? getTranscriptForRange(start, end, transcriptSource) : "";

      setStage("upload");
      setProgressText("Uploading frames for background analysis...");
      setStatus(`Uploading ${frameResponse.payload.length} frames. Analysis will continue in the background.`);
      try {
        await api.uploadChunkAsync({
          sessionId: activeSession.id,
          chunkIndex: activeChunkIndex,
          startSeconds: start,
          endSeconds: end,
          transcriptText: transcriptSlice || composeTranscriptText(activeSnapshot, settings.captureDetail),
          captureNotes: composeCaptureNotes(activeSnapshot, activeMedia.id, frameResponse.payload[0], settings.captureDetail),
          frames: frameResponse.payload
        });
      } finally {
        releaseCapturedFrames(frameResponse.payload);
      }

      const newRange: CapturedRange = { start, end, chunkIndex: activeChunkIndex };
      setCapturedRanges((prev) => [...prev, newRange]);
      chunkIndexRef.current = Math.max(chunkIndexRef.current, activeChunkIndex + 1);
      setChunkIndex(chunkIndexRef.current);
      setStatus(`Chunk ${activeChunkIndex + 1} queued. Waiting for analysis.`);

      await waitForChunkReady(activeSession.id, activeChunkIndex);
      const nextDocument = await api.getDocument(activeSession.id);
      setDocumentPayload(nextDocument);
      await refreshFinalArtifact(activeSession.id);
      stopTimer();
      setProgressText("");
      setStage("review");
      setStatus("Chunk analyzed. Reading document updated.");
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
    if (!captureConfirmed) {
      setStatus("Review capture details before starting auto-capture.");
      return;
    }
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
        fail("Auto-capture needs a video duration.", "The active media did not expose a usable duration.");
        return;
      }
      selectedMediaIdRef.current = media.id;
      setSelectedMediaId(media.id);

      const chunkSeconds = settings?.chunkSeconds ?? 30;
      const capturedEnd = capturedRanges.length ? Math.max(...capturedRanges.map((range) => range.end)) : 0;
      let nextChunkIndex = chunkIndexRef.current;

      for (let start = capturedEnd; start < media.duration && autoCaptureRef.current; start += chunkSeconds) {
        const end = Math.min(start + chunkSeconds, media.duration);
        setStatus(`Auto mode processing chunk ${nextChunkIndex + 1}: ${formatClock(start)} to ${formatClock(end)}.`);
        const ok = await captureAndAnalyze(start, end, nextChunkIndex);
        if (!ok || !autoCaptureRef.current) break;
        nextChunkIndex += 1;
      }

      if (autoCaptureRef.current) {
        setStatus("All chunks captured. Synthesizing final document.");
        await synthesizeSession(sessionRef.current?.id);
        setStatus("Auto-capture complete. Full document synthesized.");
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
      if (result.summary) {
        setStatus(`Synthesis complete: ${result.summary.slice(0, 100)}...`);
      } else {
        setStatus("Synthesis finished.");
      }
    } catch (caught) {
      fail("Synthesis failed.", String(caught));
    }
  }

  async function synthesizeDocument() {
    await synthesizeSession(sessionRef.current?.id ?? session?.id);
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
      await refreshFinalArtifact(session.id);
      setStatus("Reading document refreshed.");
    } catch (caught) {
      fail("Could not refresh the document.", String(caught));
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

  async function processVideoUrl(url: string) {
    if (!api) return;
    setError("");
    setStage("upload");
    startTimer();
    setStatus("Downloading video and starting full analysis...");
    setProgressText("Backend is downloading and processing the video...");
    try {
      const result = await api.processUrl(url);
      const newSession = await api.getSessionStatus(result.session_id);
      setSession(newSession);
      setStatus(`Processing started for "${newSession.title}". Polling for updates...`);
      pollForCompletion(result.session_id);
    } catch (caught) {
      stopTimer();
      setProgressText("");
      fail("URL processing failed.", String(caught));
    }
  }

  async function pollForCompletion(sessionId: string) {
    if (!api) return;
    const poll = async () => {
      try {
        const status = await api.getSessionStatus(sessionId);
        setSession(status);
        if (status.status === "ready") {
          stopTimer();
          setProgressText("");
          const doc = await api!.getDocument(sessionId);
          setDocumentPayload(doc);
          await refreshFinalArtifact(sessionId);
          setStage("review");
          setStatus(`Document ready: ${doc.blocks.length} blocks from "${status.title}".`);
          return;
        }
        if (status.status === "failed") {
          stopTimer();
          setProgressText("");
          fail("Video processing failed.", status.error_message);
          return;
        }
        setTimeout(poll, 5000);
      } catch {
        setTimeout(poll, 8000);
      }
    };
    setTimeout(poll, 5000);
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
            aria-label={showConnectionSettings ? "Hide capture settings" : "Show capture settings"}
            aria-pressed={showConnectionSettings}
            title={showConnectionSettings ? "Hide capture settings" : "Capture settings"}
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

          {settings && (
            <CaptureConsentPanel
              settings={settings}
              focusedMedia={focusedMedia}
              confirmed={captureConfirmed}
              onConfirm={() => {
                setCaptureConfirmed(true);
                setStatus("Capture approved for the current settings.");
              }}
            />
          )}

          {capturedRanges.length > 0 && (
            <CoverageBar
              ranges={capturedRanges}
              duration={focusedMedia?.duration}
              gaps={gapWarnings}
              onCaptureRange={(start, end) => {
                seekVideo(start);
                captureAndAnalyze(start, end);
              }}
            />
          )}

          <div className="action-row">
            <button type="button" className="button subtle" onClick={scanActiveTab} disabled={isBusy(stage) || autoCapturing}>
              <ReloadIcon aria-hidden="true" />
              Scan
            </button>
            <button type="button" className="button primary" onClick={() => captureAndAnalyze()} disabled={!api || !focusedMedia || !captureConfirmed || isBusy(stage) || autoCapturing}>
              <PlayIcon aria-hidden="true" />
              Capture
            </button>
            {autoCapturing ? (
              <button type="button" className="button danger" onClick={stopAutoCapture}>
                <StopIcon aria-hidden="true" />
                Stop auto
              </button>
            ) : (
              <button type="button" className="button accent" onClick={startAutoCapture} disabled={!api || !focusedMedia || !captureConfirmed || isBusy(stage)}>
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

      {!session && (
        <section className="url-ingest-panel" aria-label="Process video by URL">
          <div className="section-heading">
            <h2>Or process by URL</h2>
          </div>
          <div className="url-input-row">
            <input
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.currentTarget.value)}
              disabled={isBusy(stage)}
            />
            <button
              type="button"
              className="button primary"
              onClick={() => processVideoUrl(urlInput)}
              disabled={!api || !urlInput.trim() || isBusy(stage)}
            >
              <PlayIcon aria-hidden="true" />
              Process
            </button>
          </div>
          <p className="url-hint">Downloads the video, extracts frames, fetches transcript, and runs the full AI pipeline automatically.</p>
        </section>
      )}

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

      <FinalArtifactReview artifact={finalArtifact} />

      <DocumentReview
        documentPayload={documentPayload}
        editingBlockId={editingBlockId}
        onEdit={setEditingBlockId}
        onSave={saveBlock}
        onSeek={seekVideo}
      />

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

function CaptureConsentPanel({
  settings,
  focusedMedia,
  confirmed,
  onConfirm
}: {
  settings: ExtensionSettings;
  focusedMedia: DetectedMedia | null;
  confirmed: boolean;
  onConfirm: () => void;
}) {
  const captionsIncluded = settings.captureDetail !== "media";
  const pageContextIncluded = settings.captureDetail === "context";
  return (
    <section className={confirmed ? "consent-panel consent-panel--confirmed" : "consent-panel"} aria-label="Capture data review">
      <div className="section-heading">
        <div>
          <p className="label">Before upload</p>
          <h2>{confirmed ? "Capture approved" : "Review capture details"}</h2>
        </div>
        {confirmed ? <CheckCircledIcon aria-hidden="true" /> : <ExclamationTriangleIcon aria-hidden="true" />}
      </div>
      <dl className="consent-grid">
        <div><dt>Frames</dt><dd>{settings.framesPerChunk} per chunk</dd></div>
        <div><dt>Captions</dt><dd>{captionsIncluded ? "Included" : "Off"}</dd></div>
        <div><dt>Page text</dt><dd>{pageContextIncluded ? "Included" : "Off"}</dd></div>
        <div><dt>Fallback</dt><dd>{settings.screenshotFallback === "cropped" ? "Cropped video area" : "Off"}</dd></div>
        <div><dt>Destination</dt><dd title={settings.apiBaseUrl}>{settings.apiBaseUrl.replace(/^https?:\/\//, "")}</dd></div>
        <div><dt>Media</dt><dd>{focusedMedia ? focusedMedia.label : "None selected"}</dd></div>
      </dl>
      <button type="button" className={confirmed ? "button subtle" : "button primary"} onClick={onConfirm} disabled={!focusedMedia}>
        <CheckCircledIcon aria-hidden="true" />
        {confirmed ? "Approved" : "Allow capture"}
      </button>
    </section>
  );
}

function CoverageBar({
  ranges,
  duration,
  gaps,
  onCaptureRange
}: {
  ranges: CapturedRange[];
  duration: number | undefined;
  gaps: { start: number; end: number }[];
  onCaptureRange?: (start: number, end: number) => void;
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
          <button
            key={`gap-${index}`}
            type="button"
            className="coverage-gap"
            style={{
              left: `${(gap.start / totalDuration) * 100}%`,
              width: `${((gap.end - gap.start) / totalDuration) * 100}%`
            }}
            title={`Gap: ${formatClock(gap.start)} to ${formatClock(gap.end)} — click to capture`}
            aria-label={`Capture gap from ${formatClock(gap.start)} to ${formatClock(gap.end)}`}
            onClick={() => onCaptureRange?.(gap.start, gap.end)}
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
    <section className="connection-panel" aria-label="Capture settings">
      <div className="section-heading">
        <h2>Capture</h2>
        <GearIcon aria-hidden="true" />
      </div>
      <label className="field">
        <span>Capture detail</span>
        <select
          value={settings?.captureDetail ?? "media"}
          onChange={(event) => settings && onChange({ ...settings, captureDetail: event.currentTarget.value as ExtensionSettings["captureDetail"] })}
        >
          <option value="media">Media only</option>
          <option value="captions">Media + captions</option>
          <option value="context">Media + page context</option>
        </select>
      </label>
      <label className="field">
        <span>Screenshot fallback</span>
        <select
          value={settings?.screenshotFallback ?? "cropped"}
          onChange={(event) => settings && onChange({ ...settings, screenshotFallback: event.currentTarget.value as ExtensionSettings["screenshotFallback"] })}
        >
          <option value="cropped">Cropped video area</option>
          <option value="off">Off</option>
        </select>
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
      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={Boolean(settings?.autoCapture)}
          onChange={(event) => settings && onChange({ ...settings, autoCapture: event.currentTarget.checked })}
        />
        <span>Auto-capture after approval</span>
      </label>
      <button type="button" className="button subtle" onClick={onSave} disabled={disabled}>
        <CheckCircledIcon aria-hidden="true" />
        Save
      </button>
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

function DocumentReview({
  documentPayload,
  editingBlockId,
  onEdit,
  onSave,
  onSeek
}: {
  documentPayload: ReadingDocumentResponse | null;
  editingBlockId: string | null;
  onEdit: (id: string | null) => void;
  onSave: (block: ReadingBlock, body: string) => void;
  onSeek: (seconds: number) => void;
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
            onSeek={onSeek}
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
  onSave,
  onSeek
}: {
  block: ReadingBlock;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: string) => void;
  onSeek: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState(block.body);

  useEffect(() => {
    setDraft(block.body);
  }, [block.body]);

  return (
    <article className="review-block">
      <header>
        <div>
          <p className="label">
            {readableKind(block.kind)} at{" "}
            <button
              type="button"
              className="block-timestamp"
              onClick={() => onSeek(block.start_seconds)}
              aria-label={`Seek to ${formatClock(block.start_seconds)}`}
            >
              {formatClock(block.start_seconds)}
            </button>
          </p>
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
          <RenderedBody body={block.body} isCode={block.kind === "code"} />
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

function RenderedBody({ body, isCode }: { body: string; isCode: boolean }) {
  if (isCode) {
    return <pre className="block-body code-block"><code>{body}</code></pre>;
  }

  const rendered = renderMarkdown(body);
  return <div className="block-body" dangerouslySetInnerHTML={{ __html: rendered }} />;
}

function renderMarkdown(text: string): string {
  // Handle fenced code blocks (```...```)
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.slice(3, -3).replace(/^\w*\n/, "");
    return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
  });

  // Split into lines for line-level processing
  const lines = result.split("\n");
  const output: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if it's already a pre block (from fenced code above)
    if (trimmed.startsWith("<pre")) {
      if (inList) { output.push("</ul>"); inList = false; }
      output.push(line);
      continue;
    }
    if (trimmed.startsWith("</pre>") || trimmed.startsWith("<code>") || trimmed.startsWith("</code>")) {
      output.push(line);
      continue;
    }

    // Bullet list items
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) { output.push("<ul>"); inList = true; }
      const content = inlineFormat(trimmed.replace(/^[-*]\s+/, ""));
      output.push(`<li>${content}</li>`);
      continue;
    }

    // End list if not a list item
    if (inList) { output.push("</ul>"); inList = false; }

    if (trimmed === "") {
      output.push("<br>");
    } else {
      output.push(inlineFormat(trimmed));
    }
  }

  if (inList) output.push("</ul>");
  return output.join("\n");
}

function inlineFormat(text: string): string {
  // Bold: **text**
  let result = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function sseEventLabel(type: string, message?: string): string {
  if (message) return message;
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
  return labels[type] || `Processing: ${type}...`;
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

function selectPrimaryArtifact(artifacts: ArtifactResponse[]): ArtifactResponse | null {
  return artifacts.find((artifact) => artifact.workflow_template === "reading_document") ?? artifacts[0] ?? null;
}

function releaseCapturedFrames(frames: CapturedFrame[]): void {
  for (const frame of frames) {
    frame.dataUrl = "";
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
