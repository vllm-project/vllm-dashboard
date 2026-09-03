from datetime import datetime, timezone
from pathlib import Path

import pytest

from alerting.worker import scheduled_command


AWS_DIR = Path(__file__).parents[1]


def read(relative_path: str) -> str:
    return (AWS_DIR / relative_path).read_text()


def test_stack_provisions_one_disposable_worker_without_deferred_services() -> None:
    template = read("alerting-worker.yaml")

    assert template.count("Type: AWS::EC2::Instance") == 1
    assert "AWS::AutoScaling" not in template
    assert "AWS::SQS" not in template
    assert "AWS::Events" not in template
    assert "AWS::Scheduler" not in template
    assert "Encrypted: true" in template
    assert "DeleteOnTermination: true" in template
    assert "HttpTokens: required" in template
    assert "SecurityGroupIngress" not in template
    assert "nodejs22" not in template
    assert "nodejs22-npm" not in template


def test_instance_role_is_scoped_to_checkpoint_bucket_and_named_secrets() -> None:
    template = read("alerting-worker.yaml")

    assert "- s3:ListBucket" in template
    assert "- s3:GetObject" in template
    assert "- s3:PutObject" in template
    assert "- secretsmanager:GetSecretValue" in template
    assert "Ref: WorkerSecretArn" in template
    assert "Ref: GitHubReadOnlySecretArn" in template
    assert "Resource: '*'" not in template


def test_full_ci_timer_uses_pacific_wall_clock_and_recovers_after_downtime() -> None:
    timer = read("systemd/alerting-full-ci.timer")

    assert "OnCalendar=*-*-* 05:00:00 America/Los_Angeles" in timer
    assert "OnCalendar=*-*-* 19:00:00 America/Los_Angeles" in timer
    assert "OnBootSec=" in timer
    assert "Persistent=true" in timer


def test_fast_ci_timer_uses_pacific_wall_clock_every_fifteen_minutes() -> None:
    timer = read("systemd/alerting-fast-ci.timer")

    assert "OnCalendar=*-*-* *:00/15:00 America/Los_Angeles" in timer
    assert "OnBootSec=" in timer
    assert "Persistent=true" in timer


def test_main_ci_timer_polls_every_two_minutes_and_recovers_after_downtime() -> None:
    timer = read("systemd/alerting-main-ci.timer")

    assert "OnCalendar=*-*-* *:00/2:00 UTC" in timer
    assert "OnBootSec=" in timer
    assert "Persistent=true" in timer


def test_main_ci_backstop_timer_runs_hourly_off_the_hour_mark() -> None:
    timer = read("systemd/alerting-main-ci-backstop.timer")
    service = read("systemd/alerting-main-ci-backstop.service")

    assert "OnCalendar=*-*-* *:17:00 UTC" in timer
    assert "OnBootSec=" in timer
    assert "Persistent=true" in timer
    assert "Unit=alerting-main-ci-backstop.service" in timer
    assert "run-worker main-ci-backstop" in service
    assert "StandardOutput=null" in service
    assert "StandardError=null" in service
    for sensitive_name in ("DATABASE_URL", "TOKEN", "PASSWORD"):
        assert sensitive_name not in service + timer


def test_infra_timer_scans_every_five_minutes_without_sensitive_data() -> None:
    timer = read("systemd/alerting-infra.timer")
    service = read("systemd/alerting-infra.service")

    assert "OnCalendar=*-*-* *:00/5:00 UTC" in timer
    assert "OnBootSec=" in timer
    assert "Persistent=true" in timer
    assert "Unit=alerting-infra.service" in timer
    assert "run-worker infra" in service
    assert "StandardOutput=null" in service
    assert "StandardError=null" in service
    for sensitive_name in ("DATABASE_URL", "TOKEN", "PASSWORD"):
        assert sensitive_name not in service + timer


def test_run_worker_maps_infra_consumer_to_its_own_control_path() -> None:
    runner = read("bin/run-worker")

    assert "infra) alert_path=infra ;;" in runner


def test_main_ci_analysis_timer_runs_every_ten_minutes() -> None:
    timer = read("systemd/alerting-main-ci-analysis.timer")

    assert "OnCalendar=*-*-* *:00/10:00 UTC" in timer
    assert "OnBootSec=" in timer
    assert "Persistent=true" in timer
    assert "Unit=alerting-main-ci-analysis.service" in timer


def test_consumers_are_independent_and_units_never_contain_sensitive_data() -> None:
    full_service = read("systemd/alerting-full-ci.service")
    fast_service = read("systemd/alerting-fast-ci.service")
    main_service = read("systemd/alerting-main-ci.service")
    analysis_service = read("systemd/alerting-main-ci-analysis.service")
    unit_text = "\n".join(
        [
            full_service,
            fast_service,
            main_service,
            analysis_service,
            read("systemd/alerting-full-ci.timer"),
            read("systemd/alerting-fast-ci.timer"),
            read("systemd/alerting-main-ci.timer"),
            read("systemd/alerting-main-ci-analysis.timer"),
        ]
    )

    assert "run-worker full-ci" in full_service
    assert "run-worker full-ci-analyze" in full_service
    assert "run-worker fast-ci" in fast_service
    assert "run-worker main-ci" in main_service
    assert "run-worker main-ci-analyze" in analysis_service
    assert "StandardOutput=null" in full_service
    assert "StandardError=null" in full_service
    assert "StandardOutput=null" in fast_service
    assert "StandardError=null" in fast_service
    assert "StandardOutput=null" in main_service
    assert "StandardError=null" in main_service
    assert "StandardOutput=null" in analysis_service
    assert "StandardError=null" in analysis_service
    for sensitive_name in (
        "DATABASE_URL",
        "TOKEN",
        "PASSWORD",
        "CI_LOG",
        "SLACK_PAYLOAD",
        "MODEL_OUTPUT",
    ):
        assert sensitive_name not in unit_text


