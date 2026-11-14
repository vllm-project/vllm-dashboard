#!/usr/bin/env python3
"""
GPU + host metrics reporter for K8s clusters with DCGM Exporter.

Runs on the control plane. Enumerates the cluster's GPU nodes from
`kubectl get nodes` (the source of truth for which hosts should report),
maps DCGM exporter pods onto them, scrapes each pod's /metrics for GPU
data, and pulls host-level metrics per node from the kubelet via the API
server proxy:

  - CPU/RAM: /api/v1/nodes/<node>/proxy/stats/summary
  - Disk per device: /api/v1/nodes/<node>/proxy/metrics/cadvisor
    (root-cgroup container_fs_{usage,limit}_bytes rows, keyed by the
    device label; tmpfs rows use their mount path as the device value)

Driver fault signals come from each node's NVIDIA device-plugin pod:
`kubectl exec nvidia-smi` (recovery action, row-remap failure, uncorrectable
ECC) and the host's kernel journal since the last read (Xid events, through
`chroot /host journalctl` in the same pod). Each reading fails
independently to null; null means "missing reading", never a passing value.

The same nvidia-smi exec is the GPU-hang check: nvidia-smi erroring or the
exec not returning within GPU_HANG_TIMEOUT is gpu_query_hung=true, an
explicit failing value. A second exec probes NETWORK_PROBES with the plugin
image's busybox wget. A third reads GPU fabric health (FABRIC_SCRIPT). The
execs start for every node at once, before the per-node loop, so a hung node
costs the run one timeout, not one per node.

Disk scraping runs on a 5-minute cadence, not every 30s tick, because
cAdvisor payloads are 1.4-2.1 MB per node; between scrapes the cached
readings from the state file are reused.

Usage:
  GPU_REPORT_URL=https://your-dashboard.vercel.app/api/gpu/report \
  GPU_REPORT_SECRET=your-secret \
  python3 gpu-reporter-k8s.py

Environment variables:
  GPU_REPORT_URL           - Dashboard API endpoint (required)
  GPU_REPORT_SECRET        - Bearer token for auth (optional)
  DCGM_EXPORTER_NS         - Namespace of DCGM exporter (default: gpu-operator)
  DCGM_EXPORTER_LABEL      - Pod label selector (default: app=nvidia-dcgm-exporter)
  DCGM_EXPORTER_PORT       - Metrics port (default: 9400)
  DEVICE_PLUGIN_LABEL      - Device-plugin pod selector, same namespace as the
                             exporter (default: app=nvidia-device-plugin-daemonset)
  GPU_REPORT_DISK_INTERVAL - Seconds between cAdvisor disk scrapes (default: 300)
  GPU_REPORT_DISK_STATE    - Disk-scrape state file
                             (default: /var/lib/gpu-reporter/k8s-disk-state.json,
                              falls back to /tmp when not writable)
"""

import concurrent.futures
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
DCGM_NS = os.environ.get("DCGM_EXPORTER_NS", "gpu-operator")
DCGM_LABEL = os.environ.get("DCGM_EXPORTER_LABEL", "app=nvidia-dcgm-exporter")
DCGM_PORT = os.environ.get("DCGM_EXPORTER_PORT", "9400")
PLUGIN_LABEL = os.environ.get("DEVICE_PLUGIN_LABEL",
                              "app=nvidia-device-plugin-daemonset")
PLUGIN_CONTAINER = "nvidia-device-plugin"
# Readings are keyed by uuid: it joins them to DCGM's UUID label.
SMI_FIELDS = ("uuid,pci.bus_id,gpu_recovery_action,remapped_rows.failure,"
              "ecc.errors.uncorrected.volatile.total")
# Same cap as gpu-reporter.py (ingest rejects a report with more than 500);
# the rest go out on the next run.
MAX_XIDS_PER_REPORT = 200
# Per-node kernel-journal cursors live in the disk state file under this key
# (no node can be named like this). A new key: the old "_xid_since" values
# were plugin-log times, not cursors.
XID_STATE_KEY = "_journal_cursor"
# Same as gpu-reporter.py: the oldest entries read after the cursor per run,
# and the longest Xid message sent.
JOURNAL_READ_LIMIT = 10000
MAX_XID_MESSAGE = 512
XID_RE = re.compile(r"NVRM: Xid \(PCI:([0-9A-Fa-f:.]+)\): (\d+)(?:,\s*(.*))?$")

