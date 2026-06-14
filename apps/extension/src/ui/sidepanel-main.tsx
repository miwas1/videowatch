import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  BackendJobRecord,
  ChunkTimelineItem,
  DetectedMedia,
  JobProgress,
  PageAccessibilitySnapshot,
  PlaybackPackage,
  ReviewCue
} from "@describeops/shared";
import {
  type AccessibilityOptions,
  type DescriptionLevel,
  buildFallbackReviewCues,
  normalizeOptions
} from "./cues";
import { buildVideoAnalysisRequest } from "./backend-contract";
import "./styles.css";

type BackendArtifactsResponse = {
  jobId: string;
  artifacts: BackendArtifact[];
};

type BackendArtifact = {
  kind: string;
  id?: string;
  cues?: ReviewCue[];
  speechGaps?: PlaybackPackage["speechGaps"];
  videoSummary?: string;
  summary?: string;
  chunks?: ChunkTimelineItem[];
};

type StartResult = {
  ok?: boolean;
  status?: string;
  message?: string;
  cueCount?: number;
  text?: string;
};

const API_BASE_URL = "http://127.0.0.1:8000";
const API_TOKEN = "local-dev-token";

// The agent decides everything; the user never tunes these.
const DETAIL_LEVEL: DescriptionLevel = "balanced";
const AGENT_OPTIONS: AccessibilityOptions = normalizeOptions();

