"""Issue + fix PR groups (triage/groups.py): what pairs, routing, Slack."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from alerting.ports import DeliveryMode

from triage.config import default_config
from triage.groups import Member, component, group_reason, partner_map
from triage.model import Item, Maintainer
from triage.notify import DIGEST_MAX_PER_BAND, describe_reason, group_entries, maintainer_digest, page_dm, team_digest
from triage.prepass import compute_prepass, fixes_issues
from triage.routing import RoutingContext, group_owner
from triage.store import DigestEntry

NOW = datetime(2026, 11, 20, tzinfo=timezone.utc)
GH = "https://github.com/vllm-project/vllm/"


def test_only_closing_keywords_and_closing_references_count_as_fixes() -> None:
    text = (
        "Fixes #65385. Also closes https://github.com/vllm-project/vllm/issues/65906 and\n"
        "Resolves: vllm-project/vllm#66000; fix #1. Related to #70000, see #70001, addresses #70002,\n"
        "https://github.com/vllm-project/vllm/issues/70003, FIX #xxxx (template placeholder)"
    )
    assert fixes_issues(text) == [1, 65385, 65906, 66000]
    pr = Item(repo="vllm-project/vllm", number=67812, kind="pr", title="[Bugfix] beta", body="Related to #70000",
              author="a", author_association="NONE", state="open", html_url=GH + "pull/67812",
              created_at=NOW, updated_at=NOW, closing_issues=[65385])
    prepass = compute_prepass(pr, default_config())
    assert prepass["fixes_issues"] == [65385]               # the sidebar link, not the mention
    assert prepass["linked_issues"] == [65385, 70000]       # unchanged: scoring still credits both
    issue = Item(repo="vllm-project/vllm", number=65385, kind="issue", title="t", body="Fixes #1",
                 author="a", author_association="NONE", state="open", html_url=GH + "issues/65385",
                 created_at=NOW, updated_at=NOW)
    assert compute_prepass(issue, default_config())["fixes_issues"] == []


def test_partner_map_and_component() -> None:
    links = [("r#2", "r#1"), ("r#3", "r#1"), ("r#3", "r#4"), ("r#9", "r#9")]
    partners = partner_map(links)
    assert partners == {"r#1": {"r#2", "r#3"}, "r#2": {"r#1"}, "r#3": {"r#1", "r#4"}, "r#4": {"r#3"}}
    assert component("r#2", partners) == ["r#2", "r#1", "r#3", "r#4"]
    assert group_reason(Member("r#1", 1, "issue", "open", 50, "route", None)) == "fixes #1"
    assert group_reason(Member("r#2", 2, "pr", "open", 50, "route", None)) == "fixed by #2"


def test_group_reasons_in_words() -> None:
    assert describe_reason("fixes #65385") == "it fixes #65385, which you own"
    assert describe_reason("fixed by #66694") == "it is fixed by #66694, which you own"
    assert describe_reason("fixes #65385", "vi") == "đây là bản sửa cho #65385, mục bạn đang phụ trách"
    assert describe_reason("fixed by #66694", "vi") == "mục này được sửa bởi #66694, PR bạn đang phụ trách"


def ctx(score: int = 60, band: str = "route", **kw: Any) -> RoutingContext:
    return RoutingContext(item_key="vllm-project/vllm#67812", kind="pr", title="fix", score=score,
                          band=band, facets={"areas": ["kernels"], "hardware": kw.pop("hardware", [])},  # type: ignore[arg-type]
                          prepass={"commenters": kw.pop("commenters", [])}, files=[])


def member(number: int, owner: str | None, score: int = 80, kind: str = "issue", state: str = "open") -> Member:
    return Member(f"vllm-project/vllm#{number}", number, kind, state, score, "page", owner)


def test_group_owner_follows_the_highest_scored_owner_who_may_take_it() -> None:
    people = {m.github_login: m for m in [
        Maintainer("gau-nernst", min_score=70), Maintainer("b"), Maintainer("away", away=[{"start": "2026-11-01", "end": "2026-12-01"}]),
        Maintainer("amd", rules={"exclude": {"hardware": ["MI355X"]}}),
    ]}
    today = date(2026, 11, 20)
    found = group_owner(ctx(commenters=["gau-nernst"]), [member(65385, "gau-nernst", 76), member(1, "b", 50)],
                        people, load={"gau-nernst": 3}, excluded=set(), today=today)
    assert found is not None
    candidate, owned = found
    # min_score 70 is met through the group: the PR scores 60, its issue 76.
    assert candidate.maintainer.github_login == "gau-nernst" and owned.number == 65385
    assert candidate.reasons == ["fixes #65385", "commented"] and candidate.strong and candidate.load == 3
    # "Not mine" on this item: the next owner in the group.
    found = group_owner(ctx(), [member(65385, "gau-nernst", 76), member(1, "b", 50)], people,
                        load={}, excluded={"gau-nernst"}, today=today)
    assert found is not None and found[0].maintainer.github_login == "b"
    # Under min_score even as a group, away, excluded hardware, unknown login, or nobody owns it.
    assert group_owner(ctx(score=40), [member(2, "gau-nernst", 50)], people, load={}, excluded=set(), today=today) is None
    assert group_owner(ctx(), [member(2, "away")], people, load={}, excluded=set(), today=today) is None
    assert group_owner(ctx(hardware=["MI355X"]), [member(2, "amd")], people, load={}, excluded=set(), today=today) is None
    assert group_owner(ctx(), [member(2, "gone")], people, load={}, excluded=set(), today=today) is None
    assert group_owner(ctx(), [member(2, None)], people, load={}, excluded=set(), today=today) is None


def entry(number: int, kind: str, score: int, band: str = "route", fixes: tuple[int, ...] = (),
          matched: list[str] | None = None, why_local: str = "") -> DigestEntry:
    return DigestEntry(number, f"vllm-project/vllm#{number}", f"title {number}",
                       GH + ("issues/" if kind == "issue" else "pull/") + str(number), score, band, "summary",
                       ["commented"] if matched is None else matched, why_local, kind=kind,
                       fixes=tuple(f"vllm-project/vllm#{n}" for n in fixes))


def test_group_entries_nest_fix_prs_under_their_highest_scored_issue() -> None:
    entries = [entry(10, "pr", 99, "page", fixes=(1, 2)), entry(1, "issue", 70), entry(2, "issue", 80),
               entry(11, "pr", 50, fixes=(2,)), entry(12, "pr", 40, fixes=(3,)), entry(3, "issue", 30, "watch")]
    groups = group_entries(entries)
    # A group sits where its first (highest-scored) member would; a PR fixing
    # two listed issues goes under the higher-scored one.
    assert [(m.assignment_id, [f.assignment_id for f in fixes]) for m, fixes in groups] == [
        (2, [10, 11]), (1, []), (3, [12])]
    # A PR whose issue isn't listed stands alone.
    assert [(m.assignment_id, f) for m, f in group_entries([entry(12, "pr", 40, fixes=(3,))])] == [(12, [])]


def test_digest_shows_a_group_as_one_item_with_one_set_of_buttons() -> None:
    issue = entry(65385, "issue", 76, "page", matched=["relevance:high (like #61343)"])
    fix = entry(67812, "pr", 52, fixes=(65385,), matched=["fixes #65385"])
    other = entry(70000, "issue", 50)
    for lang, word in (("en", "↳ Fix"), ("vi", "↳ Bản sửa")):
        payload = maintainer_digest(maintainer="gau-nernst", maintainer_slack="U1", entries=[issue, fix, other],
                                    day=NOW, mode=DeliveryMode.SHADOW, lang=lang, reassign_to=["b"]).payload
        items = [b for b in payload["blocks"] if str(b.get("block_id", "")).startswith("triage:item:")]
        actions = [b for b in payload["blocks"] if b["type"] == "actions"]
        assert [b["block_id"] for b in items] == ["triage:item:vllm-project/vllm#65385", "triage:item:vllm-project/vllm#70000"]
        assert not actions
        assert items[0]["accessory"]["options"][0]["value"] == "ack|vllm-project/vllm#65385"
        text = items[0]["text"]["text"]
        assert text.split("\n")[-1].startswith(f"{word} <{GH}pull/67812|#67812>")
        assert "ci.vllm.ai/triage?item=" in text
        assert "65385, which you own" not in text and "mục bạn đang phụ trách" not in text
    # Counts are in groups: one P0 (the issue's group) and one P1.
    assert payload["text"] == "Digest triage: 1 P0, 1 P1"


def test_digest_max_items_counts_groups_and_fits_50_blocks() -> None:
    entries: list[DigestEntry] = []
    for i in range(1, 31):
        entries += [entry(i, "issue", 60), entry(1000 + i, "pr", 55, fixes=(i,)), entry(2000 + i, "pr", 54, fixes=(i,))]
    payload = maintainer_digest(maintainer="x", maintainer_slack="U1", entries=entries, day=NOW,
                                mode=DeliveryMode.SHADOW, reassign_to=["y"]).payload
    assert len(payload["blocks"]) <= 50
    assert sum("accessory" in b for b in payload["blocks"]) == DIGEST_MAX_PER_BAND
    assert "30 P1" in payload["blocks"][1]["text"]["text"]
    assert "…and 27 more" in payload["blocks"][-2]["elements"][0]["text"]


def test_reminders_fold_into_groups_too() -> None:
    old = datetime(2026, 11, 15, tzinfo=timezone.utc)
    waiting = [DigestEntry(1, "vllm-project/vllm#1", "issue one", GH + "issues/1", 60, "route", "", [], assigned_at=old,
                           kind="issue"),
               DigestEntry(2, "vllm-project/vllm#2", "fix one", GH + "pull/2", 55, "route", "", [], assigned_at=old,
                           kind="pr", fixes=("vllm-project/vllm#1",))]
    payload = maintainer_digest(maintainer="x", maintainer_slack="U1", entries=[], day=NOW, mode=DeliveryMode.SHADOW,
                                waiting=waiting, waiting_total=2).payload
    texts = [b.get("text", {}).get("text", "") for b in payload["blocks"]]
    assert payload["text"] == "Triage digest: 1 P1"
    assert any(f"\n↳ Fix <{GH}pull/2|#2>" in t for t in texts)
    assert sum("accessory" in b for b in payload["blocks"]) == 1


def test_page_dm_and_team_digest_show_the_group() -> None:
    issue = entry(65906, "issue", 79, "page", matched=["fixed by #66694"])
    fix = entry(66694, "pr", 99, "page", fixes=(65906,), matched=["relevance:high"])
    dm = page_dm(assignment_key="k", maintainer_slack="U1", entry=issue, role="primary", mode=DeliveryMode.SHADOW,
                 fixes=[fix]).payload
    text = dm["blocks"][1]["text"]["text"]
    assert text.startswith(f":rotating_light: *P0* *<{GH}issues/65906|#65906 title 65906>*\n↳ fix: <{GH}pull/66694|#66694 title 66694>")
    # "Why you" is the lead's (the PR was routed on its merits; the issue followed it).
    assert "*Why you:* judged high from your recent work" in text and "which you own" not in text
    assert [e.get("value") for e in dm["blocks"][2]["elements"][:2]] == ["vllm-project/vllm#65906"] * 2
    team = team_digest(channel="C1", entries=[(fix, ["gau-nernst"]), (issue, ["gau-nernst"])], day=NOW,
                       mode=DeliveryMode.SHADOW).payload
    body = "".join(b.get("text", {}).get("text", "") for b in team["blocks"])
    assert body.count("#65906 title") == 1 and "↳ fix: <" in body