KUBECTL_TIMEOUT = 10  # per-call seconds; one slow node must not kill the run
# The journal read takes well under a second; a short bound keeps a hung
# node from eating the 30 s cadence.
DRIVER_READ_TIMEOUT = 5
GPU_RESOURCE = "nvidia.com/gpu"
# nvidia-smi erroring or the exec not returning within this is a GPU hang.
# kubectl can't say whether a timed-out exec was stuck in nvidia-smi or in
# the API server; a slow API server stalls every node at once, which the
# rules treat as a shared incident rather than a host fault.
GPU_HANG_TIMEOUT = 30
NETWORK_PROBE_TIMEOUT = 10
# Same targets as gpu-reporter.py. The plugin pod is not on the host network,
# so this checks the pod network and cluster DNS that CI job pods use; the
# node's own image pulls go through the host network, which it can't see.
NETWORK_PROBES = (
    ("github", "https://github.com"),
    ("registry", "https://public.ecr.aws/v2/"),
    ("pypi", "https://pypi.org/simple/"),
)
# Three execs and a log read per node, all nodes at once (see process_node).
POD_READS = concurrent.futures.ThreadPoolExecutor(max_workers=64)

DISK_SCRAPE_INTERVAL = int(os.environ.get("GPU_REPORT_DISK_INTERVAL", "300"))
DISK_STATE_FILE = os.environ.get(
    "GPU_REPORT_DISK_STATE", "/var/lib/gpu-reporter/k8s-disk-state.json"
)
DISK_STATE_FALLBACK = "/tmp/gpu-reporter-k8s-disk-state.json"

# Device -> role map per node pool, keyed by node-name prefix. cAdvisor
# labels root-cgroup filesystem rows by device; tmpfs rows use their mount
# path as the device value. Devices not listed here default to "system" for
# the root filesystem and "other" (never alerted) otherwise.
DEVICE_ROLE_MAPS = {
    # H100 pool: /dev/vda1 = 243 GB root (also where disk-backed emptyDir
    # lands), /dev/vdc = 13.3 TB /mnt/hf-cache, /dev/shm = RAM-backed
    # workspace (also emptyDir medium: Memory).
    "inf-4x8h100-": {
        "/dev/vda1": "system",
        "/dev/vdc": "data",
        "/dev/shm": "workspace",
    },
    # DGX B200 pool: /dev/md0 = 1.8 TB root (job emptyDir + /mnt/shared
    # live here), /dev/md127 = 28 TB /raid, /dev/shm = RAM-backed workspace.
    "dgxb200-": {
        "/dev/md0": "system",
        "/dev/md127": "data",
        "/dev/shm": "workspace",
    },
}

METRIC_RE = re.compile(
    r'^(DCGM_FI_DEV_FB_USED|DCGM_FI_DEV_FB_FREE|DCGM_FI_DEV_FB_RESERVED'
    r'|DCGM_FI_DEV_GPU_UTIL|DCGM_FI_DEV_GPU_TEMP|DCGM_FI_DEV_POWER_USAGE)'
    r'\{([^}]+)\}\s+(\S+)$'
)

CADVISOR_FS_RE = re.compile(
    r'^container_fs_(usage|limit)_bytes\{([^}]*)\}\s+(\S+)'
)

# cAdvisor rows for container/pod plumbing are noise: overlay_* rows are
# per-container views duplicating the root filesystem's usage (the real
# underlying device is reported on its own row, which stays the base), and
# tmpfs rows use their mount path as the device value, so every pod adds
# "devices" like /run/containerd/.../shm and kubelet service-account volumes.
# A busy node accumulates dozens of these (dgxb200-12 had ~20), all empty or
# duplicates.
PLUMBING_DEVICE_RE = re.compile(
    r"^/(run/.+|var/lib/kubelet|sys/fs/cgroup)(/|$)"
)


def is_container_plumbing(device):
    """True for cAdvisor device values that are container/pod plumbing."""
    return device.startswith("overlay") or bool(
        PLUMBING_DEVICE_RE.match(device)
    )


def kubectl(*args, timeout=KUBECTL_TIMEOUT):
    result = subprocess.run(
        ["kubectl", *args], capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"kubectl {' '.join(args[:2])} failed: {result.stderr.strip()}"
        )
    return result.stdout


def get_nodes():
    """All cluster nodes as a list of API objects."""
    return json.loads(kubectl("get", "nodes", "-o", "json"))["items"]


def parse_cpu_cores(s):
    """K8s CPU quantity -> cores: '160' -> 160.0, '500m' -> 0.5."""
    if s.endswith("m"):
        return float(s[:-1]) / 1000.0
    return float(s)


def parse_mem_bytes(s):
    """K8s memory quantity -> bytes: '1744228632Ki' -> 1786095636480."""
    for suffix, mult in (("Ki", 1024), ("Mi", 1024**2), ("Gi", 1024**3),
                         ("Ti", 1024**4)):
        if s.endswith(suffix):
            return int(float(s[:-2]) * mult)
    return int(s)


def node_gpu_count(node):
    return int(node["status"].get("capacity", {}).get(GPU_RESOURCE, 0))


def node_conditions(node):
    conds = {c["type"]: c["status"]
             for c in node["status"].get("conditions", [])}
    return {
        "ready": conds.get("Ready") == "True",
        "disk_pressure": conds.get("DiskPressure") == "True",
        "memory_pressure": conds.get("MemoryPressure") == "True",
        "pid_pressure": conds.get("PIDPressure") == "True",
        "unschedulable": bool(node["spec"].get("unschedulable", False)),
    }


