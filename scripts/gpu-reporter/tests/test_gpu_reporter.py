"""Tests for the bare-metal reporter (gpu-reporter.py).

Covers the pure /proc parsers, the mount role map, the NFS-hang timeout
path, and the ingestion-contract payload shape on the nvidia-smi failure
path.
"""

import shutil
import time

HOST_KEYS = {
    "cpu_util", "cpu_count", "ram_used_bytes",
    "ram_total_bytes", "ram_available_bytes", "disks",
}
DISK_KEYS = {
    "mount_point", "device", "fstype", "role",
    "used_bytes", "total_bytes", "error",
}

PROC_MOUNTS_FIXTURE = "\n".join([
    "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
    "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
    "cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime 0 0",
    "devpts /dev/pts devpts rw,nosuid,noexec,relatime 0 0",
    "/dev/md0 / ext4 rw,relatime 0 0",
    "tmpfs /run tmpfs rw,nosuid,nodev 0 0",
    "tmpfs /run/lock tmpfs rw,nosuid,nodev,noexec 0 0",
    "tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0",
    "/dev/sda1 /raid0 xfs rw,relatime 0 0",
    "overlay /var/lib/docker/overlay2/abc overlay rw 0 0",
    "192.168.1.10:/export /mnt/vllm-ci nfs4 rw,relatime 0 0",
    "efivarfs /sys/firmware/efi/efivars efivarfs rw 0 0",
    "securityfs /sys/kernel/security securityfs rw 0 0",
    "tracefs /sys/kernel/tracing tracefs rw 0 0",
    "/dev/sdb15 /boot/efi vfat rw,relatime 0 0",
])


def test_parse_cpu_stat_aggregate_line(reporter):
    # user=1000 nice=0 system=500 idle=8000 iowait=1000 -> idle_all=9000
    text = "cpu  1000 0 500 8000 1000 0 0 0 0 0\ncpu0 500 0 250 4000 500 0 0 0 0 0\n"
    assert reporter.parse_cpu_stat(text) == (9000, 10500)


def test_cpu_util_delta_math(reporter):
    # delta: idle 1200 of total 1500 -> 20% busy
    idle1, total1 = reporter.parse_cpu_stat("cpu  1000 0 500 8000 1000 0 0 0\n")
    idle2, total2 = reporter.parse_cpu_stat("cpu  1200 0 600 9000 1200 0 0 0\n")
    util = round(100.0 * (1 - (idle2 - idle1) / (total2 - total1)), 2)
    assert util == 20.0


def test_parse_cpu_stat_missing_line(reporter):
    import pytest

    with pytest.raises(ValueError):
        reporter.parse_cpu_stat("cpu0 1 2 3 4 5 0 0 0\n")


def test_parse_meminfo(reporter):
    mem = reporter.parse_meminfo(
        "MemTotal:       16384 kB\nMemFree: 100 kB\nMemAvailable:    4096 kB\n"
    )
    assert mem == {"total": 16384 * 1024, "available": 4096 * 1024}


def test_parse_meminfo_missing_fields(reporter):
    import pytest

    with pytest.raises(ValueError):
        reporter.parse_meminfo("MemTotal: 16384 kB\n")


def test_parse_proc_mounts_filters_kernel_filesystems(reporter):
    parsed = reporter.parse_proc_mounts(PROC_MOUNTS_FIXTURE)
    kept = {m["mount"]: m for m in parsed}
    # kernel API filesystems, overlays and scratch tmpfs are skipped;
    # job-data tmpfs (/dev/shm) is kept
    assert set(kept) == {"/", "/dev/shm", "/raid0", "/mnt/vllm-ci", "/boot/efi"}
    assert kept["/"] == {"device": "/dev/md0", "mount": "/", "fstype": "ext4"}
    assert kept["/mnt/vllm-ci"]["fstype"] == "nfs4"


