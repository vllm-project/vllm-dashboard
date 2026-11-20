"""Tests for noise-comment filtering, re-extraction cooldown, and semantic facet gate."""

from __future__ import annotations

from datetime import datetime, timezone

from triage.facets import routing_facets_fingerprint
from triage.prepass import filter_comment_records, is_noise_comment

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def test_is_noise_comment_filters_bots_commands_and_chatter() -> None:
    assert is_noise_comment("mergify[bot]", "This PR has conflicts that must be resolved.")
    assert is_noise_comment("github-actions[bot]", "Benchmark results posted.")
    assert is_noise_comment("Copilot", "Summary of changes")
    assert is_noise_comment("alice", "+1")
    assert is_noise_comment("alice", "bump!")
    assert is_noise_comment("alice", "any updates?")
    assert is_noise_comment("alice", "/ci run\n/lgtm")
    assert is_noise_comment("alice", "> quoted text\n\nSame here")
    assert is_noise_comment("alice", "thanks!")


def test_is_noise_comment_keeps_substantive_comments_and_refs() -> None:
    assert not is_noise_comment("alice", "Fixes #12345")
    assert not is_noise_comment("alice", "See https://github.com/vllm-project/vllm/pull/999")
    assert not is_noise_comment("alice", "Crash in `fused_moe_kernel`")
    assert not is_noise_comment(
        "alice",
        "Reproduced on 8xB200 with vLLM 0.12.0 when tensor-parallel-size=8 and FP8 KV cache.",
    )


def test_filter_comment_records_keeps_substantive_only() -> None:
    records = [
        ("codecov[bot]", NOW, "[codecov[bot] (NONE)]: Coverage is 82%"),
        ("bob", NOW, "[bob (NONE)]: +1"),
        ("alice", NOW, "[alice (MEMBER)]: Root cause is in `vllm/v1/worker/gpu_model_runner.py` line 412."),
    ]
    kept = filter_comment_records(records)
    assert [login for login, _, _ in kept] == ["alice"]


def test_routing_facets_fingerprint_ignores_summary_wording_drift() -> None:
    base = {
        "type": "regression",
        "summary": "DeepSeek-V3.1 fails on B200",
        "models": [{"name": "DeepSeek-V3.1", "family": "deepseek"}],
        "model_traits": ["moe"],
        "hardware": ["B200"],
        "serving": ["tp", "openai_api"],
        "areas": ["moe", "quantization"],
        "severity": {"serving_broken": True, "crash": False, "wrong_output": False, "hang": False,
                     "perf_regression_pct": None, "memory_regression": False, "security": False},
        "pr": {"fixes_issues": [10, 20]},
        "confidence": 0.9,
        "notes": "first phrasing",
    }
    reworded = {
        **base,
        "summary": "Startup error for DeepSeek-V3.1 on B200 GPUs",
        "areas": ["quantization", "moe"],
        "models": [{"name": "deepseek-v3.1", "family": "DeepSeek"}],
        "pr": {"fixes_issues": [20, 10]},
        "confidence": 0.75,
        "notes": "different notes",
    }
    assert routing_facets_fingerprint(base) == routing_facets_fingerprint(reworded)
    changed_area = {**base, "areas": ["attention"]}
    assert routing_facets_fingerprint(base) != routing_facets_fingerprint(changed_area)
    changed_type = {**base, "type": "feature"}
    assert routing_facets_fingerprint(base) != routing_facets_fingerprint(changed_type)
