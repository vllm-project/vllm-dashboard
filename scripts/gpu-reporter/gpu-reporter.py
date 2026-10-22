#!/usr/bin/env python3
"""
Lightweight GPU + host metrics reporter for vLLM Dashboard.

Queries nvidia-smi for GPU metrics and /proc for host metrics (CPU, RAM,
disk), then POSTs everything to the dashboard API. Run via systemd
Type=oneshot service + timer every 30-60 seconds.

Usage:
  GPU_REPORT_URL=https://your-dashboard.vercel.app/api/gpu/report \
  GPU_REPORT_SECRET=your-secret \
  python3 gpu-reporter.py

Environment variables:
  GPU_REPORT_URL          - Dashboard API endpoint (required)
  GPU_REPORT_SECRET       - Bearer token for auth (optional, must match dashboard's GPU_REPORT_SECRET)
  GPU_HOSTNAME            - Override hostname (default: system hostname)
  GPU_REPORT_DISK_TIMEOUT - Seconds before a per-mount stat is given up (default: 5)
  GPU_REPORT_COMPUTE_APPS_TIMEOUT - Seconds before the compute-apps query is given up (default: 10)
  GPU_REPORT_STATE_DIR    - Where the kernel-log cursor is kept (default: /var/lib/gpu-reporter)

The reporter always POSTs, even when nvidia-smi fails: a failed GPU query
yields an empty "gpus" list with reporter_status="degraded" and last_error
set, so a sick host doesn't look like a dead one. The process only exits
non-zero when the POST itself fails (or GPU_REPORT_URL is unset).

Hardware-fault readings (recovery action, row-remap failure, uncorrected ECC,
Xids, MIG slice count, root-owned checkout slots) each come from their own
query and fail independently: a failed read is reported as null, never as a
passing value.

Two host-fault readings are explicit values instead: gpu_query_hung is true
(with gpu_query_error) when the main nvidia-smi query errors or runs past
GPU_HANG_TIMEOUT, and network_probes holds one result per target in
NETWORK_PROBES. The probes run on threads alongside everything else, so a
dead network adds at most NETWORK_PROBE_TIMEOUT to the run.
"""

import concurrent.futures
import datetime
import glob
import json
import os
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
HOSTNAME = os.environ.get("GPU_HOSTNAME", socket.gethostname())

NVIDIA_SMI_QUERY = (
    "index,name,utilization.gpu,memory.used,memory.total,"
    "temperature.gpu,power.draw,power.limit"
)
NVIDIA_SMI_UUID_QUERY = "index,uuid"
NVIDIA_SMI_COMPUTE_APPS_QUERY = "gpu_uuid,pid,used_memory"
# Separate from NVIDIA_SMI_QUERY: one field an older driver rejects would make
# nvidia-smi fail the whole query and take every metric with it.
NVIDIA_SMI_FAULT_QUERY = (
    "index,gpu_recovery_action,remapped_rows.failure,"
    "ecc.errors.uncorrected.volatile.total"
)

PROC_STAT = "/proc/stat"
PROC_MEMINFO = "/proc/meminfo"
PROC_MOUNTS = "/proc/mounts"
PROC_ROOT = "/proc"

# The main nvidia-smi query erroring or running past this is a GPU hang
# (reported as gpu_query_hung=true). The unit's TimeoutSec leaves room for it.
GPU_HANG_TIMEOUT = 30
NETWORK_PROBE_TIMEOUT = 10
# What every CI job needs: checkout, image pull (the agents' environment hook
# pulls CI images from public.ecr.aws) and pip installs. Any HTTP response,
# a registry's 401 included, means the target was reached.
NETWORK_PROBES = (
    ("github", "https://github.com"),
    ("registry", "https://public.ecr.aws/v2/"),
    ("pypi", "https://pypi.org/simple/"),
)

