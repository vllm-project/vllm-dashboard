"""Tests for budgeted PR diff excerpt filtering, prioritization, and prompt rendering."""

from __future__ import annotations

from datetime import datetime, timezone

from triage.diff import format_diff_excerpt
from triage.extract import ExtractionTask, render_prompt
from triage.model import FileChange, Item
from triage.prepass import content_hash

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)


def _diff_block(path: str, body: str) -> str:
    return (
        f"diff --git a/{path} b/{path}\n"
        f"index 1111111..2222222 100644\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        f"@@ -1,2 +1,3 @@\n"
        f"{body}\n"
    )


def test_format_diff_skips_lockfiles_binaries_and_prioritizes_source_over_tests() -> None:
    raw = "\n".join([
        _diff_block("uv.lock", "+version = 2\n" * 10),
        "diff --git a/docs/logo.png b/docs/logo.png\nBinary files a/docs/logo.png and b/docs/logo.png differ\n",
        _diff_block("docs/guide.md", "+Updated docs line"),
        _diff_block("tests/test_moe.py", "+def test_moe_fix():\n+    assert True"),
        _diff_block("vllm/model_executor/layers/fused_moe/layer.py", "+    scale = scale.to(torch.float32)"),
    ])
    out = format_diff_excerpt(raw, max_chars=2000)
    assert "uv.lock" not in out
    assert "logo.png" not in out
    assert "index 1111111" not in out
    # Core source file comes BEFORE tests, which comes BEFORE docs.
    src_pos = out.index("fused_moe/layer.py")
    test_pos = out.index("tests/test_moe.py")
    doc_pos = out.index("docs/guide.md")
    assert src_pos < test_pos < doc_pos
    assert "2 noisy/binary file(s) skipped" in out


def test_format_diff_respects_per_file_and_total_budget() -> None:
    raw = "\n".join([
        _diff_block("vllm/a.py", "+x = 1\n" * 500),
        _diff_block("vllm/b.py", "+y = 2\n" * 500),
        _diff_block("vllm/c.py", "+z = 3\n" * 500),
    ])
    out = format_diff_excerpt(raw, max_chars=900, max_per_file=400)
    assert len(out) <= 900
    assert "[file truncated]" in out
    assert "omitted" in out


def test_content_hash_and_render_prompt_with_diff_excerpt() -> None:
    base = Item(
        repo="vllm-project/vllm", number=42, kind="pr", title="Fix kernel", body="Fixes #1",
        author="dev", author_association="NONE", state="open",
        html_url="https://github.com/vllm-project/vllm/pull/42",
        created_at=NOW, updated_at=NOW, files=[FileChange("vllm/a.py", 1, 1)],
    )
    h_no_diff = content_hash(base)
    with_diff = Item(**{**base.__dict__, "diff_excerpt": "+if x < 0 & y > 1: pass"})
    assert content_hash(with_diff) != h_no_diff

    task = ExtractionTask(
        "vllm-project/vllm#42", "pr", "Fix kernel", "Fixes #1", "", "NONE", "open", [],
        [{"path": "vllm/a.py", "additions": 1, "deletions": 1}], {}, content_hash(with_diff),
        diff_excerpt="+if x < 0 & y > 1: pass",
    )
    rendered = render_prompt(task)
    assert "<diff>\n+if x &lt; 0 &amp; y &gt; 1: pass\n</diff>" in rendered

    issue_task = ExtractionTask(
        "vllm-project/vllm#1", "issue", "Bug", "Crash", "", "NONE", "open", [], [], {}, "h", diff_excerpt="ignored"
    )
    assert "<diff>" not in render_prompt(issue_task)
