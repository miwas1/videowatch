from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class VideoFrameSample(BaseModel):
    id: str
    timestamp: float
    sourcePath: str
    perceptualHash: str | None = None
    ocrText: list[str] = Field(default_factory=list)


class SceneObservation(BaseModel):
    id: str
    evidenceRefs: list[str]
    text: str
    confidence: float = Field(ge=0, le=1)
    uncertainty: list[str] = Field(default_factory=list)


class EvidenceBundle(BaseModel):
    jobId: str
    page: dict[str, Any]
    frames: list[VideoFrameSample] = Field(default_factory=list)
    transcript: list[dict[str, Any]] = Field(default_factory=list)
    speechGaps: list[dict[str, float]] = Field(default_factory=list)
    observations: list[SceneObservation] = Field(default_factory=list)
    memoryConstraints: list[str] = Field(default_factory=list)
    uncertainty: list[str] = Field(default_factory=list)


class Claim(BaseModel):
    id: str
    text: str
    evidenceRefs: list[str]
    confidence: float = Field(ge=0, le=1)


class RejectedClaim(BaseModel):
    id: str
    reason: str


class AudioDescriptionCue(BaseModel):
    id: str
    start: float
    end: float
    text: str
    evidenceRefs: list[str]
    confidence: float
    needsReview: bool


class QaReport(BaseModel):
    rejectedClaims: list[RejectedClaim] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ReviewItem(BaseModel):
    cueId: str
    reason: str


class PublishedArtifact(BaseModel):
    jobId: str
    cues: list[AudioDescriptionCue]
    webvtt: str
    qaReport: QaReport
    reviewQueue: list[ReviewItem]
    complianceSummary: dict[str, Any]


class BenchmarkResult(BaseModel):
    baseline: dict[str, float]
    society: dict[str, float]
    improvements: dict[str, float]
