"""Failure paths of the quarantine actuators (ticket 22).

What a healthy host never exercises: a run that dies between two writes, a
post the dashboard never receives, a host or node that disappears, agents that
come back under new ids, a person's cordon or pause overlapping ours, and a
hold that outlives the 12-hour pause. The fakes are the ones the per-script
tests use, so a test here reads as the same world going wrong.
"""

import datetime
import json
import urllib.error

import pytest

import test_quarantine_actuator_k8s as k8s
import test_quarantine_pauser_h200 as h200
from conftest import load_module

# ---------------------------------------------------------------- k8s actuator


@pytest.fixture()
def kube_run(monkeypatch):
    mod = load_module("quarantine_actuator_k8s_fp", "quarantine-actuator-k8s.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://dash.example/api/gpu/report")
    monkeypatch.setattr(mod, "CLUSTER", "h100")

    def go(kube, dash, *argv):
        monkeypatch.setattr(mod, "kubectl", kube)
        monkeypatch.setattr(mod, "http_json", dash)
        return mod.main(list(argv))
    go.mod = mod
    return go


def lose_posts(dash, states=None):
    """The dashboard answers the desired set but drops the posts."""
    def flaky(method, path, body=None):
        if method == "POST" and (states is None or body["state"] in states):
            raise urllib.error.URLError("connection refused")
        return dash(method, path, body)
    return flaky


def test_an_actuators_lost_out_post_is_sent_again_and_nothing_is_rewritten(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node()})
    dash = k8s.FakeDashboard([k8s.want("n1", "quarantining")])
    assert kube_run(kube, lose_posts(dash)) == 1
    # Both effects landed, but the dashboard heard nothing: not counted yet.
    assert kube.nodes["n1"]["unschedulable"] and dash.posts == []
    writes = len(kube.writes)
    assert kube_run(kube, dash) == 0
    assert len(kube.writes) == writes
    assert [b["state"] for _, b in dash.posts] == ["drained"]


def test_a_node_that_times_out_listing_pods_is_not_reported_out(kube_run):
    import subprocess

    kube = k8s.FakeKube({"n1": k8s.node()})

    def slow_pod_list(*args, input=None):
        if args[:2] == ("get", "pods"):
            raise subprocess.TimeoutExpired("kubectl", 20)
        return kube(*args, input=input)

    dash = k8s.FakeDashboard([k8s.want("n1", "quarantining")])
    assert kube_run(slow_pod_list, dash) == 1
    assert dash.posts == []
    assert kube_run(kube, dash) == 0
    assert dash.posts[0][1]["state"] == "drained"


def test_a_run_that_dies_before_lifting_the_cordon_finishes_on_later_runs(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True)}, checks=dict(k8s.PASSED))
    dash = k8s.FakeDashboard([k8s.want("n1", "resolving")])
    kube.fail = {"patch"}
    assert kube_run(kube, dash) == 1
    # The check passed and the taint is off, but the cordon is still ours and
    # on: the host is not back, and nothing says it is.
    assert kube.nodes["n1"]["unschedulable"] is True
    assert not any(t["key"] == k8s.KEY for t in kube.nodes["n1"]["taints"])
    assert dash.posts == []
    kube.fail = set()
    # The check pod was spent, so the next run checks again before returning.
    assert kube_run(kube, dash) == 0
    assert [b["state"] for _, b in dash.posts] == ["verifying"]
    assert kube.nodes["n1"]["unschedulable"] is True
    kube.checks[k8s.CHECK] = {"phase": "Succeeded"}
    assert kube_run(kube, dash) == 0
    assert dash.posts[-1][1]["state"] == "returned"
    assert kube.nodes["n1"] == k8s.node()


def test_a_lost_returned_post_is_sent_again_without_touching_the_node(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True)}, checks=dict(k8s.PASSED))
    dash = k8s.FakeDashboard([k8s.want("n1", "resolving")])
    assert kube_run(kube, lose_posts(dash)) == 1
    assert kube.nodes["n1"] == k8s.node()
    kube.writes.clear()
    assert kube_run(kube, dash) == 0
    assert kube.writes == [] and kube.created == []
    assert dash.posts == [("n1", {"alertId": 7, "state": "returned",
                                  "observed": {"cordoned": False, "tainted": False}})]


