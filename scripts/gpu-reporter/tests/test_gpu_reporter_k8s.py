"""Tests for the K8s control-plane scraper (gpu-reporter-k8s.py).

Covers the DCGM/cAdvisor/stats-summary parsers, the per-pool device role
maps, the disk-scrape cadence state, and the ingestion-contract payload
shapes on the node error paths.
"""

import time
from datetime import datetime, timezone

HOST_KEYS = {
    "cpu_util", "cpu_count", "ram_used_bytes",
    "ram_total_bytes", "ram_available_bytes", "disks",
}
DISK_KEYS = {
    "mount_point", "device", "fstype", "role",
    "used_bytes", "total_bytes", "error",
}
PAYLOAD_KEYS = {
    "hostname", "gpus", "host", "reporter_status", "last_error",
    "node_conditions", "xids", "allocatable_gpus", "capacity_gpus",
    "mig_slices", "root_owned_slots",
    "gpu_query_hung", "gpu_query_error", "network_probes",
}

CADVISOR_FIXTURE = "\n".join([
    '# HELP container_fs_limit_bytes Number of bytes that can be consumed.',
    'container_fs_limit_bytes{container="",device="/dev/shm",id="/",image="",name="",namespace="",pod=""} 8.93045059584e+11 1788387174142',
    'container_fs_limit_bytes{container="",device="/dev/vda1",id="/",image="",name="",namespace="",pod=""} 2.43379802112e+11 1788387174142',
    'container_fs_limit_bytes{container="",device="/dev/vdc",id="/",image="",name="",namespace="",pod=""} 1.331482083328e+13 1788387174142',
    'container_fs_limit_bytes{container="",device="/run",id="/",image="",name="",namespace="",pod=""} 1.78609012736e+11 1788387174142',
    # non-root cgroup rows must be ignored
    'container_fs_limit_bytes{container="abc",device="/dev/vda1",id="/kubepods.slice/x",image="",name="",namespace="",pod=""} 999 1788387174142',
    'container_fs_usage_bytes{container="",device="/dev/shm",id="/",image="",name="",namespace="",pod=""} 32768 1788387174142',
    'container_fs_usage_bytes{container="",device="/dev/vda1",id="/",image="",name="",namespace="",pod=""} 1.63235065856e+11 1788387174142',
    'container_fs_usage_bytes{container="",device="/dev/vdc",id="/",image="",name="",namespace="",pod=""} 28672 1788387174142',
    'container_fs_usage_bytes{container="",device="/run",id="/",image="",name="",namespace="",pod=""} 1.7690624e+07 1788387174142',
    'container_fs_usage_bytes{container="abc",device="/dev/vda1",id="/kubepods.slice/x",image="",name="",namespace="",pod=""} 123 1788387174142',
    'container_cpu_usage_seconds_total{container="",id="/"} 42 1788387174142',
])

DCGM_FIXTURE = (
    'DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-aaaa",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 55\n'
    'DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-aaaa",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 1000\n'
    'DCGM_FI_DEV_FB_FREE{gpu="0",UUID="GPU-aaaa",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 80000\n'
    'DCGM_FI_DEV_FB_RESERVED{gpu="0",UUID="GPU-aaaa",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 480\n'
    'DCGM_FI_DEV_GPU_TEMP{gpu="0",UUID="GPU-aaaa",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 42\n'
    'DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-aaaa",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 305.5\n'
)

STATS_SUMMARY_FIXTURE = {"node": {
    "cpu": {"usageNanoCores": 111938299,
            "usageCoreNanoSeconds": 41787826675499000},
    "memory": {"availableBytes": 1781885419520,
               "workingSetBytes": 4204699648,
               "usageBytes": 211782303744},
    "fs": {"capacityBytes": 243379802112, "usedBytes": 163235065856},
}}


def make_node(name, gpu="8", unschedulable=False, conditions=None):
    return {
        "metadata": {"name": name},
        "spec": {"unschedulable": unschedulable} if unschedulable else {},
        "status": {
            "capacity": {"cpu": "160", "memory": "1744228632Ki",
                         "nvidia.com/gpu": gpu},
            "conditions": conditions if conditions is not None else [
                {"type": "Ready", "status": "True"},
                {"type": "DiskPressure", "status": "False"},
                {"type": "MemoryPressure", "status": "False"},
                {"type": "PIDPressure", "status": "False"},
            ],
        },
    }


def test_parse_quantities(reporter_k8s):
    assert reporter_k8s.parse_cpu_cores("160") == 160.0
    assert reporter_k8s.parse_cpu_cores("500m") == 0.5
    assert reporter_k8s.parse_mem_bytes("1744228632Ki") == 1744228632 * 1024
    assert reporter_k8s.parse_mem_bytes("2Gi") == 2 * 1024**3
    assert reporter_k8s.parse_mem_bytes("1024") == 1024


