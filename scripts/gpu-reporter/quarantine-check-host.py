#!/usr/bin/env python3
"""
Return check for an H200 bare-metal host, run on the host itself.

Runs every minute as root next to gpu-reporter. It acts only when the
dashboard says this host is resolving and the pauser (quarantine-pauser-h200.py)
has posted "drained": every agent is paused and none runs a job. Then it
checks the GPUs before the pauser may lift the pauses:

  1. No process holds a GPU.
  2. nvidia-smi's recovery action and row-remap failure are clean on every
     GPU ([N/A] counts as unsupported, not a fault).
  3. `dcgmi diag -r QUARANTINE_VERIFY_LEVEL` passes, in the DCGM container
     (Docker), so it doesn't depend on whatever DCGM the host has.
     - MIG off: one diag across all GPUs.
     - MIG on: DCGM's diag refuses a GPU split into slices, and the
       privileged container it needs with MIG sees every GPU. So every GPU
       has its slices removed and one whole-GPU instance created (profile
       0), each GPU gets its own diag, and every GPU's original slices are
       recreated. MIG mode stays on, so nothing resets the GPU. The agents find their slice by
       order in `nvidia-smi -L` when a job starts, so new slice IDs are fine
       as long as every GPU gets its slices back, which is checked at the
       end.

While it runs it posts "verifying" every minute, then "verified" or
"verify_failed" with a note. A failure keeps the host out until a person
resolves again, including slices that didn't come back. The result is
saved under /var/lib/gpu-reporter, so one the dashboard didn't get is sent
again on the next run; a check cut off midway (a reboot) is reported as a
failure, so the host can't wait on it forever.

Usage (env from /etc/gpu-reporter.env, as gpu-reporter.service):
  python3 quarantine-check-host.py [--dry-run]

Environment variables:
  GPU_REPORT_URL, GPU_REPORT_SECRET - as for gpu-reporter
  QUARANTINE_CLUSTER       - this pool's name in the desired set (default h200)
  QUARANTINE_HOST          - this host's name there (default: short hostname)
  QUARANTINE_VERIFY_LEVEL  - dcgmi diag run level (default 2; 0 skips the check)
  QUARANTINE_VERIFY_IMAGE  - DCGM image for the diag

--dry-run runs nothing and posts nothing; it logs whether it would check.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse
import urllib.request

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
CLUSTER = os.environ.get("QUARANTINE_CLUSTER", "h200")
HOST = os.environ.get("QUARANTINE_HOST") or socket.gethostname().lower().split(".", 1)[0]
VERIFY_LEVEL = os.environ.get("QUARANTINE_VERIFY_LEVEL", "2")
VERIFY_IMAGE = os.environ.get(
    "QUARANTINE_VERIFY_IMAGE", "nvcr.io/nvidia/cloud-native/dcgm:4.4.2-1-ubuntu22.04")
# The worker calls a check stuck once its reports stop for 10 minutes.
HEARTBEAT_SECONDS = 60
COMMAND_TIMEOUT = 120
DIAG_TIMEOUT = 30 * 60
FULL_GPU_PROFILE = "0"
# The diag container's name, so one a timed-out docker client left running
# can be removed before the MIG slices are rebuilt.
CONTAINER = "vllm-quarantine-check"
# The episode being checked and, once known, its result: a result the
# dashboard didn't get is sent again, and a check with none was cut off.
STATE_PATH = "/var/lib/gpu-reporter/quarantine-check.json"
INTERRUPTED = ("the check was cut off before it finished (host restart?); "
               "check the MIG layout with nvidia-smi -L before resolving again")


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
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else {}


def run_cmd(cmd, timeout):
    """(exit code, stdout + stderr); raises TimeoutError past the timeout."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"{cmd[0]} timed out after {timeout}s") from None
    return r.returncode, r.stdout + r.stderr


class CheckFailed(Exception):
    pass


def must(cmd, timeout=COMMAND_TIMEOUT):
    code, out = run_cmd(cmd, timeout)
    if code != 0:
        raise CheckFailed(f"{' '.join(cmd[:3])} failed: {tail(out)}")
    return out