def pods_by_node(label, field):
    """Pods in DCGM_NS matching `label` as {node name: pod `field`}."""
    out = kubectl(
        "get", "pods", "-n", DCGM_NS, "-l", label, "-o",
        "jsonpath={range .items[*]}{" + field + "} {.spec.nodeName}{'\\n'}{end}",
        timeout=15,
    )
    pods = {}
    for line in out.strip().split("\n"):
        parts = line.strip().split()
        if len(parts) == 2:
            pods[parts[1]] = parts[0]
    return pods


def get_pod_ips():
    """DCGM exporter pods as {node name: pod IP}."""
    return pods_by_node(DCGM_LABEL, ".status.podIP")


def get_plugin_pods():
    """Device-plugin pods as {node name: pod name}."""
    return pods_by_node(PLUGIN_LABEL, ".metadata.name")


def _smi_text(v):
    """nvidia-smi csv cell -> str, or None for [N/A] / [Not Supported]."""
    v = v.strip()
    return None if not v or v.startswith("[") else v


def _smi_bool(v):
    v = (_smi_text(v) or "").lower()
    return {"yes": True, "1": True, "no": False, "0": False}.get(v)


def _smi_int(v):
    v = _smi_text(v)
    return int(v) if v is not None and v.isdigit() else None


def parse_smi_gpus(text):
    """nvidia-smi --query-gpu=SMI_FIELDS csv -> {uuid: reading}."""
    gpus = {}
    for line in text.strip().splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) != 5 or not cols[0].startswith("GPU-"):
            continue
        gpus[cols[0]] = {
            "bus_id": _smi_text(cols[1]),
            "recovery_action": _smi_text(cols[2]),
            "remapped_rows_failure": _smi_bool(cols[3]),
            "ecc_uncorrected": _smi_int(cols[4]),
        }
    return gpus


