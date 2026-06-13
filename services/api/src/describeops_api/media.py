from __future__ import annotations

from pydantic import BaseModel


class TranscriptionPlan(BaseModel):
    engine: str
    audioPath: str
    cloudFallback: bool


class OcrPlan(BaseModel):
    enabled: bool
    frameGlob: str


class MediaPreprocessingPlan(BaseModel):
    mediaPath: str
    frameSamplingMode: str
    targetFrameCount: int
    commands: list[list[str]]
    transcription: TranscriptionPlan
    extractsSubtitles: bool
    ocr: OcrPlan


def create_media_preprocessing_plan(
    *,
    media_path: str,
    duration_seconds: float,
    consent_confirmed: bool,
    low_bandwidth: bool,
) -> MediaPreprocessingPlan:
    if not consent_confirmed:
        raise ValueError("Media preprocessing requires explicit user authorization")

    frame_dir = "artifacts/frames"
    audio_path = "artifacts/audio.wav"
    if low_bandwidth:
        interval = max(5, round(duration_seconds / 8))
        frame_filter = f"fps=1/{interval}"
        target_count = max(1, round(duration_seconds / interval))
        mode = "fixed_interval"
    else:
        frame_filter = "select='gt(scene,0.35)'"
        target_count = max(4, round(duration_seconds / 6))
        mode = "scene_change"

    commands = [
        [
            "ffmpeg",
            "-i",
            media_path,
            "-vf",
            frame_filter,
            "-vsync",
            "vfr",
            f"{frame_dir}/frame-%05d.jpg",
        ],
        ["ffmpeg", "-i", media_path, "-vn", "-ac", "1", "-ar", "16000", audio_path],
        ["ffmpeg", "-i", media_path, "-map", "0:s:0?", "artifacts/subtitles.vtt"],
    ]

    return MediaPreprocessingPlan(
        mediaPath=media_path,
        frameSamplingMode=mode,
        targetFrameCount=target_count,
        commands=commands,
        transcription=TranscriptionPlan(engine="faster-whisper", audioPath=audio_path, cloudFallback=True),
        extractsSubtitles=True,
        ocr=OcrPlan(enabled=True, frameGlob=f"{frame_dir}/*.jpg"),
    )
