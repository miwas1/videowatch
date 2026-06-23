from django.db import migrations, models


def deduplicate_artifacts(apps, schema_editor):
    artifact_model = apps.get_model("reader", "GeneratedArtifact")
    seen: set[tuple[str, str]] = set()
    for artifact in artifact_model.objects.order_by("-updated_at", "-created_at"):
        key = (str(artifact.session_id), artifact.workflow_template)
        if key in seen:
            artifact.delete()
        else:
            seen.add(key)


class Migration(migrations.Migration):
    dependencies = [
        ("reader", "0003_generatedartifact"),
    ]

    operations = [
        migrations.AddField(
            model_name="videosession",
            name="pipeline_stage",
            field=models.CharField(
                choices=[
                    ("created", "Created"),
                    ("downloading", "Downloading"),
                    ("analyzing", "Analyzing"),
                    ("synthesizing", "Synthesizing"),
                    ("building_artifacts", "Building artifacts"),
                    ("ready", "Ready"),
                    ("failed", "Failed"),
                ],
                default="created",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="videosession",
            name="expected_chunk_count",
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="videosession",
            name="synthesis_error",
            field=models.TextField(blank=True),
        ),
        migrations.RunPython(deduplicate_artifacts, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="generatedartifact",
            constraint=models.UniqueConstraint(
                fields=("session", "workflow_template"),
                name="unique_session_workflow_artifact",
            ),
        ),
    ]
