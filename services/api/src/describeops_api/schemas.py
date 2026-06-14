from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


VideoPlatform = Literal[
    "youtube",
    "tiktok",
    "instagram",
    "twitter",
    "facebook",
    "vimeo",
    "twitch",
    "generic",
]


class DetectedMedia(ApiModel):
    id: str
    kind: Literal["video", "audio", "embedded-player"]
    label: str
    currentTime: float | None = None
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    hasCaptions: bool = False
    source: str | None = None
    platform: VideoPlatform = "generic"
    isSocial: bool = False
    isFocused: bool = False
    isPlaying: bool = False


class InaccessibleRegion(ApiModel):
    id: str
    kind: Literal["canvas", "iframe", "unknown"]
    label: str
    reason: str


class PageAccessibilitySnapshot(ApiModel):
    url: str = ""
    title: str = "Untitled page"
    media: list[DetectedMedia] = Field(default_factory=list)
    headings: list[str] = Field(default_factory=list)
    landmarks: list[str] = Field(default_factory=list)
    visibleText: list[str] = Field(default_factory=list)
    transcriptText: list[str] = Field(default_factory=list)
    captions: list[str] = Field(default_factory=list)
    liveCaptionText: list[str] = Field(default_factory=list)
    platform: VideoPlatform = "generic"
    inaccessibleRegions: list[InaccessibleRegion] = Field(default_factory=list)
    cookies: dict[str, str] = Field(default_factory=dict)
    localStorage: dict[str, str] = Field(default_factory=dict)


MediaSourceKind = Literal["direct_url", "uploaded_asset", "tab_capture", "embedded_player", "page_snapshot"]
AnalysisStage = Literal[
    "queued",
    "resolving_media",
    "preparing_media",
    "sampling_frames",
    "analyzing_chunk",
    "building_playback",
    "complete",
    "failed",
]


class MediaAnalysisFeatures(ApiModel):
    ocr: bool = True
    avoidDialogue: bool = True
    audioDescription: bool = True


class MediaAnalysisRequest(ApiModel):
    mediaId: str | None = None
    sourceKind: MediaSourceKind = "page_snapshot"
    videoUrl: str | None = None
    pageUrl: str = ""
    title: str = ""
    duration: float = 0
    currentTime: float = 0
    platform: VideoPlatform = "generic"
    detailLevel: Literal["minimal", "balanced", "detailed"] = "balanced"
    features: MediaAnalysisFeatures = Field(default_factory=MediaAnalysisFeatures)
    frameSamples: list[str] = Field(default_factory=list)


class JobProgress(ApiModel):
    stage: AnalysisStage = "queued"
    message: str = "Queued for analysis."
    percent: int = Field(default=0, ge=0, le=100)
    currentChunk: int = 0
    totalChunks: int = 0
    partialCueCount: int = 0
    updatedAt: datetime | None = None


class VideoFrameSample(ApiModel):
    id: str
    timestamp: float
    sourcePath: str
    perceptualHash: str | None = None
    ocrText: list[str] = Field(default_factory=list)


class TranscriptSegment(ApiModel):
    id: str
    start: float
    end: float
    text: str
    speaker: str | None = None

    @field_validator("end")
    @classmethod
    def end_after_start(cls, value: float, info: Any) -> float:
        start = info.data.get("start")
        if start is not None and value < start:
            raise ValueError("end must be greater than or equal to start")
        return value


class SpeechGap(ApiModel):
    start: float
    end: float


class SceneObservation(ApiModel):
    id: str
    evidenceRefs: list[str] = Field(default_factory=list)
    text: str
    confidence: float = Field(ge=0, le=1)
    uncertainty: list[str] = Field(default_factory=list)


class AudioDescriptionCue(ApiModel):
    id: str
    start: float
    end: float
    text: str
    evidenceRefs: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    needsReview: bool
    notes: str | None = None


class PrivacySummary(ApiModel):
    redactedFields: list[str]


class EvidenceBundle(ApiModel):
    jobId: str
    mode: Literal["standard", "low_bandwidth"] = "standard"
    page: PageAccessibilitySnapshot
    frames: list[VideoFrameSample] = Field(default_factory=list)
    transcript: list[TranscriptSegment] = Field(default_factory=list)
    observations: list[SceneObservation] = Field(default_factory=list)
    speechGaps: list[SpeechGap] = Field(default_factory=list)
    cues: list[AudioDescriptionCue] = Field(default_factory=list)
    memoryConstraints: list[str] = Field(default_factory=list)
    uncertainty: list[str] = Field(default_factory=list)
    privacy: PrivacySummary


class JobCreateRequest(ApiModel):
    source: Literal["browser", "native-companion", "api"] = "api"
    mode: Literal["standard", "low_bandwidth"] = "standard"
    snapshot: PageAccessibilitySnapshot | None = None
    analysisRequest: MediaAnalysisRequest | None = None


