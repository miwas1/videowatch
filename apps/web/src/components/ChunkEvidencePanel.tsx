import { formatTimestamp } from "@/lib/format";
import type { ChunkSummary } from "@/api/types";

type Props = { chunks: ChunkSummary[] };

export function ChunkEvidencePanel({ chunks }: Props) {
  if (chunks.length === 0) return null;
  return (
    <div className="chunk-evidence">
      <h2 className="chunk-evidence__title">Source Chunks</h2>
      <ol className="chunk-evidence__list">
        {chunks.map((c) => (
          <li key={c.id} className={`chunk-item chunk-item--${c.status}`}>
            <span className="chunk-item__range">
              {formatTimestamp(c.start_seconds)} – {formatTimestamp(c.end_seconds)}
            </span>
            <span className="chunk-item__counts">
              {c.block_count} blocks · {c.frame_count} frames
            </span>
            {c.latency_ms != null && (
              <span className="chunk-item__latency">{(c.latency_ms / 1000).toFixed(1)}s</span>
            )}
            {c.status === "failed" && c.error_message && (
              <span className="chunk-item__error">{c.error_message}</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
