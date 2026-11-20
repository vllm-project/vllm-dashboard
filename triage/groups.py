"""Issue + fix PR groups.

A PR "fixes" an issue when GitHub lists the issue among the PR's closing
references, the PR text says "Fixes/Closes/Resolves #N" (both recorded in
prepass.fixes_issues at ingest), or Claude's label says so
(facets.pr.fixes_issues). A plain mention ("related to #N", "see #N") is not
a fix. Both items must be vllm-project/vllm items in triage_items, the
issue an issue and the PR a PR (store.fix_links does that join).

A group is an issue and its fix PRs. An issue can have several fix PRs and a
PR can fix several issues; for display a PR sits under the highest-scored
issue it fixes, but routing looks at every issue it fixes.

Routing (pipeline.RouteHandler._route_one, routing.group_owner):
  * when a member already has an owner (open/acked primary), the others go
    to the same person, with the reason "fixes #N" (on the PR) or
    "fixed by #N" (on the issue), unless that person said "not mine" to it,
    excludes it, is away, or its group's score is below their min_score;
  * when nobody owns any member, the highest-scored member is routed as
    usual with its group's highest score and band (a P1 PR fixing a P0 issue
    goes with the P0), and the others follow it in the same run;
  * a group takes one weekly capacity slot: the followers' assignments carry
    reason.grouped_with and store.maintainer_load doesn't count them.

The dashboard mirrors this in src/lib/triage-groups.ts and
src/lib/triage-why-unowned.ts.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

# Reason codes on an assignment that followed its group.
FIXES = "fixes"
FIXED_BY = "fixed by"
GROUP_REASON = re.compile(r"(fixes|fixed by) #(\d+)")


@dataclass(frozen=True)
class Member:
    """What the router needs to know about another member of an item's group."""

    item_key: str
    number: int
    kind: str
    state: str
    score: int | None
    band: str | None
    # Login of the open/acked primary owner, if any.
    owner: str | None


def number_of(item_key: str) -> int:
    return int(item_key.rsplit("#", 1)[-1])


def partner_map(links: Iterable[tuple[str, str]]) -> dict[str, set[str]]:
    """{item_key: keys it is directly linked to} from (pr_key, issue_key) pairs."""
    out: dict[str, set[str]] = {}
    for pr, issue in links:
        if pr == issue:
            continue
        out.setdefault(pr, set()).add(issue)
        out.setdefault(issue, set()).add(pr)
    return out


def group_reason(member: Member) -> str:
    """Reason code for an item that follows `member`: "fixes #N" when the
    member is the issue it fixes, "fixed by #N" when the member is its fix PR."""
    return f"{FIXES if member.kind == 'issue' else FIXED_BY} #{member.number}"


def is_group_reason(code: str) -> bool:
    return GROUP_REASON.fullmatch(code) is not None


def component(start: str, partners: dict[str, set[str]]) -> list[str]:
    """Every item connected to `start` through fix links, `start` first."""
    seen = [start]
    queue = [start]
    while queue:
        for key in sorted(partners.get(queue.pop(0), ())):
            if key not in seen:
                seen.append(key)
                queue.append(key)
    return seen