def test_rpc_pipefs_and_zero_capacity_mounts_are_skipped(reporter, monkeypatch):
    # Live failure: h200-ci-1's /run/rpc_pipefs stats to total_bytes 0, and
    # the ingestion contract requires total >= 1 — the whole report was
    # rejected (HTTP 400) until these mounts are dropped.
    mounts = "sunrpc /run/rpc_pipefs rpc_pipefs rw,relatime 0 0\n" \
             "/dev/md0 / ext4 rw,relatime 0 0\n"
    assert [m["mount"] for m in reporter.parse_proc_mounts(mounts)] == ["/"]

    # Defense in depth: even a mount that slips the fstype filter is dropped
    # when its capacity stats to zero.
    monkeypatch.setattr(reporter, "PROC_MOUNTS", "/dev/null")
    monkeypatch.setattr(reporter, "PROC_MEMINFO", "/dev/null")
    monkeypatch.setattr(reporter, "parse_meminfo",
                        lambda text: {"total": 16, "available": 8})
    monkeypatch.setattr(reporter, "cpu_util_percent", lambda: 1.0)
    monkeypatch.setattr(reporter, "parse_proc_mounts",
                        lambda text: [{"device": "x", "mount": "/zero",
                                       "fstype": "ext4"},
                                      {"device": "y", "mount": "/real",
                                       "fstype": "ext4"}])
    def fake_stat(mount, timeout=5):
        if mount == "/zero":
            return {"used_bytes": 0, "total_bytes": 0, "error": None}
        return {"used_bytes": 1, "total_bytes": 10, "error": None}
    monkeypatch.setattr(reporter, "stat_mount", fake_stat)
    host = reporter.collect_host_metrics()
    assert [d["mount_point"] for d in host["disks"]] == ["/real"]


def test_h200_mount_role_map(reporter):
    assert reporter.classify_mount("/") == "system"
    assert reporter.classify_mount("/dev/shm") == "workspace"
    assert reporter.classify_mount("/raid0") == "images"
    assert reporter.classify_mount("/mnt/vllm-ci") == "data"
    assert reporter.classify_mount("/boot/efi") == "other"
    assert reporter.classify_mount("/anything-else") == "other"


def test_stat_mount_success_shape(reporter):
    entry = {"mount_point": "/", "device": "/dev/md0", "fstype": "ext4",
             "role": reporter.classify_mount("/"),
             **reporter.stat_mount("/", timeout=5)}
    assert set(entry) == DISK_KEYS
    assert entry["error"] is None
    assert entry["total_bytes"] > 0
    assert entry["used_bytes"] >= 0


def test_stat_mount_nfs_hang_times_out(reporter, monkeypatch):
    # A hung NFS stat must degrade to an error entry, not block the report.
    def hang(path):
        time.sleep(30)

    monkeypatch.setattr(shutil, "disk_usage", hang)
    start = time.time()
    result = reporter.stat_mount("/mnt/vllm-ci", timeout=0.5)
    elapsed = time.time() - start
    assert elapsed < 5
    assert result["used_bytes"] is None
    assert result["total_bytes"] is None
    assert "timed out" in result["error"]


def test_stat_mount_oserror(reporter):
    result = reporter.stat_mount("/nonexistent-path-xyz", timeout=5)
    assert result["used_bytes"] is None
    assert result["total_bytes"] is None
    assert result["error"]


def test_nvidia_smi_failure_posts_degraded_payload(reporter, monkeypatch):
    # The contract: on nvidia-smi failure the reporter still POSTs, with
    # gpus=[], reporter_status="degraded" and a non-null last_error.
    calls = {}

    def fake_report(gpus, host, status, last_error):
        calls.update(gpus=gpus, host=host, status=status, last_error=last_error)

    def boom():
        raise RuntimeError("nvidia-smi failed: not found")

    monkeypatch.setattr(reporter, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter, "report", fake_report)
    monkeypatch.setattr(reporter, "query_gpus", boom)
    monkeypatch.setattr(reporter, "collect_host_metrics", lambda: {
        "cpu_util": 1.0, "cpu_count": 8, "ram_used_bytes": 1,
        "ram_total_bytes": 2, "ram_available_bytes": 1, "disks": [],
    })

    reporter.main()

    assert calls["status"] == "degraded"
    assert calls["last_error"] == "nvidia-smi failed: not found"
    assert calls["gpus"] == []
    assert set(calls["host"]) == HOST_KEYS


def test_report_payload_top_level_keys(reporter, monkeypatch):
    # Bare metal omits node_conditions; exactly these five keys.
    sent = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"gpus": 0}'

    def fake_urlopen(req, timeout):
        import json

        sent.update(json.loads(req.data))
        return FakeResponse()

    monkeypatch.setattr(reporter.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(reporter, "REPORT_URL", "http://dummy")
    reporter.report([], {"cpu_util": 0, "cpu_count": 1, "ram_used_bytes": 0,
                         "ram_total_bytes": 0, "ram_available_bytes": 0,
                         "disks": []}, "ok", None)
    assert set(sent) == {"hostname", "gpus", "host", "reporter_status",
                         "last_error"}
    assert sent["reporter_status"] == "ok"
    assert sent["last_error"] is None
