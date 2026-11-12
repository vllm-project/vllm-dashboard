"""Offline backtest: run the pipeline over past items without a database.

  fetch    pull items created in a window from GitHub into items.jsonl
  extract  run the LLM over them (resumable; appends to facets.jsonl)
  report   score everything and write report.html + summary.json

Ground truth here is proxy-only (reactions, a merged PR that fixes the
issue, the `closed-as-slop` label); the report also emits a labeling sheet
so maintainers can judge a sample by hand.
"""

from __future__ import annotations

import html
import json
import random
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from triage.config import TriageConfig, default_config
from triage.extract import (
    BudgetExhausted,
    ExtractionError,
    ExtractionTask,
    LLMBackend,
    extract_one,
    system_prompt,
)
from triage.github import GitHubClient, item_from_raw
from triage.model import FileChange, Item
from triage.prepass import (
    BODY_LIMIT,
    COMMENTS_LIMIT,
    compute_prepass,
    content_hash,
    in_scope,
    prepass_priority,
)
from triage.scoring import score_item

REPO = "vllm-project/vllm"


# --- fetch -------------------------------------------------------------------


def _item_json(item: Item, prepass: dict[str, Any]) -> dict[str, Any]:
    data = asdict(item)
    for key in ("created_at", "updated_at", "closed_at"):
        value = data[key]
        data[key] = value.isoformat() if value else None
    data["prepass"] = prepass
    data["content_hash"] = content_hash(item)
    return data


def _item_from_json(data: dict[str, Any]) -> Item:
    fields = {k: v for k, v in data.items() if k not in ("prepass", "content_hash", "hydrated")}
    for key in ("created_at", "updated_at", "closed_at"):
        fields[key] = datetime.fromisoformat(fields[key]) if fields.get(key) else None
    fields["files"] = [FileChange(**f) for f in fields.get("files") or []]
    return Item(**fields)