def read_smi(pod):
    """exec nvidia-smi in the plugin pod -> (readings by uuid, hung, error).

    kubectl reports a non-zero exit of nvidia-smi as "command terminated
    with exit code N": that, or no answer within GPU_HANG_TIMEOUT, is a
    hang. Any other kubectl failure (API error, pod gone) raises, and the
    caller reports a missing reading.
    """
    try:
        out = kubectl(
            "exec", "-n", DCGM_NS, pod, "-c", PLUGIN_CONTAINER, "--",
            "nvidia-smi", f"--query-gpu={SMI_FIELDS}", "--format=csv,noheader",
            timeout=GPU_HANG_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return {}, True, f"nvidia-smi exec did not return in {GPU_HANG_TIMEOUT} s"
    except RuntimeError as e:
        if "command terminated with exit code" in str(e):
            return {}, True, str(e)
        raise
    return parse_smi_gpus(out), False, None


# Each probe prints "<target> <wget exit code> <ms> <wget stderr>". busybox
# date has no %N, so the clock is /proc/uptime in centiseconds.
PROBE_SCRIPT = """
cs() { read u _ < /proc/uptime; echo "${u%%.*}${u#*.}"; }
for t in %s; do
  ( s=$(cs); e=$(timeout %d wget -q -T %d --spider "${t#*=}" 2>&1); r=$?
    echo "${t%%%%=*} $r $(( ($(cs) - s) * 10 )) $(echo "$e" | tr '\\n' ' ')" ) &
done
wait
"""


def wget_error_kind(code, stderr):
    """busybox wget exit code + stderr -> None (reached) or an error kind."""
    if code == 0 or "server returned error" in stderr:
        return None  # any HTTP answer, a registry's 401 included
    if code == 127 or "not found" in stderr:
        raise RuntimeError(f"probe tool missing: {stderr.strip()}")
    if code == 143 or "timed out" in stderr:
        return "timeout"
    if "bad address" in stderr:
        return "dns"
    if "TLS" in stderr or "ssl" in stderr.lower():
        return "tls"
    if "can't connect" in stderr or "Connection" in stderr:
        return "connect"
    return "other"


def parse_probe_output(text):
    """PROBE_SCRIPT output -> [{target, ok, error, latency_ms}].

    Raises when a target's line is missing: that's no reading, not a failure.
    """
    by_target = {}
    for line in text.splitlines():
        parts = line.split(" ", 3)
        if len(parts) < 3 or not (parts[1].isdigit() and parts[2].isdigit()):
            continue
        kind = wget_error_kind(int(parts[1]), parts[3] if len(parts) > 3 else "")
        by_target[parts[0]] = {
            "target": parts[0], "ok": kind is None, "error": kind,
            "latency_ms": int(parts[2]) if kind is None else None,
        }
    missing = [t for t, _ in NETWORK_PROBES if t not in by_target]
    if missing:
        raise RuntimeError(f"no probe result for {', '.join(missing)}")
    return [by_target[t] for t, _ in NETWORK_PROBES]


def read_network_probes(pod):
    targets = " ".join(shlex.quote(f"{t}={url}") for t, url in NETWORK_PROBES)
    script = PROBE_SCRIPT % (targets, NETWORK_PROBE_TIMEOUT + 1,
                             NETWORK_PROBE_TIMEOUT)
    return parse_probe_output(kubectl(
        "exec", "-n", DCGM_NS, pod, "-c", PLUGIN_CONTAINER, "--",
        "sh", "-c", script, timeout=NETWORK_PROBE_TIMEOUT + 5,
    ))


# GPU fabric health: each GPU's NVLink fabric registration and health, plus
# the kernel's last refusal of a multicast request because the driver lost
# Fabric Manager. In the 2026-11-13 incident the refusals were the only
# sign: NVLS jobs failed for 5 h while every GPU reported a healthy fabric.
# A separate exec, so a driver without the fabric fields can't read as a
# GPU hang.
FABRIC_SCRIPT = """
read u _ < /proc/uptime; echo "uptime ${u%%.*}"
k=$(dmesg) && echo "dmesg ok"
printf '%s\n' "$k" | grep -F NV_ERR_FABRIC_MANAGER_NOT_PRESENT | tail -n 1
n=$(nvidia-smi nvlink -s) && echo "nvlink ok"
printf '%s\n' "$n"
nvidia-smi --query-gpu=index,fabric.state,fabric.status,fabric.health.summary,\
fabric.health.bandwidth,fabric.health.route_recovery_in_progress,\
fabric.health.route_unhealthy,fabric.health.access_timeout_recovery \\
  --format=csv,noheader
"""
# Refusals come only when a job asks for multicast; the longest gap between
# them in the 2026-11-13 incident was 54 min, so one keeps the host failing
# this long.
FABRIC_ERROR_WINDOW = 3600


def parse_fabric_output(text):
    """FABRIC_SCRIPT output -> (fabric_ok, fabric_error).

    A GPU whose fabric is registering or failed, reports unhealthy, or
    reports degraded bandwidth, route recovery, an unhealthy route or access
    timeout recovery (each critical in NVIDIA's health validation) fails the
    host, and so does any inactive NVLink (a sleeping one does not); N/A
    (no NVSwitch fabric, no status or no health detail) does not.
    Raises when the uptime, the dmesg or nvlink read, or every GPU row is
    missing: no reading.
    """
    uptime_s, refused_at_s, problems = None, None, {}
    kernel_read = links_read = False
    links = {}  # GPU index -> [links, inactive links]
    gpu = None
    for line in text.splitlines():
        if line.startswith("uptime "):
            uptime_s = int(line.split()[1])
        elif line == "dmesg ok":
            kernel_read = True
        elif line == "nvlink ok":
            links_read = True
        elif line.startswith("GPU "):
            # nvlink -s: "GPU 0: NVIDIA B200 (UUID: ...)", then its links
            gpu = int(line.split()[1].rstrip(":"))
            links[gpu] = [0, 0]
        elif line.strip().startswith("Link ") and gpu is not None:
            # "Link 3: 50 GB/s", "<inactive>", or "Sleep" (put to sleep by
            # the NVLink width control on purpose, so not a fault)
            links[gpu][0] += 1
            links[gpu][1] += "inactive" in line.lower()
        elif "NV_ERR_FABRIC_MANAGER_NOT_PRESENT" in line:
            # dmesg time: "[726703.163732] NVRM: ..."
            refused_at_s = float(line[1:line.index("]")])
        else:
            cols = [col.strip() for col in line.split(",")]
            if len(cols) != 8 or not cols[0].isdigit():
                continue
            index, state, status, health, bandwidth, *flags = cols
            recovery, unhealthy, timeout = (flag == "True" for flag in flags)
            if state not in ("Completed", "N/A"):
                problem = f"fabric state {state}"
            elif state == "Completed" and status not in ("Success", "N/A"):
                problem = f"fabric status {status}"
            elif health not in ("Healthy", "N/A"):
                problem = f"fabric health {health}"
            elif bandwidth not in ("Full", "N/A"):
                problem = f"fabric bandwidth {bandwidth}"
            elif recovery:
                problem = "fabric route recovery in progress"
            elif unhealthy:
                problem = "fabric route unhealthy"
            elif timeout:
                problem = "fabric access timeout recovery"
            else:
                problem = ""
            problems.setdefault(problem, []).append(int(index))
    if uptime_s is None or not kernel_read or not links_read or not problems:
        raise RuntimeError("no fabric reading")
    errors = []
    if refused_at_s is not None and uptime_s - refused_at_s <= FABRIC_ERROR_WINDOW:
        minutes = round((uptime_s - refused_at_s) / 60)
        errors.append("the driver logged NV_ERR_FABRIC_MANAGER_NOT_PRESENT "
                      f"{minutes} min ago")
    for index, (total, inactive) in links.items():
        if inactive:
            errors.append(f"GPU {index} {inactive} of {total} NVLinks inactive")
    for problem, gpus in problems.items():
        if not problem:
            continue
        contiguous = gpus == list(range(gpus[0], gpus[-1] + 1))
        names = (f"{gpus[0]}-{gpus[-1]}" if contiguous and len(gpus) > 2
                 else ",".join(str(gpu) for gpu in gpus))
        errors.append(f"GPU {names} {problem}")
    return not errors, "; ".join(errors) or None


def read_fabric(pod):
    return parse_fabric_output(kubectl(
        "exec", "-n", DCGM_NS, pod, "-c", PLUGIN_CONTAINER, "--",
        "sh", "-c", FABRIC_SCRIPT,
    ))


def start_pod_reads(pod, cursor=None):
    """Start one node's execs and its journal read; process_node waits on
    the futures."""
    return {"smi": POD_READS.submit(read_smi, pod),
            "network": POD_READS.submit(read_network_probes, pod),
            "fabric": POD_READS.submit(read_fabric, pod),
            "journal": POD_READS.submit(read_journal, pod, cursor)}


# Xids come from the host's kernel journal, not the device plugin's log: in
# a 171-Xid burst on 2026-10-27 the plugin's log carried 53 lines and lost
# every Xid 74 (NVLink fatal) and 154 (recovery action changed).
def parse_journal_xids(journal_json):
    """`journalctl -o json` output -> (xids, cursor of the last entry read).

    Every NVRM Xid line becomes {bus_id, xid, at, message}, at most
    MAX_XIDS_PER_REPORT; past the cap it stops at the last Xid sent, so the
    rest go out next run. The cursor is None when no entry was read.
    """
    xids, cursor = [], None
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
            at = datetime.fromtimestamp(
                int(entry["__REALTIME_TIMESTAMP"]) / 1e6, tz=timezone.utc)
            xids.append({
                "bus_id": match.group(1),
                "xid": int(match.group(2)),
                "at": at.isoformat(timespec="microseconds"),
                "message": (match.group(3) or "")[:MAX_XID_MESSAGE],
            })
        cursor = entry.get("__CURSOR", cursor)
    return xids, cursor


def read_journal(pod, cursor):
    """The host's kernel journal after `cursor`; without one, only its last
    entry, so the first run places the cursor and never replays history.

    _TRANSPORT=kernel rather than -k: -k implies -b, which would skip Xids
    logged between the last read and a reboot.
    """
    window = (("-n", "1") if cursor is None
              else (f"--after-cursor={cursor}", "-n", f"+{JOURNAL_READ_LIMIT}"))
    return kubectl(
        "exec", "-n", DCGM_NS, pod, "-c", PLUGIN_CONTAINER, "--",
        "chroot", "/host", "journalctl", "_TRANSPORT=kernel", "--no-pager",
        "-o", "json", "--output-fields=MESSAGE,__REALTIME_TIMESTAMP", *window,
        timeout=DRIVER_READ_TIMEOUT,
    )


def parse_labels(label_str):
    labels = {}
    for part in label_str.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            labels[k.strip()] = v.strip().strip('"')
    return labels


def scrape_dcgm(pod_ip):
    url = f"http://{pod_ip}:{DCGM_PORT}/metrics"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=KUBECTL_TIMEOUT) as resp:
            return resp.read().decode()
    except Exception as e:
        print(f"  Failed to scrape {pod_ip}: {e}", file=sys.stderr)
        return ""


