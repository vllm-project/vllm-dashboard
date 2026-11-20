# Triage dashboard

The **Triage** tab (`/triage`) shows incoming vLLM issues and PRs that the
triage pipeline (`triage/`, see `triage/README.md` and
`triage/docs/data-model.md`) has ingested, read with an LLM, scored and
routed. It is **maintainers only**: it shows LLM judgements about outside
contributors' work (including "slop" flags), so nothing is public.

## Priorities

The pipeline stores a score band per item (`page`, `route`, `watch`,
`ignore`) in the database, API, URLs (`?bands=page,route`) and config. The
dashboard shows them as priorities:

| Stored band | Shown as | Meaning |
|---|---|---|
| `page` | **P0** | Highest impact: routed first |
| `route` | **P1** | Needs an owner: routed to the best-matching maintainer |
| `watch` | **P2** | Watch: on the dashboard only |
| `ignore` | **P3** | Low: no action expected; hidden by default |
| (no score) | **Unscored** | Not scored yet: waiting for the LLM read |

The mapping lives in one place, `BAND_STYLES` in `src/lib/triage-style.ts`.
Only P0 and P1 carry color in lists (a solid badge and a left stripe); P2 is
a soft blue badge and P3 is grey.

## Pages

| Path | What |
|---|---|
| `/triage` | Queue. At the very top, one line of pipeline health: when Claude last labelled an item and how many open items wait for a label, when it last judged relevance and how many unowned P0/P1 wait for judgements, and labelling failures in 24 hours. Each part turns amber or red when it falls behind (work waiting more than 25 / 60 minutes with no new labels or judgements; 3 / 10 failures; anything that failed every attempt; the Claude login within 7 days of `TRIAGE_CLAUDE_LOGIN_EXPIRES`). Thresholds are in `src/lib/triage-health.ts`; hover a part for details. Then a strip: open items by priority (a segmented bar; each part filters), P0/P1 items with no owner (red when a P0 has none), how much the LLM has read in 7 days, and new items today. Below, one toolbar: a P0–P3 toggle with counts, kind, area, hardware, an owner picker ("Anyone", "Unowned", or a maintainer; URL `owner=<login>` or `owner=none`, and the old `assignee=<login>` still works), owner status, sort, a "Closed" switch, a "How is this scored?" link, and a search box that applies as you type (`#123`, free text, or `model:qwen3`). Sorted by priority, the list is grouped into P0 / P1 / P2 / P3 sections with sticky headers; P3 starts collapsed. Each row shows the P-badge and score, kind and number, the worst severity flag in color (others neutral), the title, one line of context (hardware, model, area; the rest in the drawer), the owner, and age. Open P0-P2 PRs also get a small CI pill: "CI ✓", "CI 20/41" (running), "CI 3 ✗" (red), "CI 3 ✗ (main)" (amber: every failure also fails on main, now or this week), or "CI not run" (nobody ran `/ci run` on the head commit); nested fix PRs get theirs too. A fix PR whose issue is on the same page sits indented under the issue's row ("↳ fix"), and the pair is filed under its more urgent member; other rows say "Fixes #N" / "Fixed by #N (merged)". Clicking a row opens the item drawer (`?item=owner/repo#N`), which lists the group with links and owners. On a phone each row stacks and the owner moves under the title. |
| `/triage/me` | My list, grouped by priority like the queue: the signed-in maintainer's open and acked assignments (their fix PRs nested under the issue they fix), why the router picked them, and Ack / Not mine / Reassign / Drop / Slop / Done; then assignments closed in the last 14 days with Reopen. |
| `/triage/scoring` | How scoring works: the formula in plain words (how bad × who it hits + extras − penalties), what each priority means for routing, every number in tables, the model and GPU tier lists, and two worked examples computed with the router's arithmetic. The numbers live in `src/lib/triage-scoring-config.ts`; a test loads `triage/config/scoring.yaml` and `tiers.yaml` and fails if they drift. |
| `/triage/guide` | How it works, for maintainers new to triage: what gets triaged, how items reach you, your maintainer file, what each button does, Slack (off during the beta), and who to ask. The routing windows it quotes live in `src/lib/triage-guide.ts`; a test checks them against `triage/pipeline.py` and `triage/maintainers.py`. |
| `/triage/rules` | Draft & preview. Loads the signed-in maintainer's current rules from the database (synced from `triage/config/maintainers/<login>.yaml`) into a local draft with the same fields (areas, hardware, model globs, path globs, keywords, type filter, excludes, minimum score, weekly capacity, away dates, Slack notification mode and user ID). **Preview last 30 days** lists which recent items the draft matches. **Copy as YAML** copies the full file content. If the maintainer already has a file (their row has `updated_by = 'repo'`), **Edit your rules file on GitHub** opens it in GitHub's editor on `main`; otherwise **Create your rules file on GitHub** opens GitHub's new-file page pre-filled with `<login>.yaml` and the draft's YAML. Nothing is saved from the dashboard. |

