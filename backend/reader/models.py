from __future__ import annotations

import uuid

from django.db import models


class VideoSession(models.Model):
    class Status(models.TextChoices):
        CREATED = "created", "Created"
        PROCESSING = "processing", "Processing"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    class PipelineStage(models.TextChoices):
        CREATED = "created", "Created"
        DOWNLOADING = "downloading", "Downloading"
        ANALYZING = "analyzing", "Analyzing"
        SYNTHESIZING = "synthesizing", "Synthesizing"
        BUILDING_ARTIFACTS = "building_artifacts", "Building artifacts"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_url = models.TextField(blank=True)
    title = models.CharField(max_length=500, blank=True)
    page_title = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.CREATED, db_index=True)
    pipeline_stage = models.CharField(max_length=32, choices=PipelineStage.choices, default=PipelineStage.CREATED)
    expected_chunk_count = models.PositiveIntegerField(null=True, blank=True)
    duration_seconds = models.FloatField(null=True, blank=True)
    settings = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    synthesis_error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["-created_at"], name="session_created_desc"),
        ]

    def __str__(self) -> str:
        return self.title or self.page_title or str(self.id)


class VideoChunk(models.Model):
    class Status(models.TextChoices):
        ACCEPTED = "accepted", "Accepted"
        ANALYZING = "analyzing", "Analyzing"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(VideoSession, related_name="chunks", on_delete=models.CASCADE, db_index=True)
    chunk_index = models.PositiveIntegerField()
    start_seconds = models.FloatField()
    end_seconds = models.FloatField()
    transcript_text = models.TextField(blank=True)
    capture_notes = models.TextField(blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.ACCEPTED, db_index=True)
    error_message = models.TextField(blank=True)
    qwen_request_ids = models.JSONField(default=list, blank=True)
    latency_ms = models.PositiveIntegerField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("session", "chunk_index")]
        ordering = ["chunk_index"]


class FrameAsset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    chunk = models.ForeignKey(VideoChunk, related_name="frames", on_delete=models.CASCADE, db_index=True)
    file = models.ImageField(upload_to="frames/%Y/%m/%d")
    mime_type = models.CharField(max_length=80)
    checksum = models.CharField(max_length=64, db_index=True)
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    byte_size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class AgentRun(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    chunk = models.ForeignKey(VideoChunk, related_name="agent_runs", on_delete=models.CASCADE)
    role = models.CharField(max_length=80)
    model = models.CharField(max_length=120)
    prompt_version = models.CharField(max_length=80)
    input_hash = models.CharField(max_length=64, db_index=True)
    output = models.JSONField(default=dict)
    confidence = models.FloatField(default=0.0)
    latency_ms = models.PositiveIntegerField()
    request_id = models.CharField(max_length=200, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class ReadingBlock(models.Model):
    class Kind(models.TextChoices):
        INTRO = "intro", "Intro"
        EXPLANATION = "explanation", "Explanation"
        EXAMPLE = "example", "Example"
        CODE = "code", "Code"
        VISUAL_CONTEXT = "visual_context", "Visual context"
        QUOTE = "quote", "Quote"
        DEMO_STEP = "demo_step", "Demo step"
        TIMESTAMP_ANCHOR = "timestamp_anchor", "Timestamp anchor"
        TAKEAWAY = "takeaway", "Takeaway"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(VideoSession, related_name="reading_blocks", on_delete=models.CASCADE, db_index=True)
    chunk = models.ForeignKey(VideoChunk, related_name="reading_blocks", on_delete=models.CASCADE, db_index=True)
    order = models.PositiveIntegerField()
    kind = models.CharField(max_length=40, choices=Kind.choices)
    heading = models.CharField(max_length=300, blank=True)
    body = models.TextField()
    start_seconds = models.FloatField()
    end_seconds = models.FloatField()
    source_evidence = models.JSONField(default=list, blank=True)
    confidence = models.FloatField(default=0.0)
    is_user_edited = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["order", "start_seconds"]


class TimelineMoment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(VideoSession, related_name="timeline_moments", on_delete=models.CASCADE, db_index=True)
    chunk = models.ForeignKey(VideoChunk, related_name="timeline_moments", on_delete=models.CASCADE, db_index=True)
    timestamp_seconds = models.FloatField()
    label = models.CharField(max_length=300)
    detail = models.TextField(blank=True)
    importance = models.PositiveSmallIntegerField(default=3)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["timestamp_seconds", "created_at"]


class SessionEvent(models.Model):
    id = models.BigAutoField(primary_key=True)
    session = models.ForeignKey(VideoSession, related_name="events", on_delete=models.CASCADE, db_index=True)
    event_type = models.CharField(max_length=80)
    payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]
        indexes = [
            models.Index(fields=["session", "id"], name="event_session_id_idx"),
        ]


class UserCorrection(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    block = models.ForeignKey(ReadingBlock, related_name="corrections", on_delete=models.CASCADE)
    previous_body = models.TextField()
    corrected_body = models.TextField()
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)


class GeneratedArtifact(models.Model):
    class ArtifactType(models.TextChoices):
        READING_DOCUMENT = "reading_document", "Reading Document"
        AUDIO_DESCRIPTION = "audio_description", "Audio Description Script"
        COURSE_NOTES = "course_notes", "Course Notes"
        COMPLIANCE_REPORT = "compliance_report", "Compliance Report"
        LOCALIZATION_BRIEF = "localization_brief", "Localization Brief"
        MARKDOWN_EXPORT = "markdown_export", "Markdown Export"
        RESEARCH_DIGEST = "research_digest", "Research Digest"
        MEETING_RECONSTRUCTION = "meeting_reconstruction", "Meeting Reconstruction"
        TUTORIAL_EXTRACTION = "tutorial_extraction", "Tutorial Extraction"
        ASSISTIVE_CUES = "assistive_cues", "Assistive Companion Cues"
        SYNTHESIS = "synthesis", "Synthesis"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(VideoSession, related_name="artifacts", on_delete=models.CASCADE)
    artifact_type = models.CharField(max_length=40, choices=ArtifactType.choices)
    workflow_template = models.CharField(max_length=80, blank=True)
    title = models.CharField(max_length=500, blank=True)
    summary = models.TextField(blank=True)
    markdown = models.TextField(blank=True)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["session", "workflow_template"], name="unique_session_workflow_artifact"),
        ]
