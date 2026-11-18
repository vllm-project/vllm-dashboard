# Issue/PR triage

Reads every new vllm-project/vllm issue and PR. It labels each one by model,
hardware, serving config and area, scores its impact, and routes the ones
above a threshold to one or two maintainers whose rules match. Maintainers
work their queue on ci.vllm.ai/triage. Slack delivery exists but is off; see
"Slack" below.

## Pipeline

```
GitHub ─► triage-ingest (worker, 5 min) ─► triage_items + deterministic prepass
                                               │
          vllm-triage extract (extractor host, Claude Code, 10 min)
                                               ▼
                                         triage_extractions (facets)
                                               │
          triage-route (worker, 5 min) ─► triage_scores ─► triage_assignments
                                               │                 │
          triage-digest (worker, daily) ─────────────────► outbox (shadow)
                                               │
                     ci.vllm.ai/triage ◄───────┘  ─► triage_actions
```

| Step | Code | Notes |
|---|---|---|
| Ingest | `pipeline.IngestHandler`, `github.py` | Read-only GitHub token. Fetches PR files and new comments only for in-scope items. |
| Prepass | `prepass.py`, `config/areas.yaml` | Areas from changed paths (seeded from vLLM's mergify rules) and labels. Also linked issues, hardware/model mentions, and scope. |
| Scope | `prepass.scope_reason`, `scope.max_age_days` in `config/scoring.yaml` | Issues and PRs **opened in the last 30 days**: issues, PRs from non-maintainers, and maintainer PRs that link an issue. Older items, maintainer PRs without a linked issue, and bot PRs are stored but not extracted. The route consumer takes items out of scope as they age past the window and removes unacted router assignments on them. |
| Extract | `extract.py`, `facets.py`, `assets/extractor-system.md` | Claude Code headless, with no tools and schema-constrained JSON. Runs on a separate host: [deploy/triage-extractor](../deploy/triage-extractor/README.md). |
| Score | `scoring.py`, `config/scoring.yaml`, `config/tiers.yaml` | Deterministic. `severity × reach (model × hardware × config) + additive factors`. The breakdown always sums to the score. |
| Route | `routing.py`, `relevance.py`, `config/maintainers/` | Who an item is for, strongest first: a maintainer already **involved** (assigned on GitHub, wrote a PR the item names, or commented), then **relevance** judged by Claude from each maintainer's last 6 months of authored/reviewed PRs plus the free-text `notes` in their own file (`vllm-triage relevance` on the extractor host), then optional rules. Profiles are rebuilt daily by the route consumer, with what the person recently said "not mine" to or took. Routing waits up to 2 hours for every maintainer's judgement, then routes among those judged. Relevance runs on Opus (`TRIAGE_RELEVANCE_MODEL`); "medium" means the same specific component the person authors in, not a broad area, and a broad "send me" category in their notes only counts inside components they author (rel-v4). Weekly capacity counts items the person kept (not ones they passed on). Only page-band items that are new or a clear match (involved or "high") may exceed it, so a backlog of weaker matches is spread out. Items assigned on GitHub only to people outside the maintainer list are not routed. |
| Follow GitHub | `store.follow_github`, run by the route consumer | Closed/merged items: open and acked assignments become `done` (reason `closed_by: github`); unacked ones stop counting toward capacity; reopened items get their assignment back. A maintainer commenting on their item after it was assigned acks it. See docs/data-model.md. |
| Notify | `notify.py` | Immediate DM for P0, daily DM digest, daily team digest. DMs have Ack / Not mine / Reassign buttons handled by the dashboard (see docs/triage-dashboard.md, "Slack buttons"). **Shadow only for now.** |
| Act | dashboard ([docs/triage-dashboard.md](../docs/triage-dashboard.md)) | ack / not mine / reassign / drop / slop / done / reopen. The router never re-routes dropped or slop items, and never routes an item back to someone who said it isn't theirs. |

The data contract between all of these is [docs/data-model.md](docs/data-model.md).

## Safety properties

- **Untrusted text.** Issue and PR text and model output are untrusted. The
  model has no tools and cannot act. Its output is re-validated against
  enums. Slack text goes through `alerting.untrusted.safe_slack_mrkdwn`, and
  the dashboard renders text only.
- **Scores are computed, not generated.** A prompt-injected issue can at most
  lie about its own facets. The system prompt asks the model to flag
  injection attempts as a slop signal.
- **The Claude Code login stays on one host.** It never reaches the AWS worker
  or Vercel. That host's database role can only read items and write
  extractions.
- **Two separate switches gate Slack.** See below.

## Slack

There is no Slack delivery until the triage owner turns it on. Two
independent switches gate it:

1. the shared S3 control `control/triage.mode` must be `live`, **and**
2. the worker env must have `TRIAGE_SLACK_ENABLED=1`.

Otherwise every DM and digest is rendered and stored in
`alerting_notification_outbox` as `delivery_mode='shadow'`. The dispatcher
never leases shadow rows. The team digest also needs
`TRIAGE_DIGEST_CHANNEL`. Tested in `tests/test_core.py`.

## Tuning

Change `config/scoring.yaml` or `config/tiers.yaml` and bump `version`. The
next `triage-route` run re-scores every open item, with no new LLM calls.
To try a change offline first, run the backtest:

```bash
cd triage
uv run vllm-triage backtest fetch   --dir /tmp/bt --days 14   # GitHub list only
uv run vllm-triage backtest extract --dir /tmp/bt --limit 120 # Claude Code, resumable
uv run vllm-triage backtest report  --dir /tmp/bt             # report.html, summary.json, labeling-sheet.json
```

`report` re-scores the cached facets, so you can iterate on weights for
free. It also writes a labeling sheet (the top 30 plus a random 30) for
maintainers to grade by hand.

## Development

```bash
cd triage
uv sync --extra dev
uv run pytest                                    # unit tests
uv run --extra dev --with pgserver pytest        # + end-to-end against embedded Postgres
uv run ruff check . && uv run mypy .
```

## Not in v1

- Routing by git-history affinity (who recently touched these paths), for
  items no rule matches. Those stay "unrouted" on the dashboard.
- Duplicate detection and links to related issues.
- PR diffs in the extractor prompt. It sees the description and the changed
  file list only.
- Slack buttons. Actions happen on the dashboard; DMs link there.
- Escalating unacked page-band items to the backup or a channel.
- Writing labels or assignees back to GitHub. The worker's GitHub token is
  read-only by policy.
