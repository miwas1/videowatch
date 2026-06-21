from __future__ import annotations

import hashlib
from io import BytesIO

from django.conf import settings
from django.core.files.base import ContentFile
from ninja.files import UploadedFile
from PIL import Image, UnidentifiedImageError

from reader.models import FrameAsset, VideoChunk


ALLOWED_MIME_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


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
    return FrameAsset.objects.create(
        chunk=chunk,
        file=ContentFile(data, name=filename),
        mime_type=mime_type,
        checksum=checksum,
        width=width,
        height=height,
        byte_size=len(data),
    )

