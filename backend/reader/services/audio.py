from __future__ import annotations

from pathlib import Path
from typing import Any

from django.conf import settings
from django.core.files.storage import default_storage

from reader.models import StoredAsset, VideoChunk
from reader.services.events import emit_event
from reader.services.qwen import QwenClient, QwenConfigurationError
from reader.services.storage import save_json_asset
from reader.services.timecode import format_timestamp


def enrich_chunk_with_audio_transcripts(chunk: VideoChunk, qwen_client: QwenClient | None = None) -> list[StoredAsset]:
    audio_assets = list(
        chunk.stored_assets.filter(asset_type=StoredAsset.AssetType.AUDIO_CHUNK).order_by("created_at")
    )
    if not audio_assets:
        return []

    existing_transcripts = list(chunk.stored_assets.filter(asset_type=StoredAsset.AssetType.TRANSCRIPT))
    transcribed_audio_ids = {
        str(asset.metadata.get("audio_asset_id"))
        for asset in existing_transcripts
        if asset.metadata.get("audio_asset_id")
    }
    pending_audio_assets = [asset for asset in audio_assets if str(asset.id) not in transcribed_audio_ids]
    if not pending_audio_assets:
        return existing_transcripts

    if not settings.QWEN_ENABLE_AUDIO_TRANSCRIPTION:
        emit_event(chunk.session, "audio.skipped", _event_payload(chunk, reason="disabled"))
        return []
    if not settings.DASHSCOPE_API_KEY:
        emit_event(chunk.session, "audio.skipped", _event_payload(chunk, reason="missing_api_key"))
        return []
    if not settings.QWEN_AUDIO_TRANSCRIPTION_MODEL:
        emit_event(chunk.session, "audio.skipped", _event_payload(chunk, reason="missing_model"))
        return []

    try:
        client = qwen_client or QwenClient()
    except QwenConfigurationError as exc:
        emit_event(chunk.session, "audio.skipped", _event_payload(chunk, reason=str(exc)))
        return []

    transcript_assets: list[StoredAsset] = []
    transcript_parts: list[str] = []
    for audio_asset in pending_audio_assets:
        emit_event(
            chunk.session,
            "audio.extracting",
            _event_payload(chunk, audio_asset_id=str(audio_asset.id), object_key=audio_asset.object_key),
        )
        try:
            with default_storage.open(audio_asset.object_key, "rb") as stored_file:
                data = stored_file.read()
        except Exception as exc:
            emit_event(
                chunk.session,
                "audio.failed",
                _event_payload(chunk, audio_asset_id=str(audio_asset.id), reason=f"storage_open_failed: {exc}"),
            )
            continue

        emit_event(
            chunk.session,
            "audio.transcribing",
            _event_payload(chunk, audio_asset_id=str(audio_asset.id), byte_size=audio_asset.byte_size),
        )
        try:
            result = client.transcribe_audio(
                data=data,
                filename=Path(audio_asset.object_key).name,
                content_type=audio_asset.content_type,
            )
        except Exception as exc:
            emit_event(
                chunk.session,
                "audio.failed",
                _event_payload(chunk, audio_asset_id=str(audio_asset.id), reason=str(exc)),
            )
            continue

        text = str(result.content.get("text") or "").strip()
        payload: dict[str, Any] = {
            "audio_asset_id": str(audio_asset.id),
            "audio_object_key": audio_asset.object_key,
            "chunk_index": chunk.chunk_index,
            "start_seconds": chunk.start_seconds,
            "end_seconds": chunk.end_seconds,
            "model": result.model,
            "request_id": result.request_id,
            "latency_ms": result.latency_ms,
            "text": text,
            "raw": result.content.get("raw"),
        }
        transcript_asset = save_json_asset(
            session=chunk.session,
            chunk=chunk,
            asset_type=StoredAsset.AssetType.TRANSCRIPT,
            object_key=f"transcripts/{chunk.session_id}/{chunk.chunk_index:05d}/{audio_asset.id}.json",
            payload=payload,
            metadata={
                "audio_asset_id": str(audio_asset.id),
                "audio_object_key": audio_asset.object_key,
                "model": result.model,
                "request_id": result.request_id,
                "chunk_index": chunk.chunk_index,
            },
        )
        transcript_assets.append(transcript_asset)
        if text:
            transcript_parts.append(_format_audio_transcript(chunk, text))
        emit_event(
            chunk.session,
            "audio.transcribed",
            _event_payload(
                chunk,
                audio_asset_id=str(audio_asset.id),
                transcript_asset_id=str(transcript_asset.id),
                latency_ms=result.latency_ms,
                text_chars=len(text),
            ),
        )

    if transcript_parts:
        existing_text = chunk.transcript_text.strip()
        addition = "\n\n".join(part for part in transcript_parts if part not in existing_text)
        if addition:
            chunk.transcript_text = f"{existing_text}\n\n{addition}".strip() if existing_text else addition
            chunk.save(update_fields=["transcript_text", "updated_at"])

    return transcript_assets


def _format_audio_transcript(chunk: VideoChunk, text: str) -> str:
    return (
        f"[Audio transcript {format_timestamp(chunk.start_seconds)} - {format_timestamp(chunk.end_seconds)}]\n"
        f"{text}"
    )


def _event_payload(chunk: VideoChunk, **extra: Any) -> dict[str, Any]:
    payload = {
        "chunk_id": str(chunk.id),
        "chunk_index": chunk.chunk_index,
        "start_seconds": chunk.start_seconds,
        "end_seconds": chunk.end_seconds,
    }
    payload.update(extra)
    return payload
