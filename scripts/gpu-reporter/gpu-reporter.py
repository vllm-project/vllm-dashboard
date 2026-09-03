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

The reporter always POSTs, even when nvidia-smi fails: a failed GPU query
yields an empty "gpus" list with reporter_status="degraded" and last_error
set, so a sick host doesn't look like a dead one. The process only exits
non-zero when the POST itself fails (or GPU_REPORT_URL is unset).
"""

import concurrent.futures
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
HOSTNAME = os.environ.get("GPU_HOSTNAME", socket.gethostname())

NVIDIA_SMI_QUERY = (
    "index,name,utilization.gpu,memory.used,memory.total,"
    "temperature.gpu,power.draw,power.limit"
)

PROC_STAT = "/proc/stat"
PROC_MEMINFO = "/proc/meminfo"
PROC_MOUNTS = "/proc/mounts"

CPU_SAMPLE_INTERVAL = 1.0  # seconds between the two /proc/stat reads
DISK_STAT_TIMEOUT = float(os.environ.get("GPU_REPORT_DISK_TIMEOUT", "5"))

# Per-mount role classification for the H200 CI pool (h200-ci-1..6):
#   /dev/shm     - buildkite build path is /dev/shm/buildkite-agent/builds
#   /raid0       - docker data-root is /raid0/docker
#   /mnt/vllm-ci - shared NFS share for datasets/models
# Unclassified mounts default to "system" for / and "other" (never alerted).
MOUNT_ROLES = {
    "/": "system",
    "/dev/shm": "workspace",
    "/raid0": "images",
    "/mnt/vllm-ci": "data",
}

# Kernel API filesystems that never hold job data and are never reported.
SKIP_FSTYPES = frozenset({
    "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs",
    "debugfs", "devpts", "devtmpfs", "efivarfs", "fuse.gvfsd-fuse",
    "fuse.portal", "fusectl", "hugetlbfs", "mqueue", "nsfs", "overlay",
    "proc", "pstore", "ramfs", "securityfs", "selinuxfs", "squashfs",
    "sysfs", "tracefs",
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
        timeout=10,
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
            "gpu_util": safe_float(parts[2]) or 0,
            "mem_used_mb": safe_float(parts[3]) or 0,
            "mem_total_mb": safe_float(parts[4]) or 0,
            "temperature_c": safe_float(parts[5]),
            "power_draw_w": safe_float(parts[6]),
            "power_limit_w": safe_float(parts[7]),
        })
    if not gpus:
        raise RuntimeError("no GPUs found in nvidia-smi output")
    return gpus


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
        disks.append({
            "mount_point": m["mount"],
            "device": m["device"],
            "fstype": m["fstype"],
            "role": classify_mount(m["mount"]),
            **stat_mount(m["mount"]),
        })

    return {
        "cpu_util": cpu_util_percent(),
        "cpu_count": os.cpu_count() or 0,
        "ram_used_bytes": meminfo["total"] - meminfo["available"],
        "ram_total_bytes": meminfo["total"],
        "ram_available_bytes": meminfo["available"],
        "disks": disks,
    }


def report(gpus, host, status, last_error):
    payload = json.dumps({
        "hostname": HOSTNAME,
        "gpus": gpus,
        "host": host,
        "reporter_status": status,
        "last_error": last_error,
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

    host = collect_host_metrics()

    try:
        gpus = query_gpus()
        status, last_error = "ok", None
    except Exception as e:
        # A GPU query failure must not silence the host: report with an
        # empty GPU list and a degraded status instead of exiting quietly.
        # The ingestion contract requires last_error to be non-null when
        # reporter_status is "degraded".
        print(str(e), file=sys.stderr)
        gpus, status, last_error = [], "degraded", str(e)

    try:
        report(gpus, host, status, last_error)
    except Exception as e:
        print(f"POST to dashboard failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