def test_an_actuator_restarted_mid_check_neither_repeats_nor_skips_it(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True)})
    dash = k8s.FakeDashboard([k8s.want("n1", "resolving")])
    assert kube_run(kube, dash) == 0  # a new process each run: the pod is the state
    assert len(kube.created) == 1
    assert kube_run(kube, dash) == 0
    assert len(kube.created) == 1
    assert [b["state"] for _, b in dash.posts] == ["verifying", "verifying"]
    assert kube.nodes["n1"]["unschedulable"] is True
    kube.checks[k8s.CHECK]["phase"] = "Succeeded"
    assert kube_run(kube, dash) == 0
    assert dash.posts[-1][1] == {"alertId": 7, "state": "returned",
                                 "observed": {"cordoned": False, "tainted": False}}
    assert len(kube.created) == 1


@pytest.mark.parametrize("stage", ["quarantined", "resolve_requested", "resolving"])
def test_a_node_that_leaves_the_cluster_is_never_reported_back(kube_run, stage):
    kube = k8s.FakeKube({"n2": k8s.node()})
    dash = k8s.FakeDashboard([k8s.want("gone", stage), k8s.want("n2", "quarantining")])
    assert kube_run(kube, dash) == 1
    # The other node is still handled, and the missing one says nothing.
    assert [h for h, _ in dash.posts] == ["n2"]
    assert all("gone" not in w for w in kube.writes)


def test_a_stage_it_does_not_know_fails_the_run_and_touches_nothing(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True)})
    dash = k8s.FakeDashboard([k8s.want("n1", "evicted")])
    assert kube_run(kube, dash) == 1
    assert kube.writes == [] and dash.posts == []


@pytest.mark.parametrize("missing", ["REPORT_URL", "CLUSTER"])
def test_missing_settings_fail_the_run_before_any_call(kube_run, monkeypatch, missing):
    monkeypatch.setattr(kube_run.mod, missing, "")
    kube = k8s.FakeKube({"n1": k8s.node()})
    dash = k8s.FakeDashboard([k8s.want("n1", "quarantining")])
    assert kube_run(kube, dash) == 1
    assert kube.writes == [] and dash.posts == []


def test_only_a_tainted_node_outside_the_desired_set_is_warned_about(kube_run, capsys):
    kube = k8s.FakeKube({"tainted": k8s.node(True, True), "plain": k8s.node(),
                         "wanted": k8s.node(True, True)})
    dash = k8s.FakeDashboard([k8s.want("wanted", "quarantined")])
    assert kube_run(kube, dash) == 0
    err = capsys.readouterr().err
    assert "tainted carries" in err and "plain" not in err and "wanted carries" not in err


def test_a_malformed_desired_set_changes_nothing(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True)})

    def odd(method, path, body=None):
        return {"hosts": []}

    assert kube_run(kube, odd) == 1
    assert kube.writes == []


def test_a_kubernetes_api_outage_changes_nothing(kube_run):
    def down(*args, input=None):
        raise RuntimeError("kubectl get nodes failed: connection refused")

    dash = k8s.FakeDashboard([k8s.want("n1", "quarantining")])
    with pytest.raises(RuntimeError, match="connection refused"):
        kube_run(down, dash)
    assert dash.posts == []


def test_a_person_uncordoning_our_node_is_drift_and_resolve_still_lifts_our_mark(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True)})
    kube.nodes["n1"]["unschedulable"] = False  # by hand; our mark stays
    dash = k8s.FakeDashboard([k8s.want("n1", "quarantined")])
    assert kube_run(kube, dash) == 0
    assert kube.nodes["n1"]["unschedulable"] is True
    assert dash.posts[0][1]["observed"]["reapplied"] is True
    # Uncordoned by hand again, then resolved: nothing of ours is left over.
    kube.nodes["n1"]["unschedulable"] = False
    kube.checks = dict(k8s.PASSED)
    back = k8s.FakeDashboard([k8s.want("n1", "resolving")])
    assert kube_run(kube, back) == 0
    assert kube.nodes["n1"] == k8s.node()
    assert back.posts[0][1]["state"] == "returned"
    assert "note" not in back.posts[0][1]["observed"]


