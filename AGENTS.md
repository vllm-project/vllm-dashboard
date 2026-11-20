# Agent & Contributor Workflow Guide

## Lightweight validation by default

- Match checks to the change. Routine UI, styling, copy, navigation, and documentation changes do **not** require screenshots, browser automation, visual inspection, a local production build, or a full test suite before opening a PR.
- For documentation-only changes, review the diff and run `git diff --check`; no application checks are needed.
- Run relevant existing tests for behavior changes. Do not add tests that merely duplicate static markup or copy changes.
- Use heavier checks only when the user explicitly requests them or a concrete risk or failure makes them necessary (for example, bundler configuration, dependency changes, or a rendering bug that cannot be checked otherwise). State the reason and keep the check scoped.
- Open the PR after the relevant lightweight checks pass. Report what was checked accurately; optional screenshots or builds are not blockers and do not need a permission request. CI and Vercel remain responsible for their configured checks.

## Fast UI / TypeScript iteration

- **Default checks:** run typechecking and lint the changed files. For behavior changes, run the relevant existing tests:
  ```bash
  npm run typecheck
  npx eslint <changed-ts-or-tsx-files>
  npx tsx --test <relevant-test-file>
  ```
  Use `npm run test:triage` when the change spans triage behavior. Do not run unrelated suites for a presentation-only change.
- **Production builds:** skip `next build` locally by default, including before PR creation. Vercel builds a preview deployment automatically on each PR. If a local build is justified, run it once and repeat only after a change addressing a failure.
- **Worktrees:** reuse one persistent worktree with warm dependencies when possible. Do not install or copy dependencies, or troubleshoot a browser/dev-server setup, solely to obtain optional screenshots or builds.
- **Screenshots are not needed.** Only take screenshots when explicitly requested. Do not start a dev server or set up Postgres just to produce PR screenshots; reviewers can use the automatically generated Vercel Preview URL.
- **Optional visual inspection:** when explicitly requested or needed to diagnose a rendering problem, prefer the Vercel Preview URL. For local triage inspection, use:
  ```bash
  npm run dev:triage
  ```
  This uses realistic in-memory fixtures with zero Postgres setup (`TRIAGE_ENABLED=1 TRIAGE_DEV_LOGIN=khluu TRIAGE_DEV_FIXTURES=1`). `TRIAGE_DEV_FIXTURES` is ignored in production. Do not set up Postgres or run migrations just to inspect the UI.
- **Keep PRs focused:** separate layout/visual polish from URL/filter/preset behavior changes when they are independent.

## Python (`triage/`, `alerting/`, `deploy/aws/`)

- Run tests covering the changed behavior, plus scoped lint/type checks where applicable. For example: `cd triage && uv run --extra dev pytest tests/test_core.py -q`.
- Full suites and embedded-Postgres tests are not routine PR prerequisites. Run broader or database checks when changes affect shared behavior, queries, schema, or permissions; choose checks that exercise the actual risk.
- Validate maintainer YAML changes with `cd triage && uv run python -m triage.maintainers check config/maintainers`.

## Commits

- Always sign off commits (`git commit --signoff`) — DCO is enforced on all PRs.
