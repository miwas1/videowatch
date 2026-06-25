import type {
  ArtifactResponse,
  CapturedFrame,
  ChunkSummary,
  CaptureDetail,
  ExtensionSettings,
  HealthResponse,
  PageAccessibilitySnapshot,
  ReadingBlock,
  ReadingDocumentResponse,
  SessionResponse,
  SynthesisResponse,
  TranscriptResponse
} from "../types";

const frameFileCache = new WeakMap<CapturedFrame, File>();

export class DescribeOpsApi {
  constructor(private readonly settings: ExtensionSettings) {}

  async health(): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>("/health", { method: "GET", auth: false });
  }

  async createSession(snapshot: PageAccessibilitySnapshot, mediaId: string): Promise<SessionResponse> {
    const media = snapshot.media.find((item) => item.id === mediaId) ?? snapshot.media[0];
    const includePageContext = this.settings.captureDetail === "context";
    return this.requestJson<SessionResponse>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        source_url: media?.source || (includePageContext ? snapshot.url : ""),
        title: media?.label || snapshot.title,
        page_title: includePageContext ? snapshot.title : "",
        duration_seconds: media?.duration ?? null,
        settings: {
          extension_version: "0.1.0",
          platform: snapshot.platform,
          media_id: media?.id,
          media_kind: media?.kind,
          capture_mode: "browser_extension",
          chunk_seconds: this.settings.chunkSeconds,
          capture_detail: this.settings.captureDetail,
          screenshot_fallback: this.settings.screenshotFallback
        }
      })
    });
  }

  async getDocument(sessionId: string): Promise<ReadingDocumentResponse> {
    return this.requestJson<ReadingDocumentResponse>(`/api/v1/sessions/${sessionId}/document`, { method: "GET" });
  }

  async getChunks(sessionId: string): Promise<ChunkSummary[]> {
    return this.requestJson<ChunkSummary[]>(`/api/v1/sessions/${sessionId}/chunks`, { method: "GET" });
  }

  async getArtifacts(sessionId: string): Promise<ArtifactResponse[]> {
    return this.requestJson<ArtifactResponse[]>(`/api/v1/sessions/${sessionId}/artifacts`, { method: "GET" });
  }

  async correctBlock(blockId: string, body: string, note: string): Promise<{ block: ReadingBlock }> {
    return this.requestJson<{ block: ReadingBlock }>(`/api/v1/reading-blocks/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify({ body, note })
    });
  }

  async uploadChunkAsync(params: {
    sessionId: string;
    chunkIndex: number;
    startSeconds: number;
    endSeconds: number;
    transcriptText: string;
    captureNotes: string;
    frames: CapturedFrame[];
  }): Promise<{ chunk_id: string; status: string; message: string }> {
    const form = new FormData();
    form.set("chunk_index", String(params.chunkIndex));
    form.set("start_seconds", String(params.startSeconds));
    form.set("end_seconds", String(params.endSeconds));
    form.set("transcript_text", params.transcriptText);
    form.set("capture_notes", params.captureNotes);

    appendFrameFiles(form, params.frames);

    return this.requestJson<{ chunk_id: string; status: string; message: string }>(
      `/api/v1/sessions/${params.sessionId}/chunks/async`,
      { method: "POST", body: form, contentType: null }
    );
  }

  async fetchTranscript(url: string): Promise<TranscriptResponse> {
    return this.requestJson<TranscriptResponse>("/api/v1/transcript", {
      method: "POST",
      body: JSON.stringify({ url })
    });
  }

  async synthesize(sessionId: string): Promise<SynthesisResponse> {
    return this.requestJson<SynthesisResponse>(`/api/v1/sessions/${sessionId}/synthesize`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async getEvents(sessionId: string, after: number): Promise<string> {
    return this.requestText(`/api/v1/sessions/${sessionId}/events?after=${after}`, {
      method: "GET",
      headers: { Accept: "text/event-stream" }
    });
  }

  async exportMarkdown(sessionId: string): Promise<string> {
    return this.requestText(`/api/v1/sessions/${sessionId}/export/markdown`, { method: "GET" });
  }

  async getSessionStatus(sessionId: string): Promise<SessionResponse> {
    return this.requestJson<SessionResponse>(`/api/v1/sessions/${sessionId}`, { method: "GET" });
  }

  async processUrl(url: string, options?: { chunkSeconds?: number; frameCount?: number }): Promise<{ session_id: string; status: string; message: string }> {
    return this.requestJson<{ session_id: string; status: string; message: string }>("/api/v1/ingest/from-url", {
      method: "POST",
      body: JSON.stringify({
        url,
        chunk_seconds: options?.chunkSeconds ?? this.settings.chunkSeconds,
        frame_count: options?.frameCount ?? this.settings.framesPerChunk
      })
    });
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit & { auth?: boolean; contentType?: string | null }
  ): Promise<T> {
    const response = await this.request(path, init);
    return response.json() as Promise<T>;
  }

  private async requestText(path: string, init: RequestInit & { auth?: boolean; contentType?: string | null }): Promise<string> {
    const response = await this.request(path, init);
    return response.text();
  }

  private async request(path: string, init: RequestInit & { auth?: boolean; contentType?: string | null }): Promise<Response> {
    const headers = new Headers(init.headers);
    const shouldAuth = init.auth ?? true;
    if (init.contentType !== null) {
      headers.set("Content-Type", init.contentType ?? "application/json");
    }
    if (shouldAuth && this.settings.apiToken) {
      headers.set("X-DescribeOps-Token", this.settings.apiToken);
    }

    const response = await fetch(`${this.settings.apiBaseUrl}${path}`, {
      ...init,
      headers
    });

    if (!response.ok) {
      let detail = `Backend request failed with ${response.status}.`;
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body.detail || detail;
      } catch {
        const text = await response.text().catch(() => "");
        if (text.trim()) detail = text.trim();
      }
      throw new Error(detail);
    }

    return response;
  }
}

export function composeTranscriptText(snapshot: PageAccessibilitySnapshot, captureDetail: CaptureDetail): string {
  if (captureDetail === "media") return "";
  const lines = [
    ...snapshot.liveCaptionText.map((item) => `Live caption: ${item}`),
    ...snapshot.transcriptText.map((item) => `Transcript: ${item}`)
  ];
  if (captureDetail === "context") {
    lines.push(...snapshot.visibleText.slice(0, 12).map((item) => `Visible text: ${item}`));
  }
  return lines.join("\n");
}

export function composeCaptureNotes(
  snapshot: PageAccessibilitySnapshot,
  mediaId: string,
  frame: CapturedFrame,
  captureDetail: CaptureDetail
): string {
  const media = snapshot.media.find((item) => item.id === mediaId) ?? snapshot.media[0];
  const lines = [
    `Capture detail: ${captureDetail}`,
    `Platform: ${snapshot.platform}`,
    `Media: ${media?.label || "unknown"}`,
    `Media kind: ${media?.kind || "unknown"}`,
    `Frame: ${frame.note}`
  ];
  if (captureDetail !== "media") {
    lines.push(`Captions detected: ${snapshot.captions.join(" | ") || "none"}`);
  }
  if (captureDetail === "context") {
    lines.push(`Page title: ${snapshot.title}`);
    lines.push(`Headings: ${snapshot.headings.slice(0, 6).join(" | ") || "none"}`);
  }
  return lines.join("\n");
}

function appendFrameFiles(form: FormData, frames: CapturedFrame[]): void {
  frames.forEach((frame, index) => {
    form.append("frames", frameToFile(frame, `frame-${index + 1}.png`));
  });
}

function frameToFile(frame: CapturedFrame, filename: string): File {
  const cached = frameFileCache.get(frame);
  if (cached) return cached;
  const file = dataUrlToFile(frame.dataUrl, filename, frame.mimeType);
  frameFileCache.set(frame, file);
  return file;
}

function dataUrlToFile(dataUrl: string, filename: string, mimeType: string): File {
  if (!dataUrl) throw new Error("Captured frame data is missing.");
  const [header, encoded] = dataUrl.split(",");
  const resolvedMime = header.match(/data:(.*?);base64/)?.[1] || mimeType;
  const binary = atob(encoded ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], filename, { type: resolvedMime });
}
