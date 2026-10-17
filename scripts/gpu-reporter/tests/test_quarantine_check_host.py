"""Tests for the H200 host return check (quarantine-check-host.py).

The dashboard and the host's commands are faked. FakeHost answers the
nvidia-smi and docker calls the check makes and keeps each GPU's MIG layout,
so a test can see the layout taken down for the diag and put back after.
"""

import time
import urllib.error

import pytest

from conftest import load_module

HOST = "mithril-h200-1"
IMAGE = "nvcr.io/nvidia/cloud-native/dcgm:4.4.2-1-ubuntu22.04"
DIAG_PASS = "| Diagnostic | Result |\n| memory | Pass |\n"
DIAG_FAIL = "| Diagnostic | Result |\n| memory | Fail - GPU 0 |\n"


class FakeHost:
    def __init__(self, gpus=2, mig=True, slices=("1g.35gb",) * 4):
        self.mig = mig
        # GPU index -> list of MIG profile names; empty when MIG is off.
        self.layout = {i: list(slices) if mig else [] for i in range(gpus)}
        self.apps = ""
        self.health = {i: ("None", "No") for i in range(gpus)}
        self.diag = {}  # GPU index (or "all") -> diag output
        self.restore_fails = False
        self.restore_wrong = False
        self.fail_cmd = None  # a command prefix that exits 1 with no output
        self.calls = []
        self.timeouts = []
        self.slow = 0

    def __call__(self, cmd, timeout):
        self.calls.append(cmd)
        self.timeouts.append(timeout)
        if self.fail_cmd and cmd[:len(self.fail_cmd)] == self.fail_cmd:
            return 1, ""
        if self.slow:
            time.sleep(self.slow)
        if cmd[:2] == ["nvidia-smi", "--query-compute-apps=pid,process_name"]:
            return 0, self.apps
        if cmd[:2] == ["nvidia-smi",
                       "--query-gpu=index,gpu_recovery_action,remapped_rows.failure"]:
            return 0, "".join(f"{i}, {r}, {f}\n"
                              for i, (r, f) in self.health.items())
        if cmd[:2] == ["nvidia-smi", "--query-gpu=index,uuid,mig.mode.current"]:
            mode = "Enabled" if self.mig else "Disabled"
            return 0, "".join(f"{i}, GPU-{i}, {mode}\n" for i in self.layout)
        if cmd == ["nvidia-smi", "-L"]:
            out = ""
            for i, profiles in self.layout.items():
                out += f"GPU {i}: NVIDIA H200 (UUID: GPU-{i})\n"
                out += "".join(f"  MIG {p}     Device  {d}: (UUID: MIG-{i}-{d})\n"
                               for d, p in enumerate(profiles))
            return 0, out
        if cmd[:2] == ["nvidia-smi", "mig"]:
            gpu = int(cmd[cmd.index("-i") + 1])
            if cmd[2] in ("-dci", "-dgi"):
                if cmd[2] == "-dgi":
                    self.layout[gpu] = []
                return 0, ""
            if cmd[2] == "-cgi":
                wanted = cmd[3].split(",")
                if self.restore_fails and wanted != ["0"]:
                    return 1, "Insufficient resources"
                if self.restore_wrong and wanted != ["0"]:
                    wanted = wanted[:-1]
                self.layout[gpu] = ["7g.141gb" if p == "0" else p for p in wanted]
                return 0, ""
        if cmd[:3] == ["docker", "rm", "-f"]:
            return 0, ""
        if cmd[:2] == ["docker", "run"]:
            script = cmd[-1]
            key = int(script.rsplit(" -i ", 1)[1]) if " -i " in script else "all"
            out = self.diag.get(key, DIAG_PASS)
            if isinstance(out, tuple):
                return out
            return (1 if "Fail" in out else 0), out
        raise AssertionError(f"unexpected command: {cmd}")


class FakeDashboard:
    def __init__(self, desired):
        self.desired, self.posts = desired, []

    def __call__(self, method, path, body=None):
        if method == "GET":
            assert path == "/api/alerts/quarantine/desired?cluster=h200"
            return {"nodes": self.desired}
        assert method == "POST"
        assert path == f"/api/alerts/quarantine/{HOST}/applied"
        self.posts.append(body)
        return {}


def want(stage="resolving", actuator_state="drained", host=HOST):
    return {"host": host, "alertId": 7, "stage": stage, "reason": "Xid 79",
            "actuatorState": actuator_state}


