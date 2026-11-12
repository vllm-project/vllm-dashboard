# Triage extractor host

The triage pipeline's only LLM step. It runs on a machine where Claude Code
is logged in with a Pro/Max plan, and nowhere else. The AWS alerting worker
does not install Claude Code (see vllm-project/vllm-dashboard#83 and
`deploy/aws/tests`), so the work is split:

| Where | Does | Credentials it holds |
|---|---|---|
| AWS alerting worker | GitHub ingest, scoring, routing, digests (`triage-*` timers) | worker secret (unchanged) |
| Extractor host | `vllm-triage extract` every 10 min | Claude Code login + `triage_extractor` DB role |

The plan login never leaves the extractor host, and the database role can
only read items and write extractions (tested in
`triage/tests/test_postgres.py::test_extractor_role_can_extract_and_nothing_else`).

## What the model can and cannot do

- It gets no tools, no MCP servers, no settings or CLAUDE.md
  (`--tools "" --strict-mcp-config --setting-sources ""`), and runs in an
  empty temporary directory.
- It reads one item's stored text and returns JSON constrained by
  `triage/facets.py:FACETS_SCHEMA`. The output is re-validated; unknown
  values are dropped.
- It never sets a score, an owner or a label. Those are computed from the
  validated facets by deterministic code on the worker.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are stripped from its
  environment, so usage always counts against the plan, never an API bill.

## Budget

Each run stops at whichever comes first:

- `TRIAGE_MAX_ITEMS_PER_RUN` (default 40) items,
- `TRIAGE_MAX_ITEMS_PER_DAY` (default 150) or `TRIAGE_MAX_TOKENS_PER_DAY`
  (default 2,000,000) over the last 24 hours, counted from
  `triage_extractions`,
- the first "usage limit" response from Claude, which leaves the remaining
  leased items pending for a later run.

The extraction queue is ordered by a cheap deterministic priority (crash /
regression keywords, hardware and model mentions, reactions), so when the
budget is short the likely-important items are read first.

Pilot measurement (2026-11-12, Sonnet, 120 items): about 8.2k input tokens
(mostly cached system prompt and schema) and 0.7k output tokens per item,
about 5.5 s per item. vLLM averaged about 156 in-scope items a day over the
two weeks before that.

## Setup

1. Apply migration `0038_triage.sql` (see `migrations/README.md`).
2. As the database owner, create the role:
   `psql "$OWNER_DATABASE_URL" -v pw="'<password>'" -f extractor-role.sql`
3. On the extractor host:
   ```bash
   install -d -m 700 ~/.config/vllm-triage
   cp deploy/triage-extractor/extractor.env.example ~/.config/vllm-triage/extractor.env
   chmod 600 ~/.config/vllm-triage/extractor.env   # then fill DATABASE_URL
   claude auth status                              # must be a claude.ai login
   ```
   For unattended use, `claude setup-token` creates a long-lived plan token;
   put it in the env file as `CLAUDE_CODE_OAUTH_TOKEN`.
4. Try one run by hand: `deploy/triage-extractor/run-extractor.sh` and read
   `~/.local/state/vllm-triage/extractor.log`.
5. Schedule it (crontab -e):
   ```
   */10 * * * * /path/to/vllm-dashboard/deploy/triage-extractor/run-extractor.sh
   ```

The extractor never talks to Slack or GitHub.
