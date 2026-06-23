import { useState } from "react";
import { api } from "@/api/client";
import { downloadBlob } from "@/lib/format";
import { PRESETS } from "@/lib/presets";
import type { Artifact } from "@/api/types";

type Props = {
  sessionId: string;
  artifacts: Artifact[];
  currentWorkflow: string;
  onNewArtifact: (a: Artifact) => void;
};

export function ExportPanel({ sessionId, artifacts, currentWorkflow, onNewArtifact }: Props) {
  const [generating, setGenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(workflowId: string) {
    setGenerating(workflowId);
    setError(null);
    try {
      const artifact = await api.regenerateArtifact(sessionId, workflowId);
      onNewArtifact(artifact);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate this format");
    } finally {
      setGenerating(null);
    }
  }

  async function downloadRaw() {
    setError(null);
    try {
      downloadBlob(await api.downloadRawMarkdown(sessionId), "describeops-source-document.md");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not download raw Markdown");
    }
  }

  function downloadArtifact(artifact: Artifact) {
    const filename = `${artifact.title || "describeops"}-${artifact.workflow_template}.md`;
    downloadBlob(artifact.markdown, filename);
  }

  const artifactByTemplate = new Map(artifacts.map((a) => [a.workflow_template, a]));
  const currentPreset = PRESETS.find((preset) => preset.id === currentWorkflow);
  const primaryVerb: Record<string, string> = {
    markdown: "Download document",
    script: "Download cue script",
    report: "Download report",
    brief: "Download brief",
  };

  return (
    <div className="export-panel">
      <h2 className="export-panel__title">Export &amp; Generate</h2>

      <div className="export-panel__current">
        {artifactByTemplate.has(currentWorkflow) && (
          <div className="export-panel__primary">
            <button
              className="btn btn--primary"
              onClick={() => downloadArtifact(artifactByTemplate.get(currentWorkflow)!)}
              type="button"
            >
              {primaryVerb[currentPreset?.exportDefault ?? "markdown"]} (.md)
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void downloadRaw()}
            >
              Raw Markdown Export
            </button>
          </div>
        )}
      </div>
      {error && <p className="export-panel__error" role="alert">{error}</p>}

      <div className="export-panel__other">
        <h3 className="export-panel__subtitle">Generate other formats</h3>
        <ul className="export-panel__list">
          {PRESETS.filter((p) => p.id !== currentWorkflow).map((preset) => {
            const existing = artifactByTemplate.get(preset.id);
            return (
              <li key={preset.id} className="export-panel__item">
                <span className="export-panel__item-label">{preset.label}</span>
                {existing ? (
                  <button
                    className="btn btn--ghost"
                    onClick={() => downloadArtifact(existing)}
                    type="button"
                  >
                    Download
                  </button>
                ) : (
                  <button
                    className="btn btn--ghost"
                    onClick={() => void generate(preset.id)}
                    disabled={generating === preset.id}
                    type="button"
                  >
                    {generating === preset.id ? "Generating…" : "Generate"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