def parse_metrics(text):
    gpus = {}
    for line in text.split("\n"):
        m = METRIC_RE.match(line)
        if not m:
            continue
        metric_name, label_str, value_str = m.group(1), m.group(2), m.group(3)
        labels = parse_labels(label_str)
        gpu_idx = int(labels.get("gpu", "0"))
        hostname = labels.get("Hostname", "unknown")
        model = labels.get("modelName", "")

        key = (hostname, gpu_idx)
        if key not in gpus:
            gpus[key] = {
                "index": gpu_idx,
                "uuid": labels.get("UUID"),
                "name": model,
                "fb_used": 0,
                "fb_free": 0,
                "fb_reserved": 0,
                "gpu_util": None,
                "gpu_temp": None,
                "power_usage": None,
            }

        val = float(value_str)
        field = {
            "DCGM_FI_DEV_FB_USED": "fb_used",
            "DCGM_FI_DEV_FB_FREE": "fb_free",
            "DCGM_FI_DEV_FB_RESERVED": "fb_reserved",
            "DCGM_FI_DEV_GPU_UTIL": "gpu_util",
            "DCGM_FI_DEV_GPU_TEMP": "gpu_temp",
            "DCGM_FI_DEV_POWER_USAGE": "power_usage",
        }[metric_name]
        current = gpus[key][field]
        gpus[key][field] = val if current is None else max(current, val)

    by_host = {}
    for (hostname, _), gpu in gpus.items():
        # FB_USED + FB_FREE understates capacity (e.g. by ~480 MiB on H100);
        # FB_RESERVED closes the gap to what nvidia-smi reports as total.
        total = gpu["fb_used"] + gpu["fb_free"] + gpu["fb_reserved"]
        entry = {
            "index": gpu["index"],
            # Joins the nvidia-smi readings; process_node pops it before POST.
            "uuid": gpu["uuid"],
            "name": gpu["name"] or None,
            # No GPU_UTIL series (MIG GPUs) stays null; 0 would read as idle.
            "gpu_util": gpu["gpu_util"],
            "mem_used_mb": gpu["fb_used"],
            "mem_total_mb": total,
            "temperature_c": gpu["gpu_temp"],
            "power_draw_w": gpu["power_usage"],
        }
        by_host.setdefault(hostname, []).append(entry)

    return by_host