def test_runtime_loads_secrets_non_interactively_into_ephemeral_storage() -> None:
    loader = read("bin/load-secrets")
    runner = read("bin/run-worker")

    assert "aws secretsmanager get-secret-value" in loader
    assert "AWS_ACCESS_KEY_ID" not in loader
    assert "/run/alerting" in runner
    assert "load-secrets" in runner
    assert "rm -f" in runner
    assert 'mode_path="/run/alerting/${alert_path}.mode"' in runner
    assert 'source "$mode_path"' in runner
    assert runner.index('source "$credentials_path"') < runner.index(
        'source "$mode_path"'
    )


def test_installation_creates_a_non_login_user_and_s3_controlled_timers() -> None:
    installer = read("install.sh")

    assert "useradd --system" in installer
    assert "--shell /sbin/nologin" in installer
    assert 'alerting[aws,postgres]' in installer
    assert "@anthropic-ai/claude-code" not in installer
    assert "npm" not in installer
    assert "systemctl start alerting-control.service" in installer
    assert "systemctl enable --now alerting-control.timer" in installer
    assert "systemctl enable --now alerting-full-ci.timer" not in installer
    assert "systemctl enable --now alerting-fast-ci.timer" not in installer
    assert "systemctl enable --now alerting-main-ci.timer" not in installer


def test_main_ci_kimi_effort_is_an_independent_deploy_knob() -> None:
    template = read("alerting-worker.yaml")
    installer = read("install.sh")

    assert "KimiMainCIReasoningEffort:" in template
    assert "KimiMainCIEffort:" in template
    assert "Ref: KimiMainCIReasoningEffort" in template
    assert "KIMI_MAIN_CI_REASONING_EFFORT" in installer
    assert installer.count("KIMI_MAIN_CI_REASONING_EFFORT") == 2


def test_s3_control_reconciles_each_path_without_cloudwatch_or_sqs() -> None:
    service = read("systemd/alerting-control.service")
    timer = read("systemd/alerting-control.timer")
    template = read("alerting-worker.yaml")

    assert "alerting.control" in service
    assert "ALERTING_CHECKPOINT_BUCKET" in service
    assert "OnUnitActiveSec=1min" in timer
    assert "AWS::CloudWatch" not in template
    assert "AWS::SQS" not in template


def test_cutover_wizard_fences_only_selected_old_path_and_supports_rollback() -> None:
    wizard = read("cutover-wizard.sh")

    assert "vllm-fast-ci-failure-alert.timer" in wizard
    assert "vllm-fast-ci-failure-alert.service" in wizard
    assert "/home/ubuntu/vllm-ci-report/tasks/vllm-ci-report.yaml" in wizard
    assert "vllm-nightly-perf-trigger.timer" not in wizard
    assert "archive-pending" in wizard
    assert "export-shadow" in wizard
    assert "control/${ALERT_PATH}.mode" in wizard
    assert "confirm" in wizard
    assert "no active Full CI results-report invocation" in wizard


def test_deployment_contract_requires_a_read_only_github_credential() -> None:
    documentation = read("README.md")

    assert "read-only" in documentation
    assert "GitHubReadOnlySecretArn" in documentation
    assert "no repository write" in documentation


def test_retention_timer_prunes_daily_without_sensitive_data() -> None:
    service = read("systemd/alerting-retention.service")
    timer = read("systemd/alerting-retention.timer")
    installer = read("install.sh")

    assert "run-retention" in service
    assert "StandardOutput=null" in service
    assert "StandardError=null" in service
    assert "OnCalendar=*-*-* 03:00:00 America/Los_Angeles" in timer
    assert "Persistent=true" in timer
    assert "run-retention" in installer
    assert "systemctl enable --now alerting-retention.timer" in installer
    for sensitive_name in ("DATABASE_URL", "TOKEN", "PASSWORD"):
        assert sensitive_name not in service + timer


@pytest.mark.parametrize(
    ("consumer", "command_type"),
    [
        ("full-ci", "full_ci_reconcile"),
        ("fast-ci", "fast_ci_scan"),
        ("main-ci", "main_ci_reconcile"),
        ("main-ci-backstop", "main_ci_backstop"),
        ("main-ci-analyze", "main_ci_analyze"),
        ("infra", "infra_scan"),
    ],
)
def test_timer_wake_up_creates_a_minute_stable_reconciliation_command(
    consumer: str, command_type: str
) -> None:
    command = scheduled_command(
        consumer,
        datetime(2026, 8, 27, 19, 0, 42, 123456, tzinfo=timezone.utc),
    )

    assert command.command_type == command_type
    assert command.target_time == datetime(2026, 8, 27, 19, 0, tzinfo=timezone.utc)
