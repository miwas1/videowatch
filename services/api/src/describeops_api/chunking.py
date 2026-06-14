from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .schemas import ChunkSemanticMemory, QwenTimelineEvent, SectionSemanticMemory, VideoChunk


def plan_video_chunks(duration_seconds: float, *, chunk_seconds: float = 45, overlap_seconds: float = 5) -> list[VideoChunk]:
    if duration_seconds <= 0:
        return []
    if chunk_seconds <= overlap_seconds:
        raise ValueError("chunk_seconds must be greater than overlap_seconds")

    chunks: list[VideoChunk] = []
    start = 0.0
    index = 1
    step = chunk_seconds - overlap_seconds
    while start < duration_seconds:
        end = min(duration_seconds, start + chunk_seconds)
        chunks.append(
            VideoChunk(
                chunk_id=f"chunk-{index:04d}",
                start=round(start, 3),
                end=round(end, 3),
                overlapPreviousSeconds=0 if index == 1 else overlap_seconds,
            )
        )
        if end >= duration_seconds:
            break
        start += step
        index += 1
    return chunks


def build_chunk_memory(
    *,
    chunk_id: str,
    start: float,
    end: float,
    summary: str,
    events: list[QwenTimelineEvent],
    ocr_keywords: list[str],
) -> ChunkSemanticMemory:
    entities = sorted({
        word.strip(".,:;()[]").lower()
        for event in events
        for word in event.description.split()
        if len(word.strip(".,:;()[]")) > 5
    })[:8]
    important_events = [event.start for event in events if event.importance == "high"]
    return ChunkSemanticMemory(
        chunk_id=chunk_id,
        start=start,
        end=end,
        summary=summary,
        entities=entities,
        important_events=important_events,
        ocr_keywords=ocr_keywords,
    )


def build_section_memory(section_index: int, chunks: list[ChunkSemanticMemory]) -> SectionSemanticMemory:
    if not chunks:
        raise ValueError("section memory requires at least one chunk")
    return SectionSemanticMemory(
        section_id=f"section-{section_index:04d}",
        start=chunks[0].start,
        end=chunks[-1].end,
        summary=" ".join(chunk.summary for chunk in chunks),
        key_events=[event for chunk in chunks for event in chunk.important_events],
    )


def retrieve_question_context(
    *,
    current_time: float,
    chunks: list[ChunkSemanticMemory],
    sections: list[SectionSemanticMemory],
    question: str,
) -> dict:
    current_index = next(
        (index for index, chunk in enumerate(chunks) if chunk.start <= current_time <= chunk.end),
        0,
    )
    nearby = chunks[max(0, current_index - 2): current_index + 2]
    lower_question = question.lower()
    matching_ocr = [
        keyword
        for chunk in chunks
        for keyword in chunk.ocr_keywords
        if keyword.lower() in lower_question
    ]
    return {
        "current_time": current_time,
        "nearby_chunk_summaries": [chunk.summary for chunk in nearby],
        "matching_ocr": matching_ocr,
        "section_summaries": [section.summary for section in sections if section.start <= current_time],
        "global_video_summary": " ".join(section.summary for section in sections[:3]),
    }


@dataclass
class ChunkRetryQueue:
    queued: list[str] = field(default_factory=list)
    retryable: set[str] = field(default_factory=set)
    partialTimelineUsable: bool = True
    attempts: dict[str, int] = field(default_factory=dict)

    def enqueue(self, chunk_id: str) -> None:
        if chunk_id not in self.queued:
            self.queued.append(chunk_id)

    def mark_rate_limited(self, chunk_id: str) -> int:
        self.enqueue(chunk_id)
        self.retryable.add(chunk_id)
        self.attempts[chunk_id] = self.attempts.get(chunk_id, 0) + 1
        return min(60, 2 ** self.attempts[chunk_id])

    def mark_timeout(self, chunk_id: str) -> dict:
        self.enqueue(chunk_id)
        self.retryable.add(chunk_id)
        return {
            "spinner": "stopped",
            "partialTimelineUsable": self.partialTimelineUsable,
            "failedChunk": chunk_id,
            "retryable": True,
        }


@dataclass
class RealtimeReconnectState:
    status: Literal["connected", "reconnecting", "failed"] = "connected"
    reconnectAttempts: int = 0

    def disconnected(self) -> str:
        self.status = "reconnecting"
        self.reconnectAttempts += 1
        return "Reconnecting accessibility assistant..."

    def reconnected(self) -> None:
        self.status = "connected"
