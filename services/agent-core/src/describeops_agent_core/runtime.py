from __future__ import annotations


class QwenAgentRuntime:
    """Configuration seam for Qwen-Agent without requiring it in local tests."""

    def __init__(self, *, model: str, memory_token_budget: int = 1600) -> None:
        self.model = model
        self.memory_token_budget = memory_token_budget

    def agent_config(self, agent_name: str) -> dict:
        return {
            "name": agent_name,
            "llm": {
                "model": self.model,
                "service": "dashscope",
                "use_raw_api": False,
            },
            "memory": {
                "token_budget": self.memory_token_budget,
                "retrieval_policy": "scope_recent_high_confidence",
            },
            "tools": [
                {"name": "ffmpeg_probe", "description": "Read authorized media metadata and scene samples."},
                {"name": "ocr_lookup", "description": "Look up OCR text extracted from sampled frames."},
                {"name": "memory_retrieve", "description": "Retrieve scoped user or organization preferences."},
                {"name": "artifact_write", "description": "Write WebVTT, JSON cues, reports, and player packages."},
            ],
        }
