from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent

for env_path in (REPO_ROOT / ".env", BASE_DIR / ".env"):
    if env_path.exists():
        load_dotenv(env_path, override=False)

DEBUG = os.getenv("DJANGO_DEBUG", "1") == "1"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "describeops-local-development-key")
ALLOWED_HOSTS = [
    host.strip()
    for host in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",")
    if host.strip()
]
CSRF_TRUSTED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",")
    if origin.strip()
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "reader",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "reader.middleware.ExtensionCorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "describeops_backend.urls"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]
WSGI_APPLICATION = "describeops_backend.wsgi.application"


def database_from_env() -> dict[str, object]:
    url = os.getenv("DATABASE_URL")
    if not url:
        return {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": os.getenv("SQLITE_PATH", str(BASE_DIR / "db.sqlite3")),
        }

    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("DATABASE_URL must use postgres:// or postgresql://")
    query_options = {key: values[-1] for key, values in parse_qs(parsed.query).items() if values}
    return {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": unquote(parsed.path.lstrip("/")),
        "USER": unquote(parsed.username or ""),
        "PASSWORD": unquote(parsed.password or ""),
        "HOST": parsed.hostname or "",
        "PORT": str(parsed.port or 5432),
        "OPTIONS": query_options,
        "CONN_MAX_AGE": int(os.getenv("DATABASE_CONN_MAX_AGE", "60")),
        "CONN_HEALTH_CHECKS": True,
    }


