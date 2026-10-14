"""Tests for the K8s quarantine actuator (quarantine-actuator-k8s.py).

kubectl and the dashboard are faked: FakeKube keeps node state and answers
the few kubectl calls the actuator makes; FakeDashboard serves the desired
set and records posts.
"""

import json
import urllib.error

import pytest

from conftest import load_module

KEY = "vllm.ci/quarantine"


class FakeKube:
    def __init__(self, nodes, pods=None):
        self.nodes = nodes  # name -> {"unschedulable": bool, "taints": [...]}
        self.pods = pods or {}  # name -> [phase, ...] in namespace buildkite
        self.writes = []

    def __call__(self, *args):
        if args[:2] == ("get", "nodes"):
            return json.dumps({"items": [
                {"metadata": {"name": n},
                 "spec": {"unschedulable": s["unschedulable"],
                          "taints": list(s["taints"])}}
                for n, s in self.nodes.items()]})
        if args[:2] == ("get", "pods"):
            assert args[2:4] == ("-n", "buildkite")
            node = args[5].split("=", 1)[1]
            return json.dumps({"items": [
                {"status": {"phase": p}} for p in self.pods.get(node, [])]})
        self.writes.append(args)
        verb, node = args[0], args[-1] if args[0] != "taint" else args[2]
        s = self.nodes[node]
        if verb == "cordon":
            s["unschedulable"] = True
        elif verb == "uncordon":
            s["unschedulable"] = False
        elif verb == "taint" and args[3].endswith("-"):
            s["taints"] = [t for t in s["taints"] if t["key"] != KEY]
        elif verb == "taint":
            k, rest = args[3].split("=", 1)
            v, effect = rest.rsplit(":", 1)
            s["taints"].append({"key": k, "value": v, "effect": effect})
        return ""


class FakeDashboard:
    def __init__(self, desired=None, down=False):
        self.desired, self.down, self.posts = desired or [], down, []

    def __call__(self, method, path, body=None):
        if self.down:
            raise urllib.error.URLError("connection refused")
        if method == "GET":
            assert path == "/api/alerts/quarantine/desired?cluster=h100"
            return {"nodes": self.desired}
        self.posts.append((path.split("/")[-2], body))
        return {}


def node(unschedulable=False, ours=False, other=()):
    taints = [{"key": k, "effect": "NoSchedule"} for k in other]
    if ours:
        taints.append({"key": KEY, "value": "xid79", "effect": "NoSchedule"})
    return {"unschedulable": unschedulable, "taints": taints}


def want(host, stage, reason="Xid 79: GPU fell off the bus"):
    return {"host": host, "alertId": 7, "stage": stage, "reason": reason}


@pytest.fixture()
def run(monkeypatch):
    mod = load_module("quarantine_actuator_k8s", "quarantine-actuator-k8s.py")
    monkeypatch.setattr(mod, "REPORT_URL", "https://dash.example/api/gpu/report")
    monkeypatch.setattr(mod, "CLUSTER", "h100")

    def go(kube, dash, *argv):
        monkeypatch.setattr(mod, "kubectl", kube)
        monkeypatch.setattr(mod, "http_json", dash)
        return mod.main(list(argv))
    go.mod = mod
    return go


def test_apply_cordons_and_taints_then_posts_out(run):
    kube = FakeKube({"n1": node()}, pods={"n1": ["Running", "Succeeded"]})
    dash = FakeDashboard([want("n1", "quarantining")])
    assert run(kube, dash) == 0
    assert kube.writes == [
        ("cordon", "n1"),
        ("taint", "nodes", "n1",
         f"{KEY}=Xid-79-GPU-fell-off-the-bus:NoSchedule"),
    ]
    assert dash.posts == [("n1", {"alertId": 7, "state": "out", "observed": {
        "cordoned": True, "tainted": True, "ciPods": 1, "reapplied": False}})]
    # Second run is idempotent: nothing new to write.
    kube.writes.clear()
    assert run(kube, dash) == 0
    assert kube.writes == []


def test_drained_once_no_ci_pod_runs_or_waits(run):
    kube = FakeKube({"n1": node(True, True)},
                    pods={"n1": ["Succeeded", "Failed"]})
    dash = FakeDashboard([want("n1", "quarantining")])
    assert run(kube, dash) == 0
    assert kube.writes == []
    assert dash.posts[0][1]["state"] == "drained"
    assert dash.posts[0][1]["observed"]["ciPods"] == 0


def test_resolve_with_our_taint_returns_node(run):
    kube = FakeKube({"n1": node(True, True, other=["gpu=bad"])})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == [("taint", "nodes", "n1", f"{KEY}:NoSchedule-"),
                           ("uncordon", "n1")]
    assert kube.nodes["n1"] == node(other=["gpu=bad"])
    assert dash.posts[0][1]["state"] == "returned"


def test_resolve_leaves_a_foreign_cordon(run):
    kube = FakeKube({"n1": node(unschedulable=True)})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == []
    body = dash.posts[0][1]
    assert body["state"] == "out" and "person" in body["observed"]["note"]


def test_resolve_already_schedulable_posts_returned(run):
    kube = FakeKube({"n1": node()})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == []
    assert dash.posts[0][1]["state"] == "returned"


@pytest.mark.parametrize("before", [node(False, True), node(True, False)])
def test_drift_reapplies_and_flags(run, before):
    kube = FakeKube({"n1": before})
    dash = FakeDashboard([want("n1", "quarantined")])
    assert run(kube, dash) == 0
    assert len(kube.writes) == 1
    assert kube.nodes["n1"]["unschedulable"]
    assert run.mod.our_taint({"spec": kube.nodes["n1"]})
    assert dash.posts[0][1]["observed"]["reapplied"] is True


def test_untracked_taint_and_would_are_left_alone(run, capsys):
    kube = FakeKube({"n1": node(True, True), "n2": node()})
    dash = FakeDashboard([want("n2", "would")])
    assert run(kube, dash) == 0
    assert kube.writes == [] and dash.posts == []
    out = capsys.readouterr()
    assert "would quarantine n2" in out.out
    assert "n1 carries" in out.err


def test_dry_run_changes_nothing(run, capsys):
    kube = FakeKube({"n1": node(), "n2": node(True, True)})
    dash = FakeDashboard([want("n1", "quarantining"), want("n2", "resolving")])
    assert run(kube, dash, "--dry-run") == 0
    assert kube.writes == [] and dash.posts == []
    out = capsys.readouterr().out
    assert "DRY RUN: kubectl cordon n1" in out
    assert "DRY RUN: kubectl uncordon n2" in out


def test_endpoint_down_changes_nothing_and_fails(run):
    kube = FakeKube({"n1": node(True, True)})
    assert run(kube, FakeDashboard(down=True)) == 1
    assert kube.writes == []


def test_taint_value_is_a_valid_label_value(run):
    v = run.mod.taint_value("  !!" + "x" * 80)
    assert len(v) <= 63 and v[0].isalnum() and v[-1].isalnum()
    assert run.mod.taint_value("") == "quarantine"
