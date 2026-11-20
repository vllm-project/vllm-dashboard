# Agent & Contributor Workflow Guide

## Fast UI / TypeScript iteration

- **Inner edit loop (~2–3s total):** iterate using fast, scoped checks instead of running a full `next build` on every edit:
  ```bash
  npm run typecheck                             # ~1.5s
  npm run test:triage                           # ~0.3s (or `npx tsx --test <file>`)
  npx eslint src/components/triage/...          # ~1s (scope to changed files)
  ```
- **Production build (`next build`):** run `NEXT_TELEMETRY_DISABLED=1 npm run build` **at most once** right before opening a PR (Vercel also builds a preview deployment automatically on every PR). Do not re-run `next build` just because Next.js prints an upgrade notice to stderr/stdout.
- **Worktrees:** reuse one persistent worktree (with warm `node_modules` and `.next/cache`) for UI work when possible; avoid hard-linking/copying `node_modules` from scratch on every round.
- **Screenshots are not needed.** Don't take before/after screenshots for PRs, and don't spin up a local Postgres or dev server just to look at the UI. Reviewers check the **Vercel Preview URL** that every PR gets automatically. Only take screenshots when someone explicitly asks for them.
- **UI verification (only when asked or truly needed):**
  - Prefer inspecting the **Vercel Preview URL** on real data rather than spinning up a local Postgres instance and running 47+ migrations.
  - For local visual inspection of `/triage` or `/triage/me`, run:
    ```bash
    npm run dev:triage
    ```
    This sets `TRIAGE_ENABLED=1 TRIAGE_DEV_LOGIN=khluu TRIAGE_DEV_FIXTURES=1` and serves realistic in-memory fixtures (issues, nested fix PRs, CI badges, drawer details, My list) with **zero Postgres setup**. (`TRIAGE_DEV_FIXTURES` is ignored when `NODE_ENV=production`.)
- **Keep PRs focused:** split layout/visual polish from URL/filter/preset behavior changes so reviews and iterations stay under ~5–10 minutes.

## Python (`triage/`, `alerting/`, `deploy/aws/`)

- Run targeted tests while iterating: `cd triage && uv run --extra dev pytest tests/test_core.py -q`.
- Run the full suite (including embedded Postgres tests), `ruff check`, and `mypy .` once before opening the PR.
- Validate maintainer YAML changes with `cd triage && uv run python -m triage.maintainers check config/maintainers`.

## Commits

- Always sign off commits (`git commit --signoff`) — DCO is enforced on all PRs.
