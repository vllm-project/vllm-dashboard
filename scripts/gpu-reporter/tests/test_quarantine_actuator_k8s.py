"""Tests for the K8s quarantine actuator (quarantine-actuator-k8s.py).

kubectl and the dashboard are faked: FakeKube keeps node state and answers
the few kubectl calls the actuator makes; FakeDashboard serves the desired
set and records posts.
"""

import datetime
import json
import urllib.error

import pytest

from conftest import load_module

KEY = "vllm.ci/quarantine"
MARK = "vllm.ci/quarantine-cordoned"


class FakeKube:
    def __init__(self, nodes, pods=None, checks=None):
        self.nodes = nodes  # name -> {"unschedulable": bool, "taints": [...]}
        self.pods = pods or {}  # name -> [phase, ...] in namespace buildkite
        # Return-check pods: pod name -> {phase, age, logs, reason, message};
        # no logs means the pod never ran and kubectl logs fails.
        self.checks = checks or {}
        self.created = []  # return-check pod specs, as created
        self.writes = []
        self.rv = {n: 1 for n in nodes}  # resourceVersion, bumped per write
        self.fail = set()  # verbs that raise, to test partial failures

    def node_json(self, n):
        s = self.nodes[n]
        return {"metadata": {"name": n, "resourceVersion": str(self.rv[n]),
                             "annotations": dict(s.get("annotations", {}))},
                "spec": {"unschedulable": s["unschedulable"],
                         "taints": list(s["taints"])},
                "status": {"capacity": {"nvidia.com/gpu": "8"},
                           "allocatable": {
                               "nvidia.com/gpu": s.get("allocatable", "8")}
                           if s.get("allocatable", "8") is not None else {}}}

    def check_call(self, args, input):
        """The return-check pod calls; None when args are not one."""
        if args[:2] == ("get", "pod"):
            assert args[3:] == ("-n", "vllm-quarantine-verify", "-o", "json")
            check = self.checks.get(args[2])
            if check is None:
                raise RuntimeError(
                    f'kubectl get pod {args[2]} failed: Error from server '
                    f'(NotFound): pods "{args[2]}" not found')
            created = (datetime.datetime.now(datetime.timezone.utc)
                       - check.get("age", datetime.timedelta(minutes=2)))
            return json.dumps({
                "metadata": {"creationTimestamp":
                             created.strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "annotations": dict(check.get("annotations", {}))},
                "status": {k: check[k] for k in ("phase", "reason", "message")
                           if k in check}})
        if args[0] == "logs":
            assert args[2:] == ("-n", "vllm-quarantine-verify", "--tail=20")
            if "logs" not in self.checks[args[1]]:
                raise RuntimeError("kubectl logs failed: container not started")
            return self.checks[args[1]]["logs"]
        if args[0] == "create":
            self.writes.append(args)
            spec = json.loads(input)
            self.created.append(spec)
            self.checks[spec["metadata"]["name"]] = {
                "phase": "Pending",
                "annotations": spec["metadata"].get("annotations", {})}
            return ""
        if args[:2] == ("delete", "pod"):
            self.writes.append(args)
            del self.checks[args[2]]
            return ""
        return None

    def __call__(self, *args, input=None):
        checked = self.check_call(args, input)
        if checked is not None:
            return checked
        if args[:2] == ("get", "nodes"):
            return json.dumps({"items": [self.node_json(n)
                                         for n in self.nodes]})
        if args[:2] == ("get", "node"):
            return json.dumps(self.node_json(args[2]))
        if args[:2] == ("get", "pods"):
            assert args[2:4] == ("-n", "buildkite")
            node = args[5].split("=", 1)[1]
            return json.dumps({"items": [
                {"metadata": {"name": f"ci-{i}", "annotations": {
                    "buildkite.com/job-url": f"https://buildkite.com/j/{i}"}},
                 "status": {"phase": p}}
                for i, p in enumerate(self.pods.get(node, []))]})
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


CHECK = "vllm-quarantine-verify-n1"
PASSED = {CHECK: {"phase": "Succeeded"}}
DELETE_CHECK = ("delete", "pod", CHECK, "-n", "vllm-quarantine-verify")


