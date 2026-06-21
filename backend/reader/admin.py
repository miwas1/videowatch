from __future__ import annotations

from django.contrib import admin

from .models import AgentRun, FrameAsset, ReadingBlock, SessionEvent, TimelineMoment, UserCorrection, VideoChunk, VideoSession


@admin.register(VideoSession)
class VideoSessionAdmin(admin.ModelAdmin):
    list_display = ("id", "title", "status", "source_url", "created_at", "updated_at")
    search_fields = ("title", "source_url")
    list_filter = ("status",)


@admin.register(VideoChunk)
class VideoChunkAdmin(admin.ModelAdmin):
    list_display = ("id", "session", "chunk_index", "status", "start_seconds", "end_seconds", "created_at")
    list_filter = ("status",)


admin.site.register(FrameAsset)
admin.site.register(AgentRun)
admin.site.register(ReadingBlock)
admin.site.register(TimelineMoment)
admin.site.register(SessionEvent)
admin.site.register(UserCorrection)