def fetch_stats_summary(node_name):
    raw = kubectl("get", "--raw",
                  f"/api/v1/nodes/{node_name}/proxy/stats/summary")
    return json.loads(raw)


def parse_stats_summary(summary, cpu_cores, mem_total_bytes):
    """Node-level CPU/RAM from kubelet stats/summary.

    CPU % = usageNanoCores / (capacity cores * 1e9) * 100. RAM used is
    total - available, matching the bare-metal reporter's semantics. The
    node rootfs capacity is returned only to identify the root device in
    cAdvisor output — NOT for disk reporting.
    """
    node = summary["node"]
    cpu = node.get("cpu") or {}
    mem = node.get("memory") or {}

    nano = cpu.get("usageNanoCores")
    cpu_util = None
    if nano is not None and cpu_cores:
        cpu_util = round(nano / (cpu_cores * 1e9) * 100, 2)

    available = mem.get("availableBytes")
    used = mem_total_bytes - available if available is not None else None
    rootfs_capacity = (node.get("fs") or {}).get("capacityBytes")

    return {
        "cpu_util": cpu_util,
        "ram_used_bytes": used,
        "ram_total_bytes": mem_total_bytes,
        "ram_available_bytes": available,
        "rootfs_capacity_bytes": rootfs_capacity,
    }


def parse_cadvisor_fs(text):
    """Parse cAdvisor Prometheus text -> {device: {used_bytes, total_bytes}}.

    Only root-cgroup rows (id="/") carry node-level filesystems. Rows are
    keyed by the device label; tmpfs rows use their mount path as the
    device value (e.g. /dev/shm, /run).
    """
    fs = {}
    for line in text.splitlines():
        m = CADVISOR_FS_RE.match(line)
        if not m:
            continue
        labels = parse_labels(m.group(2))
        if labels.get("id") != "/":
            continue
        device = labels.get("device")
        if not device:
            continue
        entry = fs.setdefault(device, {"used_bytes": None, "total_bytes": None})
        val = int(float(m.group(3)))
        if m.group(1) == "usage":
            entry["used_bytes"] = val
        else:
            entry["total_bytes"] = val
    return fs


def role_map_for(node_name):
    for prefix, role_map in DEVICE_ROLE_MAPS.items():
        if node_name.startswith(prefix):
            return role_map
    return {}


def find_root_device(fs_map, rootfs_capacity):
    """Match a cAdvisor device to the kubelet's node rootfs capacity."""
    if rootfs_capacity is None:
        return None
    for device, entry in fs_map.items():
        total = entry["total_bytes"]
        if total is not None and abs(total - rootfs_capacity) < 1 << 20:
            return device
    return None


def classify_device(node_name, device, root_device):
    role_map = role_map_for(node_name)
    if device in role_map:
        return role_map[device]
    if root_device is not None and device == root_device:
        return "system"
    return "other"


def build_disk_entries(node_name, fs_map, rootfs_capacity):
    root_device = find_root_device(fs_map, rootfs_capacity)
    disks = []
    for device in sorted(fs_map):
        entry = fs_map[device]
        # Skip loop devices (snap/squashfs images, e.g. 30 of them on the
        # dgx hosts that also run a host-level buildkite-agent): read-only
        # mounts that can never fill, pure noise in the drill-down. Also
        # skip zero-capacity devices (e.g. unbacked /dev/loopN): nothing can
        # fill them, and the ingestion contract requires total_bytes >= 1.
        if device.startswith("/dev/loop"):
            continue
        # Container/pod plumbing: overlays duplicate the root filesystem
        # (the underlying device is reported on its own row), per-pod tmpfs
        # paths can never fill. A busy node accumulates dozens of these.
        if is_container_plumbing(device):
            continue
        if not entry["total_bytes"]:
            continue
        disks.append({
            # cAdvisor labels by device, so the true mount point is unknown
            # and mount_point stays null (the server accepts a disk with
            # mount_point or device). For tmpfs rows the device value IS the
            # mount path (e.g. /dev/shm), so the path is still available in
            # the device field.
            "mount_point": None,
            "device": device,
            "fstype": "unknown",
            "role": classify_device(node_name, device, root_device),
            "used_bytes": entry["used_bytes"],
            "total_bytes": entry["total_bytes"],
            "error": None,
        })
    return disks