class JobRecord(ApiModel):
    id: str
    source: str
    mode: Literal["standard", "low_bandwidth"] = "standard"
    status: Literal["queued", "running", "needs_review", "complete", "failed"] = "queued"
    traceId: str
    createdAt: datetime
    updatedAt: datetime
    snapshot: PageAccessibilitySnapshot | None = None
    analysisRequest: MediaAnalysisRequest | None = None
    progress: JobProgress = Field(default_factory=JobProgress)
    assets: list[dict[str, Any]] = Field(default_factory=list)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    review: list[dict[str, Any]] = Field(default_factory=list)

    @classmethod
    def create(cls, request: JobCreateRequest) -> "JobRecord":
        now = datetime.now(timezone.utc)
        return cls(
            id=new_id("job"),
            source=request.source,
            mode=request.mode,
            traceId=new_id("trc"),
            createdAt=now,
            updatedAt=now,
            snapshot=request.snapshot,
            analysisRequest=request.analysisRequest,
            progress=JobProgress(updatedAt=now),
        )


class ReviewSubmission(ApiModel):
    cueId: str | None = None
    text: str
    confidence: float = Field(ge=0, le=1, default=1)
    notes: str | None = None


class MemoryPreference(ApiModel):
    id: str
    scope: Literal["user", "org", "job"]
    subjectId: str
    kind: Literal[
        "voice_style",
        "org_standard",
        "glossary",
        "pronunciation",
        "reviewer_correction",
        "ignored_preference",
        "content_fact",
    ] = "voice_style"
    value: str
    confidence: float = Field(ge=0, le=1, default=0.8)
    sourceJobId: str
    reviewerId: str | None = None
    createdAt: datetime
    expiresAt: datetime | None = None
    deletedAt: datetime | None = None


class MemoryPreferenceRequest(ApiModel):
    scope: Literal["user", "org", "job"]
    subjectId: str
    preference: str
    kind: Literal[
        "voice_style",
        "org_standard",
        "glossary",
        "pronunciation",
        "reviewer_correction",
        "ignored_preference",
        "content_fact",
    ] = "voice_style"
    confidence: float = Field(ge=0, le=1, default=0.8)
    sourceJobId: str = "manual"
    reviewerId: str | None = None
    expiresAt: datetime | None = None


class MemoryPreferenceResponse(ApiModel):
    stored: bool
    key: str
    memory: MemoryPreference


class MemoryPreferenceListResponse(ApiModel):
    memories: list[MemoryPreference]


class QwenTranscriptItem(ApiModel):
    start: float
    end: float
    text: str


class QwenOcrItem(ApiModel):
    time: float
    text: str


class QwenVisualChunkRequest(ApiModel):
    video_id: str
    chunk_id: str
    start: float
    end: float
    frames: list[str]
    transcript: list[QwenTranscriptItem] = Field(default_factory=list)
    ocr: list[QwenOcrItem] = Field(default_factory=list)

    @field_validator("end")
    @classmethod
    def chunk_end_after_start(cls, value: float, info: Any) -> float:
        start = info.data.get("start")
        if start is not None and value <= start:
            raise ValueError("chunk end must be greater than start")
        return value


class QwenTimelineEvent(ApiModel):
    start: float
    end: float
    type: Literal["visual_action", "ocr", "scene", "summary"]
    description: str
    importance: Literal["low", "medium", "high"]

    @field_validator("description")
    @classmethod
    def event_description_required(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("timeline event description is required")
        return value

    @field_validator("end")
    @classmethod
    def event_end_after_start(cls, value: float, info: Any) -> float:
        start = info.data.get("start")
        if start is not None and value < start:
            raise ValueError("timeline event end must be greater than or equal to start")
        return value


class QwenChunkAnalysisResponse(ApiModel):
    events: list[QwenTimelineEvent]
    chunk_summary: str


class QwenTtsRequest(ApiModel):
    text: str
    voice: str = "default"
    speed: float = Field(default=1.0, gt=0, le=4)


class QwenTtsResult(ApiModel):
    status: Literal["ready", "failed"]
    durationMs: int = Field(ge=0)
    format: Literal["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"]
    audioUrl: str | None = None
    audioBytes: bytes | None = None


class VideoChunk(ApiModel):
    chunk_id: str
    start: float
    end: float
    overlapPreviousSeconds: float = 0


class ChunkSemanticMemory(ApiModel):
    chunk_id: str
    start: float
    end: float
    summary: str
    entities: list[str] = Field(default_factory=list)
    important_events: list[float] = Field(default_factory=list)
    ocr_keywords: list[str] = Field(default_factory=list)


class SectionSemanticMemory(ApiModel):
    section_id: str
    start: float
    end: float
    summary: str
    key_events: list[float] = Field(default_factory=list)
