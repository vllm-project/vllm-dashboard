"""Records shared by the triage pipeline. Shapes: docs/data-model.md."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

Kind = Literal["issue", "pr"]
Band = Literal["page", "route", "watch", "ignore"]

AREAS = (
    "scheduler", "kv_cache", "attention", "moe", "quantization", "distributed",
    "model_loading", "models", "multimodal", "spec_decode", "lora",
    "frontend_api", "tool_calling", "structured_output", "compilation",
    "kernels", "sampling", "tokenizer", "engine_core", "disagg",
    "kv_connector", "rocm", "tpu", "cpu", "xpu", "build_install", "ci", "docs",
    "benchmarks", "performance", "memory", "other",
)
HARDWARE = (
    "H100", "H200", "B200", "B300", "GB200", "GB300", "A100", "L40S", "L4",
    "RTX", "MI300X", "MI325X", "MI355X", "TPU", "Gaudi", "CPU_x86", "CPU_arm",
    "Apple", "XPU", "other_nvidia", "other_amd", "other",
)
SERVING = (
    "tp", "pp", "dp", "ep", "multi_node", "quant_fp8", "quant_fp4", "quant_int4",
    "quant_awq_gptq", "quant_other", "spec_decode", "lora", "prefix_caching",
    "disagg_prefill", "kv_offload", "structured_output", "tool_calling",
    "multimodal_input", "long_context", "cuda_graph", "torch_compile",
    "chunked_prefill", "openai_api", "offline_llm", "embedding_api", "streaming",
)
ITEM_TYPES = (
    "bug", "regression", "perf_regression", "feature", "performance",
    "question", "usage", "docs", "ci", "refactor", "other", "spam",
)
MODEL_TRAITS = (
    "moe", "multimodal", "hybrid", "reasoning", "embedding", "encoder_decoder",
    "small",
)
MAINTAINER_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})


@dataclass(frozen=True)
class FileChange:
    path: str
    additions: int = 0
    deletions: int = 0


@dataclass
class Item:
    """One GitHub issue or pull request, as ingested."""

    repo: str
    number: int
    kind: Kind
    title: str
    body: str
    author: str
    author_association: str
    state: Literal["open", "closed", "merged"]
    html_url: str
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None = None
    draft: bool = False
    labels: list[str] = field(default_factory=list)
    files: list[FileChange] = field(default_factory=list)
    reactions: int = 0
    comment_count: int = 0
    comments: list[str] = field(default_factory=list)
    is_bot: bool = False

    @property
    def key(self) -> str:
        return f"{self.repo}#{self.number}"


@dataclass(frozen=True)
class ScoreFactor:
    factor: str
    points: int
    detail: str | None = None

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"factor": self.factor, "points": self.points}
        if self.detail:
            out["detail"] = self.detail
        return out


@dataclass(frozen=True)
class Score:
    score: int
    band: Band
    breakdown: tuple[ScoreFactor, ...]
    version: str


@dataclass
class Maintainer:
    github_login: str
    slack_user_id: str | None = None
    active: bool = True
    rules: dict[str, Any] = field(default_factory=dict)
    min_score: int = 40
    capacity_per_week: int = 10
    away: list[dict[str, str]] = field(default_factory=list)
    notify_mode: Literal["immediate", "digest", "off"] = "digest"
