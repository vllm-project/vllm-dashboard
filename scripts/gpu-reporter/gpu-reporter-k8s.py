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
  GPU_REPORT_DISK_INTERVAL - Seconds between cAdvisor disk scrapes (default: 300)
  GPU_REPORT_DISK_STATE    - Disk-scrape state file
                             (default: /var/lib/gpu-reporter/k8s-disk-state.json,
                              falls back to /tmp when not writable)
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request

REPORT_URL = os.environ.get("GPU_REPORT_URL", "")
REPORT_SECRET = os.environ.get("GPU_REPORT_SECRET", "")
DCGM_NS = os.environ.get("DCGM_EXPORTER_NS", "gpu-operator")
DCGM_LABEL = os.environ.get("DCGM_EXPORTER_LABEL", "app=nvidia-dcgm-exporter")
DCGM_PORT = os.environ.get("DCGM_EXPORTER_PORT", "9400")

KUBECTL_TIMEOUT = 10  # per-call seconds; one slow node must not kill the run
GPU_RESOURCE = "nvidia.com/gpu"

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
    # live here), /dev/md127 = 28 TB /raid.
    "dgxb200-": {
        "/dev/md0": "system",
        "/dev/md127": "data",
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


def get_pod_ips():
    """DCGM exporter pods as {node name: pod IP}."""
    out = kubectl(
        "get", "pods", "-n", DCGM_NS, "-l", DCGM_LABEL, "-o",
        "jsonpath={range .items[*]}{.status.podIP} {.spec.nodeName}{'\\n'}{end}",
        timeout=15,
    )
    pods = {}
    for line in out.strip().split("\n"):
        parts = line.strip().split()
        if len(parts) == 2:
            pods[parts[1]] = parts[0]
    return pods


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
            "name": gpu["name"] or None,
            "gpu_util": gpu["gpu_util"] or 0,
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


def process_node(node, pod_ip, disk_state, now):
    """Build the full report payload for one node. Never raises."""
    name = node["metadata"]["name"]
    payload = {
        "hostname": name,
        "gpus": [],
        "host": None,
        "node_conditions": node_conditions(node),
        "reporter_status": "ok",
        "last_error": None,
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

    state_path = resolve_state_path()
    disk_state = load_disk_state(state_path)
    now = time.time()

    reported = 0
    for node in gpu_nodes:
        name = node["metadata"]["name"]
        print(f"Processing {name}...")
        try:
            payload = process_node(node, pods_by_node.get(name),
                                   disk_state, now)
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
            }
        try:
            report(payload)
            reported += 1
        except Exception as e:
            print(f"ERROR: POST for {name} failed: {e}", file=sys.stderr)

    save_disk_state(state_path, disk_state)
    print(f"Done: {reported}/{len(gpu_nodes)} nodes reported")
    if reported < len(gpu_nodes):
        sys.exit(1)


if __name__ == "__main__":
    main()
