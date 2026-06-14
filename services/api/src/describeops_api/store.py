from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .schemas import AnalysisStage, JobProgress, JobRecord, MemoryPreference


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._memory: dict[str, MemoryPreference] = {}

    def add(self, job: JobRecord) -> JobRecord:
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> JobRecord | None:
        return self._jobs.get(job_id)

    def update_status(self, job_id: str, status: str) -> JobRecord:
        job = self.require(job_id)
        job.status = status  # type: ignore[assignment]
        job.updatedAt = datetime.now(timezone.utc)
        return job

    def update_progress(
        self,
        job_id: str,
        *,
        stage: AnalysisStage,
        message: str,
        percent: int,
        current_chunk: int | None = None,
        total_chunks: int | None = None,
        partial_cue_count: int | None = None,
    ) -> JobRecord:
        job = self.require(job_id)
        now = datetime.now(timezone.utc)
        job.progress = JobProgress(
            stage=stage,
            message=message,
            percent=max(0, min(100, percent)),
            currentChunk=job.progress.currentChunk if current_chunk is None else current_chunk,
            totalChunks=job.progress.totalChunks if total_chunks is None else total_chunks,
            partialCueCount=job.progress.partialCueCount if partial_cue_count is None else partial_cue_count,
            updatedAt=now,
        )
        job.updatedAt = now
        return job

    def add_asset(self, job_id: str, asset: dict[str, Any]) -> JobRecord:
        job = self.require(job_id)
        job.assets.append(asset)
        job.updatedAt = datetime.now(timezone.utc)
        return job

    def add_artifact(self, job_id: str, artifact: dict[str, Any]) -> JobRecord:
        job = self.require(job_id)
        job.artifacts.append(artifact)
        job.updatedAt = datetime.now(timezone.utc)
        return job

    def add_review(self, job_id: str, review: dict[str, Any]) -> JobRecord:
        job = self.require(job_id)
        job.review.append(review)
        job.updatedAt = datetime.now(timezone.utc)
        return job

    def save_memory(self, memory: MemoryPreference) -> MemoryPreference:
        self._memory[memory.id] = memory
        return memory

    def list_memory(
        self,
        *,
        user_id: str | None = None,
        org_id: str | None = None,
        job_id: str | None = None,
        min_confidence: float = 0.7,
    ) -> list[MemoryPreference]:
        now = datetime.now(timezone.utc)
        records = []
        for memory in self._memory.values():
            if memory.deletedAt is not None:
                continue
            if memory.expiresAt is not None and memory.expiresAt <= now:
                continue
            if memory.confidence < min_confidence:
                continue
            if memory.scope == "user" and memory.subjectId != user_id:
                continue
            if memory.scope == "org" and memory.subjectId != org_id:
                continue
            if memory.scope == "job" and memory.subjectId != job_id:
                continue
            if memory.kind == "content_fact" and memory.scope != "job":
                continue
            records.append(memory)

        return sorted(records, key=lambda item: (item.confidence, item.createdAt), reverse=True)

    def delete_memory(self, memory_id: str) -> bool:
        memory = self._memory.get(memory_id)
        if memory is None:
            return False
        memory.deletedAt = datetime.now(timezone.utc)
        return True

    def require(self, job_id: str) -> JobRecord:
        job = self.get(job_id)
        if not job:
            raise KeyError(job_id)
        return job
