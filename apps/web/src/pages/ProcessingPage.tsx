import { useEffect, useState } from "react";
import { ProcessingView } from "@/components/ProcessingView";
import { usePollingProgress } from "@/hooks/usePollingProgress";
import { api } from "@/api/client";

type Props = {
  sessionId: string;
  workflowTemplate: string;
  onReady: () => void;
  onBack: () => void;
};

export function ProcessingPage({ sessionId, workflowTemplate, onReady, onBack }: Props) {
  const { progress, error, retry } = usePollingProgress(sessionId);
  const [retrying, setRetrying] = useState(false);
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

  return (
    <main className="processing-page">
      <button className="btn btn--ghost processing-page__back" type="button" onClick={onBack}>
        ← Back
      </button>
      {progress?.status === "failed" ? (
        <section className="processing-failure" role="alert">
          <p className="processing-failure__eyebrow">Processing stopped</p>
          <h1>We could not finish this output.</h1>
          <p>{progress.synthesis_error || progress.error_message || "The backend reported an unknown processing error."}</p>
          <div className="processing-failure__actions">
            {progress.ready_chunks > 0 && progress.failed_chunks === 0 && (
              <button className="btn btn--primary" type="button" onClick={() => void retrySynthesis()} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry synthesis"}
              </button>
            )}
            <button className="btn btn--secondary" type="button" onClick={onBack}>Return home</button>
          </div>
          {retryError && <p className="processing-page__error">{retryError}</p>}
        </section>
      ) : (
        <ProcessingView sessionId={sessionId} progress={progress} workflowTemplate={workflowTemplate} />
      )}
      {error && (
        <p className="processing-page__error" role="alert">{error}</p>
      )}
    </main>
  );
}