def test_node_gpu_count_and_conditions(reporter_k8s):
    cordoned = make_node("dgxb200-15", unschedulable=True, conditions=[
        {"type": "Ready", "status": "True"},
        {"type": "DiskPressure", "status": "False"},
        {"type": "MemoryPressure", "status": "True"},
        {"type": "PIDPressure", "status": "False"},
    ])
    assert reporter_k8s.node_gpu_count(cordoned) == 8
    assert reporter_k8s.node_conditions(cordoned) == {
        "ready": True, "disk_pressure": False, "memory_pressure": True,
        "pid_pressure": False, "unschedulable": True,
    }
    # control-plane node: no GPU capacity -> not in the reporting set
    assert reporter_k8s.node_gpu_count(make_node("cp", gpu="0")) == 0


def test_parse_dcgm_metrics_shape(reporter_k8s):
    by_host = reporter_k8s.parse_metrics(DCGM_FIXTURE)
    gpu = by_host["inf-4x8h100-1"][0]
    assert gpu == {
        "index": 0,
        "uuid": "GPU-aaaa",
        "name": "NVIDIA H100 80GB HBM3",
        "gpu_util": 55.0,
        "mem_used_mb": 1000.0,
        # FB_USED + FB_FREE + FB_RESERVED closes the gap to nvidia-smi total
        "mem_total_mb": 81480.0,
        "temperature_c": 42.0,
        "power_draw_w": 305.5,
    }


def test_parse_stats_summary(reporter_k8s):
    mem_total = reporter_k8s.parse_mem_bytes("1744228632Ki")
    stats = reporter_k8s.parse_stats_summary(STATS_SUMMARY_FIXTURE, 160.0,
                                             mem_total)
    assert stats["cpu_util"] == round(111938299 / (160 * 1e9) * 100, 2)
    assert stats["ram_total_bytes"] == mem_total
    assert stats["ram_available_bytes"] == 1781885419520
    assert stats["ram_used_bytes"] == mem_total - 1781885419520
    assert stats["rootfs_capacity_bytes"] == 243379802112


def test_parse_cadvisor_fs_root_cgroup_only(reporter_k8s):
    fs = reporter_k8s.parse_cadvisor_fs(CADVISOR_FIXTURE)
    assert set(fs) == {"/dev/shm", "/dev/vda1", "/dev/vdc", "/run"}
    assert fs["/dev/vda1"]["total_bytes"] == 243379802112
    assert fs["/dev/vda1"]["used_bytes"] == 163235065856
    assert fs["/dev/shm"]["used_bytes"] == 32768
    assert fs["/dev/vdc"]["total_bytes"] == 13314820833280


def test_h100_device_roles_and_disk_entry_shape(reporter_k8s):
    fs = reporter_k8s.parse_cadvisor_fs(CADVISOR_FIXTURE)
    disks = reporter_k8s.build_disk_entries("inf-4x8h100-1", fs, 243379802112)
    roles = {d["device"]: d["role"] for d in disks}
    assert roles == {"/dev/shm": "workspace", "/dev/vda1": "system",
                     "/dev/vdc": "data", "/run": "other"}
    for d in disks:
        assert set(d) == DISK_KEYS
        # cAdvisor has no mount point or fstype; device is the identity
        assert d["mount_point"] is None
        assert d["fstype"] == "unknown"
        assert d["error"] is None


def test_dgx_device_roles(reporter_k8s):
    fs_map = {
        "/dev/md0": {"used_bytes": 1, "total_bytes": 1800000000000},
        "/dev/md127": {"used_bytes": 2, "total_bytes": 28000000000000},
        "/dev/shm": {"used_bytes": 4, "total_bytes": 1082086498304},
        "/dev/sdz9": {"used_bytes": 3, "total_bytes": 500000000},
    }
    disks = reporter_k8s.build_disk_entries("dgxb200-15", fs_map, 1800000000000)
    roles = {d["device"]: d["role"] for d in disks}
    assert roles == {"/dev/md0": "system", "/dev/md127": "data",
                     "/dev/shm": "workspace", "/dev/sdz9": "other"}


def test_unknown_pool_root_falls_back_to_system(reporter_k8s):
    fs_map = {
        "/dev/md0": {"used_bytes": 1, "total_bytes": 1800000000000},
        "/dev/md127": {"used_bytes": 2, "total_bytes": 28000000000000},
    }
    # rootfs capacity matches /dev/md127 here -> it is system, rest is other
    disks = reporter_k8s.build_disk_entries("mystery-1", fs_map, 28000000000000)
    roles = {d["device"]: d["role"] for d in disks}
    assert roles == {"/dev/md127": "system", "/dev/md0": "other"}


