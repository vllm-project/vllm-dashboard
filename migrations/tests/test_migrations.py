"""Sanity checks on SQL migration files and runner ordering."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from migrations import runner
from migrations.runner import (
    MIGRATIONS_DIR,
    database_target,
    migration_files,
    migration_is_transactional,
    migration_valid_indexes,
)


def test_migrations_are_sequential_and_non_empty() -> None:
    files = migration_files(MIGRATIONS_DIR)
    assert files, "expected at least one migration"
    for index, path in enumerate(files, start=1):
        assert path.name.startswith(f"{index:04d}_"), (
            f"unexpected numbering: {path.name}"
        )
        assert path.read_text().strip(), f"empty migration: {path.name}"


def test_migration_files_are_sorted_regardless_of_directory_order(
    tmp_path: Path,
) -> None:
    (tmp_path / "0002_b.sql").write_text("select 2;")
    (tmp_path / "0001_a.sql").write_text("select 1;")
    (tmp_path / "notes.txt").write_text("ignored")
    assert [p.name for p in migration_files(tmp_path)] == ["0001_a.sql", "0002_b.sql"]


def test_expected_tables_are_created() -> None:
    sql = "\n".join(p.read_text() for p in migration_files(MIGRATIONS_DIR))
    expected_tables = {
        "queue_snapshots",
        "buildkite_agent_snapshots",
        "alert_threads",
        "alert_summary",
        "gpu_snapshots",
        "gpu_history_5m",
        "host_snapshots",
        "host_history_5m",
        "alert_thresholds",
        "otel_spans",
        "alerting_automation_executions",
        "alerting_notification_outbox",
        "alerting_fast_failure_events",
        "alerting_fast_ci_scan_cursors",
        "alerting_fast_failure_notifications",
        "alerting_full_ci_runs",
        "alerting_full_ci_job_outcomes",
        "alerting_full_ci_comparisons",
        "alerting_full_ci_analyses",
        "alerting_analyzer_checkpoints",
        "alerting_full_ci_failure_conditions",
        "alerting_full_ci_import_baselines",
        "alerting_fast_ci_imported_deduplication_keys",
        "alerting_main_ci_scan_cursors",
        "alerting_main_ci_job_states",
        "alerting_main_ci_job_alerts",
        "alerting_main_ci_job_analysis",
        "alerting_infra_host_states",
        "alerting_infra_alerts",
    }

    for table in expected_tables:
        assert f"CREATE TABLE IF NOT EXISTS {table}" in sql


def test_fast_ci_schema_keys_events_by_job_and_links_notification_batches() -> None:
    sql = (MIGRATIONS_DIR / "0003_fast_ci.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_fast_failure_events" in sql
    assert "buildkite_job_id text PRIMARY KEY" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_fast_ci_scan_cursors" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_fast_failure_notifications" in sql
    assert "REFERENCES alerting_notification_outbox(delivery_id)" in sql
    assert "resolved_at" not in sql


def test_stale_fast_ci_batches_can_be_superseded_by_recovery_summary() -> None:
    sql = (MIGRATIONS_DIR / "0010_fast_ci_recovery_summaries.sql").read_text()

    assert "ADD COLUMN IF NOT EXISTS superseded_by text" in sql
    assert "REFERENCES alerting_notification_outbox(delivery_id)" in sql
    assert "WHERE superseded_by IS NULL" in sql


def test_full_ci_schema_keys_runs_jobs_and_comparisons_by_current_identity() -> None:
    sql = (MIGRATIONS_DIR / "0004_full_ci_ingest.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_full_ci_runs" in sql
    assert "buildkite_build_id text PRIMARY KEY" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_full_ci_job_outcomes" in sql
    assert "PRIMARY KEY (buildkite_build_id, job_name)" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_full_ci_comparisons" in sql
    assert "current_build_id text PRIMARY KEY" in sql
    assert "previous_build_id text NOT NULL" in sql


def test_full_ci_analysis_schema_preserves_baseline_and_checkpoint_guarantees() -> None:
    sql = (MIGRATIONS_DIR / "0011_full_ci_analysis.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_full_ci_analyses" in sql
    assert "REFERENCES alerting_full_ci_comparisons(current_build_id)" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_analyzer_checkpoints" in sql
    # The imported initial checkpoint predates any comparison.
    assert "current_build_id text\n" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_full_ci_failure_conditions" in sql
    assert "'infrastructure', 'flaky_test', 'test', 'code', 'unknown'" in sql
    # Fixing-PR attribution is only ever recorded with a verified code fix.
    assert "CHECK (fixing_pr_number IS NULL OR cause = 'code')" in sql
    for table in (
        "alerting_full_ci_analyses",
        "alerting_analyzer_checkpoints",
        "alerting_full_ci_failure_conditions",
    ):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in sql


def test_legacy_import_schema_keeps_seed_baseline_and_fast_ci_keys_separate() -> None:
    sql = (MIGRATIONS_DIR / "0012_legacy_alert_state_import.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_full_ci_import_baselines" in sql
    assert "buildkite_build_id      text NOT NULL UNIQUE" in sql
    assert "failure_cache           jsonb NOT NULL" in sql
    assert "reported_build_numbers  bigint[] NOT NULL" in sql
    assert (
        "CREATE TABLE IF NOT EXISTS alerting_fast_ci_imported_deduplication_keys" in sql
    )
    assert "buildkite_job_id text PRIMARY KEY" in sql
    assert "finished_at      timestamptz NOT NULL" in sql
    assert "REFERENCES alerting_fast_failure_events" not in sql
    for table in (
        "alerting_full_ci_import_baselines",
        "alerting_fast_ci_imported_deduplication_keys",
    ):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in sql


def test_shadow_delivery_schema_is_path_scoped_and_never_due() -> None:
    sql = (MIGRATIONS_DIR / "0013_shadow_delivery.sql").read_text()

    assert "ADD COLUMN IF NOT EXISTS alert_path text" in sql
    assert "ADD COLUMN IF NOT EXISTS delivery_mode text" in sql
    assert "CHECK (alert_path IN ('fast_ci', 'full_ci'))" in sql
    assert "CHECK (delivery_mode IN ('live', 'shadow'))" in sql
    assert "WHERE delivery_mode = 'live'" in sql


def test_main_ci_schema_preserves_one_open_episode_and_positive_pass_resolution() -> None:
    sql = (MIGRATIONS_DIR / "0014_main_ci_job_alerts.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_main_ci_job_states" in sql
    assert "latest_build_number         bigint NOT NULL" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_main_ci_job_alerts" in sql
    assert "WHERE status = 'open'" in sql
    assert "status IN ('open', 'resolved')" in sql
    assert "resolution_job_id           text" in sql
    assert "'fast_ci', 'full_ci', 'main_ci'" in sql
    for table in (
        "alerting_main_ci_scan_cursors",
        "alerting_main_ci_job_states",
        "alerting_main_ci_job_alerts",
    ):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in sql


def test_main_ci_analysis_schema_is_a_cascading_sidecar_to_alert_lifecycle() -> None:
    sql = (MIGRATIONS_DIR / "0016_main_ci_job_analysis.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_main_ci_job_analysis" in sql
    assert "REFERENCES alerting_main_ci_job_alerts (alert_id) ON DELETE CASCADE" in sql
    assert "'infra', 'flaky', 'code', 'test', 'unknown'" in sql
    assert "'high', 'medium', 'low'" in sql
    assert "analyzed_failure_job_id" in sql
    assert "model_version" in sql
    assert (
        "ALTER TABLE public.alerting_main_ci_job_analysis ENABLE ROW LEVEL SECURITY"
        in sql
    )


def test_dashboard_schema_keeps_legacy_additive_columns_and_covering_index() -> None:
    sql = (MIGRATIONS_DIR / "0005_dashboard_operational.sql").read_text()

    assert "ADD COLUMN IF NOT EXISTS p99_wait_secs REAL" in sql
    assert "ADD COLUMN IF NOT EXISTS history TEXT[] DEFAULT '{}'" in sql
    covering_index = (MIGRATIONS_DIR / "0006_queue_covering_index.sql").read_text()
    assert "CREATE INDEX CONCURRENTLY" in covering_index
    assert "idx_snapshots_queue_polled_cover_v2" in covering_index
    assert not migration_is_transactional(covering_index)
    assert migration_valid_indexes(covering_index) == [
        "idx_snapshots_queue_polled_cover_v2"
    ]


def test_gpu_migration_preserves_rollup_backfill() -> None:
    sql = (MIGRATIONS_DIR / "0007_gpu_rollups.sql").read_text()

    assert "LOCK TABLE gpu_snapshots IN SHARE MODE" in sql
    assert "LOCK TABLE gpu_history_5m IN SHARE ROW EXCLUSIVE MODE" in sql
    assert "ACCESS EXCLUSIVE" not in sql
    assert "INSERT INTO gpu_history_5m" in sql
    assert "ON CONFLICT (time_bucket, hostname, gpu_name) DO UPDATE" in sql


def test_host_ingest_schema_is_normalized_protected_and_seeded() -> None:
    sql = (MIGRATIONS_DIR / "0018_gpu_host_ingest.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS host_snapshots" in sql
    assert "CREATE TABLE IF NOT EXISTS host_history_5m" in sql
    assert "CREATE TABLE IF NOT EXISTS alert_thresholds" in sql
    assert "CHECK (hostname = lower(hostname))" in sql
    assert "PRIMARY KEY (time_bucket, hostname)" in sql
    assert "('unreporting', 10, 'minutes', 2)" in sql
    assert "('disk_usage', 90, 'percent', 2)" in sql
    assert "('gpu_temperature', 85, 'celsius', 2)" in sql
    assert "ON CONFLICT (alert_type) DO NOTHING" in sql
    for table in ("host_snapshots", "host_history_5m", "alert_thresholds"):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in sql


def test_infra_schema_preserves_one_open_episode_per_subject_and_widens_path() -> None:
    sql = (MIGRATIONS_DIR / "0019_infra_alerts.sql").read_text()

    assert "CREATE TABLE IF NOT EXISTS alerting_infra_host_states" in sql
    assert "CREATE TABLE IF NOT EXISTS alerting_infra_alerts" in sql
    assert "ON alerting_infra_alerts (alert_type, subject_key)" in sql
    assert "WHERE status = 'open'" in sql
    assert "status       text NOT NULL CHECK (status IN ('open', 'resolved'))" in sql
    assert "'unreporting', 'disk_usage', 'gpu_temperature'" in sql
    assert "'fast_ci', 'full_ci', 'main_ci', 'infra'" in sql
    assert "alerting_infra_alerts_alert_id_seq" in sql
    assert "DROP CONSTRAINT IF EXISTS alerting_notification_outbox_path_check" in sql
    for table in ("alerting_infra_host_states", "alerting_infra_alerts"):
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in sql


def test_supabase_api_roles_cannot_access_server_only_tables() -> None:
    sql = (MIGRATIONS_DIR / "0009_secure_supabase_api_access.sql").read_text()

    expected_tables = {
        "schema_migrations",
        "alerting_automation_executions",
        "alerting_notification_outbox",
        "alerting_fast_failure_events",
        "alerting_fast_ci_scan_cursors",
        "alerting_fast_failure_notifications",
        "alerting_full_ci_runs",
        "alerting_full_ci_job_outcomes",
        "alerting_full_ci_comparisons",
    }
    existing_dashboard_tables = {
        "queue_snapshots",
        "alert_threads",
        "alert_summary",
        "gpu_snapshots",
        "gpu_history_5m",
        "otel_spans",
    }
    for table in expected_tables:
        assert f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY" in sql
    for table in existing_dashboard_tables:
        assert table not in sql
    assert "ARRAY['anon'::name, 'authenticated'::name]" in sql
    assert "REVOKE ALL PRIVILEGES ON TABLE" in sql


def test_database_target_never_includes_credentials() -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"

    assert database_target(database_url) == "db.example.com:5432/production"


def test_database_target_accepts_supabase_client_metadata() -> None:
    database_url = (
        "postgresql://dashboard:secret@db.example.com:5432/production"
        "?sslmode=require&supa=base-pooler.x"
    )

    assert database_target(database_url) == "db.example.com:5432/production"


def test_cli_rejects_transaction_pooler_url_without_connecting(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = (
        "postgresql://dashboard:secret@pooler.example.com:6543/production"
        "?sslmode=require&supa=base-pooler.x"
    )
    monkeypatch.setenv("DATABASE_URL", database_url)

    def unexpected_plan(url: str) -> list[str]:
        raise AssertionError("invalid migration URL must not connect")

    monkeypatch.setattr(runner, "plan_migrations", unexpected_plan)

    assert runner.main([]) == 2
    captured = capsys.readouterr()
    assert "Direct connection or Session pooler" in captured.err
    assert "secret" not in captured.out + captured.err


def test_cli_defaults_to_read_only_plan(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setattr(
        runner,
        "plan_migrations",
        lambda url: ["0001_automation_executions.sql"],
    )

    def unexpected_apply(url: str) -> list[str]:
        raise AssertionError("plan must not apply migrations")

    monkeypatch.setattr(runner, "apply_migrations", unexpected_apply)

    assert runner.main([]) == 0
    output = capsys.readouterr().out
    assert "target db.example.com:5432/production" in output
    assert "pending 0001_automation_executions.sql" in output
    assert "secret" not in output


def test_cli_rejects_wrong_apply_target(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"
    monkeypatch.setenv("DATABASE_URL", database_url)

    assert runner.main(["--apply", "--confirm-target", "other.example.com/db"]) == 2
    error = capsys.readouterr().err
    assert "does not match" in error


def test_cli_applies_only_after_exact_target_confirmation(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"
    target = "db.example.com:5432/production"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setattr(
        runner,
        "plan_migrations",
        lambda url: ["0001_automation_executions.sql"],
    )
    applied_urls: list[str] = []

    def record_apply(url: str) -> list[str]:
        applied_urls.append(url)
        return ["0001_automation_executions.sql"]

    monkeypatch.setattr(runner, "apply_migrations", record_apply)

    assert runner.main(["--apply", "--confirm-target", target]) == 0
    assert applied_urls == [database_url]
    assert "applied 0001_automation_executions.sql" in capsys.readouterr().out


def test_cli_adopts_existing_dashboard_only_after_exact_target_confirmation(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"
    target = "db.example.com:5432/production"
    monkeypatch.setenv("DATABASE_URL", database_url)
    adopted_urls: list[str] = []

    def record_adoption(url: str) -> list[str]:
        adopted_urls.append(url)
        return ["0005_dashboard_operational.sql", "0006_queue_covering_index.sql"]

    monkeypatch.setattr(runner, "adopt_existing_dashboard", record_adoption)

    assert runner.main(["--adopt-existing-dashboard", "--confirm-target", target]) == 0
    assert adopted_urls == [database_url]
    output = capsys.readouterr().out
    assert "adopted 0005_dashboard_operational.sql" in output
    assert "adopted 0006_queue_covering_index.sql" in output
    assert "secret" not in output


def test_cli_apply_and_adoption_are_mutually_exclusive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://dashboard:secret@db.example.com:5432/production",
    )

    with pytest.raises(SystemExit):
        runner.main(["--apply", "--adopt-existing-dashboard"])


def test_adoption_verifies_before_creating_migration_ledger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = MagicMock()
    connect_context = MagicMock()
    connect_context.__enter__.return_value = connection
    connect = MagicMock(return_value=connect_context)
    monkeypatch.setattr("psycopg.connect", connect)
    monkeypatch.setattr(runner, "_configure_connection", MagicMock())
    monkeypatch.setattr(runner, "_acquire_migration_lock", MagicMock())
    monkeypatch.setattr(runner, "_recorded_migrations", lambda conn: set())
    create_ledger = MagicMock()
    monkeypatch.setattr(runner, "_create_migration_table", create_ledger)

    def reject_dashboard(conn: object) -> None:
        raise RuntimeError("existing dashboard index verification failed")

    monkeypatch.setattr(runner, "_verify_existing_dashboard", reject_dashboard)

    with pytest.raises(RuntimeError, match="index verification failed"):
        runner.adopt_existing_dashboard(
            "postgresql://dashboard:secret@db.example.com:5432/production"
        )
    create_ledger.assert_not_called()


def test_cli_skips_apply_when_nothing_is_pending(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"
    target = "db.example.com:5432/production"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setattr(runner, "plan_migrations", lambda url: [])

    def unexpected_apply(url: str) -> list[str]:
        raise AssertionError("nothing pending must not acquire the apply lock")

    monkeypatch.setattr(runner, "apply_migrations", unexpected_apply)

    assert runner.main(["--apply", "--confirm-target", target]) == 0
    assert "nothing to apply" in capsys.readouterr().out


def test_cli_reports_apply_lock_failure_without_traceback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database_url = "postgresql://dashboard:secret@db.example.com:5432/production"
    target = "db.example.com:5432/production"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setattr(
        runner,
        "plan_migrations",
        lambda url: ["0001_automation_executions.sql"],
    )

    def fail_apply(url: str) -> list[str]:
        raise RuntimeError("another migration process holds the advisory lock")

    monkeypatch.setattr(runner, "apply_migrations", fail_apply)

    assert runner.main(["--apply", "--confirm-target", target]) == 1
    error = capsys.readouterr().err
    assert "migration failed: another migration process" in error
