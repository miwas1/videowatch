from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from .schemas import (
    EvidenceBundle,
    PageAccessibilitySnapshot,
    SceneObservation,
    SpeechGap,
    TranscriptSegment,
    VideoFrameSample,
)


def sanitize_snapshot(snapshot: PageAccessibilitySnapshot) -> PageAccessibilitySnapshot:
    cleaned = snapshot.model_copy(deep=True)
    parts = urlsplit(cleaned.url)
    cleaned.url = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    cleaned.cookies = {}
    cleaned.localStorage = {}
    cleaned.visibleText = [
        text for text in cleaned.visibleText if "cookie" not in text.lower() and "token=" not in text.lower()
    ]
    return cleaned


def build_evidence_bundle(
    *,
    job_id: str,
    snapshot: PageAccessibilitySnapshot,
    frames: list[VideoFrameSample],
    transcript: list[TranscriptSegment | dict],
    observations: list[SceneObservation | dict],
    low_bandwidth: bool = False,
    memory_constraints: list[str] | None = None,
    uncertainty: list[str] | None = None,
) -> EvidenceBundle:
    parsed_transcript = [segment if isinstance(segment, TranscriptSegment) else TranscriptSegment(**segment) for segment in transcript]
    parsed_observations = [
        observation if isinstance(observation, SceneObservation) else _observation_from_dict(observation)
        for observation in observations
    ]
    selected_frames = _select_frames(frames, low_bandwidth=low_bandwidth)

    return EvidenceBundle(
        jobId=job_id,
        mode="low_bandwidth" if low_bandwidth else "standard",
        page=sanitize_snapshot(snapshot),
        frames=selected_frames,
        transcript=parsed_transcript,
        observations=parsed_observations,
        speechGaps=_detect_speech_gaps(parsed_transcript),
        memoryConstraints=memory_constraints or [],
        uncertainty=uncertainty or [],
        privacy={"redactedFields": ["cookies", "localStorage", "url.query"]},
    )


def _select_frames(frames: list[VideoFrameSample], *, low_bandwidth: bool) -> list[VideoFrameSample]:
    if not low_bandwidth or len(frames) <= 4:
        return frames
    step = max(2, len(frames) // 4)
    selected = frames[::step]
    if selected[-1].id != frames[-1].id:
        selected.append(frames[-1])
    return selected


def _detect_speech_gaps(transcript: list[TranscriptSegment]) -> list[SpeechGap]:
    if not transcript:
        return []
    ordered = sorted(transcript, key=lambda segment: segment.start)
    gaps: list[SpeechGap] = []
    for current, following in zip(ordered, ordered[1:]):
        if following.start > current.end:
            gaps.append(SpeechGap(start=current.end, end=following.start))
    return gaps


def _observation_from_dict(value: dict) -> SceneObservation:
    if "evidenceRefs" not in value and "frameIds" in value:
        value = {**value, "evidenceRefs": value["frameIds"]}
    return SceneObservation(**value)
