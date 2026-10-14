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
    assert reporter.classify_mount("/mnt/local") == "workspace"
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

    def fake_report(gpus, host, status, last_error, faults=None):
        calls.update(gpus=gpus, host=host, status=status, last_error=last_error,
                     faults=faults)

    def boom():
        raise RuntimeError("nvidia-smi failed: not found")

    monkeypatch.setattr(reporter, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter, "report", fake_report)
    monkeypatch.setattr(reporter, "query_gpus", boom)
    monkeypatch.setattr(reporter, "query_xids", lambda path: ([], None))
    monkeypatch.setattr(reporter, "query_mig_slices", lambda: 0)
    monkeypatch.setattr(reporter, "find_root_owned_slots", lambda: [])
    monkeypatch.setattr(reporter, "NETWORK_PROBES", ())
    monkeypatch.setattr(reporter, "collect_host_metrics", lambda: {
        "cpu_util": 1.0, "cpu_count": 8, "ram_used_bytes": 1,
        "ram_total_bytes": 2, "ram_available_bytes": 1, "disks": [],
    })

    reporter.main()

    assert calls["status"] == "degraded"
    assert calls["last_error"] == "nvidia-smi failed: not found"
    assert calls["gpus"] == []
    assert set(calls["host"]) == HOST_KEYS
    # nvidia-smi -L is skipped once nvidia-smi has failed; Xids still flow.
    # The failed query is a hang, sent as an explicit failing value.
    assert calls["faults"] == {
        "xids": [], "mig_slices": None, "root_owned_slots": [],
        "gpu_query_hung": True, "gpu_query_error": "nvidia-smi failed: not found",
        "network_probes": [],
    }


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


# --- hardware-fault readings -------------------------------------------------

# Captured from a MIG-mode H200 host: remap is [N/A], ECC reads 0.
FAULT_QUERY_MIG = "\n".join(
    f"{i}, None, [N/A], 0" for i in range(8)
)
FAULT_QUERY_MIXED = "\n".join([
    "0, None, No, 0",
    "1, GPU Reset, Yes, 12",
    "2, [Not Supported], [Not Supported], [Not Supported]",
    "3, Node Reboot, 1, [N/A]",
])

NVIDIA_SMI_L_MIG = "\n".join([
    "GPU 0: NVIDIA H200 (UUID: GPU-8800a3cd-38c6-154e-6fa4-d736a65e5535)",
    "  MIG 1g.35gb     Device  0: (UUID: MIG-a280c447-dfd8-519d-a151-88ac82b0a056)",
    "  MIG 1g.35gb     Device  1: (UUID: MIG-495c7ac0-6b37-54e9-8508-47707b9ca404)",
    "GPU 1: NVIDIA H200 (UUID: GPU-0f026f38-fd99-c806-7633-6f5cf38f5ade)",
    "  MIG 1g.35gb     Device  0: (UUID: MIG-ead74451-97af-5b6d-9a86-3da61df40ba9)",
])
NVIDIA_SMI_L_PLAIN = "\n".join(
    f"GPU {i}: NVIDIA H200 (UUID: GPU-{i})" for i in range(8)
)


def journal_line(message, usec, cursor):
    import json

    return json.dumps({
        "MESSAGE": message,
        "__REALTIME_TIMESTAMP": str(usec),
        "__CURSOR": cursor,
    })


JOURNAL_FIXTURE = "\n".join([
    journal_line("usb 1-1: new high-speed USB device", 1_760_000_000_000_000, "c1"),
    journal_line("NVRM: Xid (PCI:0000:7f:00): 43, pid=3696418, name=VLLM::EngineCor, "
                 "channel 0x09000046", 1_760_000_001_500_000, "c2"),
    journal_line("NVRM: Xid (PCI:0003:00:01): 79, GPU has fallen off the bus.",
                 1_760_000_002_000_000, "c3"),
    journal_line("NVRM: Xid (PCI:0000:3b:00): 48", 1_760_000_003_000_000, "c4"),
    "not json at all",
    journal_line("eth0: link up", 1_760_000_004_000_000, "c5"),
])


