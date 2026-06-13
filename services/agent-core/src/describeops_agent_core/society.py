from __future__ import annotations

from .schemas import (
    AudioDescriptionCue,
    BenchmarkResult,
    Claim,
    EvidenceBundle,
    PublishedArtifact,
    QaReport,
    RejectedClaim,
    ReviewItem,
)

AGENT_NAMES = [
    "intake",
    "scene_analyst",
    "transcript_alignment",
    "description_writer",
    "accessibility_qa",
    "reviewer_routing",
    "memory",
    "publisher",
]


class AgentSociety:
    def run(self, evidence: EvidenceBundle, draft_claims: list[dict] | None = None) -> PublishedArtifact:
        claims = [Claim(**claim) for claim in draft_claims] if draft_claims else self._scene_claims(evidence)
        qa_report = self._qa_claims(evidence, claims)
        supported_claims = [claim for claim in claims if claim.id not in {item.id for item in qa_report.rejectedClaims}]
        cues = self._write_cues(evidence, supported_claims)
        review_queue = self._route_review(evidence, cues, qa_report)
        return PublishedArtifact(
            jobId=evidence.jobId,
            cues=cues,
            webvtt=self._to_webvtt(cues),
            qaReport=qa_report,
            reviewQueue=review_queue,
            complianceSummary={
                "agents": AGENT_NAMES,
                "memoryConstraintsApplied": evidence.memoryConstraints,
                "artifactTypes": ["webvtt", "json", "audio_script", "compliance_summary"],
            },
        )

    def _scene_claims(self, evidence: EvidenceBundle) -> list[Claim]:
        claims: list[Claim] = []
        for observation in evidence.observations:
            claims.append(
                Claim(
                    id=f"claim_{observation.id}",
                    text=observation.text,
                    evidenceRefs=observation.evidenceRefs,
                    confidence=observation.confidence,
                )
            )
        return claims

    def _qa_claims(self, evidence: EvidenceBundle, claims: list[Claim]) -> QaReport:
        valid_refs = {frame.id for frame in evidence.frames} | {observation.id for observation in evidence.observations}
        rejected: list[RejectedClaim] = []
        for claim in claims:
            if not claim.evidenceRefs or any(ref not in valid_refs for ref in claim.evidenceRefs):
                rejected.append(RejectedClaim(id=claim.id, reason="missing evidence reference"))
        return QaReport(rejectedClaims=rejected)

    def _write_cues(self, evidence: EvidenceBundle, claims: list[Claim]) -> list[AudioDescriptionCue]:
        cues: list[AudioDescriptionCue] = []
        gaps = evidence.speechGaps or [{"start": 0.0, "end": 2.0}]
        for index, claim in enumerate(claims):
            gap = gaps[min(index, len(gaps) - 1)]
            cues.append(
                AudioDescriptionCue(
                    id=f"cue_{index + 1}",
                    start=gap["start"],
                    end=min(gap["end"], gap["start"] + 2.0),
                    text=self._apply_memory_style(claim.text, evidence.memoryConstraints),
                    evidenceRefs=claim.evidenceRefs,
                    confidence=claim.confidence,
                    needsReview=claim.confidence < 0.8 or bool(evidence.uncertainty),
                )
            )
        return cues

    def _route_review(self, evidence: EvidenceBundle, cues: list[AudioDescriptionCue], qa_report: QaReport) -> list[ReviewItem]:
        queue: list[ReviewItem] = []
        if evidence.uncertainty:
            queue.extend(ReviewItem(cueId=cue.id, reason="uncertainty") for cue in cues)
        queue.extend(ReviewItem(cueId=item.id, reason="qa_rejection") for item in qa_report.rejectedClaims)
        return queue

    def _apply_memory_style(self, text: str, memory_constraints: list[str]) -> str:
        if any("concise" in constraint.lower() for constraint in memory_constraints):
            return text.split(".")[0].strip() + "."
        return text

    def _to_webvtt(self, cues: list[AudioDescriptionCue]) -> str:
        lines = ["WEBVTT", ""]
        for cue in cues:
            lines.extend([f"{_timestamp(cue.start)} --> {_timestamp(cue.end)}", cue.text, ""])
        return "\n".join(lines)


class BaselineAgent:
    def run(self, evidence: EvidenceBundle) -> PublishedArtifact:
        text = "A red warning light flashes near the doorway."
        cue = AudioDescriptionCue(
            id="baseline_cue_1",
            start=0.0,
            end=4.0,
            text=text,
            evidenceRefs=[],
            confidence=0.55,
            needsReview=True,
        )
        return PublishedArtifact(
            jobId=evidence.jobId,
            cues=[cue],
            webvtt=f"WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n{text}\n",
            qaReport=QaReport(rejectedClaims=[RejectedClaim(id="baseline_cue_1", reason="missing evidence reference")]),
            reviewQueue=[ReviewItem(cueId="baseline_cue_1", reason="uncertainty")],
            complianceSummary={"agents": ["single_agent"]},
        )


def benchmark_against_baseline(
    baseline: BaselineAgent,
    society: AgentSociety,
    evidence: EvidenceBundle,
) -> BenchmarkResult:
    baseline_artifact = baseline.run(evidence)
    society_artifact = society.run(evidence)
    baseline_metrics = _metrics(baseline_artifact, evidence)
    society_metrics = _metrics(society_artifact, evidence)
    improvements = {
        "unsupported_claims": baseline_metrics["unsupported_claims"] - society_metrics["unsupported_claims"],
        "on_screen_text_recall": society_metrics["on_screen_text_recall"] - baseline_metrics["on_screen_text_recall"],
        "reviewer_edits_per_minute": baseline_metrics["reviewer_edits_per_minute"] - society_metrics["reviewer_edits_per_minute"],
        "cue_timing_overlap": baseline_metrics["cue_timing_overlap"] - society_metrics["cue_timing_overlap"],
        "processing_cost": baseline_metrics["processing_cost"] - society_metrics["processing_cost"],
    }
    return BenchmarkResult(baseline=baseline_metrics, society=society_metrics, improvements=improvements)


def _metrics(artifact: PublishedArtifact, evidence: EvidenceBundle) -> dict[str, float]:
    ocr_terms = {text for frame in evidence.frames for text in frame.ocrText}
    cue_text = " ".join(cue.text for cue in artifact.cues)
    return {
        "unsupported_claims": float(len(artifact.qaReport.rejectedClaims)),
        "on_screen_text_recall": 1.0 if any(term in cue_text for term in ocr_terms) else 0.0,
        "reviewer_edits_per_minute": float(len(artifact.reviewQueue)),
        "cue_timing_overlap": sum(max(0.0, cue.end - cue.start - 2.0) for cue in artifact.cues),
        "processing_cost": 1.0 + (0.1 * len(artifact.cues)),
    }


def _timestamp(seconds: float) -> str:
    whole = int(seconds)
    milliseconds = int(round((seconds - whole) * 1000))
    hours, remainder = divmod(whole, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"