def test_resolve_with_our_taint_returns_node(run):
    kube = FakeKube({"n1": node(True, True, other=["gpu=bad"])},
                    checks=dict(PASSED))
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == [DELETE_CHECK,
                           ("taint", "nodes", "n1", f"{KEY}:NoSchedule-"),
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
    kube.checks = dict(PASSED)
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


@pytest.mark.parametrize("stage", ["quarantined", "resolve_requested"])
@pytest.mark.parametrize("before", [node(False, True), node(True, False)])
def test_drift_reapplies_and_flags(run, before, stage):
    # resolve_requested waits on a clean reading: the node stays out.
    kube = FakeKube({"n1": json.loads(json.dumps(before))})
    dash = FakeDashboard([want("n1", stage)])
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
    assert "DRY RUN: would run the return check on n2" in out
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
        def __call__(self, *args, input=None):
            out = super().__call__(*args, input=input)
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
    kube.checks = dict(PASSED)
    assert run(kube, resolve) == 0
    assert kube.nodes["n1"] == node()
    assert "note" not in resolve.posts[0][1]["observed"]


def test_cordon_by_a_person_mid_run_is_never_marked_ours(run):
    # The node changes after the actuator read it (a person cordons it):
    # the guarded patch is rejected, and the next run sees a cordon that
    # isn't ours and leaves the mark off.
    kube = FakeKube({"n1": node()})
    real = kube.__call__

    def racing(*args, input=None):
        if args[0] == "patch":
            kube.nodes["n1"]["unschedulable"] = True
            kube.rv["n1"] += 1
        return real(*args, input=input)

    dash = FakeDashboard([want("n1", "quarantining")])
    assert run(racing, dash) == 1
    assert kube.nodes["n1"]["annotations"] == {}
    assert run(kube, dash) == 0
    assert kube.nodes["n1"]["annotations"] == {}
    resolve = FakeDashboard([want("n1", "resolving")])
    kube.checks = dict(PASSED)
    assert run(kube, resolve) == 0
    assert kube.nodes["n1"]["unschedulable"] is True  # the person's cordon
    assert "pre-existing cordon" in resolve.posts[0][1]["observed"]["note"]


def test_resolve_runs_the_return_check_before_returning(run):
    kube = FakeKube({"n1": node(True, True)})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    # The check starts; the node stays out.
    assert kube.writes == [("create", "-f", "-")]
    assert kube.nodes["n1"] == node(True, True)
    assert dash.posts == [("n1", {"alertId": 7, "state": "verifying",
                                  "observed": {"phase": "Created"}})]
    assert kube.created == [{
        "apiVersion": "v1", "kind": "Pod",
        "metadata": {"name": CHECK, "namespace": "vllm-quarantine-verify",
                     "labels": {"app": "vllm-quarantine-verify"}},
        "spec": {
            "nodeName": "n1", "restartPolicy": "Never",
            "automountServiceAccountToken": False,
            "runtimeClassName": "nvidia",
            "tolerations": [{"operator": "Exists"}],
            "containers": [{
                "name": "verify",
                "image": "nvcr.io/nvidia/cloud-native/dcgm:4.4.2-1-ubuntu22.04",
                "command": ["bash", "-c", run.mod.VERIFY_SCRIPT, "verify", "2"],
                "securityContext": {"capabilities": {"add": ["SYS_ADMIN"]}},
                "resources": {"limits": {"nvidia.com/gpu": "8"}},
            }],
        },
    }]
    assert "dcgmi diag -r \"$1\"" in run.mod.VERIFY_SCRIPT

    # Still running: no change, still verifying.
    kube.checks[CHECK]["phase"] = "Running"
    dash.posts.clear()
    assert run(kube, dash) == 0
    assert kube.writes == [("create", "-f", "-")]
    assert dash.posts[0][1]["state"] == "verifying"
    assert dash.posts[0][1]["observed"] == {"phase": "Running"}

    # Passed: the pod goes and the node comes back.
    kube.checks[CHECK]["phase"] = "Succeeded"
    dash.posts.clear()
    assert run(kube, dash) == 0
    assert kube.checks == {}
    assert kube.nodes["n1"] == node()
    assert [body["state"] for _, body in dash.posts] == ["returned"]


def test_a_failed_return_check_keeps_the_node_out(run, capsys):
    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {
        "phase": "Failed",
        "logs": "0, None, No\n| Memory | Fail - GPU 3 |\nline 3\nline 4\n"}})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == [DELETE_CHECK + ("--wait=false",)]
    assert kube.nodes["n1"] == node(True, True)
    assert dash.posts == [("n1", {"alertId": 7, "state": "verify_failed",
                                  "observed": {"note": (
                                      "| Memory | Fail - GPU 3 | / line 3 / "
                                      "line 4")}})]

    assert "n1: return check failed: | Memory" in capsys.readouterr().out

    # Until a person resolves again, no new check starts.
    failed = dict(want("n1", "resolving"), actuatorState="verify_failed")
    dash = FakeDashboard([failed])
    kube.writes.clear()
    assert run(kube, dash) == 0
    assert kube.writes == [] and dash.posts == []
    assert ("n1 failed its return check; waiting for a resolve"
            in capsys.readouterr().out)


