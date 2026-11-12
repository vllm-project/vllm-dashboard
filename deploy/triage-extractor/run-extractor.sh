#!/bin/bash
# One budgeted extraction run against the triage database. Called from cron
# every 10 minutes on the extractor host (see README.md). Uses the host's
# Claude Code login (Pro/Max plan); ANTHROPIC_API_KEY is stripped by the
# extractor so usage never lands on an API bill.
set -euo pipefail

env_file=${TRIAGE_EXTRACTOR_ENV:-$HOME/.config/vllm-triage/extractor.env}
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
lock=${XDG_RUNTIME_DIR:-/tmp}/vllm-triage-extractor.lock
log_dir=$HOME/.local/state/vllm-triage
mkdir -p "$log_dir"

if [ "$(stat -c %a "$env_file")" != "600" ]; then
  echo "refusing to run: $env_file must be chmod 600" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

exec flock -n "$lock" \
  uv run --project "$repo_root/triage" --extra postgres \
  vllm-triage extract >> "$log_dir/extractor.log" 2>&1