def resolve_state_path():
    try:
        os.makedirs(os.path.dirname(DISK_STATE_FILE), exist_ok=True)
        with open(DISK_STATE_FILE, "a"):
            pass
        return DISK_STATE_FILE
    except OSError as e:
        print(f"State file {DISK_STATE_FILE} not writable ({e}), "
              f"falling back to {DISK_STATE_FALLBACK}", file=sys.stderr)
        return DISK_STATE_FALLBACK


def load_disk_state(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_disk_state(path, state):
    try:
        with open(path, "w") as f:
            json.dump(state, f)
    except OSError as e:
        print(f"Failed to save disk state to {path}: {e}", file=sys.stderr)


def get_node_disks(node_name, rootfs_capacity, state, now):
    """Disk entries for a node, scraped at most every DISK_SCRAPE_INTERVAL.

    Between scrapes the cached entries from the state file are reused.
    Returns (disks, scraped_now).
    """
    cached = state.get(node_name)
    if cached and now - cached.get("scraped_at", 0) < DISK_SCRAPE_INTERVAL:
        return cached["disks"], False

    raw = kubectl("get", "--raw",
                  f"/api/v1/nodes/{node_name}/proxy/metrics/cadvisor",
                  timeout=20)
    disks = build_disk_entries(node_name, parse_cadvisor_fs(raw),
                               rootfs_capacity)
    state[node_name] = {"scraped_at": now, "disks": disks}
    return disks, True


def gpu_resource_count(node, section):
    """`nvidia.com/gpu` from node status.<section>, or None when absent."""
    v = node["status"].get(section, {}).get(GPU_RESOURCE)
    return int(v) if v is not None else None


def driver_fields(node):
    """Node-level driver signals; process_node fills in xids."""
    return {
        "xids": None,
        "allocatable_gpus": gpu_resource_count(node, "allocatable"),
        "capacity_gpus": gpu_resource_count(node, "capacity"),
        # H200-only fields; always missing on k8s.
        "mig_slices": None,
        "root_owned_slots": None,
        # Filled in by process_node; null = not checked.
        "gpu_query_hung": None,
        "gpu_query_error": None,
        "network_probes": None,
        "fabric_ok": None,
        "fabric_error": None,
    }


def process_node(node, pod_ip, disk_state, now, plugin_pod=None, reads=None):
    """Build the full report payload for one node. Never raises.

    reads are the node's execs from start_pod_reads, started early by main;
    they're started here when not given.
    """
    name = node["metadata"]["name"]
    payload = {
        "hostname": name,
        "gpus": [],
        "host": None,
        "node_conditions": node_conditions(node),
        "reporter_status": "ok",
        "last_error": None,
        **driver_fields(node),
    }
    errors = []

    if pod_ip is None:
        errors.append("no DCGM exporter pod on this node")
        print(f"ERROR: node {name} has no DCGM exporter pod", file=sys.stderr)
    else:
        text = scrape_dcgm(pod_ip)
        if not text:
            errors.append(f"DCGM scrape of pod {pod_ip} failed")
        else:
            by_host = parse_metrics(text)
            gpus = by_host.get(name)
            if gpus is None:
                errors.append(
                    f"DCGM Hostname labels {sorted(by_host)} do not match "
                    f"node name {name}"
                )
                print(f"ERROR: node {name}: {errors[-1]}", file=sys.stderr)
                gpus = next(iter(by_host.values()), [])
            gpus.sort(key=lambda g: g["index"])
            payload["gpus"] = gpus

    # Driver signals. Each read fails independently to null (a missing
    # reading, not an error: it never degrades the report).
    smi = {}
    if plugin_pod is None:
        print(f"  WARNING: node {name} has no device-plugin pod; driver "
              f"readings missing", file=sys.stderr)
    else:
        cursors = disk_state.setdefault(XID_STATE_KEY, {})
        cursor = cursors.get(name)
        reads = reads or start_pod_reads(plugin_pod, cursor)
        try:
            smi, payload["gpu_query_hung"], payload["gpu_query_error"] = \
                reads["smi"].result()
        except Exception as e:
            print(f"  WARNING: nvidia-smi exec on {name} failed: {e}",
                  file=sys.stderr)
        try:
            payload["network_probes"] = reads["network"].result()
        except Exception as e:
            print(f"  WARNING: network probe exec on {name} failed: {e}",
                  file=sys.stderr)
        try:
            payload["fabric_ok"], payload["fabric_error"] = \
                reads["fabric"].result()
        except Exception as e:
            print(f"  WARNING: fabric exec on {name} failed: {e}",
                  file=sys.stderr)
        try:
            xids, read_to = parse_journal_xids(reads["journal"].result())
            # The first read only places the cursor at the journal's end.
            payload["xids"] = xids if cursor is not None else []
            cursors[name] = read_to or cursor
        except Exception as e:
            print(f"  WARNING: kernel journal read on {name} failed: {e}",
                  file=sys.stderr)
    for gpu in payload["gpus"]:
        reading = smi.get(gpu.pop("uuid"), {})
        gpu["recovery_action"] = reading.get("recovery_action")
        gpu["remapped_rows_failure"] = reading.get("remapped_rows_failure")
        gpu["ecc_uncorrected"] = reading.get("ecc_uncorrected")

    try:
        capacity = node["status"].get("capacity", {})
        cpu_cores = parse_cpu_cores(capacity.get("cpu", "0"))
        mem_total = parse_mem_bytes(capacity.get("memory", "0"))
        stats = parse_stats_summary(fetch_stats_summary(name),
                                    cpu_cores, mem_total)
        try:
            disks, scraped = get_node_disks(
                name, stats["rootfs_capacity_bytes"], disk_state, now)
            if scraped:
                print(f"  disk: re-scraped cAdvisor ({len(disks)} devices)")
        except Exception as e:
            cached = disk_state.get(name)
            if cached:
                print(f"  WARNING: cAdvisor scrape failed ({e}), "
                      f"reusing cached disk entries", file=sys.stderr)
                disks = cached["disks"]
            else:
                raise
        payload["host"] = {
            "cpu_util": stats["cpu_util"],
            "cpu_count": int(cpu_cores),
            "ram_used_bytes": stats["ram_used_bytes"],
            "ram_total_bytes": stats["ram_total_bytes"],
            "ram_available_bytes": stats["ram_available_bytes"],
            "disks": disks,
        }
    except Exception as e:
        errors.append(f"host metrics failed: {e}")
        print(f"ERROR: node {name}: {errors[-1]}", file=sys.stderr)

    if errors:
        # Ingestion contract: only "ok"/"degraded" are accepted, and
        # last_error must be non-null when degraded.
        payload["reporter_status"] = "degraded"
        payload["last_error"] = "; ".join(errors)
    return payload


def report(payload):
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if REPORT_SECRET:
        headers["Authorization"] = f"Bearer {REPORT_SECRET}"

    req = urllib.request.Request(REPORT_URL, data=body, headers=headers,
                                 method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
        print(f"  OK: {result.get('gpus', 0)} GPUs reported for "
              f"{payload['hostname']} (status={payload['reporter_status']})")


def main():
    if not REPORT_URL:
        print("GPU_REPORT_URL not set", file=sys.stderr)
        sys.exit(1)

    nodes = get_nodes()
    gpu_nodes = [n for n in nodes if node_gpu_count(n) > 0]
    gpu_node_names = {n["metadata"]["name"] for n in gpu_nodes}
    print(f"Found {len(gpu_nodes)} GPU nodes "
          f"(of {len(nodes)} total) to report")

    try:
        pods_by_node = get_pod_ips()
    except Exception as e:
        print(f"ERROR: failed to list DCGM exporter pods: {e}",
              file=sys.stderr)
        pods_by_node = {}
    for node_name in pods_by_node:
        if node_name not in gpu_node_names:
            print(f"ERROR: DCGM exporter pod on {node_name}, which is not a "
                  f"GPU node (stale DaemonSet?)", file=sys.stderr)

    try:
        plugin_pods = get_plugin_pods()
    except Exception as e:
        print(f"ERROR: failed to list device-plugin pods: {e}",
              file=sys.stderr)
        plugin_pods = {}

    state_path = resolve_state_path()
    disk_state = load_disk_state(state_path)
    now = time.time()

    # Every node's execs and log read start now, on POD_READS' bounded
    # workers, so slow nodes overlap instead of adding up in the loop.
    cursors = disk_state.get(XID_STATE_KEY, {})
    reads = {name: start_pod_reads(pod, cursors.get(name))
             for name, pod in plugin_pods.items() if name in gpu_node_names}

    reported = 0
    for node in gpu_nodes:
        name = node["metadata"]["name"]
        print(f"Processing {name}...")
        prev_cursor = disk_state.get(XID_STATE_KEY, {}).get(name)
        try:
            payload = process_node(node, pods_by_node.get(name),
                                   disk_state, now, plugin_pods.get(name),
                                   reads.get(name))
        except Exception as e:
            print(f"ERROR: node {name}: unhandled failure: {e}",
                  file=sys.stderr)
            payload = {
                "hostname": name,
                "gpus": [],
                "host": None,
                "node_conditions": node_conditions(node),
                "reporter_status": "degraded",
                "last_error": f"unhandled failure: {e}",
                **driver_fields(node),
            }
        try:
            report(payload)
            reported += 1
        except Exception as e:
            print(f"ERROR: POST for {name} failed: {e}", file=sys.stderr)
            # Don't advance the journal cursor past Xids the server never got.
            cursors = disk_state.setdefault(XID_STATE_KEY, {})
            if prev_cursor is None:
                cursors.pop(name, None)
            else:
                cursors[name] = prev_cursor

    save_disk_state(state_path, disk_state)
    print(f"Done: {reported}/{len(gpu_nodes)} nodes reported")
    if reported < len(gpu_nodes):
        sys.exit(1)


if __name__ == "__main__":
    main()
