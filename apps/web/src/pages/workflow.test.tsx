import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { HomePage } from "./HomePage";
import { ProcessingPage } from "./ProcessingPage";
import { ReviewPage } from "./ReviewPage";

vi.mock("@/hooks/usePollingProgress", () => ({
  usePollingProgress: vi.fn(),
}));

import { usePollingProgress } from "@/hooks/usePollingProgress";

const failedProgress = {
  session_id: "session-1",
  status: "failed" as const,
  step: "failed",
  percent: 0,
  total_chunks: 2,
  ready_chunks: 2,
  failed_chunks: 0,
  artifact_ready: false,
  artifact_required: true,
  last_event_type: "session.error",
  error_message: "Final synthesis unavailable",
  synthesis_error: "Final synthesis unavailable",
  ingest_error_code: "",
};

describe("processing and review workflows", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("shows synthesis failures and retries without routing to review", async () => {
    const retry = vi.fn();
    vi.mocked(usePollingProgress).mockReturnValue({ progress: failedProgress, error: null, retry });
    vi.spyOn(api, "retrySynthesis").mockResolvedValue({ session_id: "session-1", status: "processing", message: "Retrying" });
    const onReady = vi.fn();
    render(<ProcessingPage sessionId="session-1" workflowTemplate="research_digest" onReady={onReady} onBack={() => undefined} />);

    expect(screen.getByRole("heading", { name: "We could not finish this output." })).toBeTruthy();
    expect(screen.getByText("Final synthesis unavailable")).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry synthesis" }));
    await waitFor(() => expect(api.retrySynthesis).toHaveBeenCalledWith("session-1", "research_digest"));
    expect(retry).toHaveBeenCalled();
  });

  it("cancels processing jobs from the processing page", async () => {
    const retry = vi.fn();
    vi.mocked(usePollingProgress).mockReturnValue({
      progress: {
        ...failedProgress,
        status: "processing",
        step: "analyzing",
        percent: 42,
        error_message: "",
        synthesis_error: "",
      },
      error: null,
      retry,
    });
    vi.spyOn(api, "cancelSession").mockResolvedValue({ session_id: "session-1", status: "canceled", canceled_jobs: 1 });

    render(<ProcessingPage sessionId="session-1" workflowTemplate="reading_document" onReady={() => undefined} onBack={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel job" }));

    await waitFor(() => expect(api.cancelSession).toHaveBeenCalledWith("session-1"));
    expect(retry).toHaveBeenCalled();
  });

  it("explains YouTube access failures with recovery steps", () => {
    const retry = vi.fn();
    vi.mocked(usePollingProgress).mockReturnValue({
      progress: {
        ...failedProgress,
        ready_chunks: 0,
        artifact_required: false,
        error_message: "YouTube could not confirm this server is allowed to access the video.",
        synthesis_error: "",
        ingest_error_code: "youtube_access_required",
      },
      error: null,
      retry,
    });

    render(<ProcessingPage sessionId="session-1" workflowTemplate="reading_document" onReady={() => undefined} onBack={() => undefined} />);

    expect(screen.getByRole("heading", { name: "YouTube blocked the server download." })).toBeTruthy();
    expect(screen.getByText("Open the video in your browser and capture it with the DescribeOps extension.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry synthesis" })).toBeNull();
  });

  it("queues a failed job retry from the processing page", async () => {
    const retry = vi.fn();
    vi.mocked(usePollingProgress).mockReturnValue({ progress: { ...failedProgress, ready_chunks: 0, failed_chunks: 0 }, error: null, retry });
    vi.spyOn(api, "retrySession").mockResolvedValue({ session_id: "session-1", status: "processing", message: "Retrying" });

    render(<ProcessingPage sessionId="session-1" workflowTemplate="reading_document" onReady={() => undefined} onBack={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry job" }));

    await waitFor(() => expect(api.retrySession).toHaveBeenCalledWith("session-1"));
    expect(retry).toHaveBeenCalled();
  });

  it("starts a real upload ingest from the homepage", async () => {
    const onSessionStarted = vi.fn();
    vi.spyOn(api, "health").mockResolvedValue({
      ok: true,
      service: "describeops-backend",
      qwen_configured: true,
      visual_model: "qwen3.6-flash",
      text_model: "qwen3.6-flash",
      final_model: "qwen3.7-max",
      deployment: "test",
    });
    vi.spyOn(api, "listSessions").mockResolvedValue([]);
    vi.spyOn(api, "ingestFile").mockResolvedValue({ session_id: "upload-session", status: "processing", message: "started" });

    render(
      <HomePage
        currentUser={{ id: 1, email: "reader@example.com" }}
        onLogout={() => undefined}
        onSessionStarted={onSessionStarted}
        onOpenSession={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: "Upload" }));
    const file = new File(["video-bytes"], "lesson.mp4", { type: "video/mp4" });
    await userEvent.upload(screen.getByLabelText("Video file"), file);
    expect(await screen.findByText(/lesson\.mp4/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Upload video" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    await userEvent.click(submit);

    await waitFor(() => expect(api.ingestFile).toHaveBeenCalledWith({ video: file, workflow_template: "reading_document" }));
    expect(onSessionStarted).toHaveBeenCalledWith("upload-session", "reading_document");
  });

  it("shows the generated artifact before generic source blocks", async () => {
    vi.spyOn(api, "getDocument").mockResolvedValue({
      session: {
        id: "session-1", source_url: "", title: "Video", page_title: "Video", status: "ready",
        pipeline_stage: "ready", expected_chunk_count: 1, duration_seconds: 30, settings: {},
        error_message: "", synthesis_error: "", created_at: "", updated_at: "",
      },
      blocks: [{
        id: "block-1", chunk_id: "chunk-1", order: 0, kind: "explanation", heading: "Generic source block",
        body: "Source block body", start_seconds: 0, end_seconds: 30, source_evidence: [], confidence: 0.9, is_user_edited: false,
      }],
      timeline: [],
    });
    vi.spyOn(api, "getChunks").mockResolvedValue([]);
    vi.spyOn(api, "getArtifacts").mockResolvedValue([{
      id: "artifact-1", artifact_type: "course_notes", workflow_template: "course_notes", title: "Course notes",
      summary: "Synthesized summary", markdown: "", payload: { sections: [{
        heading: "Key concepts", body: "Synthesized course-note content", start_seconds: 0, end_seconds: 30, kind: "explanation",
      }] }, created_at: "", updated_at: "",
    }]);

    render(<ReviewPage sessionId="session-1" workflowTemplate="course_notes" onBack={() => undefined} />);
    expect(await screen.findByText("Synthesized course-note content")).toBeTruthy();
    expect(screen.queryByText("Source block body")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Source" }));
    expect(screen.getByText("Source block body")).toBeTruthy();
  });
});