def test_zero_capacity_devices_are_skipped(reporter_k8s):
    # Live failure: inf-4x8h100-4's cAdvisor reports an unbacked /dev/loop0
    # with total_bytes 0, and the ingestion contract requires total >= 1 —
    # the whole node payload was rejected (HTTP 400) until these are dropped.
    fs_map = {
        "/dev/loop0": {"used_bytes": 0, "total_bytes": 0},
        "/dev/vda1": {"used_bytes": 1, "total_bytes": 243379802112},
    }
    disks = reporter_k8s.build_disk_entries("inf-4x8h100-4", fs_map, 243379802112)
    assert [d["device"] for d in disks] == ["/dev/vda1"]


def test_loop_devices_are_skipped(reporter_k8s):
    # dgxb200-12/-14 (host-level buildkite-agent, snap packages) report ~30
    # snap loop mounts via cAdvisor: read-only squashfs, can never fill,
    # pure drill-down noise.
    fs_map = {
        "/dev/loop0": {"used_bytes": 66846720, "total_bytes": 66846720},
        "/dev/loop17": {"used_bytes": 52428800, "total_bytes": 52428800},
        "/dev/md0": {"used_bytes": 1, "total_bytes": 1800000000000},
    }
    disks = reporter_k8s.build_disk_entries("dgxb200-12", fs_map, 1800000000000)
    assert [d["device"] for d in disks] == ["/dev/md0"]


def test_container_plumbing_devices_are_skipped(reporter_k8s):
    # Busy nodes report one overlay row per container (duplicating the root
    # fs usage of /dev/md0) and one tmpfs row per pod sandbox shm /
    # service-account volume — dgxb200-12 had ~20 of these, all empty or
    # duplicates. Real mounts (/dev/md0, /dev/shm, /run) stay the base.
    fs_map = {
        "/dev/md0": {"used_bytes": 1, "total_bytes": 1800000000000},
        "overlay_0-569": {"used_bytes": 1, "total_bytes": 1800000000000},
        "/dev/shm": {"used_bytes": 2, "total_bytes": 1082331758592},
        "/run": {"used_bytes": 3, "total_bytes": 216466350080},
        "/run/lock": {"used_bytes": 4, "total_bytes": 5242880},
        "/run/containerd/io.containerd.grpc.v1.cri/sandboxes/abc123/shm":
            {"used_bytes": 5, "total_bytes": 67108864},
        "/var/lib/kubelet/pods/0102f2e2/volumes/"
        "kubernetes.io~projected/kube-api-access-gjhj7":
            {"used_bytes": 6, "total_bytes": 2164663500800},
    }
    disks = reporter_k8s.build_disk_entries("dgxb200-12", fs_map, 1800000000000)
    assert [d["device"] for d in disks] == ["/dev/md0", "/dev/shm", "/run"]


def test_disk_scrape_cadence(reporter_k8s, monkeypatch):
    calls = []

    def fake_kubectl(*args, timeout=10):
        calls.append(args)
        return CADVISOR_FIXTURE

    monkeypatch.setattr(reporter_k8s, "kubectl", fake_kubectl)
    state = {}
    now = 1000.0
    d1, scraped1 = reporter_k8s.get_node_disks("inf-4x8h100-1", 243379802112,
                                               state, now)
    d2, scraped2 = reporter_k8s.get_node_disks("inf-4x8h100-1", 243379802112,
                                               state, now + 100)
    d3, scraped3 = reporter_k8s.get_node_disks("inf-4x8h100-1", 243379802112,
                                               state, now + 301)
    assert (scraped1, scraped2, scraped3) == (True, False, True)
    assert d1 == d2 == d3
    assert len(calls) == 2  # one scrape per 5-minute window


def test_disk_state_file_roundtrip(reporter_k8s, tmp_path):
    path = str(tmp_path / "k8s-disk-state.json")
    state = {"inf-4x8h100-1": {"scraped_at": 123.0, "disks": [
        {"mount_point": None, "device": "/dev/vda1", "fstype": "unknown",
         "role": "system", "used_bytes": 1, "total_bytes": 2, "error": None},
    ]}}
    reporter_k8s.save_disk_state(path, state)
    assert reporter_k8s.load_disk_state(path) == state
    # missing/corrupt state files degrade to an empty cache
    assert reporter_k8s.load_disk_state(str(tmp_path / "nope.json")) == {}
    (tmp_path / "bad.json").write_text("not json{")
    assert reporter_k8s.load_disk_state(str(tmp_path / "bad.json")) == {}


def _patch_host_metrics(reporter_k8s, monkeypatch):
    def fake_kubectl(*args, timeout=10):
        assert "metrics/cadvisor" in args[-1], args
        return CADVISOR_FIXTURE

    monkeypatch.setattr(reporter_k8s, "kubectl", fake_kubectl)
    monkeypatch.setattr(reporter_k8s, "fetch_stats_summary",
                        lambda name: STATS_SUMMARY_FIXTURE)


