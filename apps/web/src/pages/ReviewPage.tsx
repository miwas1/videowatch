import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { ReadingBlockCard } from "@/components/ReadingBlockCard";
import { TimelinePanel } from "@/components/TimelinePanel";
import { ExportPanel } from "@/components/ExportPanel";
import { ChunkEvidencePanel } from "@/components/ChunkEvidencePanel";
import { ArtifactDocument } from "@/components/ArtifactDocument";
import { presetById } from "@/lib/presets";
import type { Artifact, ChunkSummary, ReadingBlock, ReadingDocument } from "@/api/types";

type Tab = "output" | "source" | "timeline" | "evidence" | "export";

type Props = {
  sessionId: string;
  workflowTemplate: string;
  onBack: () => void;
};

export function ReviewPage({ sessionId, workflowTemplate, onBack }: Props) {
  const [doc, setDoc] = useState<ReadingDocument | null>(null);
  const [chunks, setChunks] = useState<ChunkSummary[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("output");
  const preset = presetById(workflowTemplate);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getDocument(sessionId),
      api.getChunks(sessionId),
      api.getArtifacts(sessionId),
    ])
      .then(([d, c, a]) => {
        setDoc(d);
        setChunks(c);
        setArtifacts(a);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  function updateBlock(updated: ReadingBlock) {
    setDoc((prev) => {
      if (!prev) return prev;
      return { ...prev, blocks: prev.blocks.map((b) => (b.id === updated.id ? updated : b)) };
    });
  }

  const primaryArtifact = artifacts.find((a) => a.workflow_template === workflowTemplate) ?? artifacts[0];
  const emphasizedKinds = new Set(preset.blockEmphasis);
  const prioritizedBlocks = doc?.blocks.filter((block) => emphasizedKinds.has(block.kind)) ?? [];
  const supportingBlocks = doc?.blocks.filter((block) => !emphasizedKinds.has(block.kind)) ?? [];

  if (loading) {
    return (
      <main className="review-page review-page--loading">
        <button className="btn btn--ghost" type="button" onClick={onBack}>← Back</button>
        <p className="review-page__loading-msg" aria-live="polite">Loading document…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="review-page review-page--error">
        <button className="btn btn--ghost" type="button" onClick={onBack}>← Back</button>
        <p className="review-page__error" role="alert">{error}</p>
      </main>
    );
  }

  const title = primaryArtifact?.title || doc?.session.title || doc?.session.page_title || "Untitled";

  return (
    <main className="review-page">
      <div className="review-page__top-bar">
        <button className="btn btn--ghost" type="button" onClick={onBack}>← Back</button>
        <h1 className="review-page__title">{title}</h1>
        <span className="review-page__preset">{preset.label}</span>
      </div>

      {primaryArtifact?.summary && (
        <div className="review-page__summary">
          <p>{primaryArtifact.summary}</p>
        </div>
      )}

      <nav className="review-page__tabs" role="tablist" aria-label="Review sections">
        {(["output", "source", "timeline", "evidence", "export"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`review-tab${tab === t ? " review-tab--active" : ""}`}
            onClick={() => setTab(t)}
            type="button"
          >
            {t === "output" ? preset.outputLabel : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <div className="review-page__content" role="tabpanel">
        {tab === "output" && (
          primaryArtifact
            ? <ArtifactDocument artifact={primaryArtifact} />
            : <p className="review-page__empty">No generated artifact is available for this workflow.</p>
        )}

        {tab === "source" && doc && (
          <div className="review-page__blocks">
            {doc.blocks.length === 0 ? <p className="review-page__empty">No source blocks yet.</p> : (
              <>
                {prioritizedBlocks.length > 0 && <h2 className="review-page__group-title">Priority evidence for {preset.label}</h2>}
                {prioritizedBlocks.map((block) => (
                  <ReadingBlockCard key={block.id} block={block} onEdited={updateBlock} emphasized />
                ))}
                {supportingBlocks.length > 0 && <h2 className="review-page__group-title">Supporting source blocks</h2>}
                {supportingBlocks.map((block) => (
                  <ReadingBlockCard key={block.id} block={block} onEdited={updateBlock} />
                ))}
              </>
            )}
          </div>
        )}

        {tab === "timeline" && doc && (
          <TimelinePanel moments={doc.timeline} />
        )}

        {tab === "evidence" && (
          <ChunkEvidencePanel chunks={chunks} />
        )}

        {tab === "export" && (
          <ExportPanel
            sessionId={sessionId}
            artifacts={artifacts}
            currentWorkflow={workflowTemplate}
            onNewArtifact={(a) => setArtifacts((prev) => [a, ...prev.filter((x) => x.workflow_template !== a.workflow_template)])}
          />
        )}
      </div>
    </main>
  );
}
