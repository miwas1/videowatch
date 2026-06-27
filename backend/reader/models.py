from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class CanonicalVideo(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    fingerprint = models.CharField(max_length=96, unique=True, db_index=True)
    canonical_url = models.TextField(blank=True)
    title = models.CharField(max_length=500, blank=True)
    duration_seconds = models.FloatField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.title or self.canonical_url or self.fingerprint


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
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, related_name="video_sessions", on_delete=models.CASCADE, null=True, blank=True)
    canonical_video = models.ForeignKey(CanonicalVideo, related_name="sessions", on_delete=models.SET_NULL, null=True, blank=True)
    source_fingerprint = models.CharField(max_length=96, blank=True, db_index=True)
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


class ProcessingJob(models.Model):
    class JobType(models.TextChoices):
        URL_INGEST = "url_ingest", "URL ingest"
        FILE_INGEST = "file_ingest", "File ingest"
        CHUNK_ANALYSIS = "chunk_analysis", "Chunk analysis"
        SYNTHESIS_RETRY = "synthesis_retry", "Synthesis retry"

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        RUNNING = "running", "Running"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"
        CANCELED = "canceled", "Canceled"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(VideoSession, related_name="processing_jobs", on_delete=models.CASCADE, db_index=True)
    job_type = models.CharField(max_length=40, choices=JobType.choices, db_index=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.QUEUED, db_index=True)
    payload = models.JSONField(default=dict, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    max_attempts = models.PositiveSmallIntegerField(default=2)
    locked_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"], name="job_status_created_idx"),
            models.Index(fields=["session", "status"], name="job_session_status_idx"),
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


class UserApiToken(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, related_name="describeops_tokens", on_delete=models.CASCADE)
    name = models.CharField(max_length=120, default="web")
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]


class StoredAsset(models.Model):
    class AssetType(models.TextChoices):
        SOURCE_VIDEO = "source_video", "Source video"
        AUDIO_CHUNK = "audio_chunk", "Audio chunk"
        TRANSCRIPT = "transcript", "Transcript"
        FRAME = "frame", "Frame"
        QWEN_OUTPUT = "qwen_output", "Qwen output"
        EVIDENCE_MANIFEST = "evidence_manifest", "Evidence manifest"
        FINAL_ARTIFACT = "final_artifact", "Final artifact"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    canonical_video = models.ForeignKey(CanonicalVideo, related_name="assets", on_delete=models.CASCADE, null=True, blank=True)
    session = models.ForeignKey(VideoSession, related_name="stored_assets", on_delete=models.CASCADE, null=True, blank=True)
    chunk = models.ForeignKey(VideoChunk, related_name="stored_assets", on_delete=models.CASCADE, null=True, blank=True)
    agent_run = models.ForeignKey(AgentRun, related_name="stored_assets", on_delete=models.CASCADE, null=True, blank=True)
    artifact = models.ForeignKey(GeneratedArtifact, related_name="stored_assets", on_delete=models.CASCADE, null=True, blank=True)
    asset_type = models.CharField(max_length=40, choices=AssetType.choices, db_index=True)
    object_key = models.CharField(max_length=900, db_index=True)
    storage_backend = models.CharField(max_length=80, default="default")
    content_type = models.CharField(max_length=120, blank=True)
    checksum = models.CharField(max_length=64, db_index=True)
    byte_size = models.PositiveIntegerField(default=0)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["session", "asset_type"], name="asset_session_type_idx"),
            models.Index(fields=["canonical_video", "asset_type"], name="asset_video_type_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.asset_type}: {self.object_key}"
