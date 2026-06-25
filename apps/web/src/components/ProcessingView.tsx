import { useEffect, useState } from "react";
import { ProgressBar } from "./ProgressBar";
import type { SessionProgress } from "@/api/types";
import { presetById } from "@/lib/presets";

type Props = {
  sessionId: string;
  progress: SessionProgress | null;
  workflowTemplate: string;
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function estimateRemainingSeconds({
  elapsed,
  failed,
  percent,
  ready,
  step,
  total,
}: {
  elapsed: number;
  failed: number;
  percent: number;
  ready: number;
  step: string;
  total: number;
}): number | null {
  if (elapsed < 5 || step === "ready" || step === "failed") return null;
  const completedChunks = ready + failed;
  if (step === "analyzing" && total > 0 && completedChunks > 0 && completedChunks < total) {
    return Math.max(1, Math.round((elapsed / completedChunks) * (total - completedChunks)));
  }
  if (percent >= 10 && percent < 100) {
    return Math.max(1, Math.round((elapsed * (100 - percent)) / percent));
  }
  return null;
}

const STEP_LABELS: Record<string, string> = {
  created: "Starting…",
  downloading: "Downloading video…",
  analyzing: "Analyzing chunks…",
  synthesizing: "Synthesizing document…",
  building_artifacts: "Preparing outputs…",
  ready: "Complete",
  failed: "Failed",
};

export function ProcessingView({ progress, workflowTemplate }: Props) {
  const preset = presetById(workflowTemplate);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const step = progress?.step ?? "created";
  const percent = progress?.percent ?? 0;
  const total = progress?.total_chunks ?? 0;
  const ready = progress?.ready_chunks ?? 0;
  const failed = progress?.failed_chunks ?? 0;
  const isActive = step !== "ready" && step !== "failed";
  const etaSeconds = estimateRemainingSeconds({ elapsed, failed, percent, ready, step, total });

  return (
    <div className="processing-view" aria-live="polite" aria-atomic="false">
      <div className="processing-view__header">
        <span className="processing-view__preset">{preset.label}</span>
        <span className="processing-view__step">{STEP_LABELS[step] ?? step}</span>
      </div>
      <ProgressBar percent={percent} className="processing-view__bar" />
      {total > 0 && (
        <div className="processing-view__counts">
          <span>{ready} / {total} chunks ready</span>
          {failed > 0 && <span className="processing-view__failed">{failed} failed</span>}
        </div>
      )}
      {isActive && (
        <div className="processing-view__footer">
          <span className="processing-view__elapsed">
            Elapsed {formatElapsed(elapsed)}
            {etaSeconds !== null && <span className="processing-view__eta">ETA {formatElapsed(etaSeconds)}</span>}
          </span>
          <div className="processing-view__spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
