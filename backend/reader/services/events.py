from __future__ import annotations

from typing import Any

from reader.models import SessionEvent, VideoSession


def emit_event(session: VideoSession, event_type: str, payload: dict[str, Any]) -> SessionEvent:
    return SessionEvent.objects.create(session=session, event_type=event_type, payload=payload)