def test_process_node_without_exporter_pod_is_degraded(reporter_k8s,
                                                       monkeypatch):
    # A GPU node with no exporter pod must still be reported, degraded.
    _patch_host_metrics(reporter_k8s, monkeypatch)
    payload = reporter_k8s.process_node(make_node("inf-4x8h100-9"), None,
                                        {}, time.time())
    assert set(payload) == PAYLOAD_KEYS
    assert payload["reporter_status"] == "degraded"
    assert payload["last_error"]
    assert "no DCGM exporter pod" in payload["last_error"]
    assert payload["gpus"] == []
    assert set(payload["host"]) == HOST_KEYS
    assert payload["host"]["cpu_count"] == 160
    assert isinstance(payload["host"]["cpu_count"], int)
    assert all(d["mount_point"] is None for d in payload["host"]["disks"])
    assert payload["node_conditions"]["ready"] is True


def test_process_node_with_gpu_metrics_ok(reporter_k8s, monkeypatch):
    _patch_host_metrics(reporter_k8s, monkeypatch)
    monkeypatch.setattr(reporter_k8s, "scrape_dcgm",
                        lambda pod_ip: DCGM_FIXTURE)
    payload = reporter_k8s.process_node(make_node("inf-4x8h100-1"),
                                        "192.168.3.81", {}, time.time())
    assert set(payload) == PAYLOAD_KEYS
    assert payload["reporter_status"] == "ok"
    assert payload["last_error"] is None
    assert len(payload["gpus"]) == 1
    assert payload["gpus"][0]["gpu_util"] == 55.0


def test_process_node_hostname_mismatch_is_degraded(reporter_k8s, monkeypatch):
    _patch_host_metrics(reporter_k8s, monkeypatch)
    monkeypatch.setattr(reporter_k8s, "scrape_dcgm",
                        lambda pod_ip: DCGM_FIXTURE)
    payload = reporter_k8s.process_node(make_node("inf-4x8h100-2"),
                                        "192.168.3.81", {}, time.time())
    assert payload["reporter_status"] == "degraded"
    assert "do not match node name" in payload["last_error"]


def test_main_reports_nodes_first_and_warns_on_skew(reporter_k8s, monkeypatch,
                                                    capsys, tmp_path):
    # kubectl get nodes is the source of truth: a node with no exporter pod
    # is reported degraded, and a pod on a non-GPU node is a loud error.
    nodes = [make_node("inf-4x8h100-1"), make_node("inf-4x8h100-2")]
    reported = {}

    def fake_kubectl(*args, timeout=10):
        return CADVISOR_FIXTURE

    monkeypatch.setattr(reporter_k8s, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter_k8s, "get_nodes", lambda: nodes)
    # inf-4x8h100-2 has no pod; stale-1 is not a GPU node
    monkeypatch.setattr(reporter_k8s, "get_pod_ips",
                        lambda: {"inf-4x8h100-1": "192.168.3.81",
                                 "stale-1": "192.168.99.99"})
    monkeypatch.setattr(reporter_k8s, "kubectl", fake_kubectl)
    monkeypatch.setattr(reporter_k8s, "fetch_stats_summary",
                        lambda name: STATS_SUMMARY_FIXTURE)
    monkeypatch.setattr(reporter_k8s, "scrape_dcgm",
                        lambda pod_ip: DCGM_FIXTURE)
    monkeypatch.setattr(reporter_k8s, "DISK_STATE_FILE",
                        str(tmp_path / "state.json"))
    monkeypatch.setattr(reporter_k8s, "report",
                        lambda payload: reported.setdefault(
                            payload["hostname"], payload))

    reporter_k8s.main()

    assert set(reported) == {"inf-4x8h100-1", "inf-4x8h100-2"}
    assert reported["inf-4x8h100-1"]["reporter_status"] == "ok"
    degraded = reported["inf-4x8h100-2"]
    assert degraded["reporter_status"] == "degraded"
    assert degraded["last_error"]
    err = capsys.readouterr().err
    assert "no DCGM exporter pod" in err
    assert "stale-1" in err  # exporter pod on a non-GPU node is loud


# --- driver signals (exec nvidia-smi + device-plugin log) -------------------

