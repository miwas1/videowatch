import { formatTimestamp } from "@/lib/format";
import type { TimelineMoment } from "@/api/types";

type Props = { moments: TimelineMoment[] };

export function TimelinePanel({ moments }: Props) {
  if (moments.length === 0) return null;
  return (
    <aside className="timeline-panel">
      <h2 className="timeline-panel__title">Timeline</h2>
      <ol className="timeline-panel__list">
        {moments.map((m) => (
          <li key={m.id} className={`timeline-item timeline-item--imp${m.importance}`}>
            <span className="timeline-item__ts">{formatTimestamp(m.timestamp_seconds)}</span>
            <span className="timeline-item__label">{m.label}</span>
            {m.detail && <span className="timeline-item__detail">{m.detail}</span>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
