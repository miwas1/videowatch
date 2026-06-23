from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.db import transaction

from reader.models import AgentRun, ReadingBlock, TimelineMoment, VideoChunk, VideoSession
from reader.services.events import emit_event
from reader.services.qwen import QwenClient, QwenResult, stable_hash
from reader.services.timecode import format_timestamp

PROMPT_VERSION = "video-reading-document-v1"

SYSTEM_JSON = """You are part of an agent society that translates video into a context-preserving reading document.
Return valid JSON only. Do not mention that you are an AI model. Do not summarize away steps, examples, jokes,
visual details, code, terminal output, diagrams, or demonstrations."""

SYNTHESIS_PROFILES: dict[str, str] = {
    "reading_document": "Create an accessible lesson that preserves teaching flow, examples, and essential visual context.",
    "course_notes": "Create structured lecture notes with key terms, concepts, examples, and final takeaways.",
    "audio_description": "Create a chronological spoken-cue script. Keep cues concise, concrete, and timestamped.",
    "tutorial_extraction": "Create an executable tutorial with ordered steps, exact code or commands, and UI outcomes.",
    "compliance_report": "Create an accessibility review with findings, severity, evidence timestamps, and recommendations.",
    "video_to_document": "Create a polished standalone article with a clear narrative and useful section hierarchy.",
    "meeting_reconstruction": "Create meeting notes with discussion flow, decisions, demo steps, owners, and action items.",
    "assistive_cues": "Create concise timestamped 'what is happening now' cues for an assistive playback companion.",
    "research_digest": "Create a research digest separating claims, supporting evidence, quotes, examples, and conclusions.",
    "localization_brief": "Create a localization brief with translatable segments, terminology, visual notes, and timing constraints.",
}


@dataclass(frozen=True)
class AgentSpec:
    role: str
    model: str
    prompt: str
    uses_frames: bool


def chunk_context(chunk: VideoChunk) -> str:
    return (
        f"Session title: {chunk.session.title or chunk.session.page_title or 'Untitled'}\n"
        f"Source URL: {chunk.session.source_url or 'not provided'}\n"
        f"Clip range: {format_timestamp(chunk.start_seconds)} to {format_timestamp(chunk.end_seconds)} "
        f"({chunk.start_seconds:.2f}s-{chunk.end_seconds:.2f}s)\n"
        f"Transcript or captions from extension, if any:\n{chunk.transcript_text or '[none]'}\n"
        f"Capture notes from extension, if any:\n{chunk.capture_notes or '[none]'}"
    )


def agent_specs() -> list[AgentSpec]:
    visual_model = settings.QWEN_VISUAL_MODEL
    text_model = settings.QWEN_TEXT_MODEL
    judge_model = settings.QWEN_JUDGE_MODEL
    return [
        AgentSpec(
            role="scene_reader",
            model=visual_model,
            uses_frames=True,
            prompt="""Inspect the frames as video evidence.
Return JSON with keys: observations, visual_context, on_screen_text, uncertainty, confidence.
Each observation should keep timestamp hints and concrete visual evidence. Do not infer audio.""",
        ),
        AgentSpec(
            role="code_ocr",
            model=visual_model,
            uses_frames=True,
            prompt="""Focus on code, terminal output, filenames, UI labels, commands, stack traces, diagrams, and slides.
Return JSON with keys: code_blocks, commands, ui_or_slide_text, uncertain_text, confidence.
Preserve exact text when readable; mark uncertain text explicitly instead of guessing.""",
        ),
        AgentSpec(
            role="example_keeper",
            model=text_model,
            uses_frames=False,
            prompt="""Find examples, demos, analogies, jokes, mistakes, comparisons, and context that would be lost in a short summary.
Return JSON with keys: examples, demo_steps, context_notes, continuity_notes, confidence.""",
        ),
        AgentSpec(
            role="context_compressor",
            model=text_model,
            uses_frames=False,
            prompt="""Translate the clip into reading-document blocks. This is not a summary.
Preserve order, teaching flow, examples, code, visuals, and context.
Return JSON with key blocks. Each block has kind, heading, body, start_seconds, end_seconds, source_evidence, confidence.
Allowed kind values: intro, explanation, example, code, visual_context, quote, demo_step, timestamp_anchor, takeaway.""",
        ),
        AgentSpec(
            role="timeline_judge",
            model=judge_model,
            uses_frames=False,
            prompt="""Judge the collaborating agents. Resolve conflicts and choose the final document blocks.
Prefer accuracy over speed. Remove unsupported claims. Keep useful details rather than compressing them away.
Return JSON with keys: accepted_blocks, timeline, quality_flags, confidence.
accepted_blocks use the same schema as context_compressor blocks. timeline items have timestamp_seconds, label, detail, importance.""",
        ),
    ]


