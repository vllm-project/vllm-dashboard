"""Tests for the H200 quarantine pauser (quarantine-pauser-h200.py).

Buildkite and the dashboard are faked. FakeBuildkite keeps agents and answers
the agent list, pause and resume calls the way the REST API documents them:
pausing an agent that is already paused, or not connected, is a 422.
"""

import datetime
import urllib.error

import pytest

from conftest import load_module

NOW = datetime.datetime(2026, 10, 16, 12, 0, tzinfo=datetime.timezone.utc)


class FakeBuildkite:
    def __init__(self, agents):
        self.agents = {a["id"]: a for a in agents}
        self.writes = []  # (verb, agent name, body)
        self.fail_hosts = set()

    def __call__(self, method, path, body=None):
        if method == "GET":
            assert path.startswith("/v2/organizations/vllm/agents?hostname=")
            host = path.split("hostname=", 1)[1].split("&", 1)[0]
            if host in self.fail_hosts:
                raise RuntimeError("Buildkite GET failed: 502")
            # The API matches hostnames loosely; the pauser must not.
            return [dict(a) for a in self.agents.values() if host in a["hostname"].lower()]
        assert method == "PUT"
        agent_id, verb = path.rsplit("/", 2)[-2:]
        a = self.agents[agent_id]
        if verb == "pause":
            if a["connection_state"] != "connected":
                raise RuntimeError("422 Only connected agents may be paused")
            if a["paused"]:
                raise RuntimeError("422 Agent is already paused")
            a.update(paused=True, paused_at=NOW.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                     paused_note=body["note"],
                     paused_timeout_in_minutes=body["timeout_in_minutes"])
        elif verb == "resume":
            if not a["paused"]:
                raise RuntimeError("422 Agent is not paused")
            a.update(paused=False, paused_at=None, paused_note=None)
        self.writes.append((verb, a["name"], body))
        return None


def agent(n, host="mithril-h200-1", job=None, paused=None, minutes_ago=0,
          timeout=720, connected=True):
    """paused: None, or the pause note ('ours' for the pauser's own note)."""
    a = {"id": f"{host}-id-{n}", "name": f"{host}-{n}", "hostname": host,
         "connection_state": "connected" if connected else "disconnected",
         "job": {"web_url": f"https://buildkite.com/vllm/ci/builds/1#{n}"}
         if job else None,
         "paused": False, "paused_at": None, "paused_note": None,
         "paused_timeout_in_minutes": 5}
    if paused is not None:
        at = NOW - datetime.timedelta(minutes=minutes_ago)
        a.update(paused=True, paused_at=at.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                 paused_timeout_in_minutes=timeout,
                 paused_note="vllm-quarantine 7: Xid 79" if paused == "ours"
                 else paused)
    return a


class FakeDashboard:
    def __init__(self, desired=None, down=False):
        self.desired, self.down, self.posts = desired or [], down, []

    def __call__(self, method, path, body=None):
        if self.down:
            raise urllib.error.URLError("connection refused")
        if method == "GET":
            assert path == "/api/alerts/quarantine/desired?cluster=h200"
            return {"nodes": self.desired}
        assert method == "POST"
        self.posts.append((path.split("/")[-2], body))
        return {}


def want(host, stage, actuator_state=None, held=False):
    return {"host": host, "alertId": 7, "stage": stage, "reason": "Xid 79",
            "actuatorState": actuator_state, "resolvedWhileHeld": held}


@pytest.fixture()
def run(monkeypatch):
    mod = load_module("quarantine_pauser_h200", "quarantine-pauser-h200.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://dash.example/api/gpu/report")
    monkeypatch.setattr(mod, "BUILDKITE_TOKEN", "token")
    monkeypatch.setattr(mod, "now", lambda: NOW)

    def go(bk, dash, *argv):
        monkeypatch.setattr(mod, "buildkite", bk)
        monkeypatch.setattr(mod, "http_json", dash)
        return mod.main(list(argv))
    go.mod = mod
    return go


PAUSE = {"note": "vllm-quarantine 7: Xid 79", "timeout_in_minutes": 720}


