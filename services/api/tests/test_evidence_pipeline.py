from describeops_api.evidence import build_evidence_bundle, sanitize_snapshot
from describeops_api.media import create_media_preprocessing_plan
from describeops_api.schemas import PageAccessibilitySnapshot, VideoFrameSample


def snapshot_with_private_fields() -> PageAccessibilitySnapshot:
    return PageAccessibilitySnapshot(
        url="https://example.test/lesson?token=secret",
        title="Safety Lesson",
        media=[],
        headings=["Safety"],
        landmarks=["main"],
        visibleText=["Welcome", "session cookie abc should not be retained"],
        transcriptText=["Speaker: look at the ladder"],
        captions=["English"],
        inaccessibleRegions=[],
        cookies={"session": "secret"},
        localStorage={"auth": "secret"},
    )


def test_page_without_video_produces_accessibility_snapshot():
    snapshot = sanitize_snapshot(snapshot_with_private_fields())

    assert snapshot.title == "Safety Lesson"
    assert snapshot.media == []
    assert snapshot.cookies == {}
    assert snapshot.localStorage == {}
    assert "token=secret" not in snapshot.url


def test_low_bandwidth_evidence_reduces_frame_volume():
    frames = [
        VideoFrameSample(id=f"frame-{index}", timestamp=index * 2.0, sourcePath=f"/tmp/{index}.jpg")
        for index in range(12)
    ]

    normal = build_evidence_bundle(
        job_id="job_demo",
        snapshot=snapshot_with_private_fields(),
        frames=frames,
        transcript=[],
        observations=[],
        low_bandwidth=False,
    )
    low = build_evidence_bundle(
        job_id="job_demo",
        snapshot=snapshot_with_private_fields(),
        frames=frames,
        transcript=[],
        observations=[],
        low_bandwidth=True,
    )

    assert len(low.frames) < len(normal.frames)
    assert low.mode == "low_bandwidth"
    assert low.privacy.redactedFields == ["cookies", "localStorage", "url.query"]


def test_sample_video_context_builds_single_evidence_bundle():
    bundle = build_evidence_bundle(
        job_id="job_video",
        snapshot=snapshot_with_private_fields(),
        frames=[
            VideoFrameSample(id="f1", timestamp=0.0, sourcePath="/tmp/f1.jpg", perceptualHash="abc"),
            VideoFrameSample(id="f2", timestamp=8.0, sourcePath="/tmp/f2.jpg", ocrText=["EXIT"]),
        ],
        transcript=[
            {"id": "t1", "start": 0.0, "end": 3.0, "text": "Welcome."},
            {"id": "t2", "start": 10.0, "end": 12.0, "text": "Notice the exit sign."},
        ],
        observations=[{"id": "o1", "frameIds": ["f2"], "text": "Exit sign visible", "confidence": 0.9}],
        memory_constraints=["Keep cues under two seconds."],
    )

    assert bundle.jobId == "job_video"
    assert len(bundle.frames) == 2
    assert bundle.speechGaps[0].start == 3.0
    assert bundle.observations[0].evidenceRefs == ["f2"]
    assert bundle.memoryConstraints == ["Keep cues under two seconds."]


def test_media_preprocessing_plan_switches_to_fixed_interval_in_low_bandwidth():
    standard = create_media_preprocessing_plan(
        media_path="/authorized/demo.mp4",
        duration_seconds=120,
        consent_confirmed=True,
        low_bandwidth=False,
    )
    low = create_media_preprocessing_plan(
        media_path="/authorized/demo.mp4",
        duration_seconds=120,
        consent_confirmed=True,
        low_bandwidth=True,
    )

    assert standard.frameSamplingMode == "scene_change"
    assert "select='gt(scene,0.35)'" in " ".join(standard.commands[0])
    assert low.frameSamplingMode == "fixed_interval"
    assert low.targetFrameCount < standard.targetFrameCount
    assert low.transcription.engine == "faster-whisper"
    assert low.ocr.enabled is True