The item drawer opens with a summary: priority, score, title, every severity
flag, the one-line summary, the owners (primary and backup, their status, and
one line on why each was picked) and the actions. A P0/P1 with no owner says
why the router hasn't assigned it, worked out from the same rules as the
router (`src/lib/triage-why-unowned.ts`, a mirror of `choose_owners` and
`_route_one`): for example "assigned on GitHub to someone who isn't a
triage maintainer", "Waiting for Claude to judge it for 2 of 10
maintainers; routing goes ahead without them at 14:05 UTC" (the router's
2-hour relevance wait), or one line per maintainer it matches with what
stops them ("gau-nernst is a high match but already has 8 of 8 items this
week"). Details follow as
collapsible sections: for open P0-P2 PRs, CI (open): the head commit's
Buildkite build as "38/41 passed · 2 running · 1 failed (also failing on
main)", the failed jobs linked to Buildkite, each marked "also failing on
main", "failed on main in the last 7 days" or "only on this PR", and whether
that makes it the author's move (`src/lib/triage-ci.ts`, data from
`triage_pr_ci`; see triage/docs/data-model.md); then the score breakdown (open), why these owners with
evidence, who it's for (every maintainer's relevance), what the LLM read, the
quick signals checked before the LLM, and the action history. Esc closes it.

The score breakdown names each factor in plain words (`src/lib/triage-factors.ts`
maps every factor code from `triage/scoring.py`), tags it with a category and
color (how bad = red, release = amber, who it hits = blue, evidence = lime,
community = fuchsia, PR signals = cyan, penalties = grey stripes), and draws a
bar per row plus one stacked bar that adds up to the score. The category hues
were checked for colorblind separation; each row also prints its category, so
color is never the only signal.

The signed-in maintainer and **Sign out** sit at the right end of the
section tab row.

## Access model

- `TRIAGE_ENABLED=1` (server) turns the feature on. Without it every
  `/triage` page and `/api/triage/*` route returns 404.
- `NEXT_PUBLIC_TRIAGE_ENABLED=1` (build time) shows **Triage** in the top
  navigation. Leave it unset to keep the tab reachable only by URL.
- Every page needs a signed-in maintainer; without a session the pages show a
  "Sign in with GitHub" screen and never data, and the APIs return 401.
- Sign-in is GitHub OAuth with scope `read:org`. The callback checks that the
  user is an **active** member of `TRIAGE_MAINTAINER_TEAM`, or listed in
  `TRIAGE_ALLOWED_LOGINS`. The GitHub token is used for that one check and
  never stored. The session is an HMAC-SHA256-signed cookie holding only
  `{login, exp}` (HttpOnly, Secure in production, SameSite=Lax, 12 hours).
- Mutating routes (`POST /api/triage/actions`,
  `POST /api/triage/rules/preview`, `POST /api/triage/auth/logout`) also
  require a same-origin `Origin` header (or `Sec-Fetch-Site: same-origin`).
- Authenticated responses are `Cache-Control: private, no-store`.
- Item text and LLM output are rendered as plain text; links are rendered
  only when they point to `https://github.com/vllm-project/`.
- The dashboard never posts to Slack. Slack notifications are produced by
  the triage worker through the alerting outbox.

### Who may do what

