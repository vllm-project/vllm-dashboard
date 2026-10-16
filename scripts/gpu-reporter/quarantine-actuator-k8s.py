#!/usr/bin/env python3
"""
Quarantine actuator for K8s clusters: makes the cluster match the dashboard.

Runs on the control plane every minute. Pulls the desired quarantine set for
this cluster from the dashboard and reconciles each node:

  quarantining / quarantined / resolve_requested
      (resolve_requested: a person resolved it and the dashboard is waiting
      for a clean reading before it says resolving; the node stays out.)
      Cordon + taint vllm.ci/quarantine=<reason>:NoSchedule (both). The
      cordon and its ownership annotation vllm.ci/quarantine-cordoned=true
      go in one patch guarded by the node's resourceVersion.
      Neither evicts running pods. Posts "out" once both are present and
      "drained" once no pod in namespace buildkite on the node is Running or
      Pending. A quarantined node that lost the cordon or our taint (by hand)
      gets both back and the post carries reapplied: true.
  resolving
      First the return check, on a node we took out. While CI pods are
      still on the node it posts "out" with a note naming their jobs. Then
      a one-off pod holding
      every GPU on the node checks nvidia-smi's recovery action and row
      remapping, then runs `dcgmi diag -r QUARANTINE_VERIFY_LEVEL`. While it
      runs the post is "verifying"; if it fails, or doesn't finish within
      VERIFY_TIMEOUT, it is "verify_failed", the node stays out, and the
      dashboard moves the episode back to quarantined. Once it passes:
      Removes our taint. Uncordons only if we cordoned, that is when the
      annotation is present, lifting the cordon and the annotation in one
      guarded patch. A cordon
      without it (a person's, made before or after ours) stays in place; the
      post is still "returned" (our quarantine is undone) with a note.
  would
      Dry-run stage: log only.

Nodes that carry our taint but are not in the desired set are logged and
left alone (no automatic return in the pilot). If the desired endpoint is
unreachable or returns non-2xx, nothing changes and the run exits 1.

Usage:
  GPU_REPORT_URL=https://your-dashboard.vercel.app/api/gpu/report \
  GPU_REPORT_SECRET=your-secret QUARANTINE_CLUSTER=h100 \
  python3 quarantine-actuator-k8s.py [--dry-run]

Environment variables:
  GPU_REPORT_URL       - The reporter's endpoint; only its scheme and host are
                         used, to reach /api/alerts/quarantine/... (required)
  GPU_REPORT_SECRET    - Bearer token for auth, shared with the reporter
  QUARANTINE_CLUSTER   - This cluster's name in the desired set (required)
  QUARANTINE_VERIFY_LEVEL - dcgmi diag run level for the return check
                         (default 2; 0 skips the check)
  QUARANTINE_VERIFY_IMAGE - DCGM image for the return check; match the
                         cluster's DCGM version

--dry-run changes nothing: kubectl writes and dashboard posts are logged.
"""

import argparse
import concurrent.futures
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
CLUSTER = os.environ.get("QUARANTINE_CLUSTER", "")

TAINT_KEY = "vllm.ci/quarantine"
CORDON_MARK = "vllm.ci/quarantine-cordoned"  # annotation: the cordon is ours
CI_NAMESPACE = "buildkite"
OUT_STAGES = ("quarantining", "quarantined", "resolve_requested")
KUBECTL_TIMEOUT = 20
# Nodes reconcile in parallel so slow calls on some (a hung pod list, a
# dashboard POST timing out) can't use up the run before later nodes get
# their turn. Each node's own steps stay in order on one worker.
NODE_WORKERS = 8

GPU_RESOURCE = "nvidia.com/gpu"
VERIFY_LEVEL = os.environ.get("QUARANTINE_VERIFY_LEVEL", "2")
VERIFY_IMAGE = os.environ.get(
    "QUARANTINE_VERIFY_IMAGE", "nvcr.io/nvidia/cloud-native/dcgm:4.4.2-1-ubuntu22.04")