class AgentSocietyRunner:
    def __init__(self, qwen_client: QwenClient | None = None) -> None:
        self.qwen = qwen_client or QwenClient()

    def process_chunk(self, chunk: VideoChunk) -> dict[str, Any]:
        started = time.perf_counter()
        frames = list(chunk.frames.all())
        frame_ids = [str(f.id) for f in frames]
        prior_outputs: list[dict[str, Any]] = []
        request_ids: list[str] = []
        emit_event(chunk.session, "chunk.analyzing", {"chunk_id": str(chunk.id), "chunk_index": chunk.chunk_index})

        specs = agent_specs()
        parallel_specs = [s for s in specs if s.uses_frames]
        sequential_specs = [s for s in specs if not s.uses_frames]

        # Run visual agents in parallel (they don't depend on prior outputs)
        parallel_results: dict[str, tuple[QwenResult, AgentRun]] = {}
        with ThreadPoolExecutor(max_workers=len(parallel_specs)) as executor:
            futures = {}
            for spec in parallel_specs:
                user_prompt = self._build_agent_prompt(spec, chunk, [])
                cached = self._check_cache(chunk, spec, user_prompt, frame_ids)
                if cached:
                    parallel_results[spec.role] = cached
                else:
                    futures[executor.submit(self._call_agent, spec, user_prompt, frames)] = (spec, user_prompt)
            for future in as_completed(futures):
                spec, user_prompt = futures[future]
                result = future.result()
                run = self._store_agent_run(chunk, spec, user_prompt, result, frame_ids)
                parallel_results[spec.role] = (result, run)

        for spec in parallel_specs:
            result, run = parallel_results[spec.role]
            request_ids.append(result.request_id)
            prior_outputs.append({"role": spec.role, "confidence": run.confidence, "output": result.content})

        # Run text agents sequentially (they depend on prior outputs)
        for spec in sequential_specs:
            user_prompt = self._build_agent_prompt(spec, chunk, prior_outputs)
            cached = self._check_cache(chunk, spec, user_prompt, frame_ids)
            if cached:
                result, run = cached
            else:
                result = self._call_agent(spec, user_prompt, frames)
                run = self._store_agent_run(chunk, spec, user_prompt, result, frame_ids)
            request_ids.append(result.request_id)
            prior_outputs.append({"role": spec.role, "confidence": run.confidence, "output": result.content})

        final = prior_outputs[-1]["output"] if prior_outputs else {}
        raw_fallback = self._fallback_blocks_from_outputs(chunk, prior_outputs)
        with transaction.atomic():
            chunk.reading_blocks.all().delete()
            chunk.timeline_moments.all().delete()
            blocks = self._create_blocks(chunk, final.get("accepted_blocks") or final.get("blocks") or raw_fallback)
            moments = self._create_timeline(chunk, final.get("timeline") or [])
            chunk.status = VideoChunk.Status.READY
            chunk.error_message = ""
            chunk.qwen_request_ids = [rid for rid in request_ids if rid]
            chunk.latency_ms = round((time.perf_counter() - started) * 1000)
            chunk.save(update_fields=["status", "error_message", "qwen_request_ids", "latency_ms", "updated_at"])

        emit_event(
            chunk.session,
            "document.updated",
            {
                "chunk_id": str(chunk.id),
                "chunk_index": chunk.chunk_index,
                "block_count": len(blocks),
                "timeline_count": len(moments),
            },
        )
        return {"blocks": blocks, "timeline": moments}

    def _call_agent(self, spec: AgentSpec, user_prompt: str, frames: list[Any]) -> QwenResult:
        if spec.uses_frames:
            return self.qwen.multimodal_json(
                model=spec.model,
                system_prompt=SYSTEM_JSON,
                user_prompt=user_prompt,
                frames=frames,
                fallback_models=settings.QWEN_VISUAL_FALLBACK_MODELS,
            )
        return self.qwen.text_json(
            model=spec.model,
            system_prompt=SYSTEM_JSON,
            user_prompt=user_prompt,
            fallback_models=settings.QWEN_JUDGE_FALLBACK_MODELS
            if spec.role == "timeline_judge"
            else settings.QWEN_TEXT_FALLBACK_MODELS,
        )

    def _build_agent_prompt(
        self,
        spec: AgentSpec,
        chunk: VideoChunk,
        prior_outputs: list[dict[str, Any]],
    ) -> str:
        return (
            f"{spec.prompt}\n\n"
            f"Chunk context:\n{chunk_context(chunk)}\n\n"
            f"Previous agent outputs:\n{prior_outputs if prior_outputs else '[none yet]'}"
        )

    def _check_cache(self, chunk: VideoChunk, spec: AgentSpec, prompt: str, frame_ids: list[str]) -> tuple[QwenResult, AgentRun] | None:
        input_hash = stable_hash({"prompt": prompt, "frame_ids": frame_ids})
        existing = AgentRun.objects.filter(
            chunk=chunk,
            role=spec.role,
            prompt_version=PROMPT_VERSION,
            input_hash=input_hash,
        ).first()
        if existing:
            result = QwenResult(
                model=existing.model,
                content=existing.output,
                raw_text="",
                latency_ms=existing.latency_ms,
                request_id=existing.request_id,
            )
            return result, existing
        return None

    def _store_agent_run(self, chunk: VideoChunk, spec: AgentSpec, prompt: str, result: QwenResult, frame_ids: list[str]) -> AgentRun:
        confidence = result.content.get("confidence", 0.0)
        try:
            confidence_value = max(0.0, min(1.0, float(confidence)))
        except (TypeError, ValueError):
            confidence_value = 0.0
        return AgentRun.objects.create(
            chunk=chunk,
            role=spec.role,
            model=result.model,
            prompt_version=PROMPT_VERSION,
            input_hash=stable_hash({"prompt": prompt, "frame_ids": frame_ids}),
            output=result.content,
            confidence=confidence_value,
            latency_ms=result.latency_ms,
            request_id=result.request_id,
        )

    def _create_blocks(self, chunk: VideoChunk, raw_blocks: list[Any]) -> list[ReadingBlock]:
        valid_kinds = {choice[0] for choice in ReadingBlock.Kind.choices}
        from django.db.models import Max
        max_order = chunk.session.reading_blocks.aggregate(m=Max("order"))["m"]
        next_order = (max_order + 1) if max_order is not None else 0

        to_create: list[ReadingBlock] = []
        for index, raw in enumerate(raw_blocks):
            if not isinstance(raw, dict):
                continue
            body = str(raw.get("body") or "").strip()
            if not body:
                continue
            kind = str(raw.get("kind") or "explanation").strip()
            if kind == "summary":
                kind = "explanation"
            if kind not in valid_kinds:
                kind = "explanation"
            confidence = raw.get("confidence", 0.0)
            try:
                confidence_value = max(0.0, min(1.0, float(confidence)))
            except (TypeError, ValueError):
                confidence_value = 0.0
            to_create.append(
                ReadingBlock(
                    session=chunk.session,
                    chunk=chunk,
                    order=next_order + index,
                    kind=kind,
                    heading=str(raw.get("heading") or "")[:300],
                    body=body,
                    start_seconds=float(raw.get("start_seconds") or chunk.start_seconds),
                    end_seconds=float(raw.get("end_seconds") or chunk.end_seconds),
                    source_evidence=raw.get("source_evidence") if isinstance(raw.get("source_evidence"), list) else [],
                    confidence=confidence_value,
                )
            )
        return ReadingBlock.objects.bulk_create(to_create)

    def _create_timeline(self, chunk: VideoChunk, raw_moments: list[Any]) -> list[TimelineMoment]:
        to_create: list[TimelineMoment] = []
        for raw in raw_moments:
            if not isinstance(raw, dict):
                continue
            label = str(raw.get("label") or "").strip()
            if not label:
                continue
            importance = raw.get("importance", 3)
            try:
                importance_value = max(1, min(5, int(importance)))
            except (TypeError, ValueError):
                importance_value = 3
            to_create.append(
                TimelineMoment(
                    session=chunk.session,
                    chunk=chunk,
                    timestamp_seconds=float(raw.get("timestamp_seconds") or chunk.start_seconds),
                    label=label[:300],
                    detail=str(raw.get("detail") or ""),
                    importance=importance_value,
                )
            )
        return TimelineMoment.objects.bulk_create(to_create)

    def synthesize_session(self, session: VideoSession, workflow_template: str = "reading_document") -> dict[str, Any]:
        if not settings.QWEN_ENABLE_FINAL_REPORT_AGENT:
            return {"skipped": True}

        blocks = list(session.reading_blocks.order_by("order", "start_seconds"))
        moments = list(session.timeline_moments.order_by("timestamp_seconds"))
        if not blocks:
            return {"skipped": True, "reason": "no_blocks"}

        blocks_json = [
            {
                "order": block.order,
                "kind": block.kind,
                "heading": block.heading,
                "body": block.body[:600],
                "start_seconds": block.start_seconds,
                "end_seconds": block.end_seconds,
                "confidence": block.confidence,
            }
            for block in blocks
        ]
        timeline_json = [
            {"timestamp_seconds": m.timestamp_seconds, "label": m.label, "detail": m.detail}
            for m in moments[:30]
        ]

        workflow_instruction = SYNTHESIS_PROFILES.get(workflow_template, SYNTHESIS_PROFILES["reading_document"])
        ready_count = session.chunks.filter(status=VideoChunk.Status.READY).count()
        user_prompt = (
            f"Video title: {session.title or session.page_title or 'Untitled'}\n"
            f"Duration: {session.duration_seconds or 'unknown'}s\n"
            f"Total chunks processed: {ready_count}\n\n"
            f"Requested workflow: {workflow_template}\n"
            f"Workflow requirements: {workflow_instruction}\n\n"
            f"Per-chunk blocks (in order):\n{blocks_json}\n\n"
            f"Timeline moments:\n{timeline_json}"
        )

        system_prompt = (
            "You are a document synthesis agent. Given per-chunk reading blocks from a video, "
            "produce a single unified workflow-specific artifact. Deduplicate overlapping content, maintain chronological order, "
            "create useful section headings, and ensure continuity. Preserve all code, examples, "
            "diagrams, and teaching flow. Do not summarize away details.\n\n"
            "Return JSON with keys: title, sections, summary.\n"
            "sections is a list of objects with: heading, body, start_seconds, end_seconds, kind. "
            "Use section kinds that fit the requested workflow, such as finding, cue, step, code, decision, claim, terminology, or explanation.\n"
            "summary is a 2-3 sentence overview of the entire video."
        )

        emit_event(session, "session.synthesizing", {"block_count": len(blocks), "workflow_template": workflow_template})
        result = self.qwen.text_json(
            model=settings.QWEN_FINAL_MODEL,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            max_tokens=settings.QWEN_FINAL_MAX_TOKENS,
            fallback_models=settings.QWEN_FINAL_FALLBACK_MODELS,
        )

        emit_event(session, "session.synthesized", {"latency_ms": result.latency_ms, "workflow_template": workflow_template})
        return result.content

    def _fallback_blocks_from_outputs(self, chunk: VideoChunk, prior_outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        for item in reversed(prior_outputs):
            output = item.get("output") if isinstance(item, dict) else {}
            if not isinstance(output, dict):
                continue
            raw_text = str(output.get("raw_text") or "").strip()
            if raw_text:
                return [
                    {
                        "kind": "explanation",
                        "heading": f"Backend reading for {format_timestamp(chunk.start_seconds)}",
                        "body": raw_text,
                        "start_seconds": chunk.start_seconds,
                        "end_seconds": chunk.end_seconds,
                        "source_evidence": [f"raw_qwen_output:{item.get('role')}"],
                        "confidence": output.get("confidence", 0.2),
                    }
                ]
        observations: list[str] = []
        for item in prior_outputs:
            output = item.get("output") if isinstance(item, dict) else {}
            if isinstance(output, dict):
                for key in ("observations", "visual_context", "on_screen_text", "examples", "demo_steps", "context_notes"):
                    value = output.get(key)
                    if isinstance(value, list):
                        observations.extend(str(part) for part in value if part)
                    elif value:
                        observations.append(str(value))
        if observations:
            return [
                {
                    "kind": "explanation",
                    "heading": f"Observed segment at {format_timestamp(chunk.start_seconds)}",
                    "body": "\n".join(f"- {line}" for line in observations),
                    "start_seconds": chunk.start_seconds,
                    "end_seconds": chunk.end_seconds,
                    "source_evidence": ["agent_observations"],
                    "confidence": 0.45,
                }
            ]
        return []
