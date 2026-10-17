#!/usr/bin/env python3
"""
Quarantine pauser for the H200 bare-metal hosts: makes Buildkite match the
dashboard.

Runs on the alerting worker's EC2 host every minute. Pulls the desired
quarantine set for cluster h200 from the dashboard and, through Buildkite's
REST API, pauses or resumes every agent on each host. A paused agent finishes
its running job and takes no new one. No host access is needed.

  quarantining / quarantined / resolve_requested
      Pauses every connected agent on the host with the note
      "vllm-quarantine <alertId>: <reason>" and a 12-hour timeout, so a pause
      left behind by a dead pauser lifts by itself. Each run pauses agents
      that appeared since (an agent restart registers new ones) and renews
      our pauses in their last hour. Posts "out", or "drained" once no agent
      runs a job. A new agent found once the host is quarantined is drift:
      the post carries reapplied: true. A person's pause (any other note) is
      left alone and counts as out.
  resolving
      A host resolved while held (resolvedWhileHeld in the desired set)
      never went out and is returned at once. Otherwise it stays paused,
      agents a restart registered included, and the host's own check
      (quarantine-check-host.py) decides, through the actuator state:
        - empty or "out": post "out" naming the jobs still running, or
          "drained" once none is, which starts the host check;
        - "drained", "verifying", "verify_failed": post nothing, so the host
          check's state is never overwritten, but keep renewing our pauses;
        - "verified": resume our pauses only, then post "returned", after
          which it leaves the host alone until the worker closes it.
  would
      Dry-run stage: log only.

Usage:
  GPU_REPORT_URL=https://your-dashboard.vercel.app/api/gpu/report \
  GPU_REPORT_SECRET=your-secret BUILDKITE_WRITE_TOKEN=... \
  python3 quarantine-pauser-h200.py [--dry-run]

Environment variables:
  GPU_REPORT_URL         - The reporter's endpoint; only its scheme and host
                           are used, to reach /api/alerts/quarantine/...
  GPU_REPORT_SECRET      - Bearer token for the dashboard
  BUILDKITE_WRITE_TOKEN  - Buildkite API token with read_agents and
                           write_agents, from an org admin
  QUARANTINE_CLUSTER     - This pool's name in the desired set (default h200)

--dry-run changes nothing: pauses, resumes and dashboard posts are logged.
"""

import argparse
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
BUILDKITE_TOKEN = os.environ.get("BUILDKITE_WRITE_TOKEN", "")
CLUSTER = os.environ.get("QUARANTINE_CLUSTER", "h200")
ORG = "vllm"

OUT_STAGES = ("quarantining", "quarantined", "resolve_requested")
# The host check owns the actuator state from "drained" until "verified".
CHECK_STATES = ("drained", "verifying", "verify_failed")
NOTE_PREFIX = "vllm-quarantine"
PAUSE_MINUTES = 12 * 60
RENEW_BEFORE = datetime.timedelta(hours=1)
# Where the alerting worker's OnFailure= Slack notifier reads a failed run's
# error (deploy/aws/bin/notify-failure), named by systemd's INVOCATION_ID.
FAILURE_DIR = "/run/alerting/failures"


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def _request(url, method, headers, body):
    req = urllib.request.Request(
        url, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method=method,
    )
    # urlopen raises HTTPError for non-2xx.
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def http_json(method, path, body=None):
    """Call the dashboard; raises on network errors and non-2xx."""
    u = urllib.parse.urlsplit(REPORT_URL)
    headers = {"Authorization": f"Bearer {REPORT_SECRET}"} if REPORT_SECRET else {}
    return _request(f"{u.scheme}://{u.netloc}{path}", method, headers, body) or {}


def buildkite(method, path, body=None):
    """Call Buildkite's REST API; raises on network errors and non-2xx."""
    return _request(f"https://api.buildkite.com{path}", method,
                    {"Authorization": f"Bearer {BUILDKITE_TOKEN}"}, body)


def short(hostname):
    return (hostname or "").strip().lower().split(".", 1)[0]


def host_agents(host):
    """Connected agents on exactly this host (the API matches loosely)."""
    agents = buildkite("GET", f"/v2/organizations/{ORG}/agents?hostname="
                       f"{urllib.parse.quote(host)}&per_page=100")
    return [a for a in agents
            if short(a.get("hostname")) == host
            and a.get("connection_state") == "connected"]


def ours(agent):
    return bool(agent.get("paused")) and (
        agent.get("paused_note") or "").startswith(NOTE_PREFIX)


def pause_left(agent):
    at = datetime.datetime.strptime(agent["paused_at"][:19], "%Y-%m-%dT%H:%M:%S")
    end = at.replace(tzinfo=datetime.timezone.utc) + datetime.timedelta(
        minutes=agent.get("paused_timeout_in_minutes") or 0)
    return end - now()


