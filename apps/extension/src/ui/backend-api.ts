import type {
  CapturedFrame,
  ChunkResponse,
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
    return this.requestJson<SessionResponse>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        source_url: media?.source || snapshot.url,
        title: media?.label || snapshot.title,
        page_title: snapshot.title,
        duration_seconds: media?.duration ?? null,
        settings: {
          extension_version: "0.1.0",
          platform: snapshot.platform,
          media_id: media?.id,
          media_kind: media?.kind,
          capture_mode: "browser_extension",
          chunk_seconds: this.settings.chunkSeconds
        }
      })
    });
  }

  async createLiveSession(snapshot: PageAccessibilitySnapshot, mediaId: string): Promise<SessionResponse> {
    const media = snapshot.media.find((item) => item.id === mediaId) ?? snapshot.media[0];
    return this.requestJson<SessionResponse>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        source_url: media?.source || snapshot.url || "live://browser-tab",
        title: media?.label || snapshot.title || "Live stream",
        page_title: snapshot.title,
        duration_seconds: null,
        settings: {
          extension_version: "0.1.0",
          platform: snapshot.platform,
          media_id: media?.id,
          media_kind: media?.kind,
          capture_mode: "browser_extension_live",
          source_type: "live_capture",
          live_status: "recording",
          chunk_seconds: this.settings.chunkSeconds
        }
      })
    });
  }

  async uploadChunk(params: {
    sessionId: string;
    chunkIndex: number;
    startSeconds: number;
    endSeconds: number;
    transcriptText: string;
    captureNotes: string;
    frames: CapturedFrame[];
  }): Promise<ChunkResponse> {
    const form = new FormData();
    form.set("chunk_index", String(params.chunkIndex));
    form.set("start_seconds", String(params.startSeconds));
    form.set("end_seconds", String(params.endSeconds));
    form.set("transcript_text", params.transcriptText);
    form.set("capture_notes", params.captureNotes);
    form.set("process_now", "true");

    appendFrameFiles(form, params.frames);

    return this.requestJson<ChunkResponse>(`/api/v1/sessions/${params.sessionId}/chunks`, {
      method: "POST",
      body: form,
      contentType: null
    });
  }

  async getDocument(sessionId: string): Promise<ReadingDocumentResponse> {
    return this.requestJson<ReadingDocumentResponse>(`/api/v1/sessions/${sessionId}/document`, { method: "GET" });
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

  async finishLiveSession(sessionId: string): Promise<{ session_id: string; status: string; total_chunks: number; ready_chunks: number; failed_chunks: number }> {
    return this.requestJson<{ session_id: string; status: string; total_chunks: number; ready_chunks: number; failed_chunks: number }>(
      `/api/v1/sessions/${sessionId}/live/finish`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  async exportMarkdown(sessionId: string): Promise<string> {
    const headers = new Headers();
    if (this.settings.apiToken) {
      headers.set("X-DescribeOps-Token", this.settings.apiToken);
    }
    const response = await fetch(`${this.settings.apiBaseUrl}/api/v1/sessions/${sessionId}/export/markdown`, { headers });
    if (!response.ok) throw new Error(`Export failed with ${response.status}`);
    return response.text();
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

    return response.json() as Promise<T>;
  }
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
