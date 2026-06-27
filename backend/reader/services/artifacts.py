from __future__ import annotations

import json
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from django.conf import settings

from reader.models import AgentRun, ReadingBlock, VideoSession
from reader.services.events import emit_event
from reader.services.archive import open_frame_file
from reader.services.qwen import QwenClient, QwenConfigurationError, QwenResponseError, QwenResult, stable_hash
from reader.services.timecode import format_timestamp


FENCE_RE = re.compile(r"```(?P<lang>[\w.+#-]*)\n(?P<code>.*?)```", re.DOTALL)
FINAL_REPORT_PROMPT_VERSION = "final-report-session-v1"

FINAL_REPORT_SYSTEM = """You are the final editor for DescribeOps.
Create a complete, reader-facing report from extracted video evidence.
Return valid JSON only. Use only provided evidence and provided artifact paths.
Preserve concrete code examples, screenshots, timestamps, and uncertainty notes."""


@dataclass(frozen=True)
class FinalReportResult:
    markdown: str
    model: str
    request_id: str
    confidence: float
    output: dict[str, Any]


class FinalReportAgentProtocol(Protocol):
    def generate(
        self,
        session: VideoSession,
        *,
        code_manifest: list[dict[str, Any]],
        screenshots: list[Path],
        audio_path: Path | None,
        output_dir: Path,
    ) -> FinalReportResult:
        ...


