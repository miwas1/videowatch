from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import BinaryIO

from django.core.files.storage import default_storage

from reader.models import FrameAsset


@contextmanager
def open_frame_file(frame: FrameAsset) -> Iterator[BinaryIO]:
    """Open a frame through Django storage so local and remote backends work."""
    with default_storage.open(frame.file.name, "rb") as stored_file:
        yield stored_file
