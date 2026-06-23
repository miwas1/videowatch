from __future__ import annotations

import uuid
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("reader", "0002_alter_videosession_source_url"),
    ]

    operations = [
        migrations.CreateModel(
            name="GeneratedArtifact",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "session",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="artifacts",
                        to="reader.videosession",
                    ),
                ),
                (
                    "artifact_type",
                    models.CharField(
                        choices=[
                            ("reading_document", "Reading Document"),
                            ("audio_description", "Audio Description Script"),
                            ("course_notes", "Course Notes"),
                            ("compliance_report", "Compliance Report"),
                            ("localization_brief", "Localization Brief"),
                            ("markdown_export", "Markdown Export"),
                            ("research_digest", "Research Digest"),
                            ("meeting_reconstruction", "Meeting Reconstruction"),
                            ("tutorial_extraction", "Tutorial Extraction"),
                            ("assistive_cues", "Assistive Companion Cues"),
                            ("synthesis", "Synthesis"),
                        ],
                        max_length=40,
                    ),
                ),
                ("workflow_template", models.CharField(blank=True, max_length=80)),
                ("title", models.CharField(blank=True, max_length=500)),
                ("summary", models.TextField(blank=True)),
                ("markdown", models.TextField(blank=True)),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={"ordering": ["-created_at"]},
        ),
    ]
