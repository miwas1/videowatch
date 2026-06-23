import { useState } from "react";
import { BlockKindBadge } from "./BlockKindBadge";
import { api } from "@/api/client";
import { formatTimestamp } from "@/lib/format";
import type { ReadingBlock } from "@/api/types";

type Props = {
  block: ReadingBlock;
  onEdited?: (updated: ReadingBlock) => void;
  emphasized?: boolean;
};

export function ReadingBlockCard({ block, onEdited, emphasized = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(block.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await api.correctBlock(block.id, draft);
      onEdited?.(response.block);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this block");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`block-card block-card--${block.kind}${block.is_user_edited ? " block-card--edited" : ""}${emphasized ? " block-card--emphasized" : ""}`}>
      <header className="block-card__header">
        <BlockKindBadge kind={block.kind} />
        <span className="block-card__ts">{formatTimestamp(block.start_seconds)}</span>
        {block.is_user_edited && <span className="block-card__edited-mark" aria-label="Edited">✎</span>}
        <button
          className="block-card__edit-btn"
          onClick={() => { setDraft(block.body); setEditing((v) => !v); }}
          aria-label={editing ? "Cancel edit" : "Edit block"}
          type="button"
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      </header>
      {block.heading && <h3 className="block-card__heading">{block.heading}</h3>}
      {editing ? (
        <div className="block-card__edit-area">
          <textarea
            className="block-card__textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            aria-label="Edit block body"
          />
          <div className="block-card__edit-actions">
            <button className="btn btn--primary" onClick={() => void save()} disabled={saving} type="button">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {error && <p className="block-card__error" role="alert">{error}</p>}
        </div>
      ) : block.kind === "code" ? (
        <pre className="block-card__code"><code>{block.body}</code></pre>
      ) : block.kind === "quote" ? (
        <blockquote className="block-card__quote">{block.body}</blockquote>
      ) : (
        <p className="block-card__body">{block.body}</p>
      )}
      {block.confidence < 0.5 && (
        <footer className="block-card__footer">
          <span className="block-card__confidence" aria-label={`Confidence: ${Math.round(block.confidence * 100)}%`}>
            ⚠ Low confidence ({Math.round(block.confidence * 100)}%)
          </span>
        </footer>
      )}
    </article>
  );
}