@pytest.mark.parametrize("logs, note", [
    ("", "no output"),
    ("x" * 400, "x" * 300),
])
def test_a_failure_note_is_never_empty_or_long(run, logs, note):
    kube = FakeKube({"n1": node(True, True)},
                    checks={CHECK: {"phase": "Failed", "logs": logs}})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert dash.posts[0][1]["observed"] == {"note": note}


def test_a_check_pod_the_kubelet_rejected_fails_with_its_reason(run):
    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {
        "phase": "Failed", "reason": "OutOfnvidia.com/gpu",
        "message": "Node didn't have enough resource"}})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == [DELETE_CHECK + ("--wait=false",)]
    assert dash.posts[0][1]["observed"] == {
        "note": "OutOfnvidia.com/gpu Node didn't have enough resource"}

    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {"phase": "Failed"}})
    assert run(kube, dash) == 0
    assert dash.posts[-1][1]["observed"] == {"note": "no output"}


def test_the_check_waits_for_ci_pods_to_finish_and_names_them(run, capsys):
    # It reports the wait every run, so the dashboard can name a job that
    # holds the node too long.
    kube = FakeKube({"n1": node(True, True)},
                    pods={"n1": ["Running", "Failed", "Pending"]})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.created == [] and kube.writes == []
    note = ("waiting for 2 CI job(s) to finish: https://buildkite.com/j/0, "
            "https://buildkite.com/j/2")
    assert dash.posts == [("n1", {"alertId": 7, "state": "out",
                                  "observed": {"ciPods": 2, "note": note}})]
    assert f"  n1: {note}\n" in capsys.readouterr().out


def test_a_long_ci_wait_note_names_three_jobs_and_fits(run):
    kube = FakeKube({"n1": node(True, True)}, pods={"n1": ["Running"] * 4})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    note = dash.posts[0][1]["observed"]["note"]
    assert note == ("waiting for 4 CI job(s) to finish: https://buildkite.com/j/0, "
                    "https://buildkite.com/j/1, https://buildkite.com/j/2, ...")


def test_a_ci_wait_note_lists_up_to_three_jobs_by_url_or_pod_name():
    mod = load_module("quarantine_actuator_k8s", "quarantine-actuator-k8s.py")
    url = {"buildkite.com/job-url": "https://buildkite.com/j/0"}
    pods = [{"metadata": {"name": "ci-0", "annotations": url}},
            {"metadata": {"name": "ci-1", "annotations": None}},
            {"metadata": {"name": "ci-2"}}]
    assert mod.ci_wait_note(pods) == (
        "waiting for 3 CI job(s) to finish: https://buildkite.com/j/0, ci-1, ci-2")


def test_a_failed_check_keeps_its_pod_until_the_dashboard_has_it(run):
    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {
        "phase": "Failed", "logs": "| Memory | Fail - GPU 3 |\n"}})
    dash = FakeDashboard([want("n1", "resolving")])
    real = dash.__call__

    def post_fails(method, path, body=None):
        if method == "POST":
            raise urllib.error.URLError("connection refused")
        return real(method, path, body)

    assert run(kube, post_fails) == 1
    assert kube.writes == [] and CHECK in kube.checks
    # The next run reports the same failure from the pod, then deletes it.
    assert run(kube, dash) == 0
    assert kube.created == []
    assert kube.writes == [DELETE_CHECK + ("--wait=false",)]
    assert [b["state"] for _, b in dash.posts] == ["verify_failed"]


