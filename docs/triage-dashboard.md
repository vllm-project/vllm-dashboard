# Triage dashboard

The **Triage** tab (`/triage`) shows incoming vLLM issues and PRs that the
triage pipeline (`triage/`, see `triage/README.md` and
`triage/docs/data-model.md`) has ingested, read with an LLM, scored and
routed. It is **maintainers only**: it shows LLM judgements about outside
contributors' work (including "slop" flags), so nothing is public.

## Pages

| Path | What |
|---|---|
| `/triage` | Queue: in-scope items with score and band, kind, title, one-line summary, areas, models, hardware, serving config, assignees and age. Filters for band (default page/route/watch; `ignore` and `unscored` are opt-in), kind, area, hardware, model text, assignee, assignment status, search, and include-closed; sort by score, age or last update. Header: items ingested in 24h, extraction coverage over 7 days, page-band items nobody has acked, and the not-mine rate over 7 days. Clicking a row opens the item drawer (`?item=owner/repo#N`). |
| `/triage/me` | My plate: the signed-in maintainer's open and acked assignments with Ack / Not mine / Reassign / Drop / Slop / Done, why the router picked them, and assignments closed in the last 14 days with Reopen. |
| `/triage/rules` | Draft & preview. Loads the signed-in maintainer's current rules from the database (synced from `triage/config/maintainers/<login>.yaml`) into a local draft with the same fields (areas, hardware, model globs, path globs, keywords, type filter, excludes, minimum score, weekly capacity, away dates, Slack notification mode and user ID). **Preview last 30 days** lists which recent items the draft matches. **Copy as YAML** copies the full file content. If the maintainer already has a file (their row has `updated_by = 'repo'`), **Edit your rules file on GitHub** opens it in GitHub's editor on `main`; otherwise **Create your rules file on GitHub** opens GitHub's new-file page pre-filled with `<login>.yaml` and the draft's YAML. Nothing is saved from the dashboard. |

The item drawer shows the score breakdown, every extracted facet, the
deterministic prepass, the routing reason of each assignment, and the full
action history.

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
  `{login, exp}` (HttpOnly, Secure in production, SameSite=Lax, 7 days).
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
| `TRIAGE_OAUTH_REDIRECT_URI` | no | Override the callback URL (defaults to `<request origin>/api/triage/auth/callback`). |
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