def test_a_stale_failed_check_pod_is_not_taken_for_the_next_resolves_check(kube_run):
    # The failure was posted, but deleting its pod then failed. The worker
    # moved the episode back to quarantined (the report stays 'verify_failed'),
    # and a person fixed the host and resolved again (the dashboard clears the
    # report). The old pod is a previous attempt: it must not fail this one.
    kube = k8s.FakeKube({"n1": k8s.node(True, True)}, checks={k8s.CHECK: {
        "phase": "Failed", "logs": "| Memory | Fail - GPU 3 |\n"}})
    first = k8s.FakeDashboard([k8s.want("n1", "resolving")])
    real = kube.__call__

    def delete_fails(*args, input=None):
        if args[:2] == ("delete", "pod"):
            raise RuntimeError("kubectl delete failed: timeout")
        return real(*args, input=input)

    assert kube_run(delete_fails, first) == 1
    assert [b["state"] for _, b in first.posts] == ["verify_failed"]
    # Back in quarantined (still carrying the failed report), or still in
    # resolving before the worker has moved it: the leftover pod is cleaned up.
    for stage in ("resolving", "quarantined"):
        kube.checks = {k8s.CHECK: {"phase": "Failed", "logs": "old\n"}}
        waiting = k8s.FakeDashboard([dict(k8s.want("n1", stage),
                                          actuatorState="verify_failed")])
        assert kube_run(kube, waiting) == 0
        assert kube.checks == {}, stage
        assert [b["state"] for _, b in waiting.posts] == (
            [] if stage == "resolving" else ["drained"])
    again = k8s.FakeDashboard([dict(k8s.want("n1", "resolving"), actuatorState=None)])
    assert kube_run(kube, again) == 0
    assert [b["state"] for _, b in again.posts] == ["verifying"]
    assert len(kube.created) == 1


def test_a_resolve_that_lands_before_the_cleanup_never_reads_the_old_pod(kube_run, capsys):
    # The failure was posted but its pod's delete failed, and a person resolved
    # again before any cleanup ran: the resolve clears the failed report, so
    # only the pod's own stamp says it belongs to the earlier resolve.
    kube = k8s.FakeKube({"n1": k8s.node(True, True)})
    first = k8s.FakeDashboard([dict(k8s.want("n1", "resolving"),
                                    resolveRequestedAt="2026-10-21T10:00:00+00:00")])
    assert kube_run(kube, first) == 0
    assert kube.created[0]["metadata"]["annotations"] == {
        "vllm-quarantine/resolve-requested-at": "2026-10-21T10:00:00+00:00"}
    kube.checks[k8s.CHECK].update(phase="Failed", logs="| Memory | Fail |\n")
    real = kube.__call__
    broken = [True]

    def delete_fails(*args, input=None):
        if broken[0] and args[:2] == ("delete", "pod"):
            raise RuntimeError("kubectl delete failed: timeout")
        return real(*args, input=input)

    assert kube_run(delete_fails, first) == 1
    assert [b["state"] for _, b in first.posts] == ["verifying", "verify_failed"]
    again = k8s.FakeDashboard([dict(k8s.want("n1", "resolving"), actuatorState=None,
                                    resolveRequestedAt="2026-10-21T11:00:00+00:00")])
    # While the delete keeps failing, the old result is never reported.
    assert kube_run(delete_fails, again) == 1
    assert again.posts == [] and k8s.CHECK in kube.checks
    broken[0] = False
    capsys.readouterr()
    writes = len(kube.writes)
    assert kube_run(delete_fails, again) == 0
    assert again.posts == [] and k8s.CHECK not in kube.checks
    assert kube.writes[writes:] == [k8s.DELETE_CHECK + ("--wait=false",)]
    assert "  n1: check pod is from an earlier resolve; removing it\n" in (
        capsys.readouterr().out)
    # The next run starts this resolve's own check.
    assert kube_run(delete_fails, again) == 0
    assert [b["state"] for _, b in again.posts] == ["verifying"]
    assert kube.created[-1]["metadata"]["annotations"] == {
        "vllm-quarantine/resolve-requested-at": "2026-10-21T11:00:00+00:00"}


def test_a_failed_cleanup_is_retried_until_it_works_before_the_node_reports(kube_run):
    # The node's own post replaces the failed report the cleanup keys on, so a
    # cleanup that fails must hold the post back; otherwise it is never retried.
    kube = k8s.FakeKube({"n1": k8s.node(True, True)}, checks={k8s.CHECK: {
        "phase": "Failed", "logs": "old\n"}})
    real = kube.__call__
    broken = [True]

    def lookup_fails(*args, input=None):
        if broken[0] and args[:2] == ("get", "pod"):
            raise RuntimeError("kubectl get pod failed: connection refused")
        return real(*args, input=input)

    dash = k8s.FakeDashboard([dict(k8s.want("n1", "quarantined"),
                                   actuatorState="verify_failed")])
    for _ in range(3):
        assert kube_run(lookup_fails, dash) == 1
    assert dash.posts == [] and k8s.CHECK in kube.checks
    broken[0] = False
    assert kube_run(lookup_fails, dash) == 0
    assert kube.checks == {}
    assert [b["state"] for _, b in dash.posts] == ["drained"]