# Its own namespace, so the actuator can create pods nowhere that holds
# another service account worth taking (quarantine-actuator-k8s-rbac.yaml).
VERIFY_NS = "vllm-quarantine-verify"
# Measured from the pod's creation, so it covers the image pull and the
# check itself.
VERIFY_TIMEOUT = datetime.timedelta(minutes=30)
# $1 is the diag level. A recovery action or row-remap value of [N/A] is
# unsupported on the GPU, not a fault.
VERIFY_SCRIPT = r"""
set -o pipefail
nvidia-smi --query-gpu=index,gpu_recovery_action,remapped_rows.failure \
    --format=csv,noheader \
  | awk -F', *' '{ print } ($2 != "None" && $2 !~ /^\[/) || $3 == "Yes" { bad = 1 }
                 END { exit bad }' \
  || { echo "a GPU needs recovery or is out of spare memory rows"; exit 1; }
nv-hostengine && sleep 3 || exit 1
dcgmi diag -r "$1" | tee /tmp/diag && ! grep -qi fail /tmp/diag
"""


def kubectl(*args, input=None):
    result = subprocess.run(
        ["kubectl", *args], capture_output=True, text=True, input=input,
        timeout=KUBECTL_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubectl {' '.join(args[:3])} failed: {result.stderr.strip()}"
        )
    return result.stdout


def http_json(method, path, body=None):
    """Call the dashboard; raises on network errors and non-2xx."""
    u = urllib.parse.urlsplit(REPORT_URL)
    headers = {"Content-Type": "application/json"}
    if REPORT_SECRET:
        headers["Authorization"] = f"Bearer {REPORT_SECRET}"
    req = urllib.request.Request(
        f"{u.scheme}://{u.netloc}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers=headers, method=method,
    )
    # urlopen raises HTTPError for non-2xx.
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def taint_value(reason):
    """Reason -> a valid label value (<= 63 chars of [A-Za-z0-9._-])."""
    v = re.sub(r"[^A-Za-z0-9._-]+", "-", reason or "")[:63].strip("-._")
    return v or "quarantine"


def our_taint(node):
    for t in node["spec"].get("taints") or []:
        if t.get("key") == TAINT_KEY:
            return t
    return None


def ci_pods(name):
    """CI pods still Running or Pending on the node."""
    pods = json.loads(kubectl(
        "get", "pods", "-n", CI_NAMESPACE,
        "--field-selector", f"spec.nodeName={name}", "-o", "json",
    ))["items"]
    return [p for p in pods
            if p["status"].get("phase") in ("Running", "Pending")]


def ci_wait_note(pods):
    """Names the jobs a return check waits on, by Buildkite URL."""
    jobs = [(p["metadata"].get("annotations") or {}).get(
                "buildkite.com/job-url") or p["metadata"]["name"]
            for p in pods]
    return (f"waiting for {len(pods)} CI job(s) to finish: "
            + ", ".join(jobs[:3]) + (", ..." if len(jobs) > 3 else ""))


def verify_pod_name(node_name):
    return f"vllm-quarantine-verify-{node_name}"


def verify_pod(node):
    """The return-check pod: pinned to the node, holding all its GPUs."""
    name = node["metadata"]["name"]
    gpus = node["status"]["allocatable"][GPU_RESOURCE]
    return {
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {"name": verify_pod_name(name), "namespace": VERIFY_NS,
                     "labels": {"app": "vllm-quarantine-verify"}},
        "spec": {
            # nodeName skips the scheduler, so our cordon and taint don't
            # keep it off; the toleration covers the kubelet's own checks.
            "nodeName": name, "restartPolicy": "Never",
            "automountServiceAccountToken": False,
            "runtimeClassName": "nvidia",
            "tolerations": [{"operator": "Exists"}],
            "containers": [{
                "name": "verify", "image": VERIFY_IMAGE,
                "command": ["bash", "-c", VERIFY_SCRIPT, "verify",
                            VERIFY_LEVEL],
                "securityContext": {"capabilities": {"add": ["SYS_ADMIN"]}},
                "resources": {"limits": {GPU_RESOURCE: gpus}},
            }],
        },
    }


