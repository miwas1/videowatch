from describeops_agent_core.society import (
    AgentSociety,
    BaselineAgent,
    benchmark_against_baseline,
)
from describeops_agent_core.runtime import QwenAgentRuntime
from describeops_agent_core.schemas import EvidenceBundle, SceneObservation, VideoFrameSample


def sample_evidence() -> EvidenceBundle:
    return EvidenceBundle(
        jobId="job_demo",
        page={"title": "Lab safety", "url": "https://example.test/lab"},
        frames=[
            VideoFrameSample(id="f1", timestamp=0.0, sourcePath="/tmp/f1.jpg"),
            VideoFrameSample(id="f2", timestamp=5.0, sourcePath="/tmp/f2.jpg", ocrText=["EXIT"]),
        ],
        transcript=[{"id": "t1", "start": 0.0, "end": 2.0, "text": "Welcome."}],
        speechGaps=[{"start": 2.0, "end": 5.0}],
        observations=[
            SceneObservation(
                id="obs_exit",
                evidenceRefs=["f2"],
                text="An illuminated EXIT sign is above the doorway.",
                confidence=0.92,
            )
        ],
        memoryConstraints=["Prefer concise safety-critical cues."],
        uncertainty=[],
    )


def test_agent_society_produces_complete_ad_artifact():
    artifact = AgentSociety().run(sample_evidence())

    assert artifact.jobId == "job_demo"
    assert artifact.webvtt.startswith("WEBVTT")
    assert artifact.cues[0].text
    assert artifact.complianceSummary["agents"] == [
        "intake",
        "scene_analyst",
        "transcript_alignment",
        "description_writer",
        "accessibility_qa",
        "reviewer_routing",
        "memory",
        "publisher",
    ]


def test_qa_rejects_unsupported_visual_claim():
    evidence = sample_evidence()
    artifact = AgentSociety().run(
        evidence,
        draft_claims=[
            {
                "id": "unsupported",
                "text": "A red warning light flashes on the ceiling.",
                "evidenceRefs": ["missing-frame"],
                "confidence": 0.95,
            }
        ],
    )

    assert artifact.qaReport.rejectedClaims[0].id == "unsupported"
    assert "missing evidence" in artifact.qaReport.rejectedClaims[0].reason


def test_reviewer_routing_flags_uncertain_cues():
    evidence = sample_evidence()
    evidence.uncertainty = ["low OCR confidence around f2"]

    artifact = AgentSociety().run(evidence)

    assert artifact.reviewQueue
    assert artifact.reviewQueue[0].reason == "uncertainty"


def test_agent_society_beats_single_agent_baseline_on_three_metrics():
    result = benchmark_against_baseline(BaselineAgent(), AgentSociety(), sample_evidence())

    assert result.improvements["unsupported_claims"] > 0
    assert result.improvements["on_screen_text_recall"] > 0
    assert result.improvements["reviewer_edits_per_minute"] > 0


def test_qwen_agent_runtime_exposes_tools_and_memory_budget():
    runtime = QwenAgentRuntime(model="qwen-plus", memory_token_budget=1200)

    config = runtime.agent_config("accessibility_qa")

    assert config["llm"]["model"] == "qwen-plus"
    assert config["memory"]["token_budget"] == 1200
    assert {tool["name"] for tool in config["tools"]} >= {
        "ffmpeg_probe",
        "ocr_lookup",
        "memory_retrieve",
        "artifact_write",
    }