- **Ack, Not mine, Drop, Slop, Done** act on your own open/acked assignment.
  **Ack** on an item with no open primary assignment takes it: it creates an
  acked primary assignment for you.
- **Reassign** can be done by any signed-in maintainer on any open
  assignment (or, for an unassigned item, it creates a primary assignment for
  the target). The target must be an active maintainer.
- **Reopen** reopens your own most recently closed assignment, unless the
  same role is already open.
- Nobody edits rules on the dashboard; see below.

Each action writes a `triage_actions` row in the same transaction as the
assignment change. The router reads those: it never re-routes an item with a
`drop` or `slop`, and never routes an item back to someone who said
`not_mine`.

## Where rules live

Each maintainer's rules are one file in this repo,
`triage/config/maintainers/<github_login>.yaml`, changed by pull request.
The file name stem must equal `github_login`. The triage worker syncs
`main`'s copies into `triage_maintainers` every 5 minutes, so a change takes
effect about 5 minutes after its PR merges. Rows the sync owns have
`updated_by = 'repo'`; the rules page uses that to choose between the
"Edit your rules file" and "Create your rules file" links.

The dashboard only reads rules: `GET /api/triage/rules` returns the current
row, `POST /api/triage/rules/preview` evaluates a draft without saving, and
`PUT /api/triage/rules` returns 405 with a pointer to the directory.

The one row the dashboard can create is a bare `triage_maintainers` row
(default settings, empty rules) when someone without a rules file uses
**Ack** to take an unassigned item, so the assignment has a maintainer to
point to. That row gets `updated_by` = their login, never `repo`, so the
sync leaves it alone until they add their own file.

File format (one top-level mapping; key order fixed; empty lists and
optional keys omitted except `github_login`; enum values plain, globs and
free text double-quoted):

```yaml
github_login: gau-nernst
slack_user_id: U0123456789
min_score: 45
capacity_per_week: 8
notify_mode: digest
away:
  - {start: 2026-12-20, end: 2027-01-03}
rules:
  areas: [moe, kernels]
  hardware: [B200]
  models: ["qwen4*", "kimi-k3*"]
  paths: ["vllm/models/qwen4_exp/**"]
  keywords: ["deepgemm"]
  types: [bug, regression]
  exclude: {types: [question], hardware: [MI300X]}
  natural_language: "free text"
```

## Environment variables (Vercel)

| Variable | Required | Purpose |
|---|---|---|
| `TRIAGE_ENABLED` | yes | `1` enables pages and APIs. |
| `NEXT_PUBLIC_TRIAGE_ENABLED` | no | `1` shows the nav entry (build time). |
| `GITHUB_OAUTH_CLIENT_ID` | yes | OAuth app client ID. |
| `GITHUB_OAUTH_CLIENT_SECRET` | yes | OAuth app client secret. |
| `TRIAGE_SESSION_SECRET` | yes | At least 32 random characters; signs session cookies. Rotating it signs everyone out. Generate with `openssl rand -base64 48`. |
| `TRIAGE_MAINTAINER_TEAM` | one of these two | `org/team-slug`, e.g. `vllm-project/committers`. |
| `TRIAGE_ALLOWED_LOGINS` | one of these two | Comma-separated GitHub logins allowed regardless of team. |
| `SLACK_SIGNING_SECRET` | for Slack buttons | The Slack app's signing secret (Basic Information → App Credentials). **Production only.** Without it the interactions endpoint returns 503. |
| `TRIAGE_SUPPRESSION_ALERT` | no | Drop+slop actions per person per 24h that raise the warning (default 10). Also read by the worker. |
| `TRIAGE_CLAUDE_LOGIN_EXPIRES` | no | `YYYY-MM-DD` when the extractor host's Claude login expires. The pipeline-health line warns from 7 days before. Update it after logging in again. |
| `TRIAGE_CANONICAL_ORIGIN` | no | The only origin sign-in runs on (default `https://ci.vllm.ai`). The OAuth callback is `<origin>/api/triage/auth/callback`; it is never derived from the request. |
| `TRIAGE_DEV_LOGIN` | local only | Signs every request in as this login. Ignored when `NODE_ENV=production`. |

