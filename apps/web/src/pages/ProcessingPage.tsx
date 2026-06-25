import { useEffect, useState } from "react";
import { ProcessingView } from "@/components/ProcessingView";
import { usePollingProgress } from "@/hooks/usePollingProgress";
import { api } from "@/api/client";
import type { SessionProgress } from "@/api/types";

type Props = {
  sessionId: string;
  workflowTemplate: string;
  onReady: () => void;
  onBack: () => void;
};

export function ProcessingPage({ sessionId, workflowTemplate, onReady, onBack }: Props) {
  const { progress, error, retry } = usePollingProgress(sessionId);
  const [retrying, setRetrying] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    if (progress?.status === "ready" && (!progress.artifact_required || progress.artifact_ready)) {
      onReady();
    }
  }, [onReady, progress]);

  async function retrySynthesis() {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retrySynthesis(sessionId, workflowTemplate);
      retry();
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

  async function retrySession() {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retrySession(sessionId);
      retry();
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

  async function cancelSession() {
    setCanceling(true);
    setRetryError(null);
    try {
      await api.cancelSession(sessionId);
      retry();
    } catch (caught) {
      setRetryError(caught instanceof Error ? caught.message : "Cancel failed");
    } finally {
      setCanceling(false);
    }
  }

  const failure = describeFailure(progress);

  return (
    <main className="processing-page">
      <button className="btn btn--ghost processing-page__back" type="button" onClick={onBack}>
        ← Back
      </button>
      {progress?.status === "failed" ? (
        <section className={`processing-failure ${failure.kind === "youtube" ? "processing-failure--youtube" : ""}`} role="alert">
          <p className="processing-failure__eyebrow">{failure.eyebrow}</p>
          <h1>{failure.title}</h1>
          <p>{failure.body}</p>
          {failure.steps.length > 0 && (
            <ol className="processing-failure__steps">
              {failure.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          )}
          <div className="processing-failure__actions">
            {progress.ready_chunks > 0 && progress.failed_chunks === 0 && (
              <button className="btn btn--primary" type="button" onClick={() => void retrySynthesis()} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry synthesis"}
              </button>
            )}
            <button className="btn btn--secondary" type="button" onClick={() => void retrySession()} disabled={retrying}>
              {retrying ? "Retrying…" : "Retry job"}
            </button>
            <button className="btn btn--secondary" type="button" onClick={onBack}>Return home</button>
          </div>
          {retryError && <p className="processing-page__error">{retryError}</p>}
        </section>
      ) : (
        <>
          <ProcessingView sessionId={sessionId} progress={progress} workflowTemplate={workflowTemplate} />
          {progress?.status === "processing" && (
            <div className="processing-page__actions">
              <button className="btn btn--secondary" type="button" onClick={() => void cancelSession()} disabled={canceling}>
                {canceling ? "Canceling…" : "Cancel job"}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="processing-page__error" role="alert">{error}</p>
      )}
    </main>
  );
}

function describeFailure(progress: SessionProgress | null) {
  const rawMessage = progress?.synthesis_error || progress?.error_message || "";
  const isYoutubeAccessFailure =
    progress?.ingest_error_code === "youtube_access_required" ||
    /sign in to confirm|not a bot|cookies|javascript runtime|js runtime/i.test(rawMessage);

  if (isYoutubeAccessFailure) {
    return {
      kind: "youtube",
      eyebrow: "YouTube access check",
      title: "YouTube blocked the server download.",
      body: "This video needs browser access before DescribeOps can read it. The job was created, but YouTube would not let the backend fetch the source directly.",
      steps: [
        "Open the video in your browser and capture it with the DescribeOps extension.",
        "Try a different public video URL that does not require sign-in checks.",
        "For your own videos, ask the server admin to add an authorized cookies.txt file and retry.",
      ],
    };
  }

  return {
    kind: "generic",
    eyebrow: "Processing stopped",
    title: "We could not finish this output.",
    body: rawMessage || "The backend reported an unknown processing error.",
    steps: [],
  };
}
