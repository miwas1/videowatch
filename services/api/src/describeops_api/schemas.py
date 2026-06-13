from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


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
    inaccessibleRegions: list[InaccessibleRegion] = Field(default_factory=list)
    cookies: dict[str, str] = Field(default_factory=dict)
    localStorage: dict[str, str] = Field(default_factory=dict)


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


class JobRecord(ApiModel):
    id: str
    source: str
    mode: Literal["standard", "low_bandwidth"] = "standard"
    status: Literal["queued", "running", "needs_review", "complete", "failed"] = "queued"
    traceId: str
    createdAt: datetime
    updatedAt: datetime
    snapshot: PageAccessibilitySnapshot | None = None
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
