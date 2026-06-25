import type {
  Artifact,
  AuthResponse,
  AuthUser,
  ChunkSummary,
  HealthResponse,
  IngestResponse,
  ReadingBlock,
  ReadingDocument,
  Session,
  SessionListItem,
  SessionProgress,
} from "./types";

export const USER_TOKEN_STORAGE_KEY = "describeops.userToken";
export const USER_STORAGE_KEY = "describeops.user";

export function readStoredUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(USER_STORAGE_KEY);
    return raw ? JSON.parse(raw) as AuthUser : null;
  } catch {
    return null;
  }
}

export function storeAuth(auth: AuthResponse): void {
  window.localStorage.setItem(USER_TOKEN_STORAGE_KEY, auth.token);
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(auth.user));
}

export function clearStoredAuth(): void {
  window.localStorage.removeItem(USER_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(USER_STORAGE_KEY);
}

export function createApiClient(baseUrl = "", token = "") {
  function headers(includeJson = true): HeadersInit {
    const result: Record<string, string> = {};
    if (includeJson) result["Content-Type"] = "application/json";
    const userToken = window.localStorage.getItem(USER_TOKEN_STORAGE_KEY);
    if (userToken || token) result["X-DescribeOps-Token"] = userToken || token;
    return result;
  }

  async function request<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401 && !path.includes("/auth/")) {
        clearStoredAuth();
        window.location.hash = "#/";
        window.location.reload();
        throw new Error("Session expired. Please sign in again.");
      }
      const error = (await response.json().catch(() => ({}))) as { detail?: string };
      throw new Error(error.detail ?? `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  const get = <T,>(path: string) => request<T>(path, "GET");
  const post = <T,>(path: string, body: unknown) => request<T>(path, "POST", body);
  const patch = <T,>(path: string, body: unknown) => request<T>(path, "PATCH", body);
  const del = <T,>(path: string) => request<T>(path, "DELETE");

  return {
    health: () => get<HealthResponse>("/health"),
    register: (email: string, password: string) =>
      post<AuthResponse>("/api/v1/auth/register", { email, password }),
    login: (email: string, password: string) =>
      post<AuthResponse>("/api/v1/auth/login", { email, password }),
    me: () => get<AuthUser>("/api/v1/auth/me"),
    logout: () => post<{ status: string }>("/api/v1/auth/logout", {}),
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
    ingestFile: async (params: {
      video: File;
      workflow_template: string;
      output_targets?: string[];
      chunk_seconds?: number;
      frame_count?: number;
      frame_width?: number;
      auto_synthesize?: boolean;
    }) => {
      const form = new FormData();
      form.append("video", params.video);
      form.append("workflow_template", params.workflow_template);
      form.append("auto_synthesize", String(params.auto_synthesize ?? true));
      if (params.chunk_seconds) form.append("chunk_seconds", String(params.chunk_seconds));
      if (params.frame_count) form.append("frame_count", String(params.frame_count));
      if (params.frame_width) form.append("frame_width", String(params.frame_width));
      for (const target of params.output_targets ?? []) form.append("output_targets", target);
      const response = await fetch(`${baseUrl}/api/v1/ingest/from-file`, {
        method: "POST",
        headers: headers(false),
        body: form,
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(error.detail ?? `${response.status} ${response.statusText}`);
      }
      return response.json() as Promise<IngestResponse>;
    },
    correctBlock: (blockId: string, body: string, note?: string) =>
      patch<{ block: ReadingBlock }>(`/api/v1/reading-blocks/${blockId}`, { body, note: note ?? "" }),
    retrySynthesis: (id: string, workflowTemplate: string) =>
      post<IngestResponse>(`/api/v1/sessions/${id}/retry-synthesis`, { workflow_template: workflowTemplate }),
    retrySession: (id: string) =>
      post<IngestResponse>(`/api/v1/sessions/${id}/retry`, {}),
    cancelSession: (id: string) =>
      post<{ session_id: string; status: string; canceled_jobs: number }>(`/api/v1/sessions/${id}/cancel`, {}),
    deleteSession: (id: string) =>
      del<{ session_id: string; status: string }>(`/api/v1/sessions/${id}`),
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