def test_a_node_without_a_failed_check_never_looks_for_a_check_pod(kube_run):
    # The cleanup is for a failed check only; every other live node would pay
    # a pod lookup per run, and a lookup error would hold back its report.
    kube = k8s.FakeKube({"n1": k8s.node(True, True)})
    lookups = []

    def watched(*args, input=None):
        if args[:3] == ("get", "pod", k8s.CHECK):
            lookups.append(args)
        return kube(*args, input=input)

    for state in (None, "out", "drained"):
        dash = k8s.FakeDashboard([dict(k8s.want("n1", "quarantined"),
                                       actuatorState=state)])
        assert kube_run(watched, dash) == 0
    assert lookups == []


def test_a_pod_still_visible_after_its_delete_holds_the_report_back(kube_run, capsys):
    # `delete --wait=false` returns before the pod is gone. The node's post
    # would replace the failed report and end the retries while the old pod
    # still stands, so it waits until the pod is really gone.
    kube = k8s.FakeKube({"n1": k8s.node(True, True)}, checks={k8s.CHECK: {
        "phase": "Failed", "logs": "old\n"}})
    real = kube.__call__
    pending = []

    def slow_delete(*args, input=None):
        if args[:2] == ("delete", "pod"):
            pending.append(args)  # accepted, but the pod lingers
            return ""
        return real(*args, input=input)

    dash = k8s.FakeDashboard([dict(k8s.want("n1", "quarantined"),
                                   actuatorState="verify_failed")])
    assert kube_run(slow_delete, dash) == 0
    assert pending == [k8s.DELETE_CHECK + ("--wait=false",)] and dash.posts == []
    assert "  n1: failed check pod still deleting; report held back\n" in (
        capsys.readouterr().out)
    assert kube_run(slow_delete, dash) == 0  # still there: delete again, no post
    assert dash.posts == []
    kube.checks.clear()  # the pod finally goes
    assert kube_run(slow_delete, dash) == 0
    assert [b["state"] for _, b in dash.posts] == ["drained"]


def test_a_dry_run_skips_the_leftover_pod_cleanup_and_other_nodes_still_run(kube_run):
    kube = k8s.FakeKube({"n1": k8s.node(True, True), "n2": k8s.node()},
                        checks={k8s.CHECK: {"phase": "Failed", "logs": "old\n"}})
    dash = k8s.FakeDashboard([dict(k8s.want("n1", "quarantined"),
                                   actuatorState="verify_failed")])
    assert kube_run(kube, dash, "--dry-run") == 0
    assert k8s.CHECK in kube.checks and kube.writes == [] and dash.posts == []
    # A node whose cleanup lookup fails does not stop the node after it.
    def lookup_fails(*args, input=None):
        if args[:3] == ("get", "pod", k8s.CHECK):
            raise RuntimeError("kubectl get pod failed: connection refused")
        return kube(*args, input=input)
    dash = k8s.FakeDashboard([dict(k8s.want("n1", "quarantined"),
                                   actuatorState="verify_failed"),
                              k8s.want("n2", "quarantining")])
    assert kube_run(lookup_fails, dash) == 1
    assert [h for h, _ in dash.posts] == ["n2"]


# ------------------------------------------------------------------ H200 pauser


class Clock:
    def __init__(self, start):
        self.t = start

    def __call__(self):
        return self.t


@pytest.fixture()
def pause_run(monkeypatch):
    mod = load_module("quarantine_pauser_h200_fp", "quarantine-pauser-h200.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://dash.example/api/gpu/report")
    monkeypatch.setattr(mod, "BUILDKITE_TOKEN", "token")
    monkeypatch.setattr(mod, "now", lambda: h200.NOW)

    def go(bk, dash, *argv):
        monkeypatch.setattr(mod, "buildkite", bk)
        monkeypatch.setattr(mod, "http_json", dash)
        return mod.main(list(argv))
    go.mod = mod
    return go


