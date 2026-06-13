import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Tabs from "@radix-ui/react-tabs";
import type {
  ExportArtifact,
  MemoryPreference,
  OfflineQueueItem,
  PageAccessibilitySnapshot,
  PlaybackPackage,
  ReviewCue,
  DetectedMedia
} from "@describeops/shared";
import "./styles.css";

type NativeHealth = {
  ok?: boolean;
  status?: string;
  version?: string;
  supportedTools?: string[];
  storagePath?: string;
  ffmpeg?: { available: boolean; remediation?: string };
  message?: string;
};

type NativeActionResult = {
  ok?: boolean;
  status?: string;
  message?: string;
  diagnostics?: string;
  jobId?: string;
  storagePath?: string;
  artifactPath?: string;
  uploaded?: boolean;
};

type GenerationJob = {
  jobId: string;
  backendJobId?: string;
  traceId?: string;
  media: DetectedMedia;
  status: string;
  backendStatus?: string;
  storagePath?: string;
  artifactPath?: string;
  createdAt: string;
  mode: "standard" | "low_bandwidth";
};

type BackendJobRecord = {
  id: string;
  status: "queued" | "running" | "needs_review" | "complete" | "failed";
  traceId: string;
};

type BackendAnalyzeResponse = {
  id: string;
  status: "queued" | "running" | "needs_review" | "complete" | "failed";
  traceId: string;
};

type BackendArtifactsResponse = {
  jobId: string;
  artifacts: BackendArtifact[];
};

type BackendArtifact = {
  kind: string;
  id?: string;
  jobId?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt?: string;
  offlineAvailable?: boolean;
  cues?: ReviewCue[];
  speechGaps?: PlaybackPackage["speechGaps"];
  audioTrackUrl?: string;
  ducking?: PlaybackPackage["ducking"];
  report?: unknown;
  content?: string;
};

const API_BASE_URL = "http://127.0.0.1:8000";
const API_TOKEN = "local-dev-token";

const now = "2026-06-13T12:00:00.000Z";

const initialMemories: MemoryPreference[] = [
  {
    id: "mem-style-1",
    scope: "user",
    subjectId: "demo-user",
    kind: "voice_style",
    value: "Use direct present-tense descriptions before mood language.",
    confidence: 0.91,
    sourceJobId: "job-demo-a",
    reviewerId: "reviewer-demo",
    createdAt: now
  },
  {
    id: "mem-org-1",
    scope: "org",
    subjectId: "demo-org",
    kind: "org_standard",
    value: "Name on-screen form labels before describing their position.",
    confidence: 0.88,
    sourceJobId: "job-demo-b",
    reviewerId: "reviewer-demo",
    createdAt: now
  }
];

