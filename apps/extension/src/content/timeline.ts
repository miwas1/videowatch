export type TimelineItemType = "visual_action" | "ocr" | "scene" | "summary";
export type TimelineImportance = "low" | "medium" | "high";

export type AccessibilityTimelineItem = {
  id?: string;
  start: number;
  end?: number;
  speak_at: number;
  type: TimelineItemType;
  description: string;
  importance: TimelineImportance;
  audio_url?: string;
  text?: string;
};

export type AudioActivity = {
  start: number;
  end: number;
  type: "speech" | "silence" | "music" | "unknown";
};

export type PlaybackCue = Required<Pick<AccessibilityTimelineItem, "id" | "start" | "end" | "speak_at" | "type" | "description" | "importance">> & {
  audio_url?: string;
  text?: string;
  played: boolean;
};

export function sanitizeTimeline(items: unknown[]): PlaybackCue[] {
  return items
    .map((item, index) => normalizeTimelineItem(item, index))
    .filter((item): item is PlaybackCue => item !== null)
    .sort((a, b) => a.speak_at - b.speak_at);
}

export function nextDueCue(cues: PlaybackCue[], currentTime: number, audioDescriptionEnabled = true): PlaybackCue | null {
  if (!audioDescriptionEnabled) return null;
  return cues.find((cue) => !cue.played && currentTime >= cue.speak_at) ?? null;
}

export function resetPlayedAfterSeek(cues: PlaybackCue[], fromTime: number, toTime: number): PlaybackCue[] {
  if (toTime >= fromTime - 1) return cues;
  return cues.map((cue) => cue.speak_at >= toTime ? { ...cue, played: false } : cue);
}

export function safeSpeakTime(
  requestedTime: number,
  audioActivity: AudioActivity[],
  avoidDialogue: boolean
): number {
  if (!avoidDialogue) return requestedTime;
  const overlappingSpeech = audioActivity.find((activity) =>
    activity.type === "speech" &&
    requestedTime >= activity.start &&
    requestedTime < activity.end
  );
  return overlappingSpeech ? overlappingSpeech.end : requestedTime;
}

export function ocrTextNear(cues: PlaybackCue[], currentTime: number, windowSeconds = 5): string {
  const nearby = cues.find((cue) =>
    cue.type === "ocr" &&
    Math.abs(cue.start - currentTime) <= windowSeconds
  );
  return nearby?.text || nearby?.description || "";
}

function normalizeTimelineItem(item: unknown, index: number): PlaybackCue | null {
  if (!item || typeof item !== "object") return null;
  const candidate = item as Partial<AccessibilityTimelineItem>;
  if (!isNonNegativeNumber(candidate.start)) return null;
  if (!isNonNegativeNumber(candidate.speak_at)) return null;
  if (typeof candidate.description !== "string" || !candidate.description.trim()) return null;
  if (!isTimelineType(candidate.type)) return null;
  if (!isImportance(candidate.importance)) return null;

  const end = isNonNegativeNumber(candidate.end) ? candidate.end : candidate.start;
  if (end < candidate.start) return null;

  return {
    id: candidate.id || `timeline-${index + 1}`,
    start: candidate.start,
    end,
    speak_at: candidate.speak_at,
    type: candidate.type,
    description: candidate.description.trim(),
    importance: candidate.importance,
    audio_url: candidate.audio_url,
    text: candidate.text,
    played: false
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimelineType(value: unknown): value is TimelineItemType {
  return value === "visual_action" || value === "ocr" || value === "scene" || value === "summary";
}

function isImportance(value: unknown): value is TimelineImportance {
  return value === "low" || value === "medium" || value === "high";
}
