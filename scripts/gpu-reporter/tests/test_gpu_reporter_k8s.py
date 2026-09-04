"""Tests for the K8s control-plane scraper (gpu-reporter-k8s.py).

Covers the DCGM/cAdvisor/stats-summary parsers, the per-pool device role
maps, the disk-scrape cadence state, and the ingestion-contract payload
shapes on the node error paths.
"""

import time

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
    "node_conditions",
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
    'DCGM_FI_DEV_GPU_UTIL{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 55\n'
    'DCGM_FI_DEV_FB_USED{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 1000\n'
    'DCGM_FI_DEV_FB_FREE{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 80000\n'
    'DCGM_FI_DEV_FB_RESERVED{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 480\n'
    'DCGM_FI_DEV_GPU_TEMP{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 42\n'
    'DCGM_FI_DEV_POWER_USAGE{gpu="0",modelName="NVIDIA H100 80GB HBM3",Hostname="inf-4x8h100-1"} 305.5\n'
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
        "/dev/sdz9": {"used_bytes": 3, "total_bytes": 500000000},
    }
    disks = reporter_k8s.build_disk_entries("dgxb200-15", fs_map, 1800000000000)
    roles = {d["device"]: d["role"] for d in disks}
    assert roles == {"/dev/md0": "system", "/dev/md127": "data",
                     "/dev/sdz9": "other"}


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
