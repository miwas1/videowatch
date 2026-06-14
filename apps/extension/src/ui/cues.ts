import type { DetectedMedia, PageAccessibilitySnapshot, ReviewCue } from "@describeops/shared";

export type DescriptionLevel = "minimal" | "balanced" | "detailed";

export type AccessibilityOptions = {
  readOnScreenText: boolean;
  describeActions: boolean;
  avoidDialogue: boolean;
};

export type CaptureEvidence = {
  sampleCount: number;
  speechGaps: Array<{ start: number; end: number }>;
  samples: Array<{
    timestamp: number;
    luminance: number;
    audioLevel: number;
    width: number;
    height: number;
  }>;
};

const DEFAULT_OPTIONS: AccessibilityOptions = {
  readOnScreenText: true,
  describeActions: true,
  avoidDialogue: true
};

export function normalizeOptions(options?: Partial<AccessibilityOptions>): AccessibilityOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...options
  };
}

export function buildFallbackReviewCues(
  snapshot: PageAccessibilitySnapshot,
  media: DetectedMedia,
  level: DescriptionLevel,
  requestedOptions?: Partial<AccessibilityOptions>
): ReviewCue[] {
  const options = normalizeOptions(requestedOptions);
  const startAt = Math.max(0, Math.floor(media.currentTime ?? 0));
  const title = compactText(snapshot.title || media.label || "current video");
  const readableText = firstMeaningfulText(snapshot.visibleText, title);
  const transcriptHint = firstMeaningfulText(snapshot.transcriptText, title);
  const captionHint = snapshot.captions[0];
  const samplingHint = snapshot.inaccessibleRegions[0]?.label;

  const statements: string[] = [
    `${media.label} is the active video on this page.`
  ];

  if (options.describeActions) {
    statements.push(
      transcriptHint
        ? `The surrounding transcript says: ${trimSentence(transcriptHint)}.`
        : `The scene is ready for audio descriptions while the video plays.`
    );
  }

  if (options.readOnScreenText && readableText) {
    statements.push(`Text on screen: ${trimSentence(readableText)}.`);
  }

  if (level !== "minimal") {
    statements.push(
      captionHint
        ? `Captions are detected, so descriptions can be placed between spoken moments.`
        : `No caption track text is available; timing should be confirmed during review.`
    );
  }

  if (level === "detailed") {
    statements.push(
      samplingHint
        ? `${samplingHint} needs visual confirmation before publishing.`
        : `Use Ask now at any moment to hear the current visual summary.`
    );
  }

  return statements.slice(0, cueLimit(level)).map((text, index) => ({
    id: `local-cue-${index + 1}`,
    start: startAt + 1 + index * 6,
    end: startAt + 4 + index * 6,
    text,
    evidenceRefs: [`snapshot-${index + 1}`],
    confidence: index === 0 ? 0.78 : 0.66,
    needsReview: false,
    notes: "Generated locally from browser-visible page and media evidence.",
    impact: index === 0 ? "high" : "medium",
    qaWarnings: options.avoidDialogue ? [] : ["Dialogue avoidance is disabled."],
    status: "accepted",
    rememberable: false
  }));
}

export function buildCaptureReviewCues(
  snapshot: PageAccessibilitySnapshot,
  evidence: CaptureEvidence,
  level: DescriptionLevel,
  requestedOptions?: Partial<AccessibilityOptions>
): ReviewCue[] {
  const options = normalizeOptions(requestedOptions);
  const title = compactText(snapshot.title || "captured tab");
  const firstSample = evidence.samples[0];
  const lastSample = evidence.samples[evidence.samples.length - 1];
  const averageAudio = average(evidence.samples.map((sample) => sample.audioLevel));
  const averageLuminance = average(evidence.samples.map((sample) => sample.luminance));
  const resolution = firstSample ? `${firstSample.width} by ${firstSample.height}` : "unknown size";
  const firstGap = evidence.speechGaps[0];

  const statements = [
    `${title} is being sampled through tab capture at ${resolution}.`,
    firstGap
      ? `A quiet gap was detected around ${firstGap.start.toFixed(1)} seconds for a description.`
      : `No clear quiet gap was found during the sample; keep descriptions short.`,
    options.readOnScreenText
      ? `The captured frames average ${Math.round(averageLuminance)} brightness, useful for detecting visual changes.`
      : "",
    options.describeActions
      ? `Audio activity averaged ${averageAudio.toFixed(2)}, so action descriptions should wait for lower speech levels.`
      : "",
    level === "detailed" && lastSample
      ? `The latest sample was taken at ${lastSample.timestamp.toFixed(1)} seconds.`
      : ""
  ].filter(Boolean);

  return statements.slice(0, cueLimit(level)).map((text, index) => ({
    id: `capture-cue-${index + 1}`,
    start: evidence.speechGaps[index]?.start ?? index * 5 + 1,
    end: evidence.speechGaps[index]?.end ?? index * 5 + 4,
    text,
    evidenceRefs: [`capture-sample-${index + 1}`],
    confidence: index === 0 ? 0.7 : 0.58,
    needsReview: true,
    notes: `Generated from ${evidence.sampleCount} tab-capture frame/audio sample(s).`,
    impact: index === 0 ? "high" : "medium",
    qaWarnings: ["Tab capture summaries need multimodal backend review before publishing."],
    status: "accepted",
    rememberable: false
  }));
}

function cueLimit(level: DescriptionLevel): number {
  if (level === "minimal") return 2;
  if (level === "balanced") return 3;
  return 5;
}

function firstMeaningfulText(values: string[], title: string): string {
  const normalizedTitle = compactText(title).toLowerCase();
  return values
    .map(compactText)
    .find((value) => value.length > 3 && value.toLowerCase() !== normalizedTitle) ?? "";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimSentence(value: string): string {
  const compacted = compactText(value);
  return compacted.length > 140 ? `${compacted.slice(0, 137).trim()}...` : compacted;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}