function SidePanel() {
  const [snapshot, setSnapshot] = useState<PageAccessibilitySnapshot | null>(null);
  const [cues, setCues] = useState<ReviewCue[]>([]);
  const [status, setStatus] = useState("Looking for a video on this tab...");
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [chunkCount, setChunkCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const startedRef = useRef(false);

  const focusedMedia = useMemo(() => {
    const media = snapshot?.media ?? [];
    return media.find((item) => item.isFocused && item.kind !== "audio") ?? media.find((item) => item.kind !== "audio") ?? media[0];
  }, [snapshot]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void autoStart();
  }, []);

  async function autoStart() {
    const detected = await scanPage();
    const hasVideo = detected?.media.some((item) => item.kind !== "audio");
    if (detected && hasVideo) {
      await startAccessibilityMode(detected);
    }
  }

  async function scanPage(): Promise<PageAccessibilitySnapshot | null> {
    setBusy(true);
    setStatus("Looking for the video in focus...");
    setProgress(null);
    try {
      const response = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" });
      if (!response?.payload) {
        const diagnostics = response?.diagnostics ? ` ${response.diagnostics}` : "";
        throw new Error(`${response?.message ?? "No page snapshot returned."}${diagnostics}`);
      }
      const nextSnapshot = response.payload as PageAccessibilitySnapshot;
      setSnapshot(nextSnapshot);
      const primary = nextSnapshot.media.find((item) => item.kind !== "audio");
      setStatus(
        primary
          ? `${describePlatform(primary)} detected: ${primary.label}.`
          : "No video found on this tab yet. Play a video, then reopen this panel."
      );
      return nextSnapshot;
    } catch (error) {
      setSnapshot(null);
      setStatus(`Could not read this tab. ${String(error)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function startAccessibilityMode(fromSnapshot?: PageAccessibilitySnapshot) {
    const workingSnapshot = fromSnapshot ?? snapshot;
    const media = (workingSnapshot?.media ?? []).find((item) => item.isFocused && item.kind !== "audio")
      ?? (workingSnapshot?.media ?? []).find((item) => item.kind !== "audio")
      ?? workingSnapshot?.media[0];
    if (!workingSnapshot || !media) {
      setStatus("No video to describe yet. Play a video and reopen the panel.");
      return;
    }

    setBusy(true);
    setStatus("Watching the video and writing descriptions...");
    setProgress({
      stage: "created",
      message: "Preparing direct analysis.",
      percent: 3,
      currentChunk: 0,
      totalChunks: 0,
      partialCueCount: 0
    });
    try {
      let generatedCues: ReviewCue[] = [];
      try {
        generatedCues = await createBackendPlayback(workingSnapshot, media);
      } catch {
        generatedCues = buildFallbackReviewCues(workingSnapshot, media, DETAIL_LEVEL, AGENT_OPTIONS);
      }
      setCues(generatedCues);

      const result = await chrome.runtime.sendMessage({
        name: "ACCESSIBILITY_MODE_START_REQUESTED",
        payload: {
          mediaId: media.id,
          cues: generatedCues,
          detailLevel: DETAIL_LEVEL,
          options: AGENT_OPTIONS,
          ducking: { enabled: true, level: 0 }
        }
      }) as StartResult;

      if (!result?.ok) {
        throw new Error(result?.message ?? "Could not attach to the video on this tab.");
      }

      setActive(true);
      setStatus(`Describing ${media.label}.`);
    } catch (error) {
      setActive(false);
      setStatus(`Could not start. ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function createBackendPlayback(pageSnapshot: PageAccessibilitySnapshot, media: DetectedMedia) {
    const created = await apiFetch<BackendJobRecord>("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        source: "browser",
        mode: "low_bandwidth",
        snapshot: pageSnapshot,
        analysisRequest: buildVideoAnalysisRequest(pageSnapshot, media, DETAIL_LEVEL, AGENT_OPTIONS)
      })
    });
    setProgress(created.progress ?? null);

    const analyzed = await apiFetch<BackendJobRecord>(`/v1/jobs/${encodeURIComponent(created.id)}/analyze`, { method: "POST" });
    if (analyzed.progress) {
      setProgress(analyzed.progress);
      setStatus(analyzed.progress.message);
    }

    const artifacts = await apiFetch<BackendArtifactsResponse>(`/v1/jobs/${encodeURIComponent(created.id)}/artifacts`, {
      method: "GET"
    });
    const playback = artifacts.artifacts.find((artifact) => artifact.kind === "playback-package");
    const review = artifacts.artifacts.find((artifact) => artifact.kind === "review-cues");
    const timeline = artifacts.artifacts.find((artifact) => artifact.kind === "chunk-timeline");
    setChunkCount(timeline?.chunks?.length ?? 0);
    const backendCues = playback?.cues ?? review?.cues ?? [];
    if (!backendCues.length) {
      throw new Error("Backend returned no playback cues.");
    }
    return backendCues.map((cue) => ({ ...cue, status: "accepted" as const }));
  }

  async function apiFetch<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers
      }
    });
    if (!response.ok) {
      throw new Error(`Backend request failed with ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }

  async function askNow() {
    const result = await chrome.runtime.sendMessage({ name: "ACCESSIBILITY_DESCRIBE_NOW_REQUESTED" }) as StartResult;
    setStatus(result?.ok ? result.text ?? "Describing the current moment." : result?.message ?? "Start describing first.");
  }

  async function stopDescribing() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    await chrome.runtime.sendMessage({ name: "ACCESSIBILITY_MODE_STOP_REQUESTED" });
    setActive(false);
    setStatus("Stopped. Press Describe this video to start again.");
  }

  async function primaryAction() {
    if (active) {
      await stopDescribing();
      return;
    }
    const detected = snapshot ?? (await scanPage());
    if (detected) {
      await startAccessibilityMode(detected);
    }
  }

  return (
    <main className="panel" aria-labelledby="panel-title">
      <header className="panel-header">
        <h1 id="panel-title" className="title">Describe this video</h1>
        <p className="muted">
          {focusedMedia ? describePlatform(focusedMedia) : "Accessible video assistant"}
        </p>
      </header>

      <p className="status" role="status" aria-live="assertive">{status}</p>

      <ProgressRail progress={progress} cueCount={cues.length} chunkCount={chunkCount} />

      <div className="primary-actions">
        <button type="button" className="primary-big" onClick={primaryAction} disabled={busy} aria-pressed={active}>
          {busy ? "Working..." : active ? "Stop describing" : "Describe this video"}
        </button>
        <button type="button" className="secondary" onClick={askNow} disabled={!active}>
          What is on screen now?
        </button>
      </div>

      <p className="hint">
        Shortcuts: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> describe now &middot;{" "}
        <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> pause descriptions. The video pauses automatically while a
        description is spoken, so the audio never overlaps.
      </p>

      <SpokenLog cues={cues} />
    </main>
  );
}

function ProgressRail({ progress, cueCount, chunkCount }: { progress: JobProgress | null; cueCount: number; chunkCount: number }) {
  const activeStage = progress?.stage ?? "created";
  const percent = progress?.percent ?? 0;
  const stages: Array<{ id: JobProgress["stage"]; label: string }> = [
    { id: "resolving_media", label: "Media" },
    { id: "sampling_frames", label: "Frames" },
    { id: "analyzing_chunk", label: "Analysis" },
    { id: "building_playback", label: "Playback" },
    { id: "complete", label: "Ready" }
  ];
  const activeIndex = stages.findIndex((stage) => stage.id === activeStage);
  const doneIndex = activeStage === "complete" ? stages.length - 1 : activeIndex - 1;

  return (
    <section className="analysis-progress" aria-label="Analysis progress">
      <div className="progress-meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="progress-steps">
        {stages.map((stage, index) => (
          <li
            key={stage.id}
            data-state={activeStage === "failed" ? "failed" : index <= doneIndex ? "done" : index === activeIndex ? "active" : "waiting"}
          >
            <span />
            {stage.label}
          </li>
        ))}
      </ol>
      <div className="progress-meta" aria-live="polite">
        <strong>{progress?.partialCueCount ?? cueCount}</strong>
        <span>cues</span>
        <strong>{progress?.totalChunks || chunkCount}</strong>
        <span>segments</span>
      </div>
    </section>
  );
}

function SpokenLog({ cues }: { cues: ReviewCue[] }) {
  if (!cues.length) {
    return <p className="muted">Descriptions of the video will appear here as it plays.</p>;
  }

  return (
    <section aria-labelledby="log-title">
      <h2 id="log-title" className="section-title">Spoken descriptions</h2>
      <ol className="timeline">
        {cues.map((cue) => (
          <li key={cue.id}>
            <time>{formatClock(cue.start)}</time>
            <p>{cue.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function describePlatform(media: DetectedMedia): string {
  switch (media.platform) {
    case "youtube":
      return "YouTube video";
    case "tiktok":
      return "TikTok video";
    case "instagram":
      return "Instagram video";
    case "twitter":
      return "X (Twitter) video";
    case "facebook":
      return "Facebook video";
    case "vimeo":
      return "Vimeo video";
    case "twitch":
      return "Twitch stream";
    case "generic":
      return media.kind === "embedded-player" ? "Embedded video player" : "Video";
    default: {
      const exhaustive: never = media.platform;
      return exhaustive;
    }
  }
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