`DATABASE_URL` is the existing dashboard connection; the tables come from
`migrations/sql/0038_triage.sql`.

## GitHub OAuth app setup

1. In the `vllm-project` org settings → Developer settings → OAuth Apps →
   New OAuth App (an org-owned app, so membership checks are not limited by
   third-party access restrictions).
2. Homepage URL `https://ci.vllm.ai`, authorization callback URL
   `https://ci.vllm.ai/api/triage/auth/callback`. Preview deployments need
   their own app (GitHub allows one callback URL per OAuth app) or
   `TRIAGE_OAUTH_REDIRECT_URI`.
3. Put the client ID and a generated client secret in Vercel as above.
4. Team membership checks need the user's `read:org` grant. If the org
   restricts OAuth app access, an org owner must approve the app.

## Local development

```bash
TRIAGE_ENABLED=1 NEXT_PUBLIC_TRIAGE_ENABLED=1 TRIAGE_DEV_LOGIN=<your-login> \
DATABASE_URL=postgres://... npm run dev
```

## Security notes

- **One origin.** Sign-in starts and completes only on `TRIAGE_CANONICAL_ORIGIN`.
  On any other hostname serving the same deployment (e.g. the `*.vercel.app`
  alias), "Sign in" first redirects there; the callback refuses other
  hostnames. The redirect target is configuration, not the `Host` header.
- **Short sessions.** A session is a signed `{login, exp}` cookie valid for
  12 hours (`HttpOnly`, `Secure`, `SameSite=Lax`), named
  `__Host-triage_session` in production so no other `*.vllm.ai` host can set
  or overwrite it. Team membership is checked
  only at sign-in because the GitHub token is not kept, so the session length
  is how long a removed maintainer keeps access. Rotating
  `TRIAGE_SESSION_SECRET` signs everyone out immediately.
- **Production-only secrets.** In Vercel, set `TRIAGE_SESSION_SECRET`,
  `GITHUB_OAUTH_CLIENT_SECRET` and `TRIAGE_ENABLED` for the **Production**
  environment only. Preview deployments build code from pull requests; a
  preview that can read the session secret could mint a valid session cookie
  for ci.vllm.ai.
- **PKCE (S256).** Each sign-in also carries a one-time code verifier, kept
  in the HttpOnly state cookie; GitHub only issues a token for a code
  together with that verifier, so an intercepted code is useless.
- **Suppression warning.** "Drop" and "slop" stop an item from ever being
  routed again. If one person does that to `TRIAGE_SUPPRESSION_ALERT` (default
  10) or more items in 24 hours, the queue shows a red warning and the daily
  team digest leads with it. Every action records who did it.
- **Writes** need a session and a same-origin `Origin` header (CSRF); all
  triage responses are `Cache-Control: private, no-store`.
- **Untrusted text** (GitHub titles and bodies, LLM summaries) is rendered as
  text only; links go only to `https://github.com/vllm-project/`.

## Slack buttons

Triage DMs carry **Ack**, **Not mine**, **Reassign to…** and **Open in
dashboard**; digest lines have the same actions in a ⋮ menu. Slack posts each
click to `https://ci.vllm.ai/api/triage/slack/interactions` (the app's
Interactivity Request URL). The route:

1. rejects any request not signed with `SLACK_SIGNING_SECRET` or older than
   five minutes (no replays);
2. maps the clicker's Slack user ID to a maintainer via `slack_user_id` in
   `triage/config/maintainers/<login>.yaml`; unlinked people get a private
   note and nothing changes;
3. lets only the person the item is assigned to act on it;
4. applies the action with the same code as the dashboard buttons, recorded
   with `source = 'slack'`. A digest or P0 DM shows an issue with its fix
   PRs as one item whose buttons carry the issue; ack / not mine / done /
   reassign then also apply to the fix PRs the same person holds
   (triage/docs/data-model.md, "Issue + fix PR groups");
5. replaces the buttons with the result ("Acked by …") via Slack's
   `response_url` (only `https://hooks.slack.com/` is ever called).

No extra Slack scopes are needed (`chat:write` covers posting and updating).
