from __future__ import annotations

from io import BytesIO
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.core.files.base import File
from django.core.files.storage import Storage
from django.utils.deconstruct import deconstructible


@deconstructible
class AlibabaOSSStorage(Storage):
    """Small Django storage backend for Alibaba Cloud OSS.

    The SDK is imported lazily so local development can keep using filesystem
    storage without requiring OSS credentials or the package at import time.
    """

    def __init__(self, prefix: str | None = None) -> None:
        self.prefix = (prefix if prefix is not None else settings.ALIBABA_OSS_PREFIX).strip("/")

    @property
    def bucket(self) -> Any:
        try:
            import oss2
        except ImportError as exc:
            raise ImproperlyConfigured("Install oss2 to use AlibabaOSSStorage.") from exc

        required = {
            "ALIBABA_OSS_ACCESS_KEY_ID": settings.ALIBABA_OSS_ACCESS_KEY_ID,
            "ALIBABA_OSS_ACCESS_KEY_SECRET": settings.ALIBABA_OSS_ACCESS_KEY_SECRET,
            "ALIBABA_OSS_ENDPOINT": settings.ALIBABA_OSS_ENDPOINT,
            "ALIBABA_OSS_BUCKET": settings.ALIBABA_OSS_BUCKET,
        }
        missing = [key for key, value in required.items() if not value]
        if missing:
            raise ImproperlyConfigured(f"Missing OSS settings: {', '.join(missing)}")

        auth = oss2.Auth(settings.ALIBABA_OSS_ACCESS_KEY_ID, settings.ALIBABA_OSS_ACCESS_KEY_SECRET)
        return oss2.Bucket(auth, settings.ALIBABA_OSS_ENDPOINT, settings.ALIBABA_OSS_BUCKET)

    def _open(self, name: str, mode: str = "rb") -> File:
        result = self.bucket.get_object(self._key(name))
        return File(BytesIO(result.read()), name=name)

    def _save(self, name: str, content: File) -> str:
        normalized = self.get_available_name(name)
        content.open("rb") if hasattr(content, "open") else None
        self.bucket.put_object(self._key(normalized), content)
        return normalized

    def delete(self, name: str) -> None:
        if name:
            self.bucket.delete_object(self._key(name))

    def exists(self, name: str) -> bool:
        return self.bucket.object_exists(self._key(name))

    def size(self, name: str) -> int:
        return int(self.bucket.get_object_meta(self._key(name)).content_length)

    def url(self, name: str) -> str:
        public_base = settings.ALIBABA_OSS_PUBLIC_BASE_URL.rstrip("/")
        if public_base:
            return f"{public_base}/{self._key(name)}"
        return self.bucket.sign_url("GET", self._key(name), settings.ALIBABA_OSS_SIGNED_URL_TTL_SECONDS)

    def get_available_name(self, name: str, max_length: int | None = None) -> str:
        return name.replace("\\", "/").lstrip("/")

    def _key(self, name: str) -> str:
        clean_name = name.replace("\\", "/").lstrip("/")
        return f"{self.prefix}/{clean_name}" if self.prefix else clean_name