HOST = "mithril-h200-1"
PAUSE = h200.PAUSE


def failing_on(bk, verb, agent_name, times=1):
    """Makes the Buildkite call `verb` on one agent fail its first `times`."""
    left = [times]

    def call(method, path, body=None):
        if method == "PUT" and path.endswith("/" + verb) and (
                bk.agents[path.rsplit("/", 2)[-2]]["name"] == agent_name) and left[0]:
            left[0] -= 1
            raise RuntimeError("Buildkite PUT failed: 502")
        return bk(method, path, body)
    return call


def test_a_pause_that_fails_partway_posts_nothing_and_finishes_next_run(pause_run):
    bk = h200.FakeBuildkite([h200.agent(1), h200.agent(2), h200.agent(3)])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantining")])
    assert pause_run(failing_on(bk, "pause", f"{HOST}-2"), dash) == 1
    # Not counted out: the dashboard never hears of a partly paused host.
    assert dash.posts == []
    assert [a["paused"] for a in bk.agents.values()] == [True, False, False]
    assert pause_run(bk, dash) == 0
    assert all(a["paused"] for a in bk.agents.values())
    assert [b["state"] for _, b in dash.posts] == ["drained"]
    assert dash.posts[0][1]["observed"]["paused"] == 3


def test_a_partial_pause_on_a_quarantined_host_is_flagged_as_drift_when_repaired(pause_run):
    bk = h200.FakeBuildkite([h200.agent(1, paused="ours"), h200.agent(2)])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantined")])
    assert pause_run(failing_on(bk, "pause", f"{HOST}-2"), dash) == 1
    assert dash.posts == []
    assert pause_run(bk, dash) == 0
    assert dash.posts[0][1]["observed"]["reapplied"] is True


def test_a_renewal_whose_pause_fails_leaves_the_error_and_is_repaired(pause_run):
    bk = h200.FakeBuildkite([h200.agent(1, paused="ours", minutes_ago=700)])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantined")])
    assert pause_run(failing_on(bk, "pause", f"{HOST}-1"), dash) == 1
    # Buildkite pauses only a paused agent's resume-then-pause: the resume
    # landed and the pause did not, so the agent is open until the next run.
    assert bk.agents[f"{HOST}-id-1"]["paused"] is False
    assert dash.posts == []
    assert pause_run(bk, dash) == 0
    assert bk.agents[f"{HOST}-id-1"]["paused"] is True
    assert dash.posts[0][1]["observed"]["reapplied"] is True


def test_a_pausers_lost_out_post_is_sent_again_and_nothing_is_rewritten(pause_run):
    bk = h200.FakeBuildkite([h200.agent(1, job=True)])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantining")])

    def lost(method, path, body=None):
        if method == "POST":
            raise urllib.error.URLError("connection refused")
        return dash(method, path, body)

    assert pause_run(bk, lost) == 1
    writes = len(bk.writes)
    assert pause_run(bk, dash) == 0
    assert len(bk.writes) == writes
    assert [b["state"] for _, b in dash.posts] == ["out"]


def test_a_host_with_no_connected_agents_is_pinned_drained_and_repaused_when_they_return(pause_run):
    # Nothing is connected to pause (a reboot, a network drop): the host is
    # out of CI by itself, so it reads drained. Whatever registers later is
    # paused on the next run and flagged as drift.
    bk = h200.FakeBuildkite([h200.agent(1, connected=False)])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantined")])
    assert pause_run(bk, dash) == 0
    assert dash.posts[0][1] == {"alertId": 7, "state": "drained", "observed": {
        "agents": 0, "paused": 0, "busy": 0, "reapplied": False}}
    assert bk.writes == []
    bk.agents["new-id"] = h200.agent(2)
    bk.agents["new-id"]["id"] = "new-id"
    assert pause_run(bk, dash) == 0
    assert bk.writes == [("pause", f"{HOST}-2", PAUSE)]
    assert dash.posts[-1][1]["observed"]["reapplied"] is True


def test_a_new_agent_id_replacing_our_paused_one_is_paused_and_the_old_one_untouched(pause_run):
    old = h200.agent(1, paused="ours", connected=False)
    new = h200.agent(2)
    bk = h200.FakeBuildkite([old, new])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantined")])
    assert pause_run(bk, dash) == 0
    assert bk.writes == [("pause", f"{HOST}-2", PAUSE)]
    assert dash.posts[0][1]["observed"] == {
        "agents": 1, "paused": 1, "busy": 0, "reapplied": True}


