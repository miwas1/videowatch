from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from ninja.files import UploadedFile
from PIL import Image, UnidentifiedImageError

from reader.models import AgentRun, FrameAsset, GeneratedArtifact, StoredAsset, VideoChunk, VideoSession


ALLOWED_MIME_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
ALLOWED_AUDIO_MIME_TYPES = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
}


class FrameValidationError(ValueError):
    pass


def save_uploaded_frame(chunk: VideoChunk, uploaded: UploadedFile) -> FrameAsset:
    data = uploaded.read()
    if not data:
        raise FrameValidationError("Uploaded frame is empty.")
    if len(data) > settings.DESCRIBEOPS_MAX_UPLOAD_BYTES:
        raise FrameValidationError("Uploaded frame exceeds the configured size limit.")

    try:
        image = Image.open(BytesIO(data))
        image.verify()
        width, height = image.size
    except (UnidentifiedImageError, OSError) as exc:
        raise FrameValidationError("Uploaded frame must be a valid image.") from exc

    mime_type = Image.MIME.get(image.format or "", uploaded.content_type or "")
    if mime_type not in ALLOWED_MIME_TYPES:
        raise FrameValidationError("Only JPEG, PNG, and WebP frames are supported.")

    checksum = hashlib.sha256(data).hexdigest()
    extension = ALLOWED_MIME_TYPES[mime_type]
    filename = f"{chunk.session_id}/{chunk.chunk_index:05d}/{checksum[:24]}.{extension}"
    frame = FrameAsset.objects.create(
        chunk=chunk,
        file=ContentFile(data, name=filename),
        mime_type=mime_type,
        checksum=checksum,
        width=width,
        height=height,
        byte_size=len(data),
    )
    record_stored_asset(
        session=chunk.session,
        chunk=chunk,
        asset_type=StoredAsset.AssetType.FRAME,
        object_key=frame.file.name,
        content_type=mime_type,
        checksum=checksum,
        byte_size=len(data),
        metadata={"frame_id": str(frame.id), "width": width, "height": height},
    )
    return frame


def save_uploaded_audio_chunk(chunk: VideoChunk, uploaded: UploadedFile) -> StoredAsset:
    data = uploaded.read()
    if not data:
        raise FrameValidationError("Uploaded audio chunk is empty.")
    if len(data) > settings.DESCRIBEOPS_MAX_AUDIO_UPLOAD_BYTES:
        raise FrameValidationError("Uploaded audio chunk exceeds the configured size limit.")

    content_type = (uploaded.content_type or "audio/webm").split(";", 1)[0].strip().lower()
    extension = ALLOWED_AUDIO_MIME_TYPES.get(content_type)
    if not extension:
        raise FrameValidationError("Only WebM, Ogg, MP3, M4A, and WAV audio chunks are supported.")

    checksum = hashlib.sha256(data).hexdigest()
    object_key = f"audio/{chunk.session_id}/{chunk.chunk_index:05d}/{checksum[:24]}.{extension}"
    saved_name = default_storage.save(object_key, ContentFile(data))
    return record_stored_asset(
        session=chunk.session,
        chunk=chunk,
        asset_type=StoredAsset.AssetType.AUDIO_CHUNK,
        object_key=saved_name,
        content_type=content_type,
        checksum=checksum,
        byte_size=len(data),
        metadata={"filename": Path(uploaded.name or saved_name).name},
    )


def save_json_asset(
    *,
    session: VideoSession,
    asset_type: str,
    payload: Any,
    object_key: str,
    chunk: VideoChunk | None = None,
    agent_run: AgentRun | None = None,
    artifact: GeneratedArtifact | None = None,
    metadata: dict[str, Any] | None = None,
) -> StoredAsset:
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2, default=str).encode("utf-8")
    checksum = hashlib.sha256(data).hexdigest()
    saved_name = default_storage.save(object_key, ContentFile(data))
    return record_stored_asset(
        session=session,
        chunk=chunk,
        agent_run=agent_run,
        artifact=artifact,
        asset_type=asset_type,
        object_key=saved_name,
        content_type="application/json",
        checksum=checksum,
        byte_size=len(data),
        metadata=metadata or {},
    )


def save_text_asset(
    *,
    session: VideoSession,
    asset_type: str,
    text: str,
    object_key: str,
    artifact: GeneratedArtifact | None = None,
    metadata: dict[str, Any] | None = None,
    content_type: str = "text/plain; charset=utf-8",
) -> StoredAsset:
    data = text.encode("utf-8")
    checksum = hashlib.sha256(data).hexdigest()
    saved_name = default_storage.save(object_key, ContentFile(data))
    return record_stored_asset(
        session=session,
        artifact=artifact,
        asset_type=asset_type,
        object_key=saved_name,
        content_type=content_type,
        checksum=checksum,
        byte_size=len(data),
        metadata=metadata or {},
    )


def record_stored_asset(
    *,
    session: VideoSession,
    asset_type: str,
    object_key: str,
    checksum: str,
    byte_size: int,
    content_type: str = "",
    chunk: VideoChunk | None = None,
    agent_run: AgentRun | None = None,
    artifact: GeneratedArtifact | None = None,
    metadata: dict[str, Any] | None = None,
) -> StoredAsset:
    return StoredAsset.objects.create(
        canonical_video=session.canonical_video,
        session=session,
        chunk=chunk,
        agent_run=agent_run,
        artifact=artifact,
        asset_type=asset_type,
        object_key=object_key,
        content_type=content_type,
        checksum=checksum,
        byte_size=byte_size,
        metadata=metadata or {},
    )