def test_a_gpu_the_device_plugin_dropped_fails_the_check(run, capsys):
    kube = FakeKube({"n1": dict(node(True, True), allocatable="7")})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.created == [] and kube.writes == []
    assert dash.posts == [("n1", {"alertId": 7, "state": "verify_failed",
                                  "observed": {"note": "only 7 of 8 GPUs are usable"}})]
    assert ("  n1: return check failed: only 7 of 8 GPUs are usable\n"
            in capsys.readouterr().out)

    # A plugin that dropped the resource entirely is the same failure.
    kube = FakeKube({"n1": dict(node(True, True), allocatable=None)})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert dash.posts[0][1]["observed"] == {"note": "only 0 of 8 GPUs are usable"}


def test_a_check_that_passes_after_its_timeout_still_fails(run):
    # The timeout's failure post was lost and the pod went on to pass; that
    # attempt already failed, so the node stays out.
    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {
        "phase": "Succeeded", "age": datetime.timedelta(minutes=31)}})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.nodes["n1"] == node(True, True)
    assert dash.posts[0][1]["state"] == "verify_failed"


def test_a_return_check_that_never_finishes_fails(run):
    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {
        "phase": "Pending", "age": datetime.timedelta(minutes=30)}})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.writes == [DELETE_CHECK + ("--wait=false",)]
    assert dash.posts[0][1] == {"alertId": 7, "state": "verify_failed",
                                "observed": {"note": "did not finish in 30 "
                                             "min (Pending)"}}

    kube = FakeKube({"n1": node(True, True)}, checks={CHECK: {
        "phase": "Pending", "age": datetime.timedelta(minutes=29)}})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert dash.posts[0][1]["state"] == "verifying"


def test_a_node_that_lost_our_taint_but_kept_our_cordon_is_checked(run):
    kube = FakeKube({"n1": node(True, marked=True)})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert dash.posts[0][1]["state"] == "verifying"
    assert kube.nodes["n1"]["unschedulable"] is True


def test_the_return_check_is_skipped_for_a_node_we_never_took_out(run):
    # A held quarantine resolved before it went out: nothing to check.
    kube = FakeKube({"n1": node()})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.created == []
    assert dash.posts[0][1]["state"] == "returned"


def test_level_zero_skips_the_return_check(run, monkeypatch):
    monkeypatch.setattr(run.mod, "VERIFY_LEVEL", "0")
    kube = FakeKube({"n1": node(True, True)})
    dash = FakeDashboard([want("n1", "resolving")])
    assert run(kube, dash) == 0
    assert kube.created == []
    assert kube.nodes["n1"] == node()


def test_a_check_pod_lookup_error_changes_nothing(run):
    kube = FakeKube({"n1": node(True, True)})

    def flaky(*args, input=None):
        if args[:2] == ("get", "pod"):
            raise RuntimeError("kubectl get pod failed: connection refused")
        return kube(*args, input=input)

    dash = FakeDashboard([want("n1", "resolving")])
    assert run(flaky, dash) == 1
    assert kube.writes == [] and dash.posts == []


def test_verify_settings_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("QUARANTINE_VERIFY_LEVEL", "3")
    monkeypatch.setenv("QUARANTINE_VERIFY_IMAGE", "dcgm:test")
    mod = load_module("quarantine_actuator_k8s", "quarantine-actuator-k8s.py")
    assert (mod.VERIFY_LEVEL, mod.VERIFY_IMAGE) == ("3", "dcgm:test")


def test_kubectl_passes_input_and_returns_stdout(run, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return type("Done", (), {"returncode": 0, "stdout": "ok", "stderr": ""})

    monkeypatch.setattr(run.mod.subprocess, "run", fake_run)
    assert run.mod.kubectl("create", "-f", "-", input="{}") == "ok"
    assert calls == [(["kubectl", "create", "-f", "-"], {
        "capture_output": True, "text": True, "input": "{}",
        "timeout": run.mod.KUBECTL_TIMEOUT})]