def test_a_new_agent_during_the_return_is_left_for_the_worker_to_close(pause_run):
    # 'verified' lifts only our pauses; an agent that registered since was
    # never paused, so there is nothing of it to undo.
    bk = h200.FakeBuildkite([h200.agent(1, paused="ours"), h200.agent(2)])
    dash = h200.FakeDashboard([h200.want(HOST, "resolving", "verified")])
    assert pause_run(bk, dash) == 0
    assert bk.writes == [("resume", f"{HOST}-1", {})]
    assert dash.posts[0][1] == {"alertId": 7, "state": "returned",
                                "observed": {"paused": False}}


def test_a_resolve_that_lost_the_race_to_the_return_does_nothing(pause_run):
    # The worker closed the episode: the desired set no longer lists it, and
    # a stale pause of ours is not the pauser's to chase.
    bk = h200.FakeBuildkite([h200.agent(1, paused="ours")])
    assert pause_run(bk, h200.FakeDashboard([])) == 0
    assert bk.writes == []


def test_a_hold_longer_than_the_pause_timeout_never_lets_a_job_in(pause_run, monkeypatch):
    # 14 hours of one-minute runs against a Buildkite that really lifts a pause
    # when its timeout is up: our renewal in the last hour must beat it.
    clock = Clock(h200.NOW)
    monkeypatch.setattr(pause_run.mod, "now", clock)
    stamp = "%Y-%m-%dT%H:%M:%S.000Z"

    class TimedBuildkite(h200.FakeBuildkite):
        def __call__(self, method, path, body=None):
            result = super().__call__(method, path, body)
            if method == "PUT" and path.endswith("/pause"):
                agent = self.agents[path.rsplit("/", 2)[-2]]
                agent["paused_at"] = clock().strftime(stamp)
            return result

        def expire(self):
            for a in self.agents.values():
                if a["paused"]:
                    paused = datetime.datetime.strptime(
                        a["paused_at"][:19], "%Y-%m-%dT%H:%M:%S"
                    ).replace(tzinfo=datetime.timezone.utc)
                    limit = datetime.timedelta(minutes=a["paused_timeout_in_minutes"])
                    if clock() - paused >= limit:
                        a.update(paused=False, paused_at=None, paused_note=None)

    bk = TimedBuildkite([h200.agent(1), h200.agent(2, job=True)])
    dash = h200.FakeDashboard([h200.want(HOST, "quarantined")])
    assert pause_run(bk, dash) == 0  # the first run pauses both
    open_minutes = 0
    for _ in range(14 * 60):
        clock.t += datetime.timedelta(minutes=1)
        bk.expire()
        open_minutes += sum(not a["paused"] for a in bk.agents.values())
        assert pause_run(bk, dash) == 0
    assert open_minutes == 0
    assert all(a["paused"] for a in bk.agents.values())
    assert all(b["observed"]["reapplied"] is False for _, b in dash.posts[1:])


def test_the_actuator_sends_the_reporter_secret_to_the_dashboard_host_only(monkeypatch):
    mod = load_module("quarantine_actuator_http", "quarantine-actuator-k8s.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://d.example/api/gpu/report")
    monkeypatch.setattr(mod, "REPORT_SECRET", "dash-secret")
    sent = []

    def urlopen(req, timeout):
        sent.append((req, timeout))
        return h200.FakeResponse(b'{"nodes": []}' if req.get_method() == "GET" else b"")
    monkeypatch.setattr(mod.urllib.request, "urlopen", urlopen)
    assert mod.http_json("GET", "/api/x") == {"nodes": []}
    assert mod.http_json("POST", "/api/y", {"a": 1}) == {}
    mod.REPORT_SECRET = ""
    mod.http_json("GET", "/api/z")
    (get, t), (post, _), (bare, _) = sent
    assert (get.full_url, get.get_method(), get.data, t) == (
        "https://d.example/api/x", "GET", None, 15)
    assert get.headers == {"Content-type": "application/json",
                           "Authorization": "Bearer dash-secret"}
    assert (post.full_url, post.data) == ("https://d.example/api/y", b'{"a": 1}')
    assert "Authorization" not in bare.headers


def test_a_taint_value_is_cut_at_63_characters(kube_run):
    assert len(kube_run.mod.taint_value("x" * 80)) == 63