# Device-plugin log lines in the real `kubectl logs --timestamps` format: an
# Xid 79 / 145 pair (with its UUID-bearing XidCriticalError
# lines), and H100 Skipping lines (no GPU identity).
PLUGIN_LOG_FIXTURE = "\n".join([
    "2026-01-05T04:25:00.405995263-07:00 I0105 11:25:00.402432       1 health.go:143] Processing event {Device:{Handle:0x725d24c3fc38} EventType:8 EventData:79 GpuInstanceId:4294967295 ComputeInstanceId:4294967295}",
    "2026-01-05T04:25:00.406803332-07:00 I0105 11:25:00.405750       1 health.go:169] XidCriticalError: Xid=79 on Device=GPU-11111111-2222-3333-4444-555555555555; marking device as unhealthy.",
    "2026-01-05T04:25:00.406810680-07:00 I0105 11:25:00.406688       1 health.go:143] Processing event {Device:{Handle:0x725d24b032b8} EventType:8 EventData:145 GpuInstanceId:4294967295 ComputeInstanceId:4294967295}",
    "2026-01-05T04:25:00.406812197-07:00 I0105 11:25:00.406705       1 health.go:169] XidCriticalError: Xid=145 on Device=GPU-66666666-7777-8888-9999-000000000000; marking device as unhealthy.",
    "2026-09-23T02:35:57.360474753Z I0923 02:35:57.360303       1 health.go:139] Skipping event {Device:{Handle:0x768f4a22e158} EventType:8 EventData:43 GpuInstanceId:4294967295 ComputeInstanceId:4294967295}",
    "I0928 23:13:29.028243       1 health.go:139] unstamped line is ignored",
    "2026-09-28T23:13:29.028442214Z I0928 23:13:29.028243       1 server.go:1 some other message",
])
UUID_TO_BUS = {
    "GPU-11111111-2222-3333-4444-555555555555": "00000000:C3:00.0",
}

# nvidia-smi --query-gpu=SMI_FIELDS --format=csv,noheader. The shape and the
# [N/A] spelling follow nvidia-smi docs; row 1 is a MIG-style host where
# remapped rows are not readable.
SMI_FIXTURE = "\n".join([
    "GPU-aaaa, 00000000:1B:00.0, None, No, 0",
    "GPU-bbbb, 00000000:43:00.0, Node Reboot Required, Yes, 3",
    "GPU-cccc, 00000000:52:00.0, [N/A], [N/A], [N/A]",
    "garbage line",
])
EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_parse_smi_gpus(reporter_k8s):
    gpus = reporter_k8s.parse_smi_gpus(SMI_FIXTURE)
    assert sorted(gpus) == ["GPU-aaaa", "GPU-bbbb", "GPU-cccc"]
    assert gpus["GPU-aaaa"] == {
        "bus_id": "00000000:1B:00.0", "recovery_action": "None",
        "remapped_rows_failure": False, "ecc_uncorrected": 0,
    }
    assert gpus["GPU-bbbb"]["recovery_action"] == "Node Reboot Required"
    assert gpus["GPU-bbbb"]["remapped_rows_failure"] is True
    assert gpus["GPU-bbbb"]["ecc_uncorrected"] == 3
    # [N/A] is a missing reading, never a passing value.
    assert gpus["GPU-cccc"]["recovery_action"] is None
    assert gpus["GPU-cccc"]["remapped_rows_failure"] is None
    assert gpus["GPU-cccc"]["ecc_uncorrected"] is None


def test_parse_smi_accepts_numeric_failure_flag(reporter_k8s):
    gpus = reporter_k8s.parse_smi_gpus(
        "GPU-a, 00000000:1B:00.0, None, 1, 0\n"
        "GPU-b, 00000000:43:00.0, None, 0, 0")
    assert gpus["GPU-a"]["remapped_rows_failure"] is True
    assert gpus["GPU-b"]["remapped_rows_failure"] is False


def test_parse_plugin_log_xids(reporter_k8s):
    xids, last = reporter_k8s.parse_plugin_log(PLUGIN_LOG_FIXTURE, EPOCH,
                                               UUID_TO_BUS)
    assert [x["xid"] for x in xids] == [79, 145, 43]
    assert set(xids[0]) == {"bus_id", "xid", "at", "message"}
    # UUID on the following XidCriticalError line resolves to a bus id.
    assert xids[0]["bus_id"] == "00000000:C3:00.0"
    # Unknown UUID and Skipping events carry no identity.
    assert xids[1]["bus_id"] == ""
    assert xids[2]["bus_id"] == ""
    # Times are normalised to UTC (-07:00 offset -> +7h).
    assert xids[0]["at"] == "2026-01-05T11:25:00.405995+00:00"
    assert xids[2]["at"] == "2026-09-23T02:35:57.360474+00:00"
    assert xids[0]["message"].startswith("Processing event")
    # The cursor moves past every stamped line read, not just Xids.
    assert last.isoformat().startswith("2026-09-28T23:13:29.028442")


def test_parse_plugin_log_empty(reporter_k8s):
    assert reporter_k8s.parse_plugin_log("", EPOCH) == ([], None)