def test_parse_fault_query_mig_remap_is_null_not_false(reporter):
    faults = reporter.parse_fault_query(FAULT_QUERY_MIG)
    assert sorted(faults) == list(range(8))
    assert faults[3] == {
        "recovery_action": "None",
        "remapped_rows_failure": None,
        "ecc_uncorrected": 0,
    }


def test_parse_fault_query_values_and_unreadable_cells(reporter):
    faults = reporter.parse_fault_query(FAULT_QUERY_MIXED)
    assert faults[0] == {"recovery_action": "None", "remapped_rows_failure": False,
                         "ecc_uncorrected": 0}
    assert faults[1] == {"recovery_action": "GPU Reset", "remapped_rows_failure": True,
                         "ecc_uncorrected": 12}
    assert faults[2] == {"recovery_action": None, "remapped_rows_failure": None,
                         "ecc_uncorrected": None}
    assert faults[3]["remapped_rows_failure"] is True
    assert faults[3]["ecc_uncorrected"] is None


def test_count_mig_slices(reporter):
    assert reporter.count_mig_slices(NVIDIA_SMI_L_MIG) == 3
    assert reporter.count_mig_slices(NVIDIA_SMI_L_PLAIN) == 0


def test_parse_xid_events(reporter):
    xids, last_cursor = reporter.parse_xid_events(JOURNAL_FIXTURE)
    assert last_cursor == "c5"
    assert xids == [
        {"bus_id": "0000:7f:00", "xid": 43,
         "at": "2025-10-09T08:53:21.500000+00:00",
         "message": "pid=3696418, name=VLLM::EngineCor, channel 0x09000046"},
        {"bus_id": "0003:00:01", "xid": 79,
         "at": "2025-10-09T08:53:22.000000+00:00",
         "message": "GPU has fallen off the bus."},
        {"bus_id": "0000:3b:00", "xid": 48,
         "at": "2025-10-09T08:53:23.000000+00:00", "message": ""},
    ]


def test_parse_xid_events_caps_and_keeps_the_rest_for_next_read(reporter, monkeypatch):
    monkeypatch.setattr(reporter, "MAX_XIDS_PER_REPORT", 2)
    xids, last_cursor = reporter.parse_xid_events(JOURNAL_FIXTURE)
    assert [x["xid"] for x in xids] == [43, 79]
    # Cursor stops before the third Xid, so --after-cursor resumes at it.
    assert last_cursor == "c3"


def fake_journalctl(monkeypatch, reporter, stdout="", returncode=0):
    calls = []

    class Result:
        pass

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        result = Result()
        result.stdout, result.stderr, result.returncode = stdout, "boom", returncode
        return result

    monkeypatch.setattr(reporter.subprocess, "run", fake_run)
    return calls


def test_first_run_reads_only_from_now(reporter, monkeypatch, tmp_path):
    calls = fake_journalctl(monkeypatch, reporter, stdout=JOURNAL_FIXTURE)
    xids, cursor = reporter.query_xids(str(tmp_path / "journal.cursor"))
    assert xids == []  # history is never replayed
    assert cursor == "c5"
    assert calls[0][-2:] == ["-n", "1"]


def test_later_run_resumes_after_saved_cursor(reporter, monkeypatch, tmp_path):
    path = tmp_path / "state" / "journal.cursor"
    reporter.write_cursor("c1", str(path))
    assert reporter.read_cursor(str(path)) == "c1"
    calls = fake_journalctl(monkeypatch, reporter, stdout=JOURNAL_FIXTURE)
    xids, cursor = reporter.query_xids(str(path))
    assert calls[0][-3:] == ["--after-cursor=c1", "-n", "+10000"]
    assert len(xids) == 3
    assert cursor == "c5"


def test_no_new_log_lines_leaves_nothing_to_save(reporter, monkeypatch, tmp_path):
    path = tmp_path / "journal.cursor"
    reporter.write_cursor("c9", str(path))
    fake_journalctl(monkeypatch, reporter, stdout="")
    assert reporter.query_xids(str(path)) == ([], None)