def test_quarantine_pauses_every_connected_agent_for_12_hours(run):
    bk = FakeBuildkite([agent(1), agent(2, job=True), agent(3, connected=False)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantining")])
    assert run(bk, dash) == 0
    assert bk.writes == [("pause", "mithril-h200-1-1", PAUSE),
                         ("pause", "mithril-h200-1-2", PAUSE)]
    # A running job finishes on a paused agent, so the host isn't drained yet.
    assert dash.posts == [("mithril-h200-1", {
        "alertId": 7, "state": "out",
        "observed": {"agents": 2, "paused": 2, "busy": 1, "reapplied": False}})]
    bk.writes.clear()
    assert run(bk, dash) == 0
    assert bk.writes == []


def test_drained_once_no_agent_runs_a_job(run):
    bk = FakeBuildkite([agent(1, paused="ours"), agent(2, paused="ours")])
    dash = FakeDashboard([want("mithril-h200-1", "quarantined")])
    assert run(bk, dash) == 0
    assert bk.writes == []
    assert dash.posts[0][1]["state"] == "drained"


def test_only_agents_on_exactly_this_host_are_paused(run):
    bk = FakeBuildkite([agent(1), agent(1, host="mithril-h200-10"),
                        agent(2, host="MITHRIL-H200-1.internal")])
    dash = FakeDashboard([want("mithril-h200-1", "quarantining")])
    assert run(bk, dash) == 0
    assert [w[1] for w in bk.writes] == ["mithril-h200-1-1",
                                         "MITHRIL-H200-1.internal-2"]


def test_an_agent_that_appears_after_a_restart_is_paused_as_drift(run, capsys):
    bk = FakeBuildkite([agent(1, paused="ours"), agent(2)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantined")])
    assert run(bk, dash) == 0
    assert bk.writes == [("pause", "mithril-h200-1-2", PAUSE)]
    assert dash.posts[0][1]["observed"]["reapplied"] is True
    assert "DRIFT: mithril-h200-1: paused 1 new agent(s)" in capsys.readouterr().out


def test_new_agents_while_quarantining_are_not_drift(run):
    bk = FakeBuildkite([agent(1, paused="ours"), agent(2)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantining")])
    assert run(bk, dash) == 0
    assert dash.posts[0][1]["observed"]["reapplied"] is False


@pytest.mark.parametrize("left,renewed", [(61, False), (60, False), (59, True)])
def test_our_pause_is_renewed_in_its_last_hour(run, left, renewed):
    bk = FakeBuildkite([agent(1, paused="ours", minutes_ago=720 - left)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantined")])
    assert run(bk, dash) == 0
    # A second pause is a 422, so a renewal resumes and pauses straight away.
    assert bk.writes == ([("resume", "mithril-h200-1-1", {}),
                          ("pause", "mithril-h200-1-1", PAUSE)]
                         if renewed else [])


def test_a_persons_pause_is_left_alone_and_counts_as_out(run):
    bk = FakeBuildkite([agent(1, paused="draining for a BIOS update",
                              minutes_ago=715)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantined")])
    assert run(bk, dash) == 0
    assert bk.writes == []
    assert dash.posts[0][1]["state"] == "drained"


def test_a_resolve_names_the_jobs_it_waits_on(run):
    bk = FakeBuildkite([agent(1, paused="ours", job=True),
                        agent(2, paused="ours")])
    dash = FakeDashboard([want("mithril-h200-1", "resolving")])
    assert run(bk, dash) == 0
    assert bk.writes == []
    assert dash.posts == [("mithril-h200-1", {
        "alertId": 7, "state": "out",
        "observed": {"ciPods": 1, "note": "waiting for 1 CI job(s) to finish: "
                     "https://buildkite.com/vllm/ci/builds/1#1"}})]


def test_a_drained_resolve_hands_over_to_the_host_check_once(run):
    bk = FakeBuildkite([agent(1, paused="ours")])
    dash = FakeDashboard([want("mithril-h200-1", "resolving")])
    assert run(bk, dash) == 0
    assert dash.posts == [("mithril-h200-1", {
        "alertId": 7, "state": "drained", "observed": {"busy": 0}})]
    # Already handed over: posting again could overwrite the check's state.
    dash.desired = [want("mithril-h200-1", "resolving", "drained")]
    assert run(bk, dash) == 0
    assert len(dash.posts) == 1


@pytest.mark.parametrize("state", ["verifying", "verify_failed"])
def test_the_host_check_owns_the_state_while_it_runs(run, state):
    bk = FakeBuildkite([agent(1, paused="ours", minutes_ago=700)])
    dash = FakeDashboard([want("mithril-h200-1", "resolving", state)])
    assert run(bk, dash) == 0
    assert dash.posts == []
    # The pause is still renewed, so a long check can't let jobs in.
    assert [w[0] for w in bk.writes] == ["resume", "pause"]


def test_a_verified_host_gets_only_our_pauses_lifted(run, capsys):
    bk = FakeBuildkite([agent(1, paused="ours"), agent(2, paused="ours"),
                        agent(3, paused="a person's pause")])
    dash = FakeDashboard([want("mithril-h200-1", "resolving", "verified")])
    assert run(bk, dash) == 0
    assert bk.writes == [("resume", "mithril-h200-1-1", {}),
                         ("resume", "mithril-h200-1-2", {})]
    note = "1 agent(s) paused by someone else left paused"
    assert dash.posts == [("mithril-h200-1", {
        "alertId": 7, "state": "returned",
        "observed": {"paused": False, "note": note}})]


def test_a_host_resolved_while_held_returns_without_a_check(run):
    # It never went out, so there is nothing to check or lift.
    bk = FakeBuildkite([agent(1), agent(2, job=True)])
    dash = FakeDashboard([want("mithril-h200-1", "resolving", held=True)])
    assert run(bk, dash) == 0
    assert bk.writes == []
    assert dash.posts == [("mithril-h200-1", {
        "alertId": 7, "state": "returned", "observed": {"paused": False}})]


@pytest.mark.parametrize("state", [None, "verifying"])
def test_agents_that_restart_during_a_resolve_are_paused_again(run, state):
    # Every agent restarted, so none carries our pause; the host still
    # returns only through its check.
    bk = FakeBuildkite([agent(1), agent(2)])
    dash = FakeDashboard([want("mithril-h200-1", "resolving", state)])
    assert run(bk, dash) == 0
    assert bk.writes == [("pause", "mithril-h200-1-1", PAUSE),
                         ("pause", "mithril-h200-1-2", PAUSE)]
    assert [p[1]["state"] for p in dash.posts] == ([] if state else ["drained"])


def test_dry_run_changes_nothing(run, capsys):
    bk = FakeBuildkite([agent(1)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantining"),
                          want("h200-ci-2", "would")])
    assert run(bk, dash, "--dry-run") == 0
    assert bk.writes == [] and dash.posts == []
    out = capsys.readouterr().out
    assert "DRY RUN: would pause mithril-h200-1-1" in out
    assert "would quarantine h200-ci-2" in out


def test_a_dashboard_outage_changes_nothing(run):
    bk = FakeBuildkite([agent(1)])
    assert run(bk, FakeDashboard(down=True)) == 1
    assert bk.writes == []


def test_one_hosts_buildkite_error_leaves_the_others_running(run):
    bk = FakeBuildkite([agent(1), agent(1, host="h200-ci-2")])
    bk.fail_hosts.add("mithril-h200-1")
    dash = FakeDashboard([want("mithril-h200-1", "quarantining"),
                          want("h200-ci-2", "quarantining")])
    assert run(bk, dash) == 1
    assert bk.writes == [("pause", "h200-ci-2-1", PAUSE)]


def test_a_failed_run_leaves_its_errors_for_the_failure_dm(run, monkeypatch,
                                                            tmp_path):
    monkeypatch.setattr(run.mod, "FAILURE_DIR", str(tmp_path))
    monkeypatch.setenv("INVOCATION_ID", "abc123")
    bk = FakeBuildkite([agent(1)])
    bk.fail_hosts.add("mithril-h200-1")
    dash = FakeDashboard([want("mithril-h200-1", "quarantining")])
    assert run(bk, dash) == 1
    assert (tmp_path / "abc123").read_text() == (
        "h200-pauser\nmithril-h200-1: Buildkite GET failed: 502\n")


@pytest.mark.parametrize("missing", ["REPORT_URL", "BUILDKITE_TOKEN"])
def test_missing_config_fails_without_calling_anything(run, monkeypatch, missing):
    monkeypatch.setattr(run.mod, missing, "")
    bk = FakeBuildkite([agent(1)])
    dash = FakeDashboard([want("mithril-h200-1", "quarantining")])
    assert run(bk, dash) == 1
    assert bk.writes == [] and dash.posts == []


def test_a_resolve_still_waiting_on_a_reading_keeps_the_host_paused(run):
    bk = FakeBuildkite([agent(1, paused="ours"), agent(2)])
    dash = FakeDashboard([want("mithril-h200-1", "resolve_requested")])
    assert run(bk, dash) == 0
    assert bk.writes == [("pause", "mithril-h200-1-2", PAUSE)]
    assert dash.posts[0][1]["state"] == "drained"


@pytest.mark.parametrize("reason,note", [
    (None, "vllm-quarantine 7:"),
    ("x" * 300, "vllm-quarantine 7: " + "x" * 181),
])
def test_the_pause_note_names_the_episode_within_200_characters(run, reason, note):
    bk = FakeBuildkite([agent(1)])
    dash = FakeDashboard([dict(want("mithril-h200-1", "quarantining"),
                               reason=reason)])
    assert run(bk, dash) == 0
    assert bk.writes[0][2]["note"] == note


def test_a_long_ci_wait_names_three_jobs_by_url_or_agent(run):
    agents = [agent(n, paused="ours", job=True) for n in range(1, 5)]
    agents[0]["job"] = {"id": "job-without-url"}
    bk = FakeBuildkite(agents)
    dash = FakeDashboard([want("mithril-h200-1", "resolving")])
    assert run(bk, dash) == 0
    assert dash.posts[0][1]["observed"]["note"] == (
        "waiting for 4 CI job(s) to finish: mithril-h200-1-1, "
        "https://buildkite.com/vllm/ci/builds/1#2, "
        "https://buildkite.com/vllm/ci/builds/1#3, ...")


def test_errors_are_recorded_only_for_a_systemd_run(run, monkeypatch, tmp_path):
    monkeypatch.setattr(run.mod, "FAILURE_DIR", str(tmp_path))
    monkeypatch.delenv("INVOCATION_ID", raising=False)
    bk = FakeBuildkite([agent(1)])
    bk.fail_hosts.add("mithril-h200-1")
    assert run(bk, FakeDashboard([want("mithril-h200-1", "quarantining")])) == 1
    assert list(tmp_path.iterdir()) == []


def test_recorded_errors_are_one_per_line_and_capped(run, monkeypatch, tmp_path):
    monkeypatch.setattr(run.mod, "FAILURE_DIR", str(tmp_path))
    monkeypatch.setenv("INVOCATION_ID", "abc")
    run.mod.record_failure(["one", "two"])
    assert (tmp_path / "abc").read_text() == "h200-pauser\none\ntwo\n"
    run.mod.record_failure(["x" * 2000])
    assert (tmp_path / "abc").read_text() == "h200-pauser\n" + "x" * 1500 + "\n"


def test_settings_come_from_the_environment(monkeypatch):
    for name in ("GPU_REPORT_URL", "GPU_REPORT_SECRET", "BUILDKITE_WRITE_TOKEN",
                 "QUARANTINE_CLUSTER"):
        monkeypatch.delenv(name, raising=False)
    mod = load_module("pauser_defaults", "quarantine-pauser-h200.py")
    assert (mod.REPORT_URL, mod.REPORT_SECRET, mod.BUILDKITE_TOKEN,
            mod.CLUSTER) == ("", "", "", "h200")
    monkeypatch.setenv("GPU_REPORT_URL", "https://d.example/api/gpu/report")
    monkeypatch.setenv("GPU_REPORT_SECRET", "s")
    monkeypatch.setenv("BUILDKITE_WRITE_TOKEN", "t")
    monkeypatch.setenv("QUARANTINE_CLUSTER", "h200b")
    mod = load_module("pauser_env", "quarantine-pauser-h200.py")
    assert (mod.REPORT_URL, mod.REPORT_SECRET, mod.BUILDKITE_TOKEN,
            mod.CLUSTER) == ("https://d.example/api/gpu/report", "s", "t", "h200b")


class FakeResponse:
    def __init__(self, raw):
        self.raw = raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.raw


def test_requests_carry_their_credentials(monkeypatch):
    mod = load_module("pauser_http", "quarantine-pauser-h200.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://d.example/api/gpu/report")
    monkeypatch.setattr(mod, "REPORT_SECRET", "dash-secret")
    monkeypatch.setattr(mod, "BUILDKITE_TOKEN", "bk-token")
    sent = []

    def urlopen(req, timeout):
        sent.append((req, timeout))
        return FakeResponse(b"" if req.get_method() == "PUT" else b'{"a": 1}')
    monkeypatch.setattr(mod.urllib.request, "urlopen", urlopen)
    assert mod.http_json("GET", "/api/x") == {"a": 1}
    assert mod.buildkite("PUT", "/v2/y", {"note": "n"}) is None
    mod.REPORT_SECRET = ""
    assert mod.http_json("POST", "/api/z", {"b": 2}) == {"a": 1}
    (get, t1), (put, t2), (post, _) = sent
    assert (get.full_url, get.get_method(), get.data, t1) == (
        "https://d.example/api/x", "GET", None, 15)
    assert get.headers == {"Content-type": "application/json",
                           "Authorization": "Bearer dash-secret"}
    assert (put.full_url, put.data) == ("https://api.buildkite.com/v2/y",
                                        b'{"note": "n"}')
    assert put.headers["Authorization"] == "Bearer bk-token"
    assert "Authorization" not in post.headers and post.data == b'{"b": 2}'


def test_exactly_three_jobs_are_all_named(run):
    bk = FakeBuildkite([agent(n, paused="ours", job=True) for n in range(1, 4)])
    dash = FakeDashboard([want("mithril-h200-1", "resolving")])
    assert run(bk, dash) == 0
    assert not dash.posts[0][1]["observed"]["note"].endswith("...")


def test_the_failure_dm_says_what_went_wrong(run, monkeypatch, tmp_path):
    monkeypatch.setattr(run.mod, "FAILURE_DIR", str(tmp_path))
    monkeypatch.setenv("INVOCATION_ID", "r1")
    assert run(FakeBuildkite([]), FakeDashboard(down=True)) == 1
    assert (tmp_path / "r1").read_text() == (
        "h200-pauser\ndesired set unavailable, changing nothing: "
        "<urlopen error connection refused>\n")
    dash = FakeDashboard([want("mithril-h200-1", "evicted")])
    monkeypatch.setenv("INVOCATION_ID", "r2")
    assert run(FakeBuildkite([]), dash) == 1
    assert "mithril-h200-1: unknown stage 'evicted'" in (tmp_path / "r2").read_text()
    real = FakeDashboard([want("mithril-h200-1", "quarantining")])

    def post_fails(method, path, body=None):
        if method == "POST":
            raise RuntimeError("HTTP Error 500")
        return real(method, path, body)
    monkeypatch.setenv("INVOCATION_ID", "r3")
    assert run(FakeBuildkite([agent(1)]), post_fails) == 1
    assert (tmp_path / "r3").read_text() == (
        "h200-pauser\nPOST applied for mithril-h200-1 failed: HTTP Error 500\n")
    monkeypatch.setattr(run.mod, "BUILDKITE_TOKEN", "")
    monkeypatch.setenv("INVOCATION_ID", "r4")
    assert run(FakeBuildkite([]), FakeDashboard()) == 1
    assert (tmp_path / "r4").read_text() == (
        "h200-pauser\nGPU_REPORT_URL and BUILDKITE_WRITE_TOKEN must be set\n")


def test_errors_go_where_the_worker_failure_notifier_reads_them():
    mod = load_module("pauser_paths", "quarantine-pauser-h200.py")
    assert mod.FAILURE_DIR == "/run/alerting/failures"


def test_a_returned_host_stays_returned_until_the_worker_closes_it(run):
    # The worker closes the episode within 5 minutes; the pauser runs every
    # minute and must not pause the host again meanwhile.
    bk = FakeBuildkite([agent(1), agent(2)])
    dash = FakeDashboard([want("mithril-h200-1", "resolving", "returned")])
    assert run(bk, dash) == 0
    assert bk.writes == [] and dash.posts == []