class Actuator:
    def __init__(self, dry_run):
        self.dry_run = dry_run
        self.ok = True

    def write(self, *args, input=None):
        if self.dry_run:
            print(f"  DRY RUN: kubectl {' '.join(args)}")
        else:
            kubectl(*args, input=input)

    def post(self, host, alert_id, state, observed):
        """True once the dashboard has the report."""
        body = {"alertId": alert_id, "state": state, "observed": observed}
        if self.dry_run:
            print(f"  DRY RUN: would post {host} {json.dumps(body)}")
            return True
        try:
            http_json("POST", "/api/alerts/quarantine/"
                      f"{urllib.parse.quote(host)}/applied", body)
            print(f"  posted {state} for {host}")
            return True
        except Exception as e:
            print(f"ERROR: POST applied for {host} failed: {e}",
                  file=sys.stderr)
            self.ok = False
            return False

    def set_cordon(self, node, on):
        """Cordon and mark the cordon ours (on), or lift both, in one patch.

        One write, so a failure can't leave a cordon without the mark that
        lets resolve lift it. The resourceVersion guard makes the API server
        reject the patch if the node changed since we read it, such as a
        person cordoning it in between, so a cordon that isn't ours is never
        marked as ours.
        """
        body = {"metadata": {"annotations": {CORDON_MARK: "true" if on else None},
                             "resourceVersion": node["metadata"]["resourceVersion"]},
                "spec": {"unschedulable": True if on else None}}
        self.write("patch", "node", node["metadata"]["name"], "--type", "merge",
                   "-p", json.dumps(body, sort_keys=True))

    def take_out(self, node, want):
        name = node["metadata"]["name"]
        cordoned = bool(node["spec"].get("unschedulable"))
        tainted = our_taint(node) is not None
        if not cordoned:
            self.set_cordon(node, on=True)
        if not tainted:
            self.write("taint", "nodes", name,
                       f"{TAINT_KEY}={taint_value(want['reason'])}:NoSchedule")
        # ponytail: stateless, so a lost cordon/taint counts as drift only once
        # the dashboard says quarantined; a hand uncordon during quarantining
        # is re-applied without the flag.
        reapplied = want["stage"] != "quarantining" and not (cordoned and tainted)
        if reapplied:
            print(f"  DRIFT: {name} had lost its "
                  f"{'cordon' if tainted else 'taint'}; re-applied")
        pods = len(ci_pods(name))
        self.post(name, want["alertId"], "drained" if pods == 0 else "out",
                  {"cordoned": True, "tainted": True, "ciPods": pods,
                   "reapplied": reapplied})

    def verified(self, node, want):
        """Runs the return check one step per run; True once it passed.

        Stateless like the rest: the pod is the state. A pass or failure
        deletes it, so the next resolve starts a fresh check, and after a
        failure no new one starts until a person resolves again.
        """
        name = node["metadata"]["name"]
        if self.dry_run:
            print(f"  DRY RUN: would run the return check on {name}")
            return True
        if want.get("actuatorState") == "verify_failed":
            print(f"  {name} failed its return check; waiting for a resolve")
            return False
        pod_name = verify_pod_name(name)
        try:
            pod = json.loads(kubectl("get", "pod", pod_name, "-n", VERIFY_NS,
                                     "-o", "json"))
        except RuntimeError as e:
            if "NotFound" not in str(e):
                raise
            # nodeName skips the scheduler, so the kubelet fails the pod at
            # once if a GPU is still held or unhealthy: wait out the CI pods,
            # and treat a GPU the device plugin dropped as a failed check.
            # The wait is posted as 'out' every run, naming the jobs, so the
            # dashboard can say which one holds the node.
            pods = ci_pods(name)
            if pods:
                note = ci_wait_note(pods)
                print(f"  {name}: {note}")
                self.post(name, want["alertId"], "out",
                          {"ciPods": len(pods), "note": note})
                return False
            # The device plugin may drop the resource entirely.
            status = node["status"]
            usable = status.get("allocatable", {}).get(GPU_RESOURCE, "0")
            total = status.get("capacity", {}).get(GPU_RESOURCE, "0")
            if usable != total:
                note = f"only {usable} of {total} GPUs are usable"
                print(f"  {name}: return check failed: {note}")
                self.post(name, want["alertId"], "verify_failed", {"note": note})
                return False
            self.write("create", "-f", "-", input=json.dumps(verify_pod(node)))
            self.post(name, want["alertId"], "verifying", {"phase": "Created"})
            return False
        phase = pod.get("status", {}).get("phase")
        # strptime: the control planes' Python 3.10 fromisoformat rejects "Z".
        created = datetime.datetime.strptime(
            pod["metadata"]["creationTimestamp"], "%Y-%m-%dT%H:%M:%SZ",
        ).replace(tzinfo=datetime.timezone.utc)
        age = datetime.datetime.now(datetime.timezone.utc) - created
        # A pass counts only within the timeout: past it, this attempt has
        # already failed, even if reporting that failure didn't get through.
        if phase == "Succeeded" and age < VERIFY_TIMEOUT:
            self.write("delete", "pod", pod_name, "-n", VERIFY_NS)
            return True
        if phase != "Failed" and age < VERIFY_TIMEOUT:
            self.post(name, want["alertId"], "verifying", {"phase": phase})
            return False
        if phase == "Failed":
            # A pod the kubelet rejected never ran, so it has no log; its
            # status says why.
            try:
                lines = kubectl("logs", pod_name, "-n", VERIFY_NS,
                                "--tail=20").strip().splitlines()
            except RuntimeError:
                status = pod.get("status", {})
                lines = [" ".join(filter(None, (status.get("reason"),
                                                status.get("message"))))]
            note = " / ".join(lines[-3:])[:300] or "no output"
        else:
            minutes = VERIFY_TIMEOUT // datetime.timedelta(minutes=1)
            note = f"did not finish in {minutes} min ({phase})"
        print(f"  {name}: return check failed: {note}")
        # The pod is the only record of the failure until the dashboard has
        # it; deleting it first would let a lost post start a fresh check.
        if self.post(name, want["alertId"], "verify_failed", {"note": note}):
            self.write("delete", "pod", pod_name, "-n", VERIFY_NS,
                       "--wait=false")
        return False

    def bring_back(self, node, want):
        name = node["metadata"]["name"]
        ours = (our_taint(node) is not None
                or CORDON_MARK in (node["metadata"].get("annotations") or {}))
        if ours and VERIFY_LEVEL != "0" and not self.verified(node, want):
            return
        cordoned = bool(node["spec"].get("unschedulable"))
        if our_taint(node) is not None:
            self.write("taint", "nodes", name, f"{TAINT_KEY}:NoSchedule-")
            # The taint write bumped resourceVersion; reread before the
            # guarded patch.
            if not self.dry_run:
                node = json.loads(kubectl("get", "node", name, "-o", "json"))
        if CORDON_MARK in (node["metadata"].get("annotations") or {}):
            self.set_cordon(node, on=False)
            cordoned = False
        observed = {"cordoned": cordoned, "tainted": False}
        if cordoned:
            observed["note"] = ("pre-existing cordon (not ours) left in "
                                "place; uncordon by hand to return the node")
            print(f"  NOTE: {name} {observed['note']}")
        self.post(name, want["alertId"], "returned", observed)

    def reconcile(self, want, node):
        host, stage = want["host"], want["stage"]
        print(f"{host}: {stage} ({want.get('reason', '')})")
        if stage == "would":
            print(f"  would quarantine {host}")
            return
        if node is None:
            print(f"ERROR: {host} is not a node in this cluster",
                  file=sys.stderr)
            self.ok = False
            return
        try:
            if stage in OUT_STAGES:
                self.take_out(node, want)
            elif stage == "resolving":
                self.bring_back(node, want)
            else:
                print(f"ERROR: {host}: unknown stage {stage!r}",
                      file=sys.stderr)
                self.ok = False
        except Exception as e:
            print(f"ERROR: {host}: {e}", file=sys.stderr)
            self.ok = False

    def run(self, desired, nodes):
        by_name = {n["metadata"]["name"]: n for n in nodes}
        wanted = {want["host"] for want in desired}
        with concurrent.futures.ThreadPoolExecutor(NODE_WORKERS) as pool:
            for want in desired:
                pool.submit(self.reconcile, want, by_name.get(want["host"]))
        for name, node in by_name.items():
            if name not in wanted and our_taint(node) is not None:
                print(f"WARNING: {name} carries {TAINT_KEY} but is not in the "
                      "desired set; leaving it alone", file=sys.stderr)
        return self.ok


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dry-run", action="store_true",
                   help="change nothing; log kubectl writes and posts")
    args = p.parse_args(argv)
    if not REPORT_URL or not CLUSTER:
        print("GPU_REPORT_URL and QUARANTINE_CLUSTER must be set",
              file=sys.stderr)
        return 1
    try:
        desired = http_json(
            "GET", "/api/alerts/quarantine/desired?cluster="
            + urllib.parse.quote(CLUSTER))["nodes"]
    except Exception as e:
        print(f"ERROR: desired set unavailable, changing nothing: {e}",
              file=sys.stderr)
        return 1
    nodes = json.loads(kubectl("get", "nodes", "-o", "json"))["items"]
    ok = Actuator(args.dry_run).run(desired, nodes)
    print(f"Done: {len(desired)} desired nodes for {CLUSTER}"
          + ("" if ok else " (with errors)"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