def test_parse_plugin_log_caps_events(reporter_k8s, monkeypatch):
    monkeypatch.setattr(reporter_k8s, "MAX_XIDS_PER_REPORT", 1)
    xids, last = reporter_k8s.parse_plugin_log(PLUGIN_LOG_FIXTURE, EPOCH,
                                               UUID_TO_BUS)
    # The capped event still gets its XidCriticalError bus id, and the
    # cursor stops after that line, before the next Xid, so the rest go out
    # next run.
    assert [(x["xid"], x["bus_id"]) for x in xids] == [(79, "00000000:C3:00.0")]
    assert last.isoformat().startswith("2026-01-05T11:25:00.406803")


def test_xids_since_advances_cursor_past_last_line(reporter_k8s,
                                                   monkeypatch):
    seen = {}

    def fake_kubectl(*args, timeout=10):
        seen["args"] = args
        return PLUGIN_LOG_FIXTURE

    monkeypatch.setattr(reporter_k8s, "kubectl", fake_kubectl)
    since = "2026-01-01T00:00:00+00:00"
    text = reporter_k8s.read_plugin_log("pod-1", since)
    assert "--since-time" in seen["args"] and since in seen["args"]
    xids, nxt = reporter_k8s.xids_since(text, since, UUID_TO_BUS)
    assert len(xids) == 3
    assert nxt == "2026-09-28T23:13:29.028443+00:00"
    # The API server truncates --since-time to the second, so the last
    # lines come back on the next read; they must not be sent again.
    assert reporter_k8s.xids_since(PLUGIN_LOG_FIXTURE, nxt, {}) == ([], nxt)


def test_quiet_log_still_moves_the_cursor(reporter_k8s):
    # No Xids at all: the next read must start after these lines, not
    # re-download everything since the last Xid.
    quiet = "\n".join(
        f"2026-10-01T00:00:{s:02d}.000000Z I1001 00:00:{s:02d}.0 1 "
        f"server.go:1] heartbeat" for s in range(5))
    xids, nxt = reporter_k8s.xids_since(
        quiet, "2026-10-01T00:00:00+00:00", {})
    assert xids == []
    assert nxt == "2026-10-01T00:00:04.000001+00:00"


def test_capped_log_cursor_stops_at_the_last_sent_xid(reporter_k8s,
                                                      monkeypatch):
    monkeypatch.setattr(reporter_k8s, "MAX_XIDS_PER_REPORT", 1)
    xids, nxt = reporter_k8s.xids_since(
        PLUGIN_LOG_FIXTURE, "2026-01-01T00:00:00+00:00", UUID_TO_BUS)
    assert [x["xid"] for x in xids] == [79]
    assert nxt == "2026-01-05T11:25:00.406804+00:00"
    # Next run picks up the unsent Xid 145.
    rest, _ = reporter_k8s.xids_since(PLUGIN_LOG_FIXTURE, nxt, UUID_TO_BUS)
    assert [x["xid"] for x in rest] == [145]


def test_driver_fields_from_node_status(reporter_k8s):
    node = make_node("gpu-node-1")
    node["status"]["capacity"]["nvidia.com/gpu"] = "8"
    node["status"]["allocatable"] = {"nvidia.com/gpu": "5"}
    fields = reporter_k8s.driver_fields(node)
    assert fields == {
        "xids": None, "allocatable_gpus": 5, "capacity_gpus": 8,
        "mig_slices": None, "root_owned_slots": None,
        "gpu_query_hung": None, "gpu_query_error": None,
        "network_probes": None,
    }
    # No allocatable entry is a missing reading, not 0.
    assert reporter_k8s.driver_fields(
        make_node("n"))["allocatable_gpus"] is None


# gpu 1 carries smi's first uuid, so a join by index would mix them up.
DCGM_TWO_GPU = (DCGM_FIXTURE.replace("GPU-aaaa", "GPU-bbbb")
                + DCGM_FIXTURE.replace('gpu="0"', 'gpu="1"'))


# PROBE_SCRIPT output captured from an H100 device-plugin pod.
PROBE_OUTPUT = "\n".join([
    "github 0 660  ",
    "registry 1 5180 wget: server returned error: HTTP/1.1 401 Unauthorized ",
    "pypi 0 5260 ",
])


def _patch_driver_reads(reporter_k8s, monkeypatch, smi=SMI_FIXTURE,
                        log=PLUGIN_LOG_FIXTURE, probes=PROBE_OUTPUT):
    def fake_kubectl(*args, timeout=10):
        if args[0] == "exec" and "sh" in args:
            if probes is None:
                raise RuntimeError("kubectl exec failed: Forbidden")
            return probes
        if args[0] == "exec":
            if isinstance(smi, Exception):
                raise smi
            if smi is None:
                raise RuntimeError("kubectl exec failed: Forbidden")
            return smi
        if args[0] == "logs":
            if log is None:
                raise RuntimeError("kubectl logs failed: Forbidden")
            return log
        return CADVISOR_FIXTURE

    monkeypatch.setattr(reporter_k8s, "kubectl", fake_kubectl)
    monkeypatch.setattr(reporter_k8s, "fetch_stats_summary",
                        lambda name: STATS_SUMMARY_FIXTURE)
    monkeypatch.setattr(reporter_k8s, "scrape_dcgm",
                        lambda pod_ip: DCGM_TWO_GPU)


