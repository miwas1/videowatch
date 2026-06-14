import {
  type AudioActivity,
  type PlaybackCue,
  nextDueCue,
  resetPlayedAfterSeek,
  safeSpeakTime
} from "./timeline";

export type MediaLike = {
  currentTime: number;
  volume: number;
  muted: boolean;
};

export type PlayableAudio = {
  play: () => Promise<void> | void;
  addEventListener?: (type: "ended" | "error", listener: () => void, options?: { once?: boolean }) => void;
};

export type SpeechFallback = {
  speak: (text: string) => void;
};

export type PlaybackEngineOptions = {
  audioFactory: (url: string) => PlayableAudio;
  speechFallback: SpeechFallback;
  audioActivity?: AudioActivity[];
  avoidDialogue?: boolean;
  audioDescriptionEnabled?: boolean;
  ducking?: {
    enabled: boolean;
    level: number;
  };
};

export class AccessibilityPlaybackEngine {
  private cues: PlaybackCue[];
  private readonly media: MediaLike;
  private readonly options: PlaybackEngineOptions;
  private lastTime = 0;

  constructor(media: MediaLike, cues: PlaybackCue[], options: PlaybackEngineOptions) {
    this.media = media;
    this.cues = cues.map((cue) => ({
      ...cue,
      speak_at: safeSpeakTime(cue.speak_at, options.audioActivity ?? [], options.avoidDialogue ?? true)
    }));
    this.options = options;
  }

  tick(): PlaybackCue | null {
    const cue = nextDueCue(this.cues, this.media.currentTime, this.options.audioDescriptionEnabled ?? true);
    if (!cue) {
      this.lastTime = this.media.currentTime;
      return null;
    }

    cue.played = true;
    this.playCue(cue);
    this.lastTime = this.media.currentTime;
    return cue;
  }

  seeked(toTime: number): void {
    this.cues = resetPlayedAfterSeek(this.cues, this.lastTime, toTime);
    this.lastTime = toTime;
  }

  setAudioDescriptionEnabled(enabled: boolean): void {
    this.options.audioDescriptionEnabled = enabled;
  }

  getCues(): PlaybackCue[] {
    return this.cues.map((cue) => ({ ...cue }));
  }

  private playCue(cue: PlaybackCue): void {
    if (!cue.audio_url) {
      this.options.speechFallback.speak(cue.description);
      return;
    }

    const previousVolume = this.media.volume;
    const wasMuted = this.media.muted;
    const restore = () => {
      this.media.volume = previousVolume;
      this.media.muted = wasMuted;
    };

    try {
      if (this.options.ducking?.enabled && !wasMuted) {
        this.media.volume = Math.max(0, Math.min(1, this.options.ducking.level));
      }
      const audio = this.options.audioFactory(cue.audio_url);
      audio.addEventListener?.("ended", restore, { once: true });
      audio.addEventListener?.("error", () => {
        restore();
        this.options.speechFallback.speak(cue.description);
      }, { once: true });
      const result = audio.play();
      if (result instanceof Promise) {
        result.catch(() => {
          restore();
          this.options.speechFallback.speak(cue.description);
        });
      }
    } catch {
      restore();
      this.options.speechFallback.speak(cue.description);
    }
  }
}
