import type { ReadingBlock, ReviewCue, TimelineMoment } from "../types";

export function blocksToCues(blocks: ReadingBlock[], timeline: TimelineMoment[]): ReviewCue[] {
  const timelineByChunk = new Map<string, TimelineMoment[]>();
  timeline.forEach((moment) => {
    const existing = timelineByChunk.get(moment.chunk_id) ?? [];
    existing.push(moment);
    timelineByChunk.set(moment.chunk_id, existing);
  });

  return blocks
    .slice()
    .sort((a, b) => a.start_seconds - b.start_seconds || a.order - b.order)
    .map((block) => {
      const moments = timelineByChunk.get(block.chunk_id) ?? [];
      const heading = block.heading || moments[0]?.label || readableKind(block.kind);
      return {
        id: block.id,
        start: block.start_seconds,
        end: Math.max(block.end_seconds, block.start_seconds + 1),
        text: compactSpeech(`${heading}. ${block.body}`),
        confidence: block.confidence,
        status: block.is_user_edited ? "edited" as const : "accepted" as const
      };
    })
    .filter((cue) => cue.text.length > 0);
}

export function readableKind(kind: string): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactSpeech(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "A code block is shown in the reading document.")
    .replace(/[#*_`>~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}