def test_journalctl_failure_raises_and_leaves_cursor(reporter, monkeypatch, tmp_path):
    import pytest

    path = tmp_path / "journal.cursor"
    reporter.write_cursor("c1", str(path))
    fake_journalctl(monkeypatch, reporter, returncode=1)
    with pytest.raises(RuntimeError):
        reporter.query_xids(str(path))
    assert reporter.read_cursor(str(path)) == "c1"


def test_find_root_owned_slots(reporter, tmp_path):
    import os

    clean = tmp_path / "builds" / "slot-1" / "vllm" / "ci"
    dirty = tmp_path / "builds" / "slot-2" / "vllm" / "ci"
    clean.mkdir(parents=True)
    (dirty / ".runtime-shard").mkdir(parents=True)
    pattern = str(tmp_path / "builds" / "*" / "vllm" / "ci")
    # The test user stands in for root; the empty slot has nothing to flag.
    assert reporter.find_root_owned_slots((pattern,), root_uid=os.getuid()) == [
        str(dirty)]
    assert reporter.find_root_owned_slots((pattern,), root_uid=os.getuid() + 1) == []
    assert reporter.find_root_owned_slots((str(tmp_path / "nope" / "*"),)) == []


def run_main(reporter, monkeypatch, tmp_path, post_ok=True, **queries):
    sent = {}

    def fake_report(gpus, host, status, last_error, faults=None):
        if not post_ok:
            raise OSError("down")
        sent.update(gpus=gpus, faults=faults)

    def boom(*args, **kwargs):
        raise RuntimeError("query failed")

    monkeypatch.setattr(reporter, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter, "JOURNAL_CURSOR_FILE", str(tmp_path / "journal.cursor"))
    monkeypatch.setattr(reporter, "report", fake_report)
    monkeypatch.setattr(reporter, "NETWORK_PROBES", ())
    monkeypatch.setattr(reporter, "collect_host_metrics", lambda: {})
    monkeypatch.setattr(reporter, "query_gpus", lambda: [
        {"index": 0, "dead_proc_mem_mb": None, "recovery_action": None,
         "remapped_rows_failure": None, "ecc_uncorrected": None}])
    monkeypatch.setattr(reporter, "query_dead_proc_memory", lambda: {0: 0.0})
    monkeypatch.setattr(reporter, "query_fault_fields", queries.get("fault", lambda: {
        0: {"recovery_action": "None", "remapped_rows_failure": False,
            "ecc_uncorrected": 0}}))
    monkeypatch.setattr(reporter, "query_xids", queries.get("xids", boom))
    monkeypatch.setattr(reporter, "query_mig_slices", queries.get("mig", boom))
    monkeypatch.setattr(reporter, "find_root_owned_slots", queries.get("slots", boom))
    try:
        reporter.main()
    except SystemExit:
        pass
    return sent


def test_each_failed_query_reports_null_independently(reporter, monkeypatch, tmp_path):
    def boom():
        raise RuntimeError("query failed")

    sent = run_main(reporter, monkeypatch, tmp_path, fault=boom,
                    mig=lambda: 12)  # xids and slots fail
    assert sent["faults"] == {"xids": None, "mig_slices": 12, "root_owned_slots": None,
                              "gpu_query_hung": False, "gpu_query_error": None,
                              "network_probes": []}
    gpu = sent["gpus"][0]
    assert gpu["recovery_action"] is None
    assert gpu["remapped_rows_failure"] is None
    assert gpu["ecc_uncorrected"] is None


