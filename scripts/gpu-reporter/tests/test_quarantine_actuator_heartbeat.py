"""The control-plane actuator heartbeat: unit chaining, its credential
file's shape, and the deployment recipe.

The emitter script itself and the CloudWatch alarms are covered in
deploy/aws/tests/test_alerting_worker_infrastructure.py.
"""

from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SCRIPTS_DIR.parents[1]


def read(relative_path: str) -> str:
    return (SCRIPTS_DIR / relative_path).read_text()


def test_actuator_emits_heartbeat_only_after_a_successful_run() -> None:
    """The heartbeat is its own oneshot unit on the actuator's OnSuccess=:
    it runs only after a successful poll (a failed poll exits 1 and emits
    nothing), and outside the actuator's TimeoutSec, so a slow CloudWatch
    call can never fail a poll."""
    service = read("quarantine-actuator-k8s.service")

    assert "ExecStartPost=" not in service
    assert "OnSuccess=quarantine-actuator-heartbeat.service" in service
    # A completed poll with per-node errors exits 2, still a success, so one
    # broken node cannot silence the heartbeat and page with the wrong cause
    # (the worker's per-stage stuck notices carry the node problem). Only a
    # poll that never finished — the desired set unreachable — exits 1.
    assert "SuccessExitStatus=2" in service

    unit = read("quarantine-actuator-heartbeat.service")
    assert "Type=oneshot" in unit
    assert "ExecStart=/opt/gpu-reporter/emit-heartbeat ${HEARTBEAT_JOB}" in unit
    assert "TimeoutStartSec=30s" in unit
    # A dead heartbeat is not the actuator failing; the off-host alarm
    # notices it, and there is no failure notifier on a control plane.
    assert "OnFailure=" not in unit
    # Its stderr goes to the journal, not to /dev/null.
    assert "StandardError=journal" in unit


def test_heartbeat_credentials_are_per_control_plane_not_the_reporter_secret() -> None:
    """The heartbeat unit reads only its own credential file. Loading the
    reporter env would pull GPU_REPORT_SECRET into a process that doesn't
    need it and would couple the alarm path to the secret it must survive."""
    unit = read("quarantine-actuator-heartbeat.service")

    assert "EnvironmentFile=/etc/gpu-reporter/heartbeat-aws.env" in unit
    assert "gpu-reporter-k8s.env" not in unit
    assert "GPU_REPORT_SECRET" not in unit
    # The cluster's job name comes from the credential file, so the same
    # unit file serves both control planes.
    assert "${HEARTBEAT_JOB}" in unit


def test_heartbeat_env_example_documents_every_required_value() -> None:
    example = read("heartbeat-aws.env.example")

    for variable in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_DEFAULT_REGION",
        "HEARTBEAT_JOB",
    ):
        assert f"{variable}=" in example
    # The job name must stay in step with the actuator's own cluster name.
    assert "quarantine-actuator-" in example
    assert "QUARANTINE_CLUSTER" in example
    # Installed root-only, like the reporter env it sits beside.
    assert "0600" in example


def test_emitter_is_the_shared_script_needing_no_worker_secret() -> None:
    emitter = (REPO_ROOT / "deploy/aws/bin/emit-heartbeat").read_text()

    assert "cloudwatch put-metric-data" in emitter
    assert "--namespace VllmAlerting" in emitter
    for needle in ("load-secrets", "worker.env", "TOKEN", "DATABASE_URL"):
        assert needle not in emitter


def test_deployment_recipe_is_documented_and_never_echoes_secrets() -> None:
    doc = (REPO_ROOT / "alerting/docs/infra.md").read_text()

    assert "quarantine-actuator-heartbeat" in doc
    assert "cloudwatch:PutMetricData" in doc
    # The recipe reads the secret key with echo off and never prints it.
    assert "read -r -s" in doc
