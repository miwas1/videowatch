import { describe, expect, it, vi } from "vitest";
import { AccessibilityPlaybackEngine } from "./playback-engine";
import {
  ocrTextNear,
  resetPlayedAfterSeek,
  safeSpeakTime,
  sanitizeTimeline
} from "./timeline";

describe("accessibility timeline", () => {
  it("accepts a valid backend timeline and preserves timed OCR events", () => {
    const timeline = sanitizeTimeline([
      {
        start: 5.0,
        end: 8.0,
        speak_at: 8.2,
        type: "visual_action",
        description: "A woman places a bowl on the counter.",
        importance: "high",
        audio_url: "/audio/clip-001.mp3"
      },
      {
        start: 18.0,
        end: 20.0,
        speak_at: 21.0,
        type: "ocr",
        description: "Text on screen: Add two cups of flour.",
        importance: "high",
        audio_url: "/audio/clip-002.mp3"
      }
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline[0].speak_at).toBe(8.2);
    expect(timeline[1].type).toBe("ocr");
  });

  it("filters invalid timeline items and keeps valid partial results", () => {
    const timeline = sanitizeTimeline([
      { description: "", speak_at: 10 },
      { description: "Something happens", speak_at: -3 },
      { description: "Something happens" },
      {
        start: 10,
        end: 12,
        speak_at: 12.5,
        type: "visual_action",
        description: "A man opens the door.",
        importance: "medium"
      }
    ]);

    expect(timeline).toHaveLength(1);
    expect(timeline[0].description).toBe("A man opens the door.");
  });

  it("delays descriptions until a safe dialogue gap when requested", () => {
    expect(safeSpeakTime(12, [
      { start: 11, end: 14, type: "speech" },
      { start: 14, end: 16, type: "silence" }
    ], true)).toBe(14);
  });

  it("finds OCR text near the current timestamp for read-screen-text", () => {
    const timeline = sanitizeTimeline([
      {
        start: 30,
        end: 35,
        speak_at: 35.5,
        type: "ocr",
        text: "Cook for two minutes on each side.",
        description: "Text on screen: Cook for two minutes on each side.",
        importance: "high"
      }
    ]);

    expect(ocrTextNear(timeline, 34)).toContain("Cook for two minutes");
  });

  it("resets played flags after a meaningful backward seek", () => {
    const [cue] = sanitizeTimeline([
      {
        start: 9,
        end: 11,
        speak_at: 10,
        type: "visual_action",
        description: "A man opens the door.",
        importance: "high"
      }
    ]);

    const reset = resetPlayedAfterSeek([{ ...cue, played: true }], 20, 8);

    expect(reset[0].played).toBe(false);
  });
});

describe("AccessibilityPlaybackEngine", () => {
  it("plays description audio once when the video reaches the cue timestamp", () => {
    const play = vi.fn();
    const media = { currentTime: 10, volume: 0.8, muted: false };
    const [cue] = sanitizeTimeline([
      {
        start: 9,
        end: 11,
        speak_at: 10,
        type: "visual_action",
        description: "A man opens the door.",
        importance: "high",
        audio_url: "/audio/door.mp3"
      }
    ]);
    const engine = new AccessibilityPlaybackEngine(media, [cue], {
      audioFactory: () => ({ play }),
      speechFallback: { speak: vi.fn() },
      ducking: { enabled: false, level: 0.35 }
    });

    engine.tick();
    engine.tick();

    expect(play).toHaveBeenCalledTimes(1);
  });

  it("skips scheduled descriptions while AD is off", () => {
    const play = vi.fn();
    const media = { currentTime: 10, volume: 0.8, muted: false };
    const [cue] = sanitizeTimeline([
      {
        start: 9,
        end: 11,
        speak_at: 10,
        type: "visual_action",
        description: "A man opens the door.",
        importance: "high",
        audio_url: "/audio/door.mp3"
      }
    ]);
    const engine = new AccessibilityPlaybackEngine(media, [cue], {
      audioFactory: () => ({ play }),
      speechFallback: { speak: vi.fn() },
      audioDescriptionEnabled: false
    });

    expect(engine.tick()).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it("ducks volume only while clip audio is playing and restores the previous state", () => {
    const listeners = new Map<string, () => void>();
    const media = { currentTime: 10, volume: 0.8, muted: false };
    const [cue] = sanitizeTimeline([
      {
        start: 9,
        end: 11,
        speak_at: 10,
        type: "visual_action",
        description: "A man opens the door.",
        importance: "high",
        audio_url: "/audio/door.mp3"
      }
    ]);
    const engine = new AccessibilityPlaybackEngine(media, [cue], {
      audioFactory: () => ({
        play: vi.fn(),
        addEventListener: (type, listener) => listeners.set(type, listener)
      }),
      speechFallback: { speak: vi.fn() },
      ducking: { enabled: true, level: 0.35 }
    });

    engine.tick();
    expect(media.volume).toBe(0.35);

    listeners.get("ended")?.();
    expect(media.volume).toBe(0.8);
    expect(media.muted).toBe(false);
  });

  it("falls back to browser speech when clip playback fails", () => {
    const speak = vi.fn();
    const media = { currentTime: 10, volume: 0.8, muted: true };
    const [cue] = sanitizeTimeline([
      {
        start: 9,
        end: 11,
        speak_at: 10,
        type: "visual_action",
        description: "A man opens the door.",
        importance: "high",
        audio_url: "/audio/door.mp3"
      }
    ]);
    const engine = new AccessibilityPlaybackEngine(media, [cue], {
      audioFactory: () => {
        throw new Error("Qwen TTS audio unavailable");
      },
      speechFallback: { speak },
      ducking: { enabled: true, level: 0.35 }
    });

    engine.tick();

    expect(speak).toHaveBeenCalledWith("A man opens the door.");
    expect(media.muted).toBe(true);
    expect(media.volume).toBe(0.8);
  });
});
