import { ProgressBar } from "./ProgressBar";
import type { SessionProgress } from "@/api/types";
import { presetById } from "@/lib/presets";

type Props = {
  sessionId: string;
  progress: SessionProgress | null;
  workflowTemplate: string;
};

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

  const step = progress?.step ?? "created";
  const percent = progress?.percent ?? 0;
  const total = progress?.total_chunks ?? 0;
  const ready = progress?.ready_chunks ?? 0;
  const failed = progress?.failed_chunks ?? 0;

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
      <div className="processing-view__spinner" aria-hidden="true" />
    </div>
  );
}
