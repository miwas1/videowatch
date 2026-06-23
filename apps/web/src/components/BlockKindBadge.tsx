const KIND_LABELS: Record<string, string> = {
  intro: "Intro",
  explanation: "Explanation",
  example: "Example",
  code: "Code",
  visual_context: "Visual",
  quote: "Quote",
  demo_step: "Step",
  timestamp_anchor: "Anchor",
  takeaway: "Takeaway",
};

type Props = { kind: string };

export function BlockKindBadge({ kind }: Props) {
  return (
    <span className={`block-badge block-badge--${kind}`} aria-label={KIND_LABELS[kind] ?? kind}>
      {KIND_LABELS[kind] ?? kind}
    </span>
  );
}
