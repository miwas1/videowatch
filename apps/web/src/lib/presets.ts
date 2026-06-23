export type WorkflowPreset = {
  id: string;
  label: string;
  tagline: string;
  outputLabel: string;
  blockEmphasis: string[];
  exportDefault: string;
};

export const PRESETS: WorkflowPreset[] = [
  {
    id: "reading_document",
    label: "Accessible Learning",
    tagline: "Readable lesson with full visual context",
    outputLabel: "Reading Document",
    blockEmphasis: ["visual_context", "explanation", "example"],
    exportDefault: "markdown",
  },
  {
    id: "course_notes",
    label: "Course Notes",
    tagline: "Timestamped notes, examples, and key terms",
    outputLabel: "Lecture Notes",
    blockEmphasis: ["intro", "explanation", "example", "takeaway"],
    exportDefault: "markdown",
  },
  {
    id: "audio_description",
    label: "Audio Description",
    tagline: "Spoken cue script for blind / low-vision viewers",
    outputLabel: "Description Script",
    blockEmphasis: ["visual_context", "demo_step"],
    exportDefault: "script",
  },
  {
    id: "tutorial_extraction",
    label: "Developer Tutorial",
    tagline: "Code, commands, UI steps, and explanations",
    outputLabel: "Tutorial Doc",
    blockEmphasis: ["code", "demo_step", "explanation"],
    exportDefault: "markdown",
  },
  {
    id: "compliance_report",
    label: "Compliance Review",
    tagline: "Accessibility gaps, missing context, risk flags",
    outputLabel: "Compliance Report",
    blockEmphasis: ["visual_context"],
    exportDefault: "report",
  },
  {
    id: "video_to_document",
    label: "Video → Document",
    tagline: "Article, Markdown export, or knowledge base entry",
    outputLabel: "Article",
    blockEmphasis: ["intro", "explanation", "takeaway"],
    exportDefault: "markdown",
  },
  {
    id: "meeting_reconstruction",
    label: "Meeting / Demo",
    tagline: "Decisions, demo steps, and action items",
    outputLabel: "Meeting Reconstruction",
    blockEmphasis: ["demo_step", "takeaway"],
    exportDefault: "markdown",
  },
  {
    id: "assistive_cues",
    label: "Assistive Companion",
    tagline: "\"What's happening now?\" cues for live or recorded video",
    outputLabel: "Cue Sheet",
    blockEmphasis: ["visual_context", "timestamp_anchor"],
    exportDefault: "script",
  },
  {
    id: "research_digest",
    label: "Research Digest",
    tagline: "Claims, evidence, quotes, and key moments",
    outputLabel: "Research Digest",
    blockEmphasis: ["quote", "example", "takeaway"],
    exportDefault: "markdown",
  },
  {
    id: "localization_brief",
    label: "Localization Prep",
    tagline: "Translatable script, terminology, and visual notes",
    outputLabel: "Localization Brief",
    blockEmphasis: ["explanation", "quote"],
    exportDefault: "brief",
  },
];

export function presetById(id: string): WorkflowPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
