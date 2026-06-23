import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
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