def test_successful_queries_fill_the_payload(reporter, monkeypatch, tmp_path):
    sent = run_main(reporter, monkeypatch, tmp_path,
                    xids=lambda path: ([{"bus_id": "0000:7f:00", "xid": 48,
                                    "at": "2026-10-11T00:00:00.000000+00:00",
                                    "message": ""}], "c7"),
                    mig=lambda: 0, slots=lambda: ["/mnt/x/vllm/ci"])
    assert sent["faults"]["xids"][0]["xid"] == 48
    assert sent["faults"]["mig_slices"] == 0
    assert sent["faults"]["root_owned_slots"] == ["/mnt/x/vllm/ci"]
    assert sent["gpus"][0]["recovery_action"] == "None"
    assert sent["gpus"][0]["remapped_rows_failure"] is False
    assert reporter.read_cursor(reporter.JOURNAL_CURSOR_FILE) == "c7"


def test_cursor_is_not_saved_when_the_post_fails(reporter, monkeypatch, tmp_path):
    run_main(reporter, monkeypatch, tmp_path, post_ok=False,
             xids=lambda path: ([], "c7"), mig=lambda: 0, slots=lambda: [])
    assert reporter.read_cursor(reporter.JOURNAL_CURSOR_FILE) is None


# --- GPU hang and network probes ---------------------------------------------

def test_gpu_query_past_the_hang_timeout_reports_hung(reporter, monkeypatch, tmp_path):
    import subprocess

    def hung(cmd, **kwargs):
        assert kwargs["timeout"] == reporter.GPU_HANG_TIMEOUT
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(reporter.subprocess, "run", hung)
    sent = {}
    monkeypatch.setattr(reporter, "REPORT_URL", "http://dummy")
    monkeypatch.setattr(reporter, "JOURNAL_CURSOR_FILE", str(tmp_path / "c"))
    monkeypatch.setattr(reporter, "NETWORK_PROBES", ())
    monkeypatch.setattr(reporter, "collect_host_metrics", lambda: {})
    monkeypatch.setattr(reporter, "query_xids", lambda path: ([], None))
    monkeypatch.setattr(reporter, "find_root_owned_slots", lambda: [])
    monkeypatch.setattr(reporter, "report",
                        lambda gpus, host, status, err, faults: sent.update(faults))
    reporter.main()
    assert sent["gpu_query_hung"] is True
    assert "timed out after 30 seconds" in sent["gpu_query_error"]


def test_probe_counts_any_http_answer_as_reached(reporter, monkeypatch):
    import urllib.error

    def unauthorized(req, timeout):
        assert req.get_method() == "HEAD"
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(reporter.urllib.request, "urlopen", unauthorized)
    result = reporter.probe("https://public.ecr.aws/v2/")
    assert result["ok"] is True and result["error"] is None
    assert result["latency_ms"] >= 0


def test_probe_error_kinds(reporter):
    import socket
    import ssl
    import urllib.error

    kind = reporter.probe_error_kind
    assert kind(urllib.error.URLError(socket.gaierror(-2, "Name or service not known"))) == "dns"
    assert kind(urllib.error.URLError(TimeoutError("timed out"))) == "timeout"
    assert kind(TimeoutError("read timed out")) == "timeout"
    assert kind(urllib.error.URLError(ssl.SSLError("bad cert"))) == "tls"
    assert kind(urllib.error.URLError(ConnectionRefusedError(111, "refused"))) == "connect"
    assert kind(ValueError("unknown url type")) == "other"


def test_network_probes_run_together_and_stuck_ones_time_out(reporter, monkeypatch):
    def fake_probe(url):
        if url == "stuck":
            time.sleep(5)
        return {"ok": url == "up", "error": None if url == "up" else "dns",
                "latency_ms": 1 if url == "up" else None}

    monkeypatch.setattr(reporter, "probe", fake_probe)
    monkeypatch.setattr(reporter, "NETWORK_PROBE_TIMEOUT", 0)
    start = time.monotonic()
    results = reporter.finish_network_probes(reporter.start_network_probes(
        (("a", "up"), ("b", "down"), ("c", "stuck"))))
    assert time.monotonic() - start < 2  # one shared deadline, not one each
    assert results == [
        {"target": "a", "ok": True, "error": None, "latency_ms": 1},
        {"target": "b", "ok": False, "error": "dns", "latency_ms": None},
        {"target": "c", "ok": False, "error": "timeout", "latency_ms": None},
    ]
