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
MARK = "vllm.ci/quarantine-cordoned"


class FakeKube:
    def __init__(self, nodes, pods=None):
        self.nodes = nodes  # name -> {"unschedulable": bool, "taints": [...]}
        self.pods = pods or {}  # name -> [phase, ...] in namespace buildkite
        self.writes = []
        self.rv = {n: 1 for n in nodes}  # resourceVersion, bumped per write
        self.fail = set()  # verbs that raise, to test partial failures

    def node_json(self, n):
        s = self.nodes[n]
        return {"metadata": {"name": n, "resourceVersion": str(self.rv[n]),
                             "annotations": dict(s.get("annotations", {}))},
                "spec": {"unschedulable": s["unschedulable"],
                         "taints": list(s["taints"])}}

    def __call__(self, *args):
        if args[:2] == ("get", "nodes"):
            return json.dumps({"items": [self.node_json(n)
                                         for n in self.nodes]})
        if args[:2] == ("get", "node"):
            return json.dumps(self.node_json(args[2]))
        if args[:2] == ("get", "pods"):
            assert args[2:4] == ("-n", "buildkite")
            node = args[5].split("=", 1)[1]
            return json.dumps({"items": [
                {"status": {"phase": p}} for p in self.pods.get(node, [])]})
        verb = args[0]
        if verb in self.fail:
            raise RuntimeError(f"kubectl {verb} failed: injected")
        self.writes.append(args)
        node = args[2]  # patch node <n> / taint nodes <n>
        s = self.nodes[node]
        ann = s.setdefault("annotations", {})
        if verb == "patch":
            body = json.loads(args[-1])
            if body["metadata"]["resourceVersion"] != str(self.rv[node]):
                self.writes.pop()
                raise RuntimeError("kubectl patch node failed: Conflict")
            s["unschedulable"] = bool(body["spec"]["unschedulable"])
            for k, v in body["metadata"]["annotations"].items():
                if v is None:
                    ann.pop(k, None)
                else:
                    ann[k] = v
        elif verb == "taint" and args[3].endswith("-"):
            s["taints"] = [t for t in s["taints"] if t["key"] != KEY]
        elif verb == "taint":
            k, rest = args[3].split("=", 1)
            v, effect = rest.rsplit(":", 1)
            s["taints"].append({"key": k, "value": v, "effect": effect})
        self.rv[node] += 1
        return ""


def cordon_patch(name, rv, on):
    """The one write that cordons and marks (on) or uncordons and unmarks."""
    return ("patch", "node", name, "--type", "merge", "-p", json.dumps({
        "metadata": {"annotations": {MARK: "true" if on else None},
                     "resourceVersion": str(rv)},
        "spec": {"unschedulable": True if on else None}}, sort_keys=True))


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


def node(unschedulable=False, ours=False, other=(), marked=None):
    """marked: our cordon annotation; defaults to set when ours and cordoned."""
    taints = [{"key": k, "effect": "NoSchedule"} for k in other]
    if ours:
        taints.append({"key": KEY, "value": "xid79", "effect": "NoSchedule"})
    if marked is None:
        marked = ours and unschedulable
    return {"unschedulable": unschedulable, "taints": taints,
            "annotations": {MARK: "true"} if marked else {}}


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
        cordon_patch("n1", 1, on=True),
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
                           cordon_patch("n1", 2, on=False)]
    assert kube.nodes["n1"] == node(other=["gpu=bad"])
    assert dash.posts[0][1]["state"] == "returned"


def test_resolve_leaves_a_foreign_cordon(run):
    kube = FakeKube({"n1": node(unschedulable=True)})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == []
    body = dash.posts[0][1]
    assert body["state"] == "returned"
    assert "pre-existing cordon" in body["observed"]["note"]


def test_person_cordon_survives_quarantine_and_resolve(run):
    kube = FakeKube({"n1": node(unschedulable=True)})
    assert run(kube, FakeDashboard([want("n1", "quarantining")])) == 0
    assert kube.writes == [("taint", "nodes", "n1",
                            f"{KEY}=Xid-79-GPU-fell-off-the-bus:NoSchedule")]
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.nodes["n1"] == node(unschedulable=True)  # cordoned, no taint
    body = dash.posts[0][1]
    assert body["state"] == "returned" and body["observed"]["cordoned"]
    assert "pre-existing cordon" in body["observed"]["note"]


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
    assert len(kube.writes) == 1  # the lost cordon or the lost taint
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
    assert "DRY RUN: kubectl patch node n1" in out
    assert "DRY RUN: kubectl patch node n2" in out