def fetch(
    client: GitHubClient,
    out_dir: Path,
    *,
    start: datetime,
    end: datetime,
    config: TriageConfig,
) -> int:
    """List every item created in [start, end). Files and comments are
    fetched later, only for the items chosen for extraction (`hydrate`)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "items.jsonl"
    done = set()
    if path.exists():
        done = {json.loads(line)["number"] for line in path.read_text().splitlines() if line}
    count = 0
    with path.open("a") as out:
        for raw in client.issues_updated_since(REPO, start, max_items=50_000):
            item = item_from_raw(REPO, raw)
            if not (start <= item.created_at < end) or item.number in done:
                continue
            row = _item_json(item, compute_prepass(item, config))
            row["hydrated"] = False
            out.write(json.dumps(row) + "\n")
            done.add(item.number)
            count += 1
    return count


def hydrate(client: GitHubClient, out_dir: Path, rows: list[dict[str, Any]], config: TriageConfig) -> list[dict[str, Any]]:
    """Fetch PR files and comments for `rows`; append the updated rows."""
    out: list[dict[str, Any]] = []
    with (out_dir / "items.jsonl").open("a") as sink:
        for row in rows:
            if row.get("hydrated"):
                out.append(row)
                continue
            item = _item_from_json({k: v for k, v in row.items() if k != "hydrated"})
            if item.kind == "pr":
                item.files = client.pull_files(REPO, item.number)
            if item.comment_count:
                item.comments = client.comments(REPO, item.number)
            new = _item_json(item, compute_prepass(item, config))
            new["hydrated"] = True
            sink.write(json.dumps(new) + "\n")
            out.append(new)
    return out


def load_items(out_dir: Path) -> list[dict[str, Any]]:
    path = out_dir / "items.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    latest: dict[int, dict[str, Any]] = {}
    for row in rows:
        latest[row["number"]] = row
    return list(latest.values())


def load_facets(out_dir: Path) -> dict[int, dict[str, Any]]:
    path = out_dir / "facets.jsonl"
    if not path.exists():
        return {}
    out: dict[int, dict[str, Any]] = {}
    for line in path.read_text().splitlines():
        if line:
            row = json.loads(line)
            out[row["number"]] = row
    return out


# --- extract -----------------------------------------------------------------


def task_for(row: dict[str, Any]) -> ExtractionTask:
    return ExtractionTask(
        item_key=f"{row['repo']}#{row['number']}",
        kind=row["kind"],
        title=row["title"],
        body=row["body"][:BODY_LIMIT],
        comments="\n\n".join(row.get("comments") or [])[:COMMENTS_LIMIT],
        author_association=row["author_association"],
        state=row["state"],
        labels=row["labels"],
        files=row.get("files") or [],
        prepass=row["prepass"],
        content_hash=row["content_hash"],
    )


def select_for_extraction(
    rows: list[dict[str, Any]], *, limit: int, pr_share: float, seed: int, done: set[int]
) -> list[dict[str, Any]]:
    """A reproducible sample: all in-scope issues first (by priority), then a
    random slice of in-scope PRs, so a capped run still covers both kinds.
    Labels that only appear after triage (closed-as-slop) are not used here."""
    pool = [r for r in rows if in_scope(r["prepass"]["scope_reason"]) and r["number"] not in done]
    issues = [r for r in pool if r["kind"] == "issue"]
    prs = [r for r in pool if r["kind"] == "pr"]
    rng = random.Random(seed)
    rng.shuffle(issues)
    rng.shuffle(prs)
    n_prs = min(len(prs), int(limit * pr_share))
    n_issues = min(len(issues), limit - n_prs)
    n_prs = min(len(prs), limit - n_issues)
    return issues[:n_issues] + prs[:n_prs]


def extract(
    out_dir: Path,
    backend: LLMBackend,
    client: GitHubClient,
    *,
    limit: int,
    workers: int = 4,
    pr_share: float = 0.4,
    seed: int = 7,
) -> dict[str, Any]:
    rows = load_items(out_dir)
    done = set(load_facets(out_dir))
    chosen = select_for_extraction(rows, limit=limit, pr_share=pr_share, seed=seed, done=done)
    chosen = hydrate(client, out_dir, chosen, default_config())
    system = system_prompt()
    lock = threading.Lock()
    stats: Counter[str] = Counter()
    stop = threading.Event()
    out_path = out_dir / "facets.jsonl"
    err_path = out_dir / "errors.jsonl"

    def work(row: dict[str, Any]) -> None:
        if stop.is_set():
            return
        try:
            facets, result = extract_one(task_for(row), backend, system=system)
        except BudgetExhausted as exc:
            stop.set()
            with lock:
                stats["budget_stop"] += 1
                err_path.open("a").write(json.dumps({"number": row["number"], "error": str(exc)}) + "\n")
            return
        except ExtractionError as exc:
            with lock:
                stats["failed"] += 1
                err_path.open("a").write(json.dumps({"number": row["number"], "error": str(exc)}) + "\n")
            return
        record = {
            "number": row["number"],
            "content_hash": row["content_hash"],
            "facets": facets,
            "model": result.model,
            "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens,
            "duration_ms": result.duration_ms,
        }
        with lock:
            with out_path.open("a") as out:
                out.write(json.dumps(record) + "\n")
            stats["extracted"] += 1
            stats["input_tokens"] += result.input_tokens or 0
            stats["output_tokens"] += result.output_tokens or 0

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for future in as_completed([pool.submit(work, row) for row in chosen]):
            future.result()
    return {"selected": len(chosen), **stats}


# --- report ------------------------------------------------------------------


def _ground_truth(rows: list[dict[str, Any]]) -> dict[int, list[str]]:
    """Proxy signals that an item mattered (or was slop), known only later."""
    fixed_by: dict[int, list[int]] = {}
    for row in rows:
        if row["kind"] == "pr" and row["state"] == "merged":
            for issue in row["prepass"].get("linked_issues") or []:
                fixed_by.setdefault(issue, []).append(row["number"])
    truth: dict[int, list[str]] = {}
    for row in rows:
        tags = []
        if "closed-as-slop" in row["labels"]:
            tags.append("slop")
        if row["kind"] == "issue" and row["number"] in fixed_by:
            tags.append("fixed_by_merged_pr")
        if row["reactions"] >= 5:
            tags.append("reactions>=5")
        if row["comment_count"] >= 10:
            tags.append("comments>=10")
        if "verified" in row["labels"]:
            tags.append("verified")
        truth[row["number"]] = tags
    return truth


def score_all(
    rows: list[dict[str, Any]], facets: dict[int, dict[str, Any]], config: TriageConfig
) -> list[dict[str, Any]]:
    scored: dict[int, dict[str, Any]] = {}
    # Issues first so PRs can inherit the score of the issue they fix.
    for row in sorted(rows, key=lambda r: r["kind"] != "issue"):
        if not in_scope(row["prepass"]["scope_reason"]):
            continue
        record = facets.get(row["number"])
        linked = {
            n: scored[n]["score"] for n in row["prepass"].get("linked_issues") or [] if n in scored
        }
        score = score_item(
            kind=row["kind"],
            draft=row["draft"],
            reactions=row["reactions"],
            comment_count=row["comment_count"],
            prepass=row["prepass"],
            facets=record["facets"] if record else None,
            config=config,
            linked_issue_scores=linked,
        )
        scored[row["number"]] = {
            "row": row,
            "facets": record["facets"] if record else None,
            "score": score.score,
            "band": score.band,
            "breakdown": [f.as_json() for f in score.breakdown],
            "priority": prepass_priority(_item_from_json(row), row["prepass"]),
        }
    return list(scored.values())


def _rank_auc(scores_pos: list[int], scores_neg: list[int]) -> float | None:
    if not scores_pos or not scores_neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in scores_pos for n in scores_neg)
    return wins / (len(scores_pos) * len(scores_neg))


def summarize(scored: list[dict[str, Any]], rows: list[dict[str, Any]]) -> dict[str, Any]:
    truth = _ground_truth(rows)
    extracted = [s for s in scored if s["facets"] is not None]
    bands = Counter(s["band"] for s in extracted)
    by_kind_band = Counter((s["row"]["kind"], s["band"]) for s in extracted)
    metrics: dict[str, Any] = {}
    for tag in ("fixed_by_merged_pr", "reactions>=5", "slop"):
        pos = [s["score"] for s in extracted if tag in truth[s["row"]["number"]]]
        neg = [s["score"] for s in extracted if tag not in truth[s["row"]["number"]]]
        routed = [s for s in extracted if tag in truth[s["row"]["number"]] and s["band"] in ("page", "route")]
        metrics[tag] = {
            "n": len(pos),
            "auc_score_vs_rest": _rank_auc(pos, neg),
            "share_routed": (len(routed) / len(pos)) if pos else None,
        }
    scope = Counter(r["prepass"]["scope_reason"] for r in rows)
    days = max(
        1.0,
        (
            max(datetime.fromisoformat(r["created_at"]) for r in rows)
            - min(datetime.fromisoformat(r["created_at"]) for r in rows)
        ).total_seconds() / 86400,
    )
    return {
        "items_total": len(rows),
        "scope": dict(scope),
        "in_scope_per_day": round(sum(v for k, v in scope.items() if in_scope(k)) / days, 1),
        "extracted": len(extracted),
        "bands": dict(bands),
        "bands_by_kind": {f"{k}:{b}": n for (k, b), n in sorted(by_kind_band.items())},
        "routed_share": round((bands["page"] + bands["route"]) / max(1, len(extracted)), 3),
        "ground_truth": metrics,
    }


def _chips(values: list[str]) -> str:
    return "".join(f'<span class="chip">{html.escape(v)}</span>' for v in values)


def write_report(out_dir: Path, config: TriageConfig | None = None) -> dict[str, Any]:
    config = config or default_config()
    rows = load_items(out_dir)
    facets = load_facets(out_dir)
    scored = score_all(rows, facets, config)
    summary = summarize(scored, rows)
    truth = _ground_truth(rows)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))

    extracted = sorted((s for s in scored if s["facets"]), key=lambda s: -s["score"])
    rng = random.Random(11)
    sample = rng.sample(extracted, min(30, len(extracted)))
    sheet = [
        {
            "number": s["row"]["number"],
            "kind": s["row"]["kind"],
            "url": s["row"]["html_url"],
            "title": s["row"]["title"],
            "summary": s["facets"]["summary"],
            "score": s["score"],
            "band": s["band"],
            "your_band": "",
            "notes": "",
        }
        for s in extracted[:30] + sample
    ]
    (out_dir / "labeling-sheet.json").write_text(json.dumps(sheet, indent=2))

    def row_html(s: dict[str, Any]) -> str:
        r, f = s["row"], s["facets"]
        models = [m["name"] for m in f["models"]]
        breakdown = ", ".join(
            f"{b['factor']} {b['points']:+d}" + (f" ({b['detail']})" if b.get("detail") else "")
            for b in s["breakdown"]
        )
        url = r["html_url"] if r["html_url"].startswith("https://github.com/vllm-project/") else "#"
        return (
            f'<tr class="band-{s["band"]}"><td class="num">{s["score"]}</td><td>{s["band"]}</td>'
            f'<td>{r["kind"]}</td>'
            f'<td><a href="{html.escape(url)}">#{r["number"]}</a> {html.escape(r["title"][:140])}'
            f'<div class="sum">{html.escape(f["summary"])}</div>'
            f'<div class="bd">{html.escape(breakdown)}</div></td>'
            f'<td>{html.escape(f["type"])}</td><td>{_chips(f["areas"])}</td>'
            f"<td>{_chips(models)}</td><td>{_chips(f['hardware'])}</td>"
            f"<td>{_chips(truth[r['number']])}</td></tr>"
        )

    gt_rows = "".join(
        f"<tr><td>{html.escape(tag)}</td><td>{m['n']}</td>"
        f"<td>{'' if m['auc_score_vs_rest'] is None else f'{m['auc_score_vs_rest']:.2f}'}</td>"
        f"<td>{'' if m['share_routed'] is None else f'{m['share_routed']:.0%}'}</td></tr>"
        for tag, m in summary["ground_truth"].items()
    )
    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Triage Backtest</title>
<style>
:root{{--bg:#fff;--fg:#1b1b1f;--muted:#666;--line:#e3e3e8;--page:#fde2e1;--route:#fff3d6;--chip:#eef1f6}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151518;--fg:#e9e9ee;--muted:#9a9aa5;--line:#2c2c33;--page:#4a1f1f;--route:#43391c;--chip:#262a33}}}}
body{{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}}
.num{{font-variant-numeric:tabular-nums;font-weight:600}}.band-page{{background:var(--page)}}.band-route{{background:var(--route)}}
.chip{{display:inline-block;background:var(--chip);border-radius:4px;padding:0 5px;margin:1px;font-size:12px}}
.sum{{color:var(--muted)}}.bd{{color:var(--muted);font-size:12px}}a{{color:inherit}}
.wrap{{overflow-x:auto}}pre{{white-space:pre-wrap}}
</style></head><body>
<h1>Triage backtest</h1>
<pre>{html.escape(json.dumps({k: v for k, v in summary.items() if k != "ground_truth"}, indent=1))}</pre>
<h2>Ground-truth proxies</h2>
<p>AUC = chance a random positive outscores a random other item (0.5 = no signal; for slop, lower is better).</p>
<table><tr><th>signal</th><th>n</th><th>AUC</th><th>share routed</th></tr>{gt_rows}</table>
<h2>Extracted items by score</h2>
<div class="wrap"><table><tr><th>score</th><th>band</th><th>kind</th><th>item</th><th>type</th><th>areas</th><th>models</th><th>hw</th><th>proxies</th></tr>
{"".join(row_html(s) for s in extracted)}</table></div>
</body></html>"""
    (out_dir / "report.html").write_text(page)
    return summary


def default_window(days: int, *, end: datetime | None = None) -> tuple[datetime, datetime]:
    end = end or datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return end - timedelta(days=days), end