@pytest.fixture()
def run(monkeypatch, tmp_path):
    mod = load_module("quarantine_check_host", "quarantine-check-host.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://dash.example/api/gpu/report")
    monkeypatch.setattr(mod, "HOST", HOST)
    monkeypatch.setattr(mod, "STATE_PATH", str(tmp_path / "check.json"))
    monkeypatch.setattr(mod.shutil, "which",
                        lambda name: "/usr/bin/docker" if name == "docker" else None)

    def go(host, dash, *argv):
        monkeypatch.setattr(mod, "run_cmd", host)
        monkeypatch.setattr(mod, "http_json", dash)
        return mod.main(list(argv))
    go.mod = mod
    return go


def states(dash):
    return [p["state"] for p in dash.posts]


@pytest.mark.parametrize("desired", [
    [],
    [want(host="h200-ci-2")],
    [want(stage="quarantined")],
    [want(actuator_state="out")],
])
def test_it_checks_only_its_own_drained_resolve(run, desired):
    host, dash = FakeHost(), FakeDashboard(desired)
    assert run(host, dash) == 0
    assert host.calls == [] and dash.posts == []


def test_a_host_without_mig_runs_one_diag_on_all_gpus(run):
    host, dash = FakeHost(mig=False), FakeDashboard([want()])
    assert run(host, dash) == 0
    assert states(dash) == ["verifying", "verified"]
    docker = [c for c in host.calls if c[0] == "docker"]
    # The image's entrypoint is nv-hostengine, so bash is set explicitly.
    assert docker == [
        ["docker", "run", "--rm", "--name", "vllm-quarantine-check",
         "--network", "none", "--gpus", "all", "--cap-add", "SYS_ADMIN",
         "--entrypoint", "bash", IMAGE, "-c",
         "nv-hostengine && sleep 3 && dcgmi diag -r 2"],
        ["docker", "rm", "-f", "vllm-quarantine-check"],
    ]
    assert not any(c[:2] == ["nvidia-smi", "mig"] for c in host.calls)


def test_a_mig_host_gets_every_gpu_whole_then_its_slices_back(run):
    # DCGM needs a privileged container with MIG on, which sees every GPU,
    # and refuses to run while any visible GPU is still sliced.
    host, dash = FakeHost(gpus=2), FakeDashboard([want()])
    assert run(host, dash) == 0
    assert states(dash) == ["verifying", "verified"]
    steps = [c[2:] if c[0] == "nvidia-smi" else ["diag", c[-1]]
             for c in host.calls
             if c[:2] in (["nvidia-smi", "mig"], ["docker", "run"])]
    slices = "1g.35gb,1g.35gb,1g.35gb,1g.35gb"
    assert steps == [
        ["-dci", "-i", "0"], ["-dgi", "-i", "0"], ["-cgi", "0", "-C", "-i", "0"],
        ["-dci", "-i", "1"], ["-dgi", "-i", "1"], ["-cgi", "0", "-C", "-i", "1"],
        ["diag", "nv-hostengine && sleep 3 && dcgmi diag -r 2 -i 0"],
        ["diag", "nv-hostengine && sleep 3 && dcgmi diag -r 2 -i 1"],
        ["-dci", "-i", "0"], ["-dgi", "-i", "0"], ["-cgi", slices, "-C", "-i", "0"],
        ["-dci", "-i", "1"], ["-dgi", "-i", "1"], ["-cgi", slices, "-C", "-i", "1"],
    ]
    [run_cmd] = [c for c in host.calls if c[:2] == ["docker", "run"]][:1]
    assert "--privileged" in run_cmd and "--cap-add" not in run_cmd
    assert host.layout == {0: ["1g.35gb"] * 4, 1: ["1g.35gb"] * 4}


def test_a_failed_diag_still_puts_the_slices_back(run):
    host, dash = FakeHost(gpus=2), FakeDashboard([want()])
    host.diag[1] = DIAG_FAIL
    assert run(host, dash) == 0
    assert states(dash) == ["verifying", "verify_failed"]
    assert dash.posts[-1]["observed"]["note"].startswith("GPU 1: ")
    assert "Fail - GPU 0" in dash.posts[-1]["observed"]["note"]
    assert host.layout == {0: ["1g.35gb"] * 4, 1: ["1g.35gb"] * 4}


def test_slices_that_dont_come_back_fail_the_check(run):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    host.restore_fails = True
    assert run(host, dash) == 0
    assert states(dash) == ["verifying", "verify_failed"]
    note = dash.posts[-1]["observed"]["note"]
    assert note.startswith("MIG layout not restored on GPU 0")