def test_process_node_merges_driver_readings(reporter_k8s, monkeypatch):
    _patch_driver_reads(reporter_k8s, monkeypatch)
    state = {reporter_k8s.XID_STATE_KEY: {
        "inf-4x8h100-1": "2026-01-01T00:00:00+00:00"}}
    payload = reporter_k8s.process_node(
        make_node("inf-4x8h100-1"), "192.168.3.81", state, time.time(),
        "plugin-pod")
    assert payload["reporter_status"] == "ok"
    g0, g1 = payload["gpus"]
    assert "uuid" not in g0  # join key only, not a reported field
    assert g0["recovery_action"] == "Node Reboot Required"
    assert g0["remapped_rows_failure"] is True
    assert g1["recovery_action"] == "None"
    assert g1["remapped_rows_failure"] is False
    assert g1["ecc_uncorrected"] == 0
    assert [x["xid"] for x in payload["xids"]] == [79, 145, 43]
    assert payload["gpu_query_hung"] is False
    assert payload["gpu_query_error"] is None
    assert [p["ok"] for p in payload["network_probes"]] == [True] * 3
    assert state[reporter_k8s.XID_STATE_KEY]["inf-4x8h100-1"] > \
        "2026-09-23"


def test_process_node_first_run_starts_cursor_at_now(reporter_k8s,
                                                     monkeypatch):
    _patch_driver_reads(reporter_k8s, monkeypatch, log=None)
    state = {}
    payload = reporter_k8s.process_node(
        make_node("inf-4x8h100-1"), "192.168.3.81", state, 1788387174.0,
        "plugin-pod")
    assert payload["xids"] == []
    assert state[reporter_k8s.XID_STATE_KEY]["inf-4x8h100-1"].startswith(
        "2026-09-02T")


def test_process_node_failed_reads_are_null_not_degraded(reporter_k8s,
                                                         monkeypatch):
    _patch_driver_reads(reporter_k8s, monkeypatch, smi=None, log=None,
                        probes=None)
    state = {reporter_k8s.XID_STATE_KEY: {
        "inf-4x8h100-1": "2026-01-01T00:00:00+00:00"}}
    payload = reporter_k8s.process_node(
        make_node("inf-4x8h100-1"), "192.168.3.81", state, time.time(),
        "plugin-pod")
    assert payload["reporter_status"] == "ok"
    assert payload["xids"] is None
    # An exec kubectl refused is no reading, not a hang or a dead network.
    assert payload["gpu_query_hung"] is None
    assert payload["network_probes"] is None
    for g in payload["gpus"]:
        assert g["recovery_action"] is None
        assert g["remapped_rows_failure"] is None
        assert g["ecc_uncorrected"] is None
    # A failed log read leaves the cursor so the next run covers the gap.
    assert state[reporter_k8s.XID_STATE_KEY]["inf-4x8h100-1"] == \
        "2026-01-01T00:00:00+00:00"


def test_process_node_without_plugin_pod_reports_null(reporter_k8s,
                                                      monkeypatch):
    _patch_driver_reads(reporter_k8s, monkeypatch)
    payload = reporter_k8s.process_node(
        make_node("inf-4x8h100-1"), "192.168.3.81", {}, time.time())
    assert payload["xids"] is None
    assert all(g["recovery_action"] is None for g in payload["gpus"])


def test_main_keeps_log_cursor_when_post_fails(reporter_k8s, monkeypatch,
                                               tmp_path):
    _patch_driver_reads(reporter_k8s, monkeypatch)
    state_file = tmp_path / "state.json"
    since = "2026-01-01T00:00:00+00:00"
    state_file.write_text('{"_xid_since": {"inf-4x8h100-1": "%s"}}' % since)
    monkeypatch.setattr(reporter_k8s, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter_k8s, "DISK_STATE_FILE", str(state_file))
    monkeypatch.setattr(reporter_k8s, "get_nodes",
                        lambda: [make_node("inf-4x8h100-1")])
    monkeypatch.setattr(reporter_k8s, "get_pod_ips",
                        lambda: {"inf-4x8h100-1": "192.168.3.81"})
    monkeypatch.setattr(reporter_k8s, "get_plugin_pods",
                        lambda: {"inf-4x8h100-1": "plugin-pod"})

    def failing_report(payload):
        raise OSError("down")

    monkeypatch.setattr(reporter_k8s, "report", failing_report)
    try:
        reporter_k8s.main()
    except SystemExit:
        pass
    saved = reporter_k8s.load_disk_state(str(state_file))
    assert saved[reporter_k8s.XID_STATE_KEY]["inf-4x8h100-1"] == since


