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
| Scope | `prepass.scope_reason` | Issues, PRs from non-maintainers, and maintainer PRs that link an issue. Maintainer PRs without a linked issue and bot PRs are stored but not extracted. |
| Extract | `extract.py`, `facets.py`, `assets/extractor-system.md` | Claude Code headless, with no tools and schema-constrained JSON. Runs on a separate host: [deploy/triage-extractor](../deploy/triage-extractor/README.md). |
| Score | `scoring.py`, `config/scoring.yaml`, `config/tiers.yaml` | Deterministic. `severity × reach (model × hardware × config) + additive factors`. The breakdown always sums to the score. |
| Route | `routing.py`, `maintainers.py`, `config/maintainers/` | Explicit maintainer rules only, one file per maintainer in [`config/maintainers/`](config/maintainers/README.md). Maintainers change their own file by PR; the worker syncs `main`'s copy every 5 minutes, and CI (`.github/workflows/triage.yml`) checks the files. The most specific match wins, then lowest load relative to capacity. Page-band items also get a backup. |
| Notify | `notify.py` | Immediate DM for page band, daily DM digest, daily team digest. **Shadow only for now.** |
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
