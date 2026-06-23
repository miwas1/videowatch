import type {
  Artifact,
  ChunkSummary,
  HealthResponse,
  IngestResponse,
  ReadingBlock,
  ReadingDocument,
  Session,
  SessionListItem,
  SessionProgress,
} from "./types";

export function createApiClient(baseUrl = "", token = "") {
  function headers(includeJson = true): HeadersInit {
    const result: Record<string, string> = {};
    if (includeJson) result["Content-Type"] = "application/json";
    if (token) result["X-DescribeOps-Token"] = token;
    return result;
  }

  async function request<T>(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { detail?: string };
      throw new Error(error.detail ?? `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  const get = <T,>(path: string) => request<T>(path, "GET");
  const post = <T,>(path: string, body: unknown) => request<T>(path, "POST", body);
  const patch = <T,>(path: string, body: unknown) => request<T>(path, "PATCH", body);

  return {
    health: () => get<HealthResponse>("/health"),
    listSessions: (limit = 20, offset = 0) =>
      get<SessionListItem[]>(`/api/v1/sessions?limit=${limit}&offset=${offset}`),
    getSession: (id: string) => get<Session>(`/api/v1/sessions/${id}`),
    getProgress: (id: string) => get<SessionProgress>(`/api/v1/sessions/${id}/progress`),
    getDocument: (id: string) => get<ReadingDocument>(`/api/v1/sessions/${id}/document`),
    getChunks: (id: string) => get<ChunkSummary[]>(`/api/v1/sessions/${id}/chunks`),
    getArtifacts: (id: string) => get<Artifact[]>(`/api/v1/sessions/${id}/artifacts`),
    regenerateArtifact: (id: string, workflowTemplate: string) =>
      post<Artifact>(`/api/v1/sessions/${id}/artifacts`, { workflow_template: workflowTemplate }),
    ingestUrl: (params: {
      url: string;
      workflow_template: string;
      output_targets?: string[];
      chunk_seconds?: number;
      frame_count?: number;
      frame_width?: number;
      max_height?: number;
      auto_synthesize?: boolean;
    }) => post<IngestResponse>("/api/v1/ingest/from-url", { auto_synthesize: true, ...params }),
    correctBlock: (blockId: string, body: string, note?: string) =>
      patch<{ block: ReadingBlock }>(`/api/v1/reading-blocks/${blockId}`, { body, note: note ?? "" }),
    retrySynthesis: (id: string, workflowTemplate: string) =>
      post<IngestResponse>(`/api/v1/sessions/${id}/retry-synthesis`, { workflow_template: workflowTemplate }),
    downloadRawMarkdown: async (sessionId: string) => {
      const response = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/export/markdown`, {
        headers: headers(false),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.text();
    },
  };
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const token = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "";
export const api = createApiClient(baseUrl, token);