def test_endpoint_down_changes_nothing_and_fails(run):
    kube = FakeKube({"n1": node(True, True)})
    assert run(kube, FakeDashboard(down=True)) == 1
    assert kube.writes == []


def test_taint_value_is_a_valid_label_value(run):
    v = run.mod.taint_value("  !!" + "x" * 80)
    assert len(v) <= 63 and v[0].isalnum() and v[-1].isalnum()
    assert run.mod.taint_value("") == "quarantine"


def test_slow_nodes_do_not_hold_up_a_new_quarantine(run):
    import threading

    # n1 and n2 are already out; their applied POSTs hang until n3, a new
    # quarantine listed after them, has been cordoned. Run serially, n3 is
    # never reached while they wait.
    n3_cordoned = threading.Event()
    waited = {}

    class Kube(FakeKube):
        def __call__(self, *args):
            out = super().__call__(*args)
            if args[:3] == ("patch", "node", "n3"):
                n3_cordoned.set()
            return out

    class Dash(FakeDashboard):
        def __call__(self, method, path, body=None):
            host = path.split("/")[-2]
            if method == "POST" and host in ("n1", "n2"):
                waited[host] = n3_cordoned.wait(timeout=5)
            return super().__call__(method, path, body)

    kube = Kube({"n1": node(True, ours=True), "n2": node(True, ours=True),
                 "n3": node()})
    dash = Dash([want("n1", "quarantined"), want("n2", "quarantined"),
                 want("n3", "quarantining")])
    assert run(kube, dash) == 0
    assert waited == {"n1": True, "n2": True}
    # Each node's own steps keep their order.
    assert [w for w in kube.writes if "n3" in w] == [
        cordon_patch("n3", 1, on=True),
        ("taint", "nodes", "n3",
         f"{KEY}=Xid-79-GPU-fell-off-the-bus:NoSchedule"),
    ]


def test_failed_cordon_patch_leaves_nothing_half_done(run):
    # The cordon and our mark are one write: when it fails neither lands,
    # and the next run applies both.
    kube = FakeKube({"n1": node()})
    kube.fail = {"patch"}
    dash = FakeDashboard([want("n1", "quarantining")])
    assert run(kube, dash) == 1
    assert kube.nodes["n1"] == node()
    kube.fail = set()
    assert run(kube, dash) == 0
    assert kube.nodes["n1"]["unschedulable"] is True
    assert kube.nodes["n1"]["annotations"] == {MARK: "true"}


def test_taint_failure_after_cordon_still_resolves_cleanly(run):
    # Cordoned and marked, but the taint failed: the next run adds the taint,
    # and resolve still knows the cordon is ours and lifts it.
    kube = FakeKube({"n1": node()})
    kube.fail = {"taint"}
    dash = FakeDashboard([want("n1", "quarantining")])
    assert run(kube, dash) == 1
    kube.fail = set()
    assert run(kube, dash) == 0
    assert any(t["key"] == KEY for t in kube.nodes["n1"]["taints"])
    resolve = FakeDashboard([want("n1", "resolving")])
    assert run(kube, resolve) == 0
    assert kube.nodes["n1"] == node()
    assert "note" not in resolve.posts[0][1]["observed"]


def test_cordon_by_a_person_mid_run_is_never_marked_ours(run):
    # The node changes after the actuator read it (a person cordons it):
    # the guarded patch is rejected, and the next run sees a cordon that
    # isn't ours and leaves the mark off.
    kube = FakeKube({"n1": node()})
    real = kube.__call__

    def racing(*args):
        if args[0] == "patch":
            kube.nodes["n1"]["unschedulable"] = True
            kube.rv["n1"] += 1
        return real(*args)

    dash = FakeDashboard([want("n1", "quarantining")])
    assert run(racing, dash) == 1
    assert kube.nodes["n1"]["annotations"] == {}
    assert run(kube, dash) == 0
    assert kube.nodes["n1"]["annotations"] == {}
    resolve = FakeDashboard([want("n1", "resolving")])
    assert run(kube, resolve) == 0
    assert kube.nodes["n1"]["unschedulable"] is True  # the person's cordon
    assert "pre-existing cordon" in resolve.posts[0][1]["observed"]["note"]