def test_a_gpu_needing_recovery_fails_before_any_diag(run):
    host, dash = FakeHost(), FakeDashboard([want()])
    host.health[1] = ("Reset", "No")
    assert run(host, dash) == 0
    assert dash.posts[-1] == {"alertId": 7, "state": "verify_failed", "observed": {
        "note": "a GPU needs recovery or is out of spare memory rows: 1, Reset, No"}}
    assert not any(c[0] == "docker" for c in host.calls)


def test_unsupported_health_fields_are_not_faults(run):
    host, dash = FakeHost(mig=False), FakeDashboard([want()])
    host.health = {0: ("[N/A]", "[N/A]"), 1: ("None", "No")}
    assert run(host, dash) == 0
    assert states(dash)[-1] == "verified"


def test_a_gpu_still_in_use_fails_the_check(run):
    host, dash = FakeHost(), FakeDashboard([want()])
    host.apps = "4242, python3\n"
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "a GPU is still in use: 4242, python3"


def test_mixed_mig_modes_fail_the_check(run, monkeypatch):
    host, dash = FakeHost(), FakeDashboard([want()])
    real = host.__call__

    def mixed(cmd, timeout):
        if cmd[:2] == ["nvidia-smi", "--query-gpu=index,uuid,mig.mode.current"]:
            return 0, "0, GPU-0, Enabled\n1, GPU-1, Disabled\n"
        return real(cmd, timeout)
    assert run(mixed, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == (
        "some GPUs have MIG on and some off; fix the layout by hand")


def test_a_command_that_times_out_fails_the_check(run, monkeypatch):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    real = host.__call__

    def hangs(cmd, timeout):
        if cmd[0] == "docker":
            raise TimeoutError(f"{cmd[0]} timed out after {timeout}s")
        return real(cmd, timeout)
    assert run(hangs, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "GPU 0: docker timed out after 1800s"
    assert host.layout == {0: ["1g.35gb"] * 4}


def test_the_check_keeps_reporting_while_it_runs(run, monkeypatch):
    monkeypatch.setattr(run.mod, "HEARTBEAT_SECONDS", 0.01)
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    host.slow = 0.005
    assert run(host, dash) == 0
    assert states(dash)[-1] == "verified"
    assert states(dash).count("verifying") >= 3


def test_level_0_returns_without_a_check(run, monkeypatch):
    monkeypatch.setattr(run.mod, "VERIFY_LEVEL", "0")
    host, dash = FakeHost(), FakeDashboard([want()])
    assert run(host, dash) == 0
    assert host.calls == []
    assert dash.posts == [{"alertId": 7, "state": "verified",
                           "observed": {"note": "QUARANTINE_VERIFY_LEVEL=0"}}]


def test_dry_run_changes_nothing(run, capsys):
    host, dash = FakeHost(), FakeDashboard([want()])
    assert run(host, dash, "--dry-run") == 0
    assert host.calls == [] and dash.posts == []
    assert f"DRY RUN: would run the return check on {HOST}" in capsys.readouterr().out


def test_a_dashboard_outage_runs_nothing(run):
    host = FakeHost()

    def down(method, path, body=None):
        raise urllib.error.URLError("connection refused")
    assert run(host, down) == 1
    assert host.calls == []


def test_a_host_without_mig_runs_exactly_these_commands(run):
    host, dash = FakeHost(mig=False), FakeDashboard([want()])
    assert run(host, dash) == 0
    assert host.calls[:3] == [
        ["nvidia-smi", "--query-compute-apps=pid,process_name", "--format=csv,noheader"],
        ["nvidia-smi", "--query-gpu=index,gpu_recovery_action,remapped_rows.failure",
         "--format=csv,noheader"],
        ["nvidia-smi", "--query-gpu=index,uuid,mig.mode.current",
         "--format=csv,noheader"],
    ]
    assert host.timeouts == [120, 120, 120, 1800, 120]
    assert dash.posts[0] == {"alertId": 7, "state": "verifying",
                             "observed": {"phase": "Started"}}


def test_slices_are_recreated_as_compute_instances_too(run):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    assert run(host, dash) == 0
    assert host.calls[-2] == ["nvidia-smi", "mig", "-cgi",
                              "1g.35gb,1g.35gb,1g.35gb,1g.35gb", "-C", "-i", "0"]


def test_a_failed_mig_command_names_itself(run):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    host.fail_cmd = ["nvidia-smi", "mig", "-dci"]
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == (
        "MIG layout not restored on GPU 0: nvidia-smi mig -dci failed: no output")


def test_a_diag_that_exits_0_but_reports_a_fail_fails(run):
    host, dash = FakeHost(mig=False), FakeDashboard([want()])
    host.diag["all"] = (0, "a\nb\n| pcie | Fail |\nd\n")
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "b / | pcie | Fail | / d"


def test_a_diag_with_no_output_says_so(run):
    host, dash = FakeHost(mig=False), FakeDashboard([want()])
    host.diag["all"] = (1, "")
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "no output"


def test_out_of_spare_rows_fails_and_every_bad_gpu_is_named(run):
    host, dash = FakeHost(), FakeDashboard([want()])
    host.health = {0: ("None", "Yes"), 1: ("Reset", "No")}
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == (
        "a GPU needs recovery or is out of spare memory rows: "
        "0, None, Yes / 1, Reset, No")


def test_every_gpu_whose_slices_dont_come_back_is_named(run):
    host, dash = FakeHost(gpus=2), FakeDashboard([want()])
    host.restore_fails = True
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == (
        "MIG layout not restored on GPU 0: nvidia-smi mig -cgi failed: "
        "Insufficient resources / GPU 1: nvidia-smi mig -cgi failed: "
        "Insufficient resources")


def test_a_failure_making_whole_gpus_still_restores_every_gpu(run):
    host, dash = FakeHost(gpus=2), FakeDashboard([want()])
    real = host.__call__

    def second_fails(cmd, timeout):
        if cmd[:4] == ["nvidia-smi", "mig", "-cgi", "0"] and cmd[-1] == "1":
            return 1, "In use by another client"
        return real(cmd, timeout)
    assert run(second_fails, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == (
        "nvidia-smi mig -cgi failed: In use by another client")
    assert not any(c[:2] == ["docker", "run"] for c in host.calls)
    assert host.layout == {0: ["1g.35gb"] * 4, 1: ["1g.35gb"] * 4}


def test_a_layout_that_comes_back_different_fails(run):
    host, dash = FakeHost(gpus=2), FakeDashboard([want()])
    host.restore_wrong = True
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "MIG layout not restored on GPU 0, 1"


def test_every_failed_gpu_is_named(run):
    host, dash = FakeHost(gpus=2), FakeDashboard([want()])
    host.diag[0] = (1, "bad 0")
    host.diag[1] = (1, "bad 1")
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "GPU 0: bad 0 / GPU 1: bad 1"


def test_a_long_note_is_cut_to_300_characters(run):
    host, dash = FakeHost(mig=False), FakeDashboard([want()])
    host.diag["all"] = (1, "x" * 400)
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "x" * 300


def test_a_crash_inside_the_check_fails_it(run):
    host, dash = FakeHost(), FakeDashboard([want()])
    host.apps = None  # .strip() on None raises AttributeError
    assert run(host, dash) == 0
    assert dash.posts[-1]["state"] == "verify_failed"
    assert dash.posts[-1]["observed"]["note"].startswith("check crashed: ")


def test_heartbeats_say_the_check_is_running(run, monkeypatch):
    monkeypatch.setattr(run.mod, "HEARTBEAT_SECONDS", 0.01)
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    host.slow = 0.005
    assert run(host, dash) == 0
    assert dash.posts[1] == {"alertId": 7, "state": "verifying",
                             "observed": {"phase": "Running"}}


@pytest.mark.parametrize("level", ["2", "0"])
def test_a_lost_post_fails_the_run(run, monkeypatch, level):
    monkeypatch.setattr(run.mod, "VERIFY_LEVEL", level)
    host = FakeHost(mig=False)
    real = FakeDashboard([want()])

    def posts_fail(method, path, body=None):
        if method == "POST":
            raise urllib.error.URLError("connection refused")
        return real(method, path, body)
    assert run(host, posts_fail) == 1


def test_a_missing_url_fails_without_calling_anything(run, monkeypatch):
    monkeypatch.setattr(run.mod, "REPORT_URL", "")
    host, dash = FakeHost(), FakeDashboard([want()])
    assert run(host, dash) == 1
    assert host.calls == [] and dash.posts == []


def test_run_cmd_returns_output_and_times_out(run):
    assert run.mod.run_cmd(["sh", "-c", "echo out; echo err >&2; exit 3"], 5) == (
        3, "out\nerr\n")
    with pytest.raises(TimeoutError, match="^sleep timed out after 0.2s$"):
        run.mod.run_cmd(["sleep", "5"], 0.2)


def test_settings_come_from_the_environment(monkeypatch):
    for name in ("GPU_REPORT_URL", "GPU_REPORT_SECRET", "QUARANTINE_CLUSTER",
                 "QUARANTINE_HOST", "QUARANTINE_VERIFY_LEVEL",
                 "QUARANTINE_VERIFY_IMAGE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr("socket.gethostname", lambda: "Mithril-H200-1.ib.example")
    mod = load_module("check_defaults", "quarantine-check-host.py")
    assert (mod.REPORT_URL, mod.REPORT_SECRET, mod.CLUSTER, mod.HOST,
            mod.VERIFY_LEVEL, mod.VERIFY_IMAGE) == (
        "", "", "h200", "mithril-h200-1", "2", IMAGE)
    env = {"GPU_REPORT_URL": "u", "GPU_REPORT_SECRET": "s",
           "QUARANTINE_CLUSTER": "c", "QUARANTINE_HOST": "h",
           "QUARANTINE_VERIFY_LEVEL": "3", "QUARANTINE_VERIFY_IMAGE": "i"}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    mod = load_module("check_env", "quarantine-check-host.py")
    assert (mod.REPORT_URL, mod.REPORT_SECRET, mod.CLUSTER, mod.HOST,
            mod.VERIFY_LEVEL, mod.VERIFY_IMAGE) == ("u", "s", "c", "h", "3", "i")


class FakeResponse:
    def __init__(self, raw):
        self.raw = raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.raw


def test_requests_carry_the_reporter_secret(run, monkeypatch):
    monkeypatch.setattr(run.mod, "REPORT_SECRET", "dash-secret")
    sent = []

    def urlopen(req, timeout):
        sent.append((req, timeout))
        return FakeResponse(b"" if req.get_method() == "POST" else b'{"a": 1}')
    monkeypatch.setattr(run.mod.urllib.request, "urlopen", urlopen)
    assert run.mod.http_json("GET", "/api/x") == {"a": 1}
    assert run.mod.http_json("POST", "/api/y", {"b": 2}) == {}
    (get, timeout), (post, _) = sent
    assert (get.full_url, get.data, timeout) == ("https://dash.example/api/x", None, 15)
    assert get.headers == {"Content-type": "application/json",
                           "Authorization": "Bearer dash-secret"}
    assert post.data == b'{"b": 2}'


def test_heartbeats_come_well_inside_the_workers_10_minute_stuck_timer():
    mod = load_module("check_beat", "quarantine-check-host.py")
    assert 0 < mod.HEARTBEAT_SECONDS <= 120


def test_a_long_crash_note_is_cut_to_300_characters(run):
    dash = FakeDashboard([want()])

    def crashes(cmd, timeout):
        raise ValueError("x" * 400)
    assert run(crashes, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == ("check crashed: " + "x" * 400)[:300]


def test_a_lost_result_is_sent_again_on_the_next_run(run):
    host = FakeHost(gpus=1)
    real = FakeDashboard([want()])
    lost = []

    def last_post_fails(method, path, body=None):
        if method == "POST" and body["state"] != "verifying":
            lost.append(body)
            raise urllib.error.URLError("connection refused")
        return real(method, path, body)
    assert run(host, last_post_fails) == 1
    calls = len(host.calls)
    # The dashboard still says verifying; the next run sends the result
    # without checking again.
    dash = FakeDashboard([want(actuator_state="verifying")])
    assert run(host, dash) == 0
    assert dash.posts == lost == [{"alertId": 7, "state": "verified", "observed": {}}]
    assert len(host.calls) == calls


def test_a_check_cut_off_midway_fails_so_the_host_isnt_stuck(run):
    host = FakeHost(gpus=1)
    real = FakeDashboard([want()])

    def dies(cmd, timeout):
        if cmd[0] == "docker":
            raise KeyboardInterrupt  # the host rebooting mid-check
        return host(cmd, timeout)
    with pytest.raises(KeyboardInterrupt):
        run(dies, real)
    dash = FakeDashboard([want(actuator_state="verifying")])
    assert run(host, dash) == 0
    assert dash.posts == [{"alertId": 7, "state": "verify_failed", "observed": {
        "note": "the check was cut off before it finished (host restart?); "
                "check the MIG layout with nvidia-smi -L before resolving again"}}]


@pytest.mark.parametrize("saved", [None, "{not json", '{"alertId": 8, "result": null}'])
def test_verifying_without_this_episodes_state_is_a_cut_off_check(run, saved):
    # Only this host's check moves its episode to verifying, so missing,
    # unreadable or another episode's state means the check was cut off.
    if saved is not None:
        with open(run.mod.STATE_PATH, "w") as f:
            f.write(saved)
    host, dash = FakeHost(), FakeDashboard([want(actuator_state="verifying")])
    assert run(host, dash) == 0
    assert host.calls == []
    assert dash.posts == [{"alertId": 7, "state": "verify_failed",
                           "observed": {"note": run.mod.INTERRUPTED}}]


def test_no_gpu_is_touched_until_the_dashboard_has_verifying(run):
    host = FakeHost(gpus=1)

    def posts_fail(method, path, body=None):
        if method == "POST":
            raise urllib.error.URLError("connection refused")
        return {"nodes": [want()]}
    assert run(host, posts_fail) == 1
    assert host.calls == []


def test_a_timed_out_diag_has_its_container_removed_before_slices_return(run):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    real = host.__call__

    def hangs(cmd, timeout):
        if cmd[:2] == ["docker", "run"]:
            host.calls.append(cmd)
            raise TimeoutError("docker timed out after 1800s")
        return real(cmd, timeout)
    assert run(hangs, dash) == 0
    after_run = host.calls[host.calls.index(next(
        c for c in host.calls if c[:2] == ["docker", "run"])) + 1:]
    assert after_run[0] == ["docker", "rm", "-f", "vllm-quarantine-check"]
    assert host.layout == {0: ["1g.35gb"] * 4}


def test_a_failed_container_removal_doesnt_stop_the_restore(run):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    real = host.__call__

    def rm_hangs(cmd, timeout):
        if cmd[:2] == ["docker", "rm"]:
            raise TimeoutError("docker timed out after 120s")
        return real(cmd, timeout)
    assert run(rm_hangs, dash) == 0
    assert dash.posts[-1]["state"] == "verified"
    assert host.layout == {0: ["1g.35gb"] * 4}


def test_state_is_replaced_whole_never_written_in_place(run, monkeypatch):
    replaced = []
    real_replace = run.mod.os.replace
    monkeypatch.setattr(run.mod.os, "replace",
                        lambda a, b: (replaced.append(b), real_replace(a, b)))
    run.mod.save_state(7, ["verified", {}])
    assert replaced == [run.mod.STATE_PATH]
    assert run.mod.load_state() == {"alertId": 7, "result": ["verified", {}]}


def test_a_new_resolve_of_the_same_episode_checks_again(run):
    host = FakeHost(mig=False)
    host.diag["all"] = (1, "Fail")
    assert run(host, FakeDashboard([want()])) == 0
    host.diag["all"] = DIAG_PASS
    dash = FakeDashboard([want()])
    assert run(host, dash) == 0
    assert [p["state"] for p in dash.posts] == ["verifying", "verified"]


def test_any_error_during_a_gpus_diag_still_puts_its_slices_back(run):
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    real = host.__call__

    def exec_fails(cmd, timeout):
        if cmd[0] == "docker":
            raise OSError("exec format error")
        return real(cmd, timeout)
    assert run(exec_fails, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "GPU 0: exec format error"
    assert host.layout == {0: ["1g.35gb"] * 4}


def test_no_docker_fails_before_any_slice_is_touched(run, monkeypatch):
    monkeypatch.setattr(run.mod.shutil, "which", lambda name: None)
    host, dash = FakeHost(gpus=1), FakeDashboard([want()])
    assert run(host, dash) == 0
    assert dash.posts[-1]["observed"]["note"] == "docker is not installed"
    assert not any(c[:2] == ["nvidia-smi", "mig"] for c in host.calls)


def test_its_state_lives_in_the_units_state_directory():
    mod = load_module("check_paths", "quarantine-check-host.py")
    assert mod.STATE_PATH == "/var/lib/gpu-reporter/quarantine-check.json"
    unit = (load_module.__globals__["SCRIPTS_DIR"]
            / "quarantine-check-host.service").read_text()
    assert "StateDirectory=gpu-reporter" in unit


def test_a_result_that_still_cant_be_sent_fails_the_run(run):
    host = FakeHost(gpus=1)
    assert run(host, FakeDashboard([want()])) == 0

    def posts_fail(method, path, body=None):
        if method == "POST":
            raise urllib.error.URLError("connection refused")
        return {"nodes": [want(actuator_state="verifying")]}
    assert run(host, posts_fail) == 1