def tail(out, lines=3):
    return " / ".join(out.strip().splitlines()[-lines:]) or "no output"


def diag(index=None):
    """Runs the DCGM diag on every GPU, or with MIG on, on GPU `index`.

    The image's entrypoint is nv-hostengine, so bash is set explicitly. The
    diag needs no network. With MIG on, only a privileged container lets
    DCGM read the MIG layout (checked on an H200 host), and it then sees
    every GPU, so all of them must be whole-GPU instances first.
    """
    access = (["--cap-add", "SYS_ADMIN"] if index is None else ["--privileged"])
    target = "" if index is None else f" -i {index}"
    try:
        code, out = run_cmd(
            ["docker", "run", "--rm", "--name", CONTAINER, "--network", "none",
             "--gpus", "all", *access, "--entrypoint", "bash", VERIFY_IMAGE,
             "-c", f"nv-hostengine && sleep 3 && dcgmi diag -r {VERIFY_LEVEL}{target}"],
            DIAG_TIMEOUT)
    finally:
        # A timeout kills only the docker client, not the container.
        try:
            run_cmd(["docker", "rm", "-f", CONTAINER], COMMAND_TIMEOUT)
        except Exception as e:
            print(f"WARNING: removing {CONTAINER} failed: {e}", file=sys.stderr)
    if code != 0 or "fail" in out.lower():
        raise CheckFailed(tail(out))


def mig_layout():
    """GPU index -> its MIG profile names, in nvidia-smi -L order."""
    layout, gpu = {}, None
    for line in must(["nvidia-smi", "-L"]).splitlines():
        line = line.strip()
        if line.startswith("GPU "):
            gpu = int(line.split()[1].rstrip(":"))
            layout[gpu] = []
        elif line.startswith("MIG ") and gpu is not None:
            layout[gpu].append(line.split()[1])
    return layout


def clear_mig(index):
    must(["nvidia-smi", "mig", "-dci", "-i", index])
    must(["nvidia-smi", "mig", "-dgi", "-i", index])


def check_mig(indexes):
    """Makes every GPU one whole-GPU instance, diags each, then puts every
    GPU's slices back whatever happened."""
    before = mig_layout()
    failures = []
    try:
        for index in indexes:
            clear_mig(index)
            must(["nvidia-smi", "mig", "-cgi", FULL_GPU_PROFILE, "-C", "-i", index])
        for index in indexes:
            try:
                diag(index)
            except Exception as e:
                failures.append(f"GPU {index}: {e}")
    except Exception as e:
        failures.append(str(e))
    not_restored = []
    for index in indexes:
        try:
            clear_mig(index)
            must(["nvidia-smi", "mig", "-cgi", ",".join(before[int(index)]),
                  "-C", "-i", index])
        except Exception as e:
            not_restored.append(f"GPU {index}: {e}")
    if not_restored:
        raise CheckFailed("MIG layout not restored on " + " / ".join(not_restored))
    after = mig_layout()
    if after != before:
        changed = [str(g) for g in before if after.get(g) != before[g]]
        raise CheckFailed(f"MIG layout not restored on GPU {', '.join(changed)}")
    if failures:
        raise CheckFailed(" / ".join(failures))


def check():
    """Raises CheckFailed with a note when the host isn't fit to return."""
    if shutil.which("docker") is None:
        raise CheckFailed("docker is not installed")
    apps = must(["nvidia-smi", "--query-compute-apps=pid,process_name",
                 "--format=csv,noheader"]).strip()
    if apps:
        raise CheckFailed(f"a GPU is still in use: {tail(apps)}")
    bad = []
    for line in must(["nvidia-smi",
                      "--query-gpu=index,gpu_recovery_action,remapped_rows.failure",
                      "--format=csv,noheader"]).strip().splitlines():
        _, action, failure = (f.strip() for f in line.split(",", 2))
        if (action != "None" and not action.startswith("[")) or failure == "Yes":
            bad.append(line.strip())
    if bad:
        raise CheckFailed("a GPU needs recovery or is out of spare memory rows: "
                          + " / ".join(bad))
    gpus = [[f.strip() for f in line.split(",")] for line in must(
        ["nvidia-smi", "--query-gpu=index,uuid,mig.mode.current",
         "--format=csv,noheader"]).strip().splitlines()]
    modes = {mode for _, _, mode in gpus}
    if modes == {"Disabled"}:
        diag()
        return
    if modes != {"Enabled"}:
        raise CheckFailed("some GPUs have MIG on and some off; fix the layout by hand")
    check_mig([index for index, _, _ in gpus])


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(alert_id, result):
    """Replaces the state file whole, so a reboot can't leave half of it."""
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = f"{STATE_PATH}.tmp"
    with open(tmp, "w") as f:
        json.dump({"alertId": alert_id, "result": result}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE_PATH)


