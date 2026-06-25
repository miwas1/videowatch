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
  const [urlInput, setUrlInput] = useState("");
  const [capturedRanges, setCapturedRanges] = useState<CapturedRange[]>([]);
  const [autoCapturing, setAutoCapturing] = useState(false);
  const [liveCapturing, setLiveCapturing] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [progressText, setProgressText] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const autoCaptureRef = useRef(false);
  const autoStartedRef = useRef(false);
  const liveCaptureRef = useRef(false);
  const liveStartedAtRef = useRef<number | null>(null);
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
    liveCaptureRef.current = liveCapturing;
  }, [liveCapturing]);

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

  useEffect(() => {
    if (!settings?.autoCapture || autoStartedRef.current || autoCapturing || isBusy(stage) || !api || !snapshot || !focusedMedia) {
      return;
    }
    autoStartedRef.current = true;
    setStatus("Auto mode enabled. Starting capture.");
    void startAutoCapture();
  }, [api, autoCapturing, focusedMedia, settings?.autoCapture, snapshot, stage]);

  // Task 4: Per-agent progress via SSE polling
  useEffect(() => {
    if (stage !== "upload" || !session || !settings) return;
    let cancelled = false;
    let lastEventId = 0;

    async function pollEvents() {
      while (!cancelled) {
        try {
          const url = `${settings!.apiBaseUrl}/api/v1/sessions/${session!.id}/events?after=${lastEventId}`;
          const headers: Record<string, string> = { Accept: "text/event-stream" };
          if (settings!.apiToken) headers["Authorization"] = `Bearer ${settings!.apiToken}`;
          const res = await fetch(url, { headers });
          if (!res.ok) break;
          const text = await res.text();
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
        } catch {
          // Network error, stop polling
          break;
        }
        if (cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    pollEvents();
    return () => { cancelled = true; };
  }, [stage, session, settings]);

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

  async function createLiveSession(nextSnapshot = snapshotRef.current, media = mediaFromSnapshot(nextSnapshot)) {
    if (!api || !nextSnapshot || !media) return null;
    const current = sessionRef.current;
    if (current?.settings?.source_type === "live_capture" && current.settings.live_status === "recording") return current;
    setStage("session");
    setStatus("Starting a live DescribeOps session.");
    const created = await api.createLiveSession(nextSnapshot, media.id);
    sessionRef.current = created;
    setSession(created);
    setDocumentPayload(null);
    setCapturedRanges([]);
    setChunkIndex(0);
    chunkIndexRef.current = 0;
    setStatus("Live session started.");
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
        frameCount
      }) as RuntimeResponse<CapturedFrame[]>;

      if (!frameResponse.ok) {
        fail("Frame capture failed.", frameResponse.message);
        stopTimer();
        return false;
      }

      const transcriptSlice = getTranscriptForRange(start, end);

      setStage("upload");
      setProgressText("Uploading frames to agent society...");
      setStatus(`Uploading ${frameResponse.payload.length} frames. Agents are analyzing.`);
      const uploaded = await api.uploadChunk({
        sessionId: activeSession.id,
        chunkIndex: activeChunkIndex,
        startSeconds: start,
        endSeconds: end,
        transcriptText: transcriptSlice || transcriptFromSnapshot(activeSnapshot),
        captureNotes: captureNotes(activeSnapshot, activeMedia, frameResponse.payload[0]),
        frames: frameResponse.payload
      });

      const newRange: CapturedRange = { start, end, chunkIndex: activeChunkIndex };
      setCapturedRanges((prev) => [...prev, newRange]);
      chunkIndexRef.current = Math.max(chunkIndexRef.current, activeChunkIndex + 1);
      setChunkIndex(chunkIndexRef.current);
      stopTimer();
      setProgressText("");
      setStatus(uploaded.status === "ready" ? "Chunk analyzed. Reading document updated." : `Chunk accepted (${uploaded.status}). Refreshing...`);

      const nextDocument = await api.getDocument(activeSession.id);
      setDocumentPayload(nextDocument);
      setStage("review");
      return true;
    } catch (caught) {
      stopTimer();
      setProgressText("");
      fail("Capture and analysis failed.", String(caught));
      return false;
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

  async function startLiveCapture() {
    if (!api) return;
    setError("");
    setLiveCapturing(true);
    liveCaptureRef.current = true;
    liveStartedAtRef.current = Date.now();
    startTimer();
    try {
      let activeSnapshot = snapshotRef.current;
      if (!activeSnapshot) {
        const response = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" }) as RuntimeResponse<PageAccessibilitySnapshot>;
        if (!response.ok) {
          fail("Could not scan the active tab.", response.message);
          return;
        }
        activeSnapshot = response.payload;
        snapshotRef.current = activeSnapshot;
        setSnapshot(activeSnapshot);
      }

      let media = mediaFromSnapshot(activeSnapshot);
      if (!media) {
        fail("Live capture needs a playable video.", "Start playback on the stream, then scan again.");
        return;
      }
      selectedMediaIdRef.current = media.id;
      setSelectedMediaId(media.id);

      const activeSession = await createLiveSession(activeSnapshot, media);
      if (!activeSession) return;

      const chunkSeconds = settings?.chunkSeconds ?? 30;
      const frameCount = settings?.framesPerChunk ?? 4;
      setStage("upload");
      setStatus("Live capture running. DescribeOps will add chunks until you stop.");

      while (liveCaptureRef.current) {
        const chunkStart = liveElapsedSeconds();
        const activeChunkIndex = chunkIndexRef.current;
        setProgressText(`Sampling live chunk ${activeChunkIndex + 1}...`);

        const frameResponse = await chrome.runtime.sendMessage({
          name: "CAPTURE_LIVE_FRAMES_REQUESTED",
          mediaId: selectedMediaIdRef.current,
          durationSeconds: chunkSeconds,
          frameCount
        }) as RuntimeResponse<CapturedFrame[]>;

        if (!frameResponse.ok) {
          fail("Live frame capture failed.", frameResponse.message);
          return;
        }

        const scanResponse = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" }) as RuntimeResponse<PageAccessibilitySnapshot>;
        if (scanResponse.ok) {
          activeSnapshot = scanResponse.payload;
          snapshotRef.current = activeSnapshot;
          setSnapshot(activeSnapshot);
          media = mediaFromSnapshot(activeSnapshot) ?? media;
        }

        const chunkEnd = Math.max(chunkStart + 1, liveElapsedSeconds());
        setStatus(`Uploading live chunk ${activeChunkIndex + 1}: ${formatClock(chunkStart)} to ${formatClock(chunkEnd)}.`);
        await api.uploadChunkAsync({
          sessionId: activeSession.id,
          chunkIndex: activeChunkIndex,
          startSeconds: chunkStart,
          endSeconds: chunkEnd,
          transcriptText: transcriptFromSnapshot(activeSnapshot),
          captureNotes: `${captureNotes(activeSnapshot, media, frameResponse.payload[0])}\nCapture mode: live stream`,
          frames: frameResponse.payload
        });

        const newRange: CapturedRange = { start: chunkStart, end: chunkEnd, chunkIndex: activeChunkIndex };
        setCapturedRanges((prev) => [...prev, newRange]);
        chunkIndexRef.current = activeChunkIndex + 1;
        setChunkIndex(chunkIndexRef.current);
        setStatus(`Live chunk ${activeChunkIndex + 1} queued. Continuing capture.`);
      }
    } catch (caught) {
      fail("Live capture failed.", String(caught));
    } finally {
      setLiveCapturing(false);
      liveCaptureRef.current = false;
      setProgressText("");
      if (sessionRef.current?.settings?.source_type === "live_capture" && sessionRef.current.settings.live_status === "recording") {
        await finalizeLiveSession();
      }
    }
  }

  async function stopLiveCapture() {
    liveCaptureRef.current = false;
    setLiveCapturing(false);
    setStatus("Stopping live capture after the current sample.");
  }

  async function finalizeLiveSession() {
    stopTimer();
    setProgressText("");
    const liveSession = sessionRef.current;
    if (!api || !liveSession) {
      setStatus("Live capture stopped.");
      return;
    }
    try {
      setStage("upload");
      setStatus("Finalizing live session.");
      const result = await api.finishLiveSession(liveSession.id);
      const nextSession = await api.getSessionStatus(liveSession.id);
      setSession(nextSession);
      sessionRef.current = nextSession;
      if (result.status === "ready") {
        const nextDocument = await api.getDocument(liveSession.id);
        setDocumentPayload(nextDocument);
        setStage("review");
        setStatus(`Live capture ready with ${result.ready_chunks} analyzed chunks.`);
      } else {
        setStatus(`Live capture stopped. ${result.ready_chunks}/${result.total_chunks} chunks are ready.`);
        pollForCompletion(liveSession.id);
      }
    } catch (caught) {
      fail("Could not finalize live capture.", String(caught));
    }
  }

  function liveElapsedSeconds(): number {
    const startedAt = liveStartedAtRef.current ?? Date.now();
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  async function synthesizeSession(sessionId: string | undefined) {
    if (!api || !sessionId) return;
    setStage("upload");
    setProgressText("Synthesizing all ready chunks...");
    try {
      const result = await api.synthesize(sessionId);
      const nextDocument = await api.getDocument(sessionId);
      setDocumentPayload(nextDocument);
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
      setStatus("Reading document refreshed.");
    } catch (caught) {
      fail("Could not refresh the document.", String(caught));
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
            <button type="button" className="button primary" onClick={() => captureAndAnalyze()} disabled={!api || !focusedMedia || isBusy(stage) || autoCapturing}>
              <PlayIcon aria-hidden="true" />
              Capture
            </button>
            {liveCapturing ? (
              <button type="button" className="button danger" onClick={stopLiveCapture}>
                <StopIcon aria-hidden="true" />
                Stop live
              </button>
            ) : (
              <button type="button" className="button accent" onClick={startLiveCapture} disabled={!api || !focusedMedia || (isBusy(stage) && !liveCapturing) || autoCapturing}>
                <TimerIcon aria-hidden="true" />
                Live
              </button>
            )}
            {autoCapturing ? (
              <button type="button" className="button danger" onClick={stopAutoCapture}>
                <StopIcon aria-hidden="true" />
                Stop auto
              </button>
            ) : (
              <button type="button" className="button accent" onClick={startAutoCapture} disabled={!api || !focusedMedia || isBusy(stage) || liveCapturing}>
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
      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={Boolean(settings?.autoCapture)}
          onChange={(event) => settings && onChange({ ...settings, autoCapture: event.currentTarget.checked })}
        />
        <span>Start in auto mode</span>
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