class Pauser:
    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.errors = []

    def fail(self, message):
        print(f"ERROR: {message}", file=sys.stderr)
        self.errors.append(message)

    def agent_call(self, agent, verb, body):
        if self.dry_run:
            print(f"  DRY RUN: would {verb} {agent['name']}")
            return
        buildkite("PUT", f"/v2/organizations/{ORG}/agents/{agent['id']}/{verb}",
                  body)

    def pause(self, agent, want):
        note = f"{NOTE_PREFIX} {want['alertId']}: {want.get('reason') or ''}"
        self.agent_call(agent, "pause",
                        {"note": note[:200].strip(),
                         "timeout_in_minutes": PAUSE_MINUTES})

    def renew(self, agents, want):
        """Renews our pauses in their last hour. Buildkite refuses to pause
        a paused agent, so this resumes and pauses again at once."""
        for a in agents:
            if ours(a) and pause_left(a) < RENEW_BEFORE:
                self.agent_call(a, "resume", {})
                self.pause(a, want)

    def post(self, host, alert_id, state, observed):
        body = {"alertId": alert_id, "state": state, "observed": observed}
        if self.dry_run:
            print(f"  DRY RUN: would post {host} {json.dumps(body)}")
            return
        try:
            http_json("POST", "/api/alerts/quarantine/"
                      f"{urllib.parse.quote(host)}/applied", body)
            print(f"  posted {state} for {host}")
        except Exception as e:
            self.fail(f"POST applied for {host} failed: {e}")

    def take_out(self, host, want, agents):
        fresh = [a for a in agents if not a.get("paused")]
        for a in fresh:
            self.pause(a, want)
        self.renew(agents, want)
        reapplied = bool(fresh) and want["stage"] != "quarantining"
        if reapplied:
            print(f"  DRIFT: {host}: paused {len(fresh)} new agent(s)")
        busy = sum(bool(a.get("job")) for a in agents)
        self.post(host, want["alertId"], "out" if busy else "drained",
                  {"agents": len(agents), "paused": len(agents), "busy": busy,
                   "reapplied": reapplied})

    def bring_back(self, host, want, agents):
        state = want.get("actuatorState")
        if state == "returned":
            # Done; the worker closes the episode on its next scan.
            return
        # A host resolved while held never went out; one that passed its
        # check is done. Our pauses are lifted only then.
        if want.get("resolvedWhileHeld") or state == "verified":
            self.lift(host, want, agents)
            return
        # Still out until its check passes, including agents a restart
        # registered since.
        fresh = [a for a in agents if not a.get("paused")]
        for a in fresh:
            self.pause(a, want)
        if fresh:
            print(f"  DRIFT: {host}: paused {len(fresh)} new agent(s)")
        self.renew(agents, want)
        if state in CHECK_STATES:
            return
        busy = [a for a in agents if a.get("job")]
        if busy:
            jobs = [a["job"].get("web_url") or a["name"] for a in busy]
            note = (f"waiting for {len(busy)} CI job(s) to finish: "
                    + ", ".join(jobs[:3]) + (", ..." if len(jobs) > 3 else ""))
            print(f"  {host}: {note}")
            self.post(host, want["alertId"], "out",
                      {"ciPods": len(busy), "note": note})
        else:
            self.post(host, want["alertId"], "drained", {"busy": 0})

    def lift(self, host, want, agents):
        for a in agents:
            if ours(a):
                self.agent_call(a, "resume", {})
        observed = {"paused": False}
        others = sum(1 for a in agents if a.get("paused") and not ours(a))
        if others:
            observed["note"] = (f"{others} agent(s) paused by someone else "
                                "left paused")
            print(f"  NOTE: {host} {observed['note']}")
        self.post(host, want["alertId"], "returned", observed)

    def reconcile(self, want):
        host, stage = want["host"], want["stage"]
        print(f"{host}: {stage} ({want.get('reason', '')})")
        if stage == "would":
            print(f"  would quarantine {host}")
            return
        try:
            agents = host_agents(host)
            if stage in OUT_STAGES:
                self.take_out(host, want, agents)
            elif stage == "resolving":
                self.bring_back(host, want, agents)
            else:
                self.fail(f"{host}: unknown stage {stage!r}")
        except Exception as e:
            self.fail(f"{host}: {e}")

    def run(self, desired):
        for want in desired:
            self.reconcile(want)


def record_failure(errors):
    """Leaves the errors where the failure notifier's Slack DM shows them."""
    invocation = os.environ.get("INVOCATION_ID")
    if not invocation or not os.path.isdir(FAILURE_DIR):
        return
    try:
        with open(os.path.join(FAILURE_DIR, invocation), "w") as f:
            f.write("h200-pauser\n" + "\n".join(errors)[:1500] + "\n")
    except OSError:
        pass


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dry-run", action="store_true",
                   help="change nothing; log pauses, resumes and posts")
    args = p.parse_args(argv)
    pauser = Pauser(args.dry_run)
    if not REPORT_URL or not BUILDKITE_TOKEN:
        pauser.fail("GPU_REPORT_URL and BUILDKITE_WRITE_TOKEN must be set")
    else:
        try:
            desired = http_json(
                "GET", "/api/alerts/quarantine/desired?cluster="
                + urllib.parse.quote(CLUSTER))["nodes"]
        except Exception as e:
            pauser.fail(f"desired set unavailable, changing nothing: {e}")
        else:
            pauser.run(desired)
            print(f"Done: {len(desired)} desired hosts for {CLUSTER}"
                  + (" (with errors)" if pauser.errors else ""))
    if pauser.errors:
        record_failure(pauser.errors)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