# --- GPU hang and network probes ----------------------------------------------
def test_nvidia_smi_error_inside_the_pod_is_a_hang(reporter_k8s, monkeypatch):
    _patch_driver_reads(reporter_k8s, monkeypatch, smi=RuntimeError(
        "kubectl exec -n failed: command terminated with exit code 15"))
    payload = reporter_k8s.process_node(
        make_node("inf-4x8h100-1"), "192.168.3.81", {}, time.time(),
        "plugin-pod")
    assert payload["gpu_query_hung"] is True
    assert "exit code 15" in payload["gpu_query_error"]
    assert all(g["recovery_action"] is None for g in payload["gpus"])


def test_nvidia_smi_exec_past_the_hang_timeout_is_a_hang(reporter_k8s,
                                                         monkeypatch):
    import subprocess

    def hung(cmd, **kwargs):
        assert kwargs["timeout"] == reporter_k8s.GPU_HANG_TIMEOUT
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(reporter_k8s.subprocess, "run", hung)
    assert reporter_k8s.read_smi("plugin-pod") == (
        {}, True, "nvidia-smi exec did not return in 30 s")


def test_parse_probe_output(reporter_k8s):
    assert reporter_k8s.parse_probe_output(PROBE_OUTPUT) == [
        {"target": "github", "ok": True, "error": None, "latency_ms": 660},
        {"target": "registry", "ok": True, "error": None, "latency_ms": 5180},
        {"target": "pypi", "ok": True, "error": None, "latency_ms": 5260},
    ]
    down = "\n".join([
        "pypi 1 10 wget: can't connect to remote host (1.2.3.4): "
        "Connection refused ",
        "github 1 5010 wget: bad address 'github.com' ",
        "registry 143 11000  ",
    ])
    assert [(p["target"], p["ok"], p["error"], p["latency_ms"])
            for p in reporter_k8s.parse_probe_output(down)] == [
        ("github", False, "dns", None),
        ("registry", False, "timeout", None),
        ("pypi", False, "connect", None),
    ]


def test_probe_output_without_every_target_is_no_reading(reporter_k8s):
    import pytest

    with pytest.raises(RuntimeError, match="registry"):
        reporter_k8s.parse_probe_output("github 0 1 \npypi 0 1 ")
    # A plugin image without wget can't say anything about the network.
    with pytest.raises(RuntimeError, match="missing"):
        reporter_k8s.parse_probe_output("\n".join(
            f"{t} 127 0 sh: wget: not found" for t, _ in
            reporter_k8s.NETWORK_PROBES))


def test_main_starts_every_nodes_execs_before_the_node_loop(
        reporter_k8s, monkeypatch, tmp_path):
    started = []
    monkeypatch.setattr(reporter_k8s, "start_pod_reads",
                        lambda pod, since=None: started.append(pod) or {})
    seen = {}

    def fake_process_node(node, pod_ip, state, now, plugin_pod=None,
                          reads=None):
        seen[node["metadata"]["name"]] = list(started)
        return {"hostname": node["metadata"]["name"],
                "reporter_status": "ok"}

    monkeypatch.setattr(reporter_k8s, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter_k8s, "DISK_STATE_FILE",
                        str(tmp_path / "state.json"))
    monkeypatch.setattr(reporter_k8s, "get_nodes", lambda: [
        make_node("inf-4x8h100-1"), make_node("inf-4x8h100-2")])
    monkeypatch.setattr(reporter_k8s, "get_pod_ips", lambda: {})
    monkeypatch.setattr(reporter_k8s, "get_plugin_pods", lambda: {
        "inf-4x8h100-1": "pod-1", "inf-4x8h100-2": "pod-2"})
    monkeypatch.setattr(reporter_k8s, "process_node", fake_process_node)
    monkeypatch.setattr(reporter_k8s, "report", lambda payload: None)
    reporter_k8s.main()
    assert seen["inf-4x8h100-1"] == ["pod-1", "pod-2"]


def test_log_fetch_starts_with_the_other_pod_reads(reporter_k8s,
                                                   monkeypatch):
    calls = []

    def fake_kubectl(*args, timeout=10):
        calls.append(args[0])
        return ""

    monkeypatch.setattr(reporter_k8s, "kubectl", fake_kubectl)
    reads = reporter_k8s.start_pod_reads("pod-1", "2026-10-01T00:00:00+00:00")
    assert set(reads) == {"smi", "network", "log"}
    for future in reads.values():
        try:
            future.result()
        except Exception:
            pass
    assert "logs" in calls
    # First run: no cursor yet, so nothing to fetch.
    assert "log" not in reporter_k8s.start_pod_reads("pod-1", None)