CPU_SAMPLE_INTERVAL = 1.0  # seconds between the two /proc/stat reads
DISK_STAT_TIMEOUT = float(os.environ.get("GPU_REPORT_DISK_TIMEOUT", "5"))
COMPUTE_APPS_TIMEOUT = float(os.environ.get("GPU_REPORT_COMPUTE_APPS_TIMEOUT", "10"))
FAULT_QUERY_TIMEOUT = 5  # nvidia-smi -L, fault query and journalctl; the unit's TimeoutSec is 90
STATE_DIR = os.environ.get("GPU_REPORT_STATE_DIR", "/var/lib/gpu-reporter")
JOURNAL_CURSOR_FILE = os.path.join(STATE_DIR, "journal.cursor")
MAX_XIDS_PER_REPORT = 200  # the ingestion contract allows 500
# Kernel-log entries read per report. A long backlog (reporter stopped for
# days) catches up over several reports instead of timing out every time.
JOURNAL_READ_LIMIT = 10000
MAX_XID_MESSAGE = 512
CHECKOUT_GLOBS = (
    "/mnt/local/buildkite-agent/builds/*/vllm/ci",
    "/dev/shm/buildkite-agent/builds/*/vllm/ci",
)
XID_RE = re.compile(r"NVRM: Xid \(PCI:([0-9A-Fa-f:.]+)\): (\d+)(?:,\s*(.*))?$")

# Per-mount role classification for the bare-metal H200 pools
# (h200-ci-*, mithril-h200-*):
#   /dev/shm     - buildkite build path is /dev/shm/buildkite-agent/builds
#   /mnt/local   - buildkite build path is /mnt/local/buildkite-agent/builds
#   /raid0       - docker data-root is /raid0/docker
#   /mnt/vllm-ci - shared NFS share for datasets/models
# Unclassified mounts default to "system" for / and "other" (never alerted).
MOUNT_ROLES = {
    "/": "system",
    "/dev/shm": "workspace",
    "/mnt/local": "workspace",
    "/raid0": "images",
    "/mnt/vllm-ci": "data",
}

# Kernel API filesystems that never hold job data and are never reported.
SKIP_FSTYPES = frozenset({
    "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs",
    "debugfs", "devpts", "devtmpfs", "efivarfs", "fuse.gvfsd-fuse",
    "fuse.portal", "fusectl", "hugetlbfs", "mqueue", "nsfs", "overlay",
    "proc", "pstore", "ramfs", "rpc_pipefs", "securityfs", "selinuxfs",
    "squashfs", "sysfs", "tracefs",
})


