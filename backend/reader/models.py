from __future__ import annotations

import uuid

from django.db import models


class VideoSession(models.Model):
    class Status(models.TextChoices):
        CREATED = "created", "Created"
        PROCESSING = "processing", "Processing"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_url = models.TextField(blank=True)
    title = models.CharField(max_length=500, blank=True)
    page_title = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.CREATED)
    duration_seconds = models.FloatField(null=True, blank=True)
    settings = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return self.title or self.page_title or str(self.id)


class VideoChunk(models.Model):
    class Status(models.TextChoices):
        ACCEPTED = "accepted", "Accepted"
        ANALYZING = "analyzing", "Analyzing"
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(VideoSession, related_name="chunks", on_delete=models.CASCADE)
    chunk_index = models.PositiveIntegerField()
    start_seconds = models.FloatField()
    end_seconds = models.FloatField()
    transcript_text = models.TextField(blank=True)
    capture_notes = models.TextField(blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.ACCEPTED)
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
    chunk = models.ForeignKey(VideoChunk, related_name="frames", on_delete=models.CASCADE)
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
    session = models.ForeignKey(VideoSession, related_name="reading_blocks", on_delete=models.CASCADE)
    chunk = models.ForeignKey(VideoChunk, related_name="reading_blocks", on_delete=models.CASCADE)
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
    session = models.ForeignKey(VideoSession, related_name="timeline_moments", on_delete=models.CASCADE)
    chunk = models.ForeignKey(VideoChunk, related_name="timeline_moments", on_delete=models.CASCADE)
    timestamp_seconds = models.FloatField()
    label = models.CharField(max_length=300)
    detail = models.TextField(blank=True)
    importance = models.PositiveSmallIntegerField(default=3)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["timestamp_seconds", "created_at"]


class SessionEvent(models.Model):
    id = models.BigAutoField(primary_key=True)
    session = models.ForeignKey(VideoSession, related_name="events", on_delete=models.CASCADE)
    event_type = models.CharField(max_length=80)
    payload = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]


class UserCorrection(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    block = models.ForeignKey(ReadingBlock, related_name="corrections", on_delete=models.CASCADE)
    previous_body = models.TextField()
    corrected_body = models.TextField()
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