DATABASES = {"default": database_from_env()}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = Path(os.getenv("DJANGO_STATIC_ROOT", str(BASE_DIR / "staticfiles")))
ALIBABA_OSS_ACCESS_KEY_ID = os.getenv("ALIBABA_OSS_ACCESS_KEY_ID", "")
ALIBABA_OSS_ACCESS_KEY_SECRET = os.getenv("ALIBABA_OSS_ACCESS_KEY_SECRET", "")
ALIBABA_OSS_ENDPOINT = os.getenv("ALIBABA_OSS_ENDPOINT", "")
ALIBABA_OSS_BUCKET = os.getenv("ALIBABA_OSS_BUCKET", "")
ALIBABA_OSS_PREFIX = os.getenv("ALIBABA_OSS_PREFIX", "describeops")
ALIBABA_OSS_PUBLIC_BASE_URL = os.getenv("ALIBABA_OSS_PUBLIC_BASE_URL", "")
ALIBABA_OSS_SIGNED_URL_TTL_SECONDS = int(os.getenv("ALIBABA_OSS_SIGNED_URL_TTL_SECONDS", "3600"))
STORAGES = {
    "default": {
        "BACKEND": "reader.storage_backends.AlibabaOSSStorage" if ALIBABA_OSS_BUCKET else "django.core.files.storage.FileSystemStorage",
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}
MEDIA_URL = "media/"
MEDIA_ROOT = Path(os.getenv("DESCRIBEOPS_MEDIA_ROOT", str(BASE_DIR / "media")))
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = os.getenv("DJANGO_USE_X_FORWARDED_HOST", "1") == "1"
SESSION_COOKIE_SECURE = os.getenv("DJANGO_SESSION_COOKIE_SECURE", "0" if DEBUG else "1") == "1"
CSRF_COOKIE_SECURE = os.getenv("DJANGO_CSRF_COOKIE_SECURE", "0" if DEBUG else "1") == "1"
SECURE_SSL_REDIRECT = os.getenv("DJANGO_SECURE_SSL_REDIRECT", "0" if DEBUG else "1") == "1"
SECURE_HSTS_SECONDS = int(os.getenv("DJANGO_SECURE_HSTS_SECONDS", "0"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = os.getenv("DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS", "0") == "1"
SECURE_HSTS_PRELOAD = os.getenv("DJANGO_SECURE_HSTS_PRELOAD", "0") == "1"

DESCRIBEOPS_API_TOKEN = os.getenv("DESCRIBEOPS_API_TOKEN", "")
DESCRIBEOPS_ALLOW_DEBUG_EXTENSION_AUTH = os.getenv(
    "DESCRIBEOPS_ALLOW_DEBUG_EXTENSION_AUTH",
    "1" if DEBUG else "0",
) == "1"
DESCRIBEOPS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("DESCRIBEOPS_ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:5174").split(",")
    if origin.strip()
]
DESCRIBEOPS_MAX_UPLOAD_BYTES = int(os.getenv("DESCRIBEOPS_MAX_UPLOAD_BYTES", "26214400"))
DESCRIBEOPS_MAX_AUDIO_UPLOAD_BYTES = int(os.getenv("DESCRIBEOPS_MAX_AUDIO_UPLOAD_BYTES", "52428800"))
DESCRIBEOPS_MAX_VIDEO_UPLOAD_BYTES = int(os.getenv("DESCRIBEOPS_MAX_VIDEO_UPLOAD_BYTES", "524288000"))
DESCRIBEOPS_MAX_FRAMES_PER_CHUNK = int(os.getenv("DESCRIBEOPS_MAX_FRAMES_PER_CHUNK", "8"))
DESCRIBEOPS_YTDLP_COOKIE_FILE = os.getenv("DESCRIBEOPS_YTDLP_COOKIE_FILE", "")

DASHSCOPE_API_KEY = os.getenv("DASHSCOPE_API_KEY") or os.getenv("QWEN_API_KEY") or ""
DASHSCOPE_BASE_URL = os.getenv(
    "DASHSCOPE_BASE_URL",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
)

QWEN_VISUAL_MODEL = os.getenv("QWEN_VISUAL_MODEL", "qwen3.6-flash")
QWEN_TEXT_MODEL = os.getenv("QWEN_TEXT_MODEL", "qwen3.6-flash")
QWEN_JUDGE_MODEL = os.getenv("QWEN_JUDGE_MODEL", os.getenv("QWEN_QA_MODEL", "qwen3.6-plus"))
QWEN_FINAL_MODEL = os.getenv("QWEN_FINAL_MODEL", "qwen3.7-max")
QWEN_AUDIO_TRANSCRIPTION_MODEL = os.getenv(
    "QWEN_AUDIO_TRANSCRIPTION_MODEL",
    os.getenv("DASHSCOPE_AUDIO_TRANSCRIPTION_MODEL", ""),
)
QWEN_VISUAL_FALLBACK_MODELS = [
    model.strip()
    for model in os.getenv("QWEN_VISUAL_FALLBACK_MODELS", "qwen3.6-plus,qwen3-vl-plus,qwen3-vl-flash").split(",")
    if model.strip()
]
QWEN_TEXT_FALLBACK_MODELS = [
    model.strip()
    for model in os.getenv("QWEN_TEXT_FALLBACK_MODELS", "qwen3.6-plus,qwen-plus-latest").split(",")
    if model.strip()
]
QWEN_JUDGE_FALLBACK_MODELS = [
    model.strip()
    for model in os.getenv("QWEN_JUDGE_FALLBACK_MODELS", "qwen3.6-plus,qwen-plus-latest").split(",")
    if model.strip()
]
QWEN_FINAL_FALLBACK_MODELS = [
    model.strip()
    for model in os.getenv("QWEN_FINAL_FALLBACK_MODELS", "qwen3-max,qwen3.5-plus,qwen3.6-plus").split(",")
    if model.strip()
]
QWEN_MAX_TOKENS = int(os.getenv("QWEN_MAX_TOKENS", "3000"))
QWEN_FINAL_MAX_TOKENS = int(os.getenv("QWEN_FINAL_MAX_TOKENS", "12000"))
QWEN_TEMPERATURE = float(os.getenv("QWEN_TEMPERATURE", "0.1"))
QWEN_TOP_P = float(os.getenv("QWEN_TOP_P", "0.7"))
QWEN_ENABLE_FINAL_REPORT_AGENT = os.getenv("QWEN_ENABLE_FINAL_REPORT_AGENT", "1") == "1"
QWEN_ENABLE_AUDIO_TRANSCRIPTION = os.getenv("QWEN_ENABLE_AUDIO_TRANSCRIPTION", "1") == "1"
ALIBABA_CLOUD_DEPLOYMENT = os.getenv("ALIBABA_CLOUD_DEPLOYMENT", "local")

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "standard",
        },
    },
    "loggers": {
        "describeops": {
            "handlers": ["console"],
            "level": os.getenv("DESCRIBEOPS_LOG_LEVEL", "INFO"),
            "propagate": False,
        },
        "reader": {
            "handlers": ["console"],
            "level": os.getenv("DESCRIBEOPS_LOG_LEVEL", "INFO"),
            "propagate": False,
        },
    },
}