function SidePanel() {
  const [snapshot, setSnapshot] = useState<PageAccessibilitySnapshot | null>(null);
  const [health, setHealth] = useState<NativeHealth | null>(null);
  const [reviewCues, setReviewCues] = useState<ReviewCue[]>([]);
  const [memories, setMemories] = useState<MemoryPreference[]>(initialMemories);
  const [selectedCueId, setSelectedCueId] = useState("");
  const [playbackPackageState, setPlaybackPackageState] = useState<PlaybackPackage | null>(null);
  const [exportArtifactsState, setExportArtifactsState] = useState<ExportArtifact[]>([]);
  const [offlineQueueState, setOfflineQueueState] = useState<OfflineQueueItem[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState("");
  const [generationJob, setGenerationJob] = useState<GenerationJob | null>(null);
  const [generationBusy, setGenerationBusy] = useState(false);
  const [generationMode, setGenerationMode] = useState<"standard" | "low_bandwidth">("low_bandwidth");
  const [liveMessage, setLiveMessage] = useState("Ready.");

  const summary = useMemo(() => ({
    media: snapshot?.media.length ?? 0,
    headings: snapshot?.headings.length ?? 0,
    text: snapshot?.visibleText.length ?? 0,
    issues: snapshot?.inaccessibleRegions.length ?? 0
  }), [snapshot]);

  async function scanPage() {
    try {
      setLiveMessage("Scanning page.");
      const response = await chrome.runtime.sendMessage({ name: "PAGE_SCAN_REQUESTED" });
      if (!response?.payload) {
        const message = response?.message ?? "DescribeOps did not receive a page snapshot.";
        setSnapshot(null);
        setLiveMessage(message);
        return;
      }

      setSnapshot(response.payload);
      setSelectedMediaId((current) => current || response.payload.media[0]?.id || "");
      setLiveMessage(`Scan complete. Found ${response.payload.media.length} media item(s).`);
    } catch (error) {
      setSnapshot(null);
      setLiveMessage(`Scan failed. ${String(error)}`);
    }
  }

  async function checkCompanion() {
    setLiveMessage("Checking native companion.");
    const response = await chrome.runtime.sendMessage({ name: "NATIVE_HEALTH_REQUESTED" });
    setHealth(response);
    setLiveMessage(response?.status === "ok" ? "Native companion connected." : "Native companion needs attention.");
  }

  async function createGenerationJob() {
    const media = snapshot?.media.find((item) => item.id === selectedMediaId) ?? snapshot?.media[0];
    if (!snapshot || !media) {
      setLiveMessage("Scan a page with media before creating a generation job.");
      return;
    }

    setGenerationBusy(true);
    setLiveMessage("Creating local generation job.");

    try {
      const queued = await sendNativeAction("queueJob", {
        action: "create_job",
        mode: generationMode,
        media,
        page: {
          url: snapshot.url,
          title: snapshot.title,
          headings: snapshot.headings,
          transcriptText: snapshot.transcriptText,
          captions: snapshot.captions,
          inaccessibleRegions: snapshot.inaccessibleRegions
        },
        createdAt: new Date().toISOString()
      });

      if (!queued.jobId) {
        throw new Error(queued.message ?? "The companion did not return a queued job id.");
      }

      const backendJob = await createBackendJob(snapshot, generationMode);
      const analyzed = await analyzeBackendJob(backendJob.id);
      const backendArtifacts = await listBackendArtifacts(backendJob.id);
      const artifacts = await sendNativeAction("createArtifactDirectory", { jobId: queued.jobId });
      if (artifacts.ok === false) {
        throw new Error(artifacts.message ?? "The companion could not create an artifact directory.");
      }

      setGenerationJob({
        jobId: queued.jobId,
        backendJobId: backendJob.id,
        traceId: analyzed.traceId || backendJob.traceId,
        media,
        status: queued.status ?? "queued",
        backendStatus: analyzed.status,
        storagePath: queued.storagePath,
        artifactPath: artifacts.artifactPath,
        createdAt: new Date().toISOString(),
        mode: generationMode
      });
      applyBackendArtifacts(backendArtifacts, media);
      setLiveMessage("Generation job queued locally and sent to backend analysis.");
    } catch (error) {
      setGenerationJob(null);
      setLiveMessage(`Generation job failed. ${String(error)}`);
    } finally {
      setGenerationBusy(false);
    }
  }

  async function createBackendJob(
    pageSnapshot: PageAccessibilitySnapshot,
    mode: "standard" | "low_bandwidth"
  ): Promise<BackendJobRecord> {
    return apiFetch<BackendJobRecord>("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        source: "browser",
        mode,
        snapshot: pageSnapshot
      })
    });
  }

  async function analyzeBackendJob(jobId: string): Promise<BackendAnalyzeResponse> {
    return apiFetch<BackendAnalyzeResponse>(`/v1/jobs/${encodeURIComponent(jobId)}/analyze`, {
      method: "POST"
    });
  }

  async function listBackendArtifacts(jobId: string): Promise<BackendArtifactsResponse> {
    return apiFetch<BackendArtifactsResponse>(`/v1/jobs/${encodeURIComponent(jobId)}/artifacts`, {
      method: "GET"
    });
  }

  function applyBackendArtifacts(response: BackendArtifactsResponse, media: DetectedMedia) {
    const reviewArtifact = response.artifacts.find((artifact) => artifact.kind === "review-cues");
    const playbackArtifact = response.artifacts.find((artifact) => artifact.kind === "playback-package");
    const exportArtifacts = response.artifacts
      .filter((artifact) => artifact.kind === "webvtt" || artifact.kind === "qa_report")
      .map((artifact): ExportArtifact => ({
        id: artifact.id ?? `${artifact.kind}-${response.jobId}`,
        jobId: artifact.jobId ?? response.jobId,
        kind: artifact.kind as ExportArtifact["kind"],
        filename: artifact.filename ?? `${response.jobId}-${artifact.kind}`,
        mimeType: artifact.mimeType ?? "application/octet-stream",
        sizeBytes: artifact.sizeBytes ?? 0,
        createdAt: artifact.createdAt ?? new Date().toISOString(),
        offlineAvailable: artifact.offlineAvailable ?? true
      }));

    const cues = reviewArtifact?.cues ?? playbackArtifact?.cues ?? [];
    setReviewCues(cues);
    setSelectedCueId(cues[0]?.id ?? "");
    setExportArtifactsState(exportArtifacts);
    setPlaybackPackageState({
      id: playbackArtifact?.id ?? `pkg-${response.jobId}`,
      jobId: response.jobId,
      mediaId: media.id,
      cues,
      speechGaps: playbackArtifact?.speechGaps ?? cues.map((cue) => ({ start: cue.start, end: cue.end })),
      audioTrackUrl: playbackArtifact?.audioTrackUrl,
      offlineAvailable: playbackArtifact?.offlineAvailable ?? true,
      ducking: playbackArtifact?.ducking ?? { enabled: true, level: 0.35 }
    });
    setOfflineQueueState([{
      id: `offline-${response.jobId}`,
      jobId: response.jobId,
      action: "sync_review",
      status: "queued",
      createdAt: new Date().toISOString(),
      retryCount: 0,
      payloadSummary: `${cues.length} generated cue(s) ready for review sync.`
    }]);
  }

  async function apiFetch<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Backend request failed (${response.status}). ${body}`);
    }

    return response.json() as Promise<T>;
  }

  async function sendNativeAction(method: string, params: unknown): Promise<NativeActionResult> {
    const response = await chrome.runtime.sendMessage({ name: "NATIVE_ACTION_REQUESTED", method, params });
    if (response?.ok === false || response?.status === "error") {
      throw new Error(response.message ?? "Native companion action failed.");
    }
    return response;
  }

  async function updateCue(cueId: string, changes: Partial<ReviewCue>, syncReview = false) {
    const nextCue = reviewCues.find((cue) => cue.id === cueId);
    const updatedCue = nextCue ? { ...nextCue, ...changes } : null;
    setReviewCues((cues) => cues.map((cue) => cue.id === cueId ? { ...cue, ...changes } : cue));
    setPlaybackPackageState((current) => current ? {
      ...current,
      cues: current.cues.map((cue) => cue.id === cueId ? { ...cue, ...changes } : cue)
    } : current);
    setLiveMessage("Review cue updated.");
    if (syncReview && updatedCue && playbackPackageState?.jobId) {
      await submitReview(playbackPackageState.jobId, updatedCue);
    }
  }

  async function submitReview(jobId: string, cue: ReviewCue) {
    await apiFetch(`/v1/jobs/${encodeURIComponent(jobId)}/review`, {
      method: "POST",
      body: JSON.stringify({
        cueId: cue.id,
        text: cue.text,
        confidence: cue.confidence,
        notes: cue.notes
      })
    });
    setOfflineQueueState((items) => items.map((item) => item.jobId === jobId ? {
      ...item,
      status: "complete",
      payloadSummary: `Review cue ${cue.id} synced to backend.`
    } : item));
    setLiveMessage("Review cue synced to backend.");
  }

  async function rememberCuePreference(cue: ReviewCue) {
    const sourceJobId = playbackPackageState?.jobId ?? "manual";
    const memory: MemoryPreference = {
      id: `mem-${cue.id}`,
      scope: "user",
      subjectId: "demo-user",
      kind: "reviewer_correction",
      value: cue.text,
      confidence: Math.max(cue.confidence, 0.75),
      sourceJobId,
      reviewerId: "reviewer-demo",
      createdAt: new Date().toISOString()
    };
    await apiFetch("/v1/memory/preferences", {
      method: "POST",
      body: JSON.stringify({
        scope: memory.scope,
        subjectId: memory.subjectId,
        kind: memory.kind,
        preference: memory.value,
        confidence: memory.confidence,
        sourceJobId: memory.sourceJobId,
        reviewerId: memory.reviewerId
      })
    });
    setMemories((items) => [memory, ...items.filter((item) => item.id !== memory.id)]);
    setLiveMessage("Preference saved to memory audit.");
  }

  function forgetMemory(memoryId: string) {
    setMemories((items) => items.filter((memory) => memory.id !== memoryId));
    setLiveMessage("Memory preference removed.");
  }

  const selectedCue = reviewCues.find((cue) => cue.id === selectedCueId) ?? reviewCues[0];

  return (
    <main className="panel" aria-labelledby="panel-title">
      <header className="panel-header">
        <h1 id="panel-title" className="title">DescribeOps</h1>
        <p className="muted">Detect, generate, review, and play accessible media support.</p>
      </header>
      <div className="sr-only" role="status" aria-live="polite">{liveMessage}</div>
      <Tabs.Root defaultValue="detect">
        <Tabs.List className="tab-list" aria-label="DescribeOps workflow">
          {["Detect", "Generate", "Review", "Playback", "Settings"].map((label) => (
            <Tabs.Trigger key={label} className="tab-trigger" value={label.toLowerCase()}>
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content className="tab-content" value="detect">
          <button type="button" onClick={scanPage}>Scan current page</button>
          <button type="button" className="secondary" onClick={checkCompanion}>Check companion</button>
          {liveMessage.startsWith("Scan failed") || liveMessage.includes("did not receive") || liveMessage.includes("could not scan") ? (
            <p className="status warning" role="alert">{liveMessage}</p>
          ) : null}
          <section className="summary-grid" aria-label="Scan summary">
            <Metric label="Media" value={summary.media} />
            <Metric label="Headings" value={summary.headings} />
            <Metric label="Text blocks" value={summary.text} />
            <Metric label="Needs sampling" value={summary.issues} />
          </section>
          {snapshot ? <SnapshotDetails snapshot={snapshot} /> : <p className="muted">No scan has run yet.</p>}
          {health ? <HealthDetails health={health} /> : null}
        </Tabs.Content>

        <Tabs.Content className="tab-content" value="generate">
          <GeneratePanel
            snapshot={snapshot}
            selectedMediaId={selectedMediaId}
            generationJob={generationJob}
            generationBusy={generationBusy}
            generationMode={generationMode}
            liveMessage={liveMessage}
            onSelectMedia={setSelectedMediaId}
            onChangeMode={setGenerationMode}
            onCreateJob={createGenerationJob}
          />
        </Tabs.Content>

        <Tabs.Content className="tab-content" value="review">
          <ReviewPanel
            cues={reviewCues}
            selectedCue={selectedCue}
            selectedCueId={selectedCueId}
            onSelectCue={setSelectedCueId}
            onUpdateCue={updateCue}
            onRememberCue={rememberCuePreference}
          />
        </Tabs.Content>

        <Tabs.Content className="tab-content" value="playback">
          <PlaybackPanel packageData={playbackPackageState} artifacts={exportArtifactsState} queue={offlineQueueState} />
        </Tabs.Content>

        <Tabs.Content className="tab-content" value="settings">
          <MemoryPanel memories={memories} onForget={forgetMemory} />
        </Tabs.Content>
      </Tabs.Root>
    </main>
  );
}

function GeneratePanel({
  snapshot,
  selectedMediaId,
  generationJob,
  generationBusy,
  generationMode,
  liveMessage,
  onSelectMedia,
  onChangeMode,
  onCreateJob
}: {
  snapshot: PageAccessibilitySnapshot | null;
  selectedMediaId: string;
  generationJob: GenerationJob | null;
  generationBusy: boolean;
  generationMode: "standard" | "low_bandwidth";
  liveMessage: string;
  onSelectMedia: (mediaId: string) => void;
  onChangeMode: (mode: "standard" | "low_bandwidth") => void;
  onCreateJob: () => void;
}) {
  const media = snapshot?.media ?? [];
  const selectedMedia = media.find((item) => item.id === selectedMediaId) ?? media[0];
  const cannotCreate = generationBusy || !snapshot || !selectedMedia;
  const failed = liveMessage.startsWith("Generation job failed");

  return (
    <section aria-labelledby="generate-title">
      <div className="section-heading">
        <h2 id="generate-title">Generate descriptions</h2>
        <span className={generationJob ? "badge success" : "badge"}>{generationJob ? generationJob.status : "not queued"}</span>
      </div>

      {!snapshot ? (
        <p className="status warning">Scan the current page first so DescribeOps knows which media to process.</p>
      ) : null}

      <label className="field">
        Media
        <select
          value={selectedMedia?.id ?? ""}
          disabled={!media.length || generationBusy}
          onChange={(event) => onSelectMedia(event.target.value)}
        >
          {media.length ? media.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} - {item.kind}
            </option>
          )) : <option value="">No media detected</option>}
        </select>
      </label>

      <label className="field">
        Processing mode
        <select
          value={generationMode}
          disabled={generationBusy}
          onChange={(event) => onChangeMode(event.target.value as "standard" | "low_bandwidth")}
        >
          <option value="low_bandwidth">Low-bandwidth sampling</option>
          <option value="standard">Standard evidence package</option>
        </select>
      </label>

      {selectedMedia ? (
        <div className="status">
          <p><strong>Source:</strong> {selectedMedia.source ?? snapshot?.url}</p>
          <p><strong>Captions:</strong> {selectedMedia.hasCaptions ? "detected" : "not detected"}</p>
          <p><strong>Sampling flags:</strong> {snapshot?.inaccessibleRegions.length ?? 0}</p>
        </div>
      ) : null}

      <button type="button" onClick={onCreateJob} disabled={cannotCreate}>
        {generationBusy ? "Creating job..." : "Create generation job"}
      </button>

      {failed ? <p className="status warning" role="alert">{liveMessage}</p> : null}

      {generationJob ? (
        <div className="status success">
          <p><strong>Backend job:</strong> {generationJob.backendJobId ?? "not created"}</p>
          {generationJob.traceId ? <p><strong>Trace:</strong> {generationJob.traceId}</p> : null}
          <p><strong>Backend status:</strong> {generationJob.backendStatus ?? "not started"}</p>
          <p><strong>Local job:</strong> {generationJob.jobId}</p>
          <p><strong>Media:</strong> {generationJob.media.label}</p>
          <p><strong>Mode:</strong> {generationJob.mode === "low_bandwidth" ? "low-bandwidth sampling" : "standard evidence package"}</p>
          {generationJob.artifactPath ? <p><strong>Artifacts:</strong> {generationJob.artifactPath}</p> : null}
          {generationJob.storagePath ? <p><strong>Queue:</strong> {generationJob.storagePath}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function ReviewPanel({
  cues,
  selectedCue,
  selectedCueId,
  onSelectCue,
  onUpdateCue,
  onRememberCue
}: {
  cues: ReviewCue[];
  selectedCue?: ReviewCue;
  selectedCueId: string;
  onSelectCue: (cueId: string) => void;
  onUpdateCue: (cueId: string, changes: Partial<ReviewCue>, syncReview?: boolean) => void;
  onRememberCue: (cue: ReviewCue) => void;
}) {
  if (!selectedCue) {
    return <p className="status warning">Generate descriptions first. Review cues from the backend will appear here.</p>;
  }

  return (
    <section aria-labelledby="review-title">
      <div className="section-heading">
        <h2 id="review-title">Review queue</h2>
        <span className="badge">{cues.filter((cue) => cue.status === "needs_review").length} open</span>
      </div>
      <label className="field">
        Cue
        <select value={selectedCueId} onChange={(event) => onSelectCue(event.target.value)}>
          {cues.map((cue) => (
            <option key={cue.id} value={cue.id}>
              {cue.id} - {cue.impact} impact
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Description text
        <textarea
          value={selectedCue.text}
          rows={4}
          onChange={(event) => onUpdateCue(selectedCue.id, { text: event.target.value, status: "edited" })}
        />
      </label>
      <div className="cue-meta" aria-label="Cue timing and confidence">
        <span>{selectedCue.start.toFixed(1)}s-{selectedCue.end.toFixed(1)}s</span>
        <span>{Math.round(selectedCue.confidence * 100)}% confidence</span>
        <span>{selectedCue.impact} impact</span>
      </div>
      {selectedCue.qaWarnings.length ? (
        <div className="status warning" role="note">
          <strong>QA warning:</strong> {selectedCue.qaWarnings.join(" ")}
        </div>
      ) : null}
      <div className="button-row">
        <button type="button" onClick={() => onUpdateCue(selectedCue.id, { status: "accepted", needsReview: false }, true)}>
          Accept cue
        </button>
        <button type="button" className="secondary" onClick={() => onUpdateCue(selectedCue.id, { status: "rejected" }, true)}>
          Reject cue
        </button>
        <button type="button" className="secondary" onClick={() => onUpdateCue(selectedCue.id, { status: "edited" }, true)}>
          Sync edit
        </button>
        <button type="button" className="secondary" onClick={() => onRememberCue(selectedCue)}>
          Remember wording
        </button>
      </div>
    </section>
  );
}

function PlaybackPanel({
  packageData,
  artifacts,
  queue
}: {
  packageData: PlaybackPackage | null;
  artifacts: ExportArtifact[];
  queue: OfflineQueueItem[];
}) {
  if (!packageData) {
    return <p className="status warning">Generate descriptions first. Playback packages from the backend will appear here.</p>;
  }

  const approved = packageData.cues.filter((cue) => cue.status === "accepted" || cue.status === "edited").length;
  const playableCues = packageData.cues.filter((cue) => cue.status !== "rejected");

  function speakCues() {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const text = playableCues.map((cue) => cue.text).join(" ");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeech() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  return (
    <section aria-labelledby="playback-title">
      <div className="section-heading">
        <h2 id="playback-title">Playback and exports</h2>
        <span className={packageData.offlineAvailable ? "badge success" : "badge"}>Offline package ready</span>
      </div>
      <div className="status">
        <p><strong>{approved}</strong> reviewed cue(s) ready for synchronized playback.</p>
        <p><strong>{playableCues.length}</strong> cue(s) available for browser text-to-speech.</p>
        <p>Ducking is {packageData.ducking.enabled ? `enabled at ${Math.round(packageData.ducking.level * 100)}%` : "disabled"}.</p>
      </div>
      <div className="button-row">
        <button type="button" onClick={speakCues} disabled={!playableCues.length}>
          Play descriptions
        </button>
        <button type="button" className="secondary" onClick={stopSpeech}>
          Stop
        </button>
      </div>
      <h3>Speech gaps</h3>
      <ol className="timeline">
        {packageData.speechGaps.map((gap) => (
          <li key={`${gap.start}-${gap.end}`}>
            <span>{gap.start.toFixed(1)}s</span>
            <meter min={0} max={60} value={gap.end} aria-label={`Speech gap ending at ${gap.end.toFixed(1)} seconds`} />
            <span>{gap.end.toFixed(1)}s</span>
          </li>
        ))}
      </ol>
      <h3>Exports</h3>
      <ul className="list">
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <strong>{artifact.filename}</strong> - {artifact.kind.toUpperCase()} - {Math.ceil(artifact.sizeBytes / 1024)} KB
          </li>
        ))}
      </ul>
      <h3>Offline queue</h3>
      <ul className="list">
        {queue.map((item) => (
          <li key={item.id}>{item.payloadSummary} Status: {item.status}.</li>
        ))}
      </ul>
    </section>
  );
}

function MemoryPanel({ memories, onForget }: { memories: MemoryPreference[]; onForget: (memoryId: string) => void }) {
  return (
    <section aria-labelledby="memory-title">
      <div className="section-heading">
        <h2 id="memory-title">Memory audit</h2>
        <span className="badge">{memories.length} active</span>
      </div>
      <p className="muted">Saved preferences are scoped, attributed, and removable. Content-specific visual facts stay attached to a single job.</p>
      <ul className="memory-list">
        {memories.map((memory) => (
          <li key={memory.id}>
            <div>
              <strong>{memory.kind.replaceAll("_", " ")}</strong>
              <p>{memory.value}</p>
              <small>{memory.scope}:{memory.subjectId} - {Math.round(memory.confidence * 100)}% confidence - source {memory.sourceJobId}</small>
            </div>
            <button type="button" className="secondary" onClick={() => onForget(memory.id)}>
              Forget
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SnapshotDetails({ snapshot }: { snapshot: PageAccessibilitySnapshot }) {
  return (
    <section aria-labelledby="scan-details">
      <h2 id="scan-details">Scan details</h2>
      <p><strong>Title:</strong> {snapshot.title}</p>
      <h3>Media</h3>
      <ul className="list">
        {snapshot.media.map((media) => (
          <li key={media.id}>{media.label} ({media.kind}) {media.hasCaptions ? "with captions" : "without detected captions"}</li>
        ))}
      </ul>
      <h3>Readable text</h3>
      <ul className="list">
        {snapshot.visibleText.slice(0, 5).map((text) => <li key={text}>{text}</li>)}
      </ul>
    </section>
  );
}

function HealthDetails({ health }: { health: NativeHealth }) {
  return (
    <section className={health.status === "ok" ? "status" : "status warning"} aria-labelledby="companion-health">
      <h2 id="companion-health">Companion</h2>
      <p>{health.status === "ok" ? `Version ${health.version}` : health.message}</p>
      {health.storagePath ? <p><strong>Storage:</strong> {health.storagePath}</p> : null}
      {health.supportedTools ? <p><strong>Tools:</strong> {health.supportedTools.join(", ")}</p> : null}
      {health.ffmpeg && !health.ffmpeg.available ? <p>{health.ffmpeg.remediation}</p> : null}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SidePanel />
  </React.StrictMode>
);