def _clamp_confidence(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _truncate(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 20].rstrip() + "\n...[truncated]"


class FinalReportAgent:
    def __init__(self, qwen_client: QwenClient | None = None) -> None:
        self.qwen = qwen_client or QwenClient()

    def generate(
        self,
        session: VideoSession,
        *,
        code_manifest: list[dict[str, Any]],
        screenshots: list[Path],
        audio_path: Path | None,
        output_dir: Path,
    ) -> FinalReportResult:
        chunk = session.chunks.order_by("-chunk_index").first()
        if chunk is None:
            raise QwenResponseError("Final report requires at least one analyzed chunk.")

        prompt = self._build_prompt(
            session,
            code_manifest=code_manifest,
            screenshots=screenshots,
            audio_path=audio_path,
            output_dir=output_dir,
        )
        result = self.qwen.text_json(
            model=settings.QWEN_FINAL_MODEL,
            system_prompt=FINAL_REPORT_SYSTEM,
            user_prompt=prompt,
            max_tokens=settings.QWEN_FINAL_MAX_TOKENS,
            fallback_models=settings.QWEN_FINAL_FALLBACK_MODELS,
        )
        output = result.content if isinstance(result.content, dict) else {}
        markdown = str(output.get("report_markdown") or output.get("markdown") or "").strip()
        if not markdown:
            raw_text = str(output.get("raw_text") or result.raw_text or "").strip()
            if not raw_text:
                raise QwenResponseError("Final report agent returned no report_markdown.")
            markdown = raw_text

        confidence = _clamp_confidence(output.get("confidence", 0.0))
        AgentRun.objects.create(
            chunk=chunk,
            role="final_report",
            model=result.model,
            prompt_version=FINAL_REPORT_PROMPT_VERSION,
            input_hash=stable_hash(
                {
                    "prompt": prompt,
                    "reading_block_ids": [str(block.id) for block in session.reading_blocks.order_by("order")],
                    "timeline_ids": [str(moment.id) for moment in session.timeline_moments.order_by("timestamp_seconds")],
                    "code_paths": [item.get("path") for item in code_manifest],
                    "screenshot_paths": [str(path.relative_to(output_dir)) for path in screenshots],
                }
            ),
            output=output,
            confidence=confidence,
            latency_ms=result.latency_ms,
            request_id=result.request_id,
        )
        emit_event(
            session,
            "final_report.created",
            {"model": result.model, "request_id": result.request_id, "confidence": confidence},
        )
        return FinalReportResult(
            markdown=markdown,
            model=result.model,
            request_id=result.request_id,
            confidence=confidence,
            output=output,
        )

    def _build_prompt(
        self,
        session: VideoSession,
        *,
        code_manifest: list[dict[str, Any]],
        screenshots: list[Path],
        audio_path: Path | None,
        output_dir: Path,
    ) -> str:
        payload = {
            "task": (
                "Create the final product: a complete Markdown report that intelligently arranges all extracted "
                "materials into a coherent reader-facing document. Include narrative text, timestamps, code "
                "examples, relevant screenshot references, source limitations, and a concise conclusion."
            ),
            "required_json_shape": {
                "report_markdown": "Full Markdown report. Use relative links for screenshots/code only from the provided paths.",
                "screenshot_references": [{"path": "screenshots/...", "reason": "why it matters"}],
                "code_references": [{"path": "code/...", "language": "python", "reason": "why it matters"}],
                "quality_flags": ["uncertainties, missing context, or unsupported details"],
                "confidence": 0.0,
            },
            "rules": [
                "Do not invent screenshots, code files, claims, speakers, or source material.",
                "Prefer embedded screenshot image links only when the screenshot materially supports the explanation.",
                "Quote code exactly from extracted snippets where useful; otherwise link to the code artifact.",
                "Keep timestamped sections when the original teaching flow matters.",
                "If evidence conflicts, explain the uncertainty rather than smoothing it over.",
            ],
            "session": {
                "id": str(session.id),
                "title": session.title or session.page_title or "Untitled",
                "source_url": session.source_url,
                "duration": format_timestamp(session.duration_seconds or 0),
                "settings": session.settings,
            },
            "audio": str(audio_path.relative_to(output_dir)) if audio_path else None,
            "screenshots": self._screenshot_payload(screenshots, output_dir),
            "code_examples": self._code_payload(code_manifest, output_dir),
            "timeline_blocks": self._blocks_payload(session),
            "timeline_moments": self._moments_payload(session),
            "agent_evidence": self._agent_payload(session),
        }
        return json.dumps(payload, indent=2, default=str)

    def _screenshot_payload(self, screenshots: list[Path], output_dir: Path) -> list[dict[str, Any]]:
        return [
            {
                "path": str(path.relative_to(output_dir)),
                "filename": path.name,
            }
            for path in screenshots[:80]
        ]

    def _code_payload(self, code_manifest: list[dict[str, Any]], output_dir: Path) -> list[dict[str, Any]]:
        payload: list[dict[str, Any]] = []
        for item in code_manifest[:40]:
            path = output_dir / str(item.get("path") or "")
            code_text = path.read_text(encoding="utf-8") if path.exists() else ""
            payload.append(
                {
                    "path": item.get("path"),
                    "language": item.get("language") or "text",
                    "source": item.get("source"),
                    "start_time": format_timestamp(float(item.get("start_seconds") or 0)),
                    "code": _truncate(code_text, 3000),
                }
            )
        return payload

    def _blocks_payload(self, session: VideoSession) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        for block in session.reading_blocks.select_related("chunk").order_by("order", "start_seconds")[:120]:
            blocks.append(
                {
                    "kind": block.kind,
                    "heading": block.heading,
                    "start_time": format_timestamp(block.start_seconds),
                    "end_time": format_timestamp(block.end_seconds),
                    "body": _truncate(block.body, 1800),
                    "source_evidence": block.source_evidence,
                    "confidence": block.confidence,
                    "user_edited": block.is_user_edited,
                }
            )
        return blocks

    def _moments_payload(self, session: VideoSession) -> list[dict[str, Any]]:
        return [
            {
                "time": format_timestamp(moment.timestamp_seconds),
                "label": moment.label,
                "detail": _truncate(moment.detail, 600),
                "importance": moment.importance,
            }
            for moment in session.timeline_moments.order_by("timestamp_seconds")[:160]
        ]

    def _agent_payload(self, session: VideoSession) -> list[dict[str, Any]]:
        evidence: list[dict[str, Any]] = []
        runs = AgentRun.objects.filter(chunk__session=session).exclude(role="final_report").order_by("chunk__chunk_index", "created_at")
        for run in runs[:120]:
            output = run.output if isinstance(run.output, dict) else {}
            evidence.append(
                {
                    "chunk_index": run.chunk.chunk_index,
                    "role": run.role,
                    "model": run.model,
                    "confidence": run.confidence,
                    "output": self._compact_agent_output(output),
                }
            )
        return evidence

    def _compact_agent_output(self, output: dict[str, Any]) -> dict[str, Any]:
        compact: dict[str, Any] = {}
        for key in (
            "observations",
            "visual_context",
            "on_screen_text",
            "code_blocks",
            "commands",
            "ui_or_slide_text",
            "examples",
            "demo_steps",
            "context_notes",
            "quality_flags",
            "uncertainty",
            "uncertain_text",
        ):
            value = output.get(key)
            if value:
                compact[key] = _truncate(value, 1600)
        return compact


def extension_for_language(language: str) -> str:
    normalized = language.lower().strip()
    if normalized in {"go", "golang"}:
        return "go"
    if normalized in {"python", "py"}:
        return "py"
    if normalized in {"shell", "bash", "sh", "zsh"}:
        return "sh"
    if normalized in {"javascript", "js"}:
        return "js"
    if normalized in {"typescript", "ts"}:
        return "ts"
    if normalized in {"sql"}:
        return "sql"
    if normalized in {"json"}:
        return "json"
    return "txt"


def extract_code_candidates(session: VideoSession) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for block in session.reading_blocks.order_by("order", "start_seconds"):
        if block.kind == ReadingBlock.Kind.CODE:
            candidates.extend(_from_block(block))
        else:
            for match in FENCE_RE.finditer(block.body):
                candidates.append(
                    {
                        "language": match.group("lang") or "text",
                        "code": match.group("code").strip(),
                        "source": f"reading_block:{block.id}",
                        "start_seconds": block.start_seconds,
                    }
                )

    for run in AgentRun.objects.filter(chunk__session=session, role="code_ocr").order_by("chunk__chunk_index"):
        output = run.output if isinstance(run.output, dict) else {}
        for item in output.get("code_blocks") or []:
            if isinstance(item, dict):
                code = str(item.get("code") or item.get("text") or item.get("source") or item.get("content") or "").strip()
                language = str(item.get("language") or item.get("lang") or "text")
            else:
                code = str(item).strip()
                language = "text"
            if code:
                candidates.append(
                    {
                        "language": language,
                        "code": code,
                        "source": f"agent_run:{run.id}",
                        "start_seconds": run.chunk.start_seconds,
                    }
                )
        for command in output.get("commands") or []:
            text = str(command.get("command") if isinstance(command, dict) else command).strip()
            if text:
                candidates.append(
                    {
                        "language": "shell",
                        "code": text,
                        "source": f"agent_run:{run.id}:command",
                        "start_seconds": run.chunk.start_seconds,
                    }
                )
        raw_text = str(output.get("raw_text") or "")
        for match in FENCE_RE.finditer(raw_text):
            candidates.append(
                {
                    "language": match.group("lang") or "text",
                    "code": match.group("code").strip(),
                    "source": f"agent_run:{run.id}:raw_text",
                    "start_seconds": run.chunk.start_seconds,
                }
            )
    return _dedupe_candidates(candidates)


def _from_block(block: ReadingBlock) -> list[dict[str, Any]]:
    matches = list(FENCE_RE.finditer(block.body))
    if matches:
        return [
            {
                "language": match.group("lang") or "text",
                "code": match.group("code").strip(),
                "source": f"reading_block:{block.id}",
                "start_seconds": block.start_seconds,
            }
            for match in matches
            if match.group("code").strip()
        ]
    return [
        {
            "language": "text",
            "code": block.body.strip(),
            "source": f"reading_block:{block.id}",
            "start_seconds": block.start_seconds,
        }
    ] if block.body.strip() else []


def _dedupe_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for candidate in candidates:
        code = str(candidate.get("code") or "").strip()
        if not code or code in seen:
            continue
        seen.add(code)
        unique.append(candidate)
    return unique


def export_session_artifacts(
    session: VideoSession,
    output_dir: Path,
    *,
    audio_path: Path | None = None,
    final_report_agent: FinalReportAgentProtocol | None = None,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    screenshots_dir = output_dir / "screenshots"
    code_dir = output_dir / "code"
    if screenshots_dir.exists():
        shutil.rmtree(screenshots_dir)
    if code_dir.exists():
        shutil.rmtree(code_dir)
    screenshots_dir.mkdir(exist_ok=True)
    code_dir.mkdir(exist_ok=True)

    screenshot_paths = []
    for chunk in session.chunks.order_by("chunk_index"):
        for index, frame in enumerate(chunk.frames.all(), start=1):
            target = screenshots_dir / f"chunk-{chunk.chunk_index:03d}-{format_timestamp(chunk.start_seconds).replace(':', '-')}-frame-{index:02d}.jpg"
            with open_frame_file(frame) as source, target.open("wb") as destination:
                shutil.copyfileobj(source, destination)
            screenshot_paths.append(target)

    code_manifest = []
    for index, candidate in enumerate(extract_code_candidates(session), start=1):
        ext = extension_for_language(str(candidate.get("language") or "text"))
        timestamp = format_timestamp(float(candidate.get("start_seconds") or 0)).replace(":", "-")
        target = code_dir / f"snippet-{index:03d}-{timestamp}.{ext}"
        target.write_text(str(candidate["code"]).rstrip() + "\n", encoding="utf-8")
        code_manifest.append(
            {
                "path": str(target.relative_to(output_dir)),
                "language": candidate.get("language") or "text",
                "source": candidate.get("source"),
                "start_seconds": candidate.get("start_seconds"),
            }
        )

    audio_target = None
    if audio_path and audio_path.exists():
        audio_target = output_dir / "audio" / audio_path.name
        audio_target.parent.mkdir(exist_ok=True)
        shutil.copy2(audio_path, audio_target)

    markdown_path = output_dir / "reading_document.md"
    markdown_path.write_text(render_markdown(session, code_manifest, screenshot_paths, audio_target, output_dir), encoding="utf-8")
    final_report_path = output_dir / "final_report.md"
    final_report_model = None
    final_report_request_id = None
    final_report_confidence = None
    final_report_error = None
    final_agent_started = time.perf_counter()
    if final_report_agent is None and settings.QWEN_ENABLE_FINAL_REPORT_AGENT and settings.DASHSCOPE_API_KEY:
        try:
            final_report_agent = FinalReportAgent()
        except QwenConfigurationError as exc:
            final_report_error = str(exc)

    if final_report_agent is not None:
        try:
            final_report = final_report_agent.generate(
                session,
                code_manifest=code_manifest,
                screenshots=screenshot_paths,
                audio_path=audio_target,
                output_dir=output_dir,
            )
            final_report_path.write_text(final_report.markdown.rstrip() + "\n", encoding="utf-8")
            final_report_model = final_report.model
            final_report_request_id = final_report.request_id
            final_report_confidence = final_report.confidence
        except (QwenConfigurationError, QwenResponseError, OSError) as exc:
            final_report_error = str(exc)

    if not final_report_path.exists():
        final_report_path.write_text(
            render_fallback_final_report(session, code_manifest, screenshot_paths, audio_target, output_dir),
            encoding="utf-8",
        )

    manifest = {
        "session_id": str(session.id),
        "title": session.title,
        "source_url": session.source_url,
        "document": str(markdown_path),
        "final_report": str(final_report_path),
        "final_report_model": final_report_model,
        "final_report_request_id": final_report_request_id,
        "final_report_confidence": final_report_confidence,
        "final_report_latency_ms": round((time.perf_counter() - final_agent_started) * 1000),
        "final_report_error": final_report_error,
        "screenshots": [str(path) for path in screenshot_paths],
        "code": code_manifest,
        "audio": str(audio_target) if audio_target else None,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def render_fallback_final_report(
    session: VideoSession,
    code_manifest: list[dict[str, Any]],
    screenshots: list[Path],
    audio_path: Path | None,
    output_dir: Path,
) -> str:
    lines = [
        f"# {session.title or session.page_title or 'Final Video Report'}",
        "",
        "## Overview",
        "",
        "This report assembles the extracted reading blocks, code artifacts, screenshots, timeline moments, and audio reference into a single deliverable.",
        "",
    ]
    if session.source_url:
        lines.extend([f"Source: {session.source_url}", ""])
    if audio_path:
        rel_audio = audio_path.relative_to(output_dir)
        lines.extend(["## Audio Reference", "", f"- [{rel_audio}]({rel_audio})", ""])

    lines.extend(["## Key Code Examples", ""])
    if code_manifest:
        for item in code_manifest[:20]:
            path = item["path"]
            lines.append(f"- `{item['language']}` [{path}]({path}) at {format_timestamp(float(item.get('start_seconds') or 0))}")
    else:
        lines.append("- No standalone code artifacts were extracted.")

    lines.extend(["", "## Relevant Screenshots", ""])
    if screenshots:
        for path in screenshots[:12]:
            rel = path.relative_to(output_dir)
            lines.append(f"![{rel}]({rel})")
        if len(screenshots) > 12:
            lines.append(f"\nAdditional screenshots are available in `screenshots/` ({len(screenshots)} total).")
    else:
        lines.append("- No screenshot artifacts were exported.")

    lines.extend(["", "## Detailed Walkthrough", ""])
    for block in session.reading_blocks.order_by("order", "start_seconds"):
        heading = block.heading or block.kind.replace("_", " ").title()
        lines.extend(
            [
                f"### {format_timestamp(block.start_seconds)} - {format_timestamp(block.end_seconds)}: {heading}",
                "",
                block.body.strip(),
                "",
            ]
        )

    lines.extend(["## Timeline", ""])
    moments = list(session.timeline_moments.order_by("timestamp_seconds"))
    if moments:
        for moment in moments:
            lines.append(f"- **{format_timestamp(moment.timestamp_seconds)}** {moment.label}: {moment.detail}")
    else:
        lines.append("- No timeline moments were extracted.")
    lines.append("")
    return "\n".join(lines)


def render_markdown(
    session: VideoSession,
    code_manifest: list[dict[str, Any]],
    screenshots: list[Path],
    audio_path: Path | None,
    output_dir: Path,
) -> str:
    lines = [
        "# Video Reading Document",
        "",
        f"**Title:** {session.title}",
        f"**Source:** {session.source_url}",
        f"**Backend session:** `{session.id}`",
        f"**Duration:** {format_timestamp(session.duration_seconds or 0)}",
        "",
        "This document was generated through the Django backend pipeline, including persisted chunks, frames, agent runs, reading blocks, and timeline moments.",
        "",
    ]
    if audio_path:
        lines.extend(["## Audio", "", f"- Extracted audio: [{audio_path.relative_to(output_dir)}]({audio_path.relative_to(output_dir)})", ""])
    lines.extend(["## Extracted Code Files", ""])
    if code_manifest:
        for item in code_manifest:
            lines.append(f"- `{item['language']}` [{item['path']}]({item['path']}) at {format_timestamp(float(item.get('start_seconds') or 0))}")
    else:
        lines.append("- No standalone code blocks were confidently extracted. See screenshots for visual source evidence.")
    lines.extend(["", "## Screenshot Evidence", ""])
    if screenshots:
        for path in screenshots[:40]:
            rel = path.relative_to(output_dir)
            lines.append(f"- [{rel}]({rel})")
        if len(screenshots) > 40:
            lines.append(f"- ...and {len(screenshots) - 40} more screenshots in `screenshots/`.")
    else:
        lines.append("- No screenshots exported.")
    lines.extend(["", "## Timeline Reading", ""])
    for block in session.reading_blocks.order_by("order", "start_seconds"):
        heading = block.heading or block.kind.replace("_", " ").title()
        lines.extend(
            [
                f"### {format_timestamp(block.start_seconds)} - {format_timestamp(block.end_seconds)}: {heading}",
                "",
                block.body.strip(),
                "",
            ]
        )
    lines.extend(["## Timeline Moments", ""])
    for moment in session.timeline_moments.order_by("timestamp_seconds"):
        lines.append(f"- **{format_timestamp(moment.timestamp_seconds)}** {moment.label}: {moment.detail}")
    lines.append("")
    return "\n".join(lines)