class Reporter:
    """Posts "verifying" every HEARTBEAT_SECONDS until stopped."""

    def __init__(self, alert_id):
        self.alert_id = alert_id
        self.stop = threading.Event()
        self.ok = True

    def post(self, state, observed):
        try:
            http_json("POST", f"/api/alerts/quarantine/{urllib.parse.quote(HOST)}"
                      "/applied", {"alertId": self.alert_id, "state": state,
                                   "observed": observed})
            print(f"posted {state} for {HOST}")
        except Exception as e:
            print(f"ERROR: POST applied failed: {e}", file=sys.stderr)
            self.ok = False

    def beat(self):
        while not self.stop.wait(HEARTBEAT_SECONDS):
            self.post("verifying", {"phase": "Running"})


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--dry-run", action="store_true",
                   help="run nothing; log whether it would check")
    args = p.parse_args(argv)
    if not REPORT_URL:
        print("GPU_REPORT_URL must be set", file=sys.stderr)
        return 1
    try:
        desired = http_json("GET", "/api/alerts/quarantine/desired?cluster="
                            + urllib.parse.quote(CLUSTER))["nodes"]
    except Exception as e:
        print(f"ERROR: desired set unavailable: {e}", file=sys.stderr)
        return 1
    want = next((w for w in desired if w["host"] == HOST), None)
    state = (want or {}).get("actuatorState")
    if want is None or want["stage"] != "resolving" or state not in (
            "drained", "verifying"):
        print(f"{HOST}: nothing to check")
        return 0
    if args.dry_run:
        print(f"DRY RUN: would run the return check on {HOST}")
        return 0
    reporter = Reporter(want["alertId"])
    if state == "verifying":
        # Only this host's check moves its episode to verifying, and none
        # runs now (systemd starts one run at a time): its result never
        # reached the dashboard, or it was cut off. State that is missing,
        # unreadable or another episode's counts as cut off.
        saved = load_state()
        result = (saved.get("result") if saved.get("alertId") == want["alertId"]
                  else None) or ["verify_failed", {"note": INTERRUPTED}]
        save_state(want["alertId"], result)
        reporter.post(*result)
        return 0 if reporter.ok else 1
    if VERIFY_LEVEL == "0":
        reporter.post("verified", {"note": "QUARANTINE_VERIFY_LEVEL=0"})
        return 0 if reporter.ok else 1
    save_state(want["alertId"], None)
    # No GPU is touched until the dashboard has "verifying": from then on a
    # lost result or a cut-off check is recovered by the branch above.
    reporter.post("verifying", {"phase": "Started"})
    if not reporter.ok:
        return 1
    beat = threading.Thread(target=reporter.beat, daemon=True)
    beat.start()
    try:
        check()
        result = ["verified", {}]
    except (CheckFailed, TimeoutError) as e:
        result = ["verify_failed", {"note": str(e)[:300]}]
    except Exception as e:
        result = ["verify_failed", {"note": f"check crashed: {e}"[:300]}]
    finally:
        reporter.stop.set()
        beat.join()
    save_state(want["alertId"], result)
    print(f"{HOST}: {result[0]} {result[1].get('note', '')}")
    reporter.post(*result)
    return 0 if reporter.ok else 1

if __name__ == "__main__":
    sys.exit(main())