def query_gpus():
    result = subprocess.run(
        [
            "nvidia-smi",
            f"--query-gpu={NVIDIA_SMI_QUERY}",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        timeout=GPU_HANG_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"nvidia-smi failed: {result.stderr.strip()}")

    gpus = []
    for line in result.stdout.strip().split("\n"):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            continue

        def safe_float(v):
            try:
                return float(v)
            except (ValueError, TypeError):
                return None

        gpus.append({
            "index": int(parts[0]),
            "name": parts[1] if parts[1] != "[N/A]" else None,
            # [N/A] on MIG GPUs stays null; 0 would read as idle.
            "gpu_util": safe_float(parts[2]),
            "mem_used_mb": safe_float(parts[3]) or 0,
            "mem_total_mb": safe_float(parts[4]) or 0,
            "temperature_c": safe_float(parts[5]),
            "power_draw_w": safe_float(parts[6]),
            "power_limit_w": safe_float(parts[7]),
            "dead_proc_mem_mb": None,  # filled in by main(); null = unknown
            "recovery_action": None,  # filled in by main(); null = unknown
            "remapped_rows_failure": None,
            "ecc_uncorrected": None,
        })
    if not gpus:
        raise RuntimeError("no GPUs found in nvidia-smi output")
    return gpus


def _pid_alive(pid, proc_root=PROC_ROOT):
    return os.path.isdir(os.path.join(proc_root, str(pid)))


def query_dead_proc_memory():
    """Per-GPU MiB still attributed to processes that no longer exist.

    When a compute process is SIGKILLed mid-teardown the driver can keep its
    memory allocated to the dead PID indefinitely (observed on the H200 MIG
    fleet); only a GPU reset or reboot reclaims it. The compute-apps table
    keys rows by GPU UUID, so a second query maps UUIDs to the indexes used
    by the rest of the report. Raises on any nvidia-smi failure; the caller
    degrades the metric to null rather than the whole report.
    """
    index_of_uuid = {}
    result = subprocess.run(
        [
            "nvidia-smi",
            f"--query-gpu={NVIDIA_SMI_UUID_QUERY}",
            "--format=csv,noheader",
        ],
        capture_output=True,
        text=True,
        timeout=COMPUTE_APPS_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"nvidia-smi uuid query failed: {result.stderr.strip()}")
    for line in result.stdout.strip().split("\n"):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            index_of_uuid[parts[1]] = int(parts[0])

    result = subprocess.run(
        [
            "nvidia-smi",
            f"--query-compute-apps={NVIDIA_SMI_COMPUTE_APPS_QUERY}",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        timeout=COMPUTE_APPS_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"nvidia-smi compute-apps query failed: {result.stderr.strip()}"
        )
    dead_mb = {index: 0.0 for index in index_of_uuid.values()}
    for line in result.stdout.strip().split("\n"):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            continue
        gpu_uuid, pid, mem_mb = parts[0], parts[1], parts[2]
        if gpu_uuid not in index_of_uuid:
            continue
        try:
            mem_mb = float(mem_mb)
        except ValueError:
            continue
        if not _pid_alive(pid):
            dead_mb[index_of_uuid[gpu_uuid]] += mem_mb
    return dead_mb


SMI_BOOL = {"yes": True, "1": True, "true": True, "no": False, "0": False, "false": False}


def _smi_field(value):
    """nvidia-smi cell -> str, or None for [N/A], [Not Supported] and blanks."""
    value = value.strip()
    if not value or (value.startswith("[") and value.endswith("]")):
        return None
    return value


def parse_fault_query(text):
    """Parse the NVIDIA_SMI_FAULT_QUERY csv -> {index: {field: value|None}}.

    MIG hosts return [N/A] for the row-remap field; that and any other
    unreadable cell becomes None, never False/0.
    """
    faults = {}
    for line in text.strip().split("\n"):
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        ecc = _smi_field(parts[3])
        faults[int(parts[0])] = {
            "recovery_action": _smi_field(parts[1]),
            "remapped_rows_failure": SMI_BOOL.get(parts[2].lower()),
            "ecc_uncorrected": int(ecc) if ecc is not None and ecc.isdigit() else None,
        }
    return faults


def query_fault_fields():
    result = subprocess.run(
        [
            "nvidia-smi",
            f"--query-gpu={NVIDIA_SMI_FAULT_QUERY}",
            "--format=csv,noheader,nounits",
        ],
        capture_output=True,
        text=True,
        timeout=FAULT_QUERY_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"nvidia-smi fault query failed: {result.stderr.strip()}")
    return parse_fault_query(result.stdout)


def count_mig_slices(text):
    """Count MIG devices in `nvidia-smi -L` output (0 on a non-MIG host)."""
    return sum(1 for line in text.splitlines() if line.strip().startswith("MIG "))


def query_mig_slices():
    result = subprocess.run(
        ["nvidia-smi", "-L"],
        capture_output=True,
        text=True,
        timeout=FAULT_QUERY_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"nvidia-smi -L failed: {result.stderr.strip()}")
    return count_mig_slices(result.stdout)


def parse_xid_events(journal_json):
    """Parse `journalctl -k -o json` output -> (xids, last_cursor).

    xids holds every NVRM Xid line as {bus_id, xid, at, message}. last_cursor
    is the cursor of the last entry consumed: if more than MAX_XIDS_PER_REPORT
    Xids are pending, it stops at the last one reported so the rest go out in
    the next report instead of being dropped.
    """
    xids = []
    last_cursor = None
    for line in journal_json.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("MESSAGE")
        match = XID_RE.search(message) if isinstance(message, str) else None
        if match:
            if len(xids) == MAX_XIDS_PER_REPORT:
                break
            at = datetime.datetime.fromtimestamp(
                int(entry["__REALTIME_TIMESTAMP"]) / 1e6, tz=datetime.timezone.utc
            )
            xids.append({
                "bus_id": match.group(1),
                "xid": int(match.group(2)),
                "at": at.isoformat(timespec="microseconds"),
                "message": (match.group(3) or "")[:MAX_XID_MESSAGE],
            })
        last_cursor = entry.get("__CURSOR", last_cursor)
    return xids, last_cursor


def read_cursor(path=JOURNAL_CURSOR_FILE):
    try:
        with open(path) as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None


def write_cursor(cursor, path=JOURNAL_CURSOR_FILE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        f.write(cursor)
    os.replace(tmp, path)


def _journalctl(*args):
    result = subprocess.run(
        # _TRANSPORT=kernel rather than -k: -k implies -b, which would skip
        # Xids logged between the last report and a reboot.
        ["journalctl", "_TRANSPORT=kernel", "--no-pager", "-o", "json", *args],
        capture_output=True,
        text=True,
        timeout=FAULT_QUERY_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(f"journalctl failed: {result.stderr.strip()}")
    return result.stdout


def query_xids(cursor_path=JOURNAL_CURSOR_FILE):
    """Xids logged since the last successful report -> (xids, new_cursor).

    The first run (no cursor yet) only records where the kernel log ends, so
    the whole history is never replayed; it returns no Xids. new_cursor is
    None when nothing new was read. The caller saves it after the POST
    succeeds, so a failed POST resends the same Xids; the dashboard drops
    duplicates.
    """
    cursor = read_cursor(cursor_path)
    if cursor is None:
        _, last_cursor = parse_xid_events(_journalctl("-n", "1"))
        return [], last_cursor
    # With --after-cursor, -n +N means the oldest N entries after it.
    return parse_xid_events(
        _journalctl(f"--after-cursor={cursor}", "-n", f"+{JOURNAL_READ_LIMIT}")
    )


DOCKER_BRIDGE = "/sys/class/net/docker0"
DOCKER_TIMEOUT = 10


def check_docker():
    """(docker_ok, error): can Docker start a container here?

    Every CI job runs in a container on the default bridge. On 2026-10-16
    h200-ci-1 lost its docker0 bridge while `docker info` still answered,
    so every job failed at `docker run` in seconds. (None, None) on a host
    without Docker.
    """
    if shutil.which("docker") is None:
        return None, None
    if not os.path.exists(DOCKER_BRIDGE):
        return False, "the docker0 bridge is missing"
    try:
        r = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True, text=True, timeout=DOCKER_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return False, f"docker info did not answer in {DOCKER_TIMEOUT} s"
    if r.returncode != 0:
        last = (r.stderr.strip().splitlines() or ["no output"])[-1]
        return False, f"docker info failed: {last}"[:300]
    return True, None


def _raise(error):
    raise error


def _agent_cant_empty(path, root_uid):
    """A directory at or below `path` that is root-owned, holds something,
    and keeps the agent from deleting what's inside.

    Emptying a directory needs read (to list it), write and search
    permission on it, and in a sticky directory also owning each entry. A root-owned
    file, or an empty directory, goes when the agent deletes its parent. The
    recorders make their directories 0777 all the way down for exactly this
    reason (ci-infra#701), so those don't count. A directory that can't be
    read raises, so the reading is unknown rather than clean.
    """
    needed = stat.S_IROTH | stat.S_IWOTH | stat.S_IXOTH
    for dirpath, dirnames, filenames in os.walk(path, onerror=_raise):
        st = os.lstat(dirpath)
        names = dirnames + filenames
        if st.st_uid != root_uid or not names:
            continue
        if st.st_mode & needed != needed:
            return True
        if st.st_mode & stat.S_ISVTX and any(
                os.lstat(os.path.join(dirpath, n)).st_uid == root_uid
                for n in names):
            return True
    return False


def find_root_owned_slots(patterns=CHECKOUT_GLOBS, root_uid=0):
    """Checkout dirs the agent can't delete because of root-owned files.

    Job containers run as root, so a directory created in the bind-mounted
    checkout comes out root:root 0755 and the agent can't empty it; the next
    clone on that slot fails. Only root-owned top-level directories are
    walked, so a normal checkout costs one scandir. Raises on an unreadable
    checkout; the caller reports null rather than an empty list.
    """
    slots = []
    for pattern in patterns:
        for checkout in sorted(glob.glob(pattern)):
            try:
                with os.scandir(checkout) as entries:
                    if any(e.is_dir(follow_symlinks=False)
                           and e.stat(follow_symlinks=False).st_uid == root_uid
                           and _agent_cant_empty(e.path, root_uid)
                           for e in entries):
                        slots.append(checkout)
            except FileNotFoundError:
                continue  # slot was cleaned up mid-scan
    return slots


def probe_error_kind(error):
    """Exception from urlopen -> "timeout" | "dns" | "tls" | "connect" | "other"."""
    reason = getattr(error, "reason", error)  # URLError wraps the socket error
    if isinstance(reason, TimeoutError):
        return "timeout"
    if isinstance(reason, socket.gaierror):
        return "dns"
    if isinstance(reason, ssl.SSLError):
        return "tls"
    if isinstance(reason, OSError):
        return "connect"
    return "other"


def probe(url, timeout=NETWORK_PROBE_TIMEOUT):
    """HEAD `url` -> {"ok", "error", "latency_ms"}."""
    start = time.monotonic()
    try:
        urllib.request.urlopen(urllib.request.Request(url, method="HEAD"),
                               timeout=timeout).close()
    except urllib.error.HTTPError:
        pass  # the server answered: reachable
    except Exception as e:
        return {"ok": False, "error": probe_error_kind(e), "latency_ms": None}
    return {"ok": True, "error": None,
            "latency_ms": round((time.monotonic() - start) * 1000)}


def start_network_probes(targets):
    """Start one daemon-thread probe per target; see finish_network_probes."""
    started = []
    for target, url in targets:
        slot = [None]  # one assignment, so a late thread can't half-write it

        def run(slot=slot, url=url):
            slot[0] = probe(url)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        started.append((target, thread, slot))
    return started, time.monotonic() + NETWORK_PROBE_TIMEOUT + 1


def finish_network_probes(started):
    """Wait out the probes' shared deadline -> [{target, ok, error, latency_ms}].

    urlopen's timeout doesn't cover DNS, so a probe still running at the
    deadline is reported as a timeout and its daemon thread is abandoned.
    """
    probes, deadline = started
    results = []
    for target, thread, slot in probes:
        thread.join(max(0.0, deadline - time.monotonic()))
        results.append({"target": target, **(slot[0] or {
            "ok": False, "error": "timeout", "latency_ms": None})})
    return results


def parse_cpu_stat(text):
    """Parse the aggregate 'cpu' line of /proc/stat -> (idle, total) jiffies.

    idle includes iowait; guest time is already folded into user/nice, so
    total sums the first 8 fields (user..steal).
    """
    for line in text.splitlines():
        if line.startswith("cpu "):
            fields = [int(x) for x in line.split()[1:9]]
            idle = fields[3] + fields[4]  # idle + iowait
            return idle, sum(fields)
    raise ValueError("no aggregate cpu line found")


def cpu_util_percent(path=PROC_STAT, interval=CPU_SAMPLE_INTERVAL):
    """CPU utilization % from two /proc/stat reads `interval` seconds apart."""
    with open(path) as f:
        idle1, total1 = parse_cpu_stat(f.read())
    time.sleep(interval)
    with open(path) as f:
        idle2, total2 = parse_cpu_stat(f.read())
    d_idle = idle2 - idle1
    d_total = total2 - total1
    if d_total <= 0:
        return 0.0
    return round(100.0 * (1.0 - d_idle / d_total), 2)


def parse_meminfo(text):
    """Parse /proc/meminfo -> {"total": bytes, "available": bytes}."""
    values = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].rstrip(":") in ("MemTotal", "MemAvailable"):
            values[parts[0].rstrip(":")] = int(parts[1]) * 1024  # kB -> bytes
    if "MemTotal" not in values or "MemAvailable" not in values:
        raise ValueError("MemTotal/MemAvailable missing from meminfo")
    return {"total": values["MemTotal"], "available": values["MemAvailable"]}


def unescape_mount(path):
    # /proc/mounts escapes space, tab, newline and backslash as octal.
    return (path.replace("\\040", " ").replace("\\011", "\t")
            .replace("\\012", "\n").replace("\\134", "\\"))


def keep_mount(mount, fstype):
    if fstype == "tmpfs":
        # tmpfs only matters where it holds job data (/dev/shm builds);
        # /run, /run/lock etc. are runtime scratch and never alerted.
        return mount == "/dev/shm"
    return fstype not in SKIP_FSTYPES


def parse_proc_mounts(text):
    """Parse /proc/mounts -> list of real mounts worth reporting on."""
    mounts = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        device, mount, fstype = parts[0], unescape_mount(parts[1]), parts[2]
        if keep_mount(mount, fstype):
            mounts.append({"device": device, "mount": mount, "fstype": fstype})
    return mounts


def classify_mount(mount):
    return MOUNT_ROLES.get(mount, "other")


def stat_mount(mount, timeout=DISK_STAT_TIMEOUT):
    """shutil.disk_usage under a timeout.

    /mnt/vllm-ci is NFS and a stat on it can block indefinitely. Threads
    can't be killed, but the oneshot unit's TimeoutSec bounds the process,
    so a hung stat degrades this one mount to an error entry instead of
    killing the whole report.
    """
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(shutil.disk_usage, mount)
        try:
            usage = future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            return {"used_bytes": None, "total_bytes": None,
                    "error": f"stat timed out after {timeout}s"}
        except OSError as e:
            return {"used_bytes": None, "total_bytes": None, "error": str(e)}
        return {"used_bytes": usage.used, "total_bytes": usage.total, "error": None}
    finally:
        pool.shutdown(wait=False)


def collect_host_metrics():
    meminfo = parse_meminfo(open(PROC_MEMINFO).read())
    with open(PROC_MOUNTS) as f:
        mounts = parse_proc_mounts(f.read())

    disks = []
    for m in mounts:
        entry = {
            "mount_point": m["mount"],
            "device": m["device"],
            "fstype": m["fstype"],
            "role": classify_mount(m["mount"]),
            **stat_mount(m["mount"]),
        }
        # Skip zero-capacity mounts (kernel pseudo-filesystems that slip the
        # fstype filter): nothing can fill them, and the ingestion contract
        # requires total_bytes >= 1, so one would fail the whole report.
        if entry["error"] is None and not entry["total_bytes"]:
            continue
        disks.append(entry)

    return {
        "cpu_util": cpu_util_percent(),
        "cpu_count": os.cpu_count() or 0,
        "ram_used_bytes": meminfo["total"] - meminfo["available"],
        "ram_total_bytes": meminfo["total"],
        "ram_available_bytes": meminfo["available"],
        "disks": disks,
    }


def report(gpus, host, status, last_error, faults=None):
    payload = json.dumps({
        "hostname": HOSTNAME,
        "gpus": gpus,
        "host": host,
        "reporter_status": status,
        "last_error": last_error,
        **(faults or {}),
    }).encode()

    headers = {"Content-Type": "application/json"}
    if REPORT_SECRET:
        headers["Authorization"] = f"Bearer {REPORT_SECRET}"

    req = urllib.request.Request(REPORT_URL, data=payload, headers=headers, method="POST")

    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read())
        print(f"OK: {body.get('gpus', 0)} GPUs reported for {HOSTNAME} "
              f"(status={status})")


def main():
    if not REPORT_URL:
        print("GPU_REPORT_URL not set", file=sys.stderr)
        sys.exit(1)

    probes = start_network_probes(NETWORK_PROBES)
    host = collect_host_metrics()
    faults = {"xids": None, "mig_slices": None, "root_owned_slots": None,
              "gpu_query_hung": False, "gpu_query_error": None,
              "docker_ok": None, "docker_error": None}

    try:
        gpus = query_gpus()
        status, last_error = "ok", None
    except Exception as e:
        # An error or a run past GPU_HANG_TIMEOUT is a hang: an explicit
        # failing value, never a missing reading.
        faults["gpu_query_hung"], faults["gpu_query_error"] = True, str(e)
        # A GPU query failure must not silence the host: report with an
        # empty GPU list and a degraded status instead of exiting quietly.
        # The ingestion contract requires last_error to be non-null when
        # reporter_status is "degraded".
        print(str(e), file=sys.stderr)
        gpus, status, last_error = [], "degraded", str(e)
    else:
        # Dead-PID memory is a supplementary metric: a compute-apps query
        # failure (observed hanging on a degraded host, bounded by
        # COMPUTE_APPS_TIMEOUT) must leave dead_proc_mem_mb null and never
        # affect reporter_status or the POST.
        try:
            dead_mb = query_dead_proc_memory()
        except Exception as e:
            print(f"dead process GPU memory query failed: {e}", file=sys.stderr)
        else:
            for gpu in gpus:
                gpu["dead_proc_mem_mb"] = dead_mb.get(gpu["index"], 0.0)

        # Fault readings: each is its own query and degrades to null alone.
        try:
            fault_fields = query_fault_fields()
        except Exception as e:
            print(f"GPU fault query failed: {e}", file=sys.stderr)
        else:
            for gpu in gpus:
                gpu.update(fault_fields.get(gpu["index"], {}))

        # Skipped when nvidia-smi already failed: a hung driver would cost
        # another timeout for a reading that can't be trusted.
        try:
            faults["mig_slices"] = query_mig_slices()
        except Exception as e:
            print(f"MIG slice query failed: {e}", file=sys.stderr)

    # Xids are read even when nvidia-smi fails: Xid 79 (fallen off the bus)
    # is exactly when it does.
    new_cursor = None
    try:
        faults["xids"], new_cursor = query_xids(JOURNAL_CURSOR_FILE)
    except Exception as e:
        print(f"kernel log Xid query failed: {e}", file=sys.stderr)
    try:
        faults["root_owned_slots"] = find_root_owned_slots()
    except Exception as e:
        print(f"root-owned checkout scan failed: {e}", file=sys.stderr)
    try:
        faults["docker_ok"], faults["docker_error"] = check_docker()
    except Exception as e:
        print(f"Docker check failed: {e}", file=sys.stderr)

    faults["network_probes"] = finish_network_probes(probes)

    try:
        report(gpus, host, status, last_error, faults)
    except Exception as e:
        print(f"POST to dashboard failed: {e}", file=sys.stderr)
        sys.exit(1)

    if new_cursor:
        try:
            write_cursor(new_cursor, JOURNAL_CURSOR_FILE)
        except OSError as e:
            # Not fatal: the next report resends these Xids and the dashboard
            # drops the duplicates.
            print(f"could not save journal cursor: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
