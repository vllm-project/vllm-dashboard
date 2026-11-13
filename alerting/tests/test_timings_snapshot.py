"""The timings snapshot keeps last-good data and publishes the pointer last."""

from __future__ import annotations

import gzip
import io
import json
import sys
import types
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
import pytest

from alerting import timings_snapshot as ts

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
GOOD = {
    "setupMs": 60_000,
    "buildNumbers": [7],
    "files": [
        {
            "command": "pytest -v -s a",
            "file": "a/test_x.py",
            "observedMs": 1_000,
            "tests": [{"nodeid": "a/test_x.py::t", "observedMs": 900}],
        }
    ],
}
OLD_ENTRY = {"fetched_at": "2026-11-12T00:00:00Z", "response": {**GOOD, "setupMs": 1}}


class FakeConnection:
    def __init__(self, rows_per_call: list[list[tuple[str, str]]]) -> None:
        self.rows_per_call = rows_per_call
        self.params: list[dict[str, Any]] = []

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def execute(self, sql: str, params: dict[str, Any]) -> "FakeConnection":
        self.params.append(params)
        self.rows = self.rows_per_call[len(self.params) - 1]
        return self

    def fetchall(self) -> list[tuple[str, str]]:
        return self.rows


def test_list_pairs_reads_the_window_in_one_statement() -> None:
    connection = FakeConnection(
        [[("a", "gpu_1"), ("a", "gpu_1"), ("b", "amd_mi325_1")]]
    )

    pairs = ts.list_pairs(connection, now=NOW, days=ts.LOOKBACK_DAYS)

    assert pairs == {("a", "gpu_1"), ("b", "amd_mi325_1")}
    assert connection.params == [{"since": NOW - timedelta(days=14), "newest": 20}]


def test_pairs_query_repeats_each_branch_index_predicate_in_every_subquery() -> None:
    for branch in ("main", "khluu/otel"):
        predicate = f"(span_attributes->>'buildkite.build.branch') = '{branch}'"
        assert ts.PAIRS_SQL.count(predicate) == 3
    assert ts.PAIRS_SQL.count("span_name = 'buildkite.job'") == 6
    assert "\nUNION\n" in ts.PAIRS_SQL


def test_tests_over_ms_matches_the_generator() -> None:
    # ci-infra runtime_shard.py: (MAX_SHARD_SECONDS 1140 - MAX_SETUP_SECONDS 180) * 1000
    assert ts.TESTS_OVER_MS == 960_000


class _Response(io.BytesIO):
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *args: Any) -> None:
        pass


def _endpoint(monkeypatch: pytest.MonkeyPatch, answer: Any) -> list[tuple[str, float]]:
    calls: list[tuple[str, float]] = []

    def urlopen(url: str, timeout: float) -> _Response:
        calls.append((url, timeout))
        if isinstance(answer, Exception):
            raise answer
        return _Response(json.dumps(answer).encode())

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return calls


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("u", code, "error", {}, None)  # type: ignore[arg-type]


def test_fetch_asks_the_endpoint_with_the_generators_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _endpoint(monkeypatch, GOOD)

    assert ts.fetch_from_endpoint("amd-k", "amd_mi325_1") == GOOD
    assert calls == [
        (
            "https://ci.vllm.ai/api/timings/latest"
            "?stepKey=amd-k&queue=amd_mi325_1&testsOverMs=960000",
            120,
        )
    ]


def test_fetch_reads_a_404_as_no_timings(monkeypatch: pytest.MonkeyPatch) -> None:
    _endpoint(monkeypatch, _http_error(404))

    assert ts.fetch_from_endpoint("k", "gpu_1") is None


@pytest.mark.parametrize("code", [403, 405, 422, 500])
def test_fetch_raises_any_other_error(
    monkeypatch: pytest.MonkeyPatch, code: int
) -> None:
    _endpoint(monkeypatch, _http_error(code))

    with pytest.raises(urllib.error.HTTPError):
        ts.fetch_from_endpoint("k", "gpu_1")


@pytest.mark.parametrize(
    "response",
    [
        None,
        [],
        {"files": []},
        {"setupMs": -1, "files": GOOD["files"]},
        {"setupMs": True, "files": GOOD["files"]},
        {"files": [{"command": "c", "file": "f"}]},
        {"files": [{"command": "c", "file": "f", "observedMs": "1"}]},
        {"files": [{"command": 1, "file": "f", "observedMs": 1}]},
        {"files": [{"command": "c", "file": None, "observedMs": 1}]},
        {"files": ["f"]},
        {
            "files": [
                {
                    "command": "c",
                    "file": "f",
                    "observedMs": 1,
                    "tests": [{"nodeid": "n"}],
                }
            ]
        },
        {
            "files": [
                {
                    "command": "c",
                    "file": "f",
                    "observedMs": 1,
                    "tests": [{"observedMs": 1}],
                }
            ]
        },
        {"files": [{"command": "c", "file": "f", "observedMs": 1, "tests": ["n"]}]},
    ],
)
def test_valid_rejects_what_the_planner_cannot_read(response: Any) -> None:
    assert not ts.valid(response)


def test_valid_accepts_a_real_shape_and_a_missing_setup() -> None:
    assert ts.valid(GOOD)
    assert ts.valid({"files": [{"command": "c", "file": "f", "observedMs": 0}]})


def _fetch(answers: dict[str, Any]) -> ts.Fetch:
    def fetch(step_key: str, queue: str) -> dict[str, Any] | None:
        answer = answers[f"{step_key}|{queue}"]
        if isinstance(answer, Exception):
            raise answer
        return answer  # type: ignore[no-any-return]

    return fetch


def test_refresh_stores_new_answers_and_404s_as_null() -> None:
    entries, failed, _ = ts.refresh(
        ["a|gpu_1", "b|gpu_1"], {}, _fetch({"a|gpu_1": GOOD, "b|gpu_1": None}), now=NOW
    )

    assert failed == []
    assert entries == {
        "a|gpu_1": {"fetched_at": "2026-11-13T12:00:00Z", "response": GOOD},
        "b|gpu_1": {"fetched_at": "2026-11-13T12:00:00Z", "response": None},
    }


def test_refresh_keeps_the_last_good_entry_when_a_fetch_fails(
    capsys: pytest.CaptureFixture[str],
) -> None:
    previous = {"a|gpu_1": OLD_ENTRY, "b|gpu_1": OLD_ENTRY}
    answers = {
        "a|gpu_1": TimeoutError("slow"),
        "b|gpu_1": {"files": []},
        "c|gpu_1": OSError("down"),
    }

    entries, failed, _ = ts.refresh(answers, previous, _fetch(answers), now=NOW)

    # c is new, so it goes first.
    assert failed == ["c|gpu_1", "a|gpu_1", "b|gpu_1"]
    # Old data stays, marked as tried; c gets only the mark, so builds ask the
    # endpoint for it.
    tried = {"attempted_at": "2026-11-13T12:00:00Z"}
    assert entries == {
        "a|gpu_1": {**OLD_ENTRY, **tried},
        "b|gpu_1": {**OLD_ENTRY, **tried},
        "c|gpu_1": tried,
    }
    assert capsys.readouterr().err.splitlines() == [
        "c|gpu_1: OSError: down",
        "a|gpu_1: TimeoutError: slow",
        "b|gpu_1: ValueError: response the planner cannot read",
    ]


def test_keys_that_keep_failing_cannot_starve_the_rest() -> None:
    previous = {key: OLD_ENTRY for key in ("a|q", "b|q", "c|q")}
    answers = {"a|q": TimeoutError("slow"), "b|q": GOOD, "c|q": GOOD}
    ticks = iter([0.0, 10.0, 10.0])

    # Run 1: a fails, then the budget is gone; b and c wait.
    entries, failed, skipped = ts.refresh(
        previous,
        previous,
        _fetch(answers),
        now=NOW,
        deadline=10.0,
        clock=lambda: next(ticks),
    )
    assert (failed, skipped) == (["a|q"], ["b|q", "c|q"])

    # Run 2: b and c, never tried since, go before a.
    seen = []

    def fetch(step_key: str, queue: str) -> dict[str, Any] | None:
        seen.append(step_key)
        return GOOD

    ts.refresh(previous, entries, fetch, now=NOW + timedelta(hours=1))
    assert seen == ["b", "c", "a"]


def test_refresh_keeps_timings_through_a_404_but_not_an_old_404() -> None:
    old_404 = {"fetched_at": "2026-11-12T00:00:00Z", "response": None}
    previous = {"a|gpu_1": OLD_ENTRY, "b|gpu_1": old_404}

    entries, failed, _ = ts.refresh(
        ["a|gpu_1", "b|gpu_1"],
        previous,
        _fetch({"a|gpu_1": None, "b|gpu_1": None}),
        now=NOW,
    )

    assert failed == []
    assert entries["a|gpu_1"] == OLD_ENTRY
    assert entries["b|gpu_1"] == {
        "fetched_at": "2026-11-13T12:00:00Z",
        "response": None,
    }


def test_refresh_replaces_an_old_entry_with_a_new_answer() -> None:
    entries, _, _ = ts.refresh(
        ["a|gpu_1"], {"a|gpu_1": OLD_ENTRY}, _fetch({"a|gpu_1": GOOD}), now=NOW
    )

    assert entries["a|gpu_1"]["response"] == GOOD


def test_refresh_splits_the_key_at_the_first_bar_only() -> None:
    seen = []

    def fetch(step_key: str, queue: str) -> dict[str, Any] | None:
        seen.append((step_key, queue))
        return None

    ts.refresh(["k|q|x"], {}, fetch, now=NOW)

    assert seen == [("k", "q|x")]


def test_refresh_goes_new_keys_first_then_oldest_entry_first() -> None:
    seen = []

    def fetch(step_key: str, queue: str) -> dict[str, Any] | None:
        seen.append(step_key)
        return GOOD

    previous = {
        "a|q": {"fetched_at": "2026-11-13T11:00:00Z", "response": GOOD},
        "b|q": {"fetched_at": "2026-11-13T09:00:00Z", "response": GOOD},
    }
    ts.refresh(["a|q", "b|q", "c|q"], previous, fetch, now=NOW)

    assert seen == ["c", "b", "a"]


def test_refresh_stops_at_the_deadline_and_keeps_the_rest() -> None:
    ticks = iter([0.0, 5.0, 10.0, 15.0])
    previous = {"b|q": OLD_ENTRY, "d|q": OLD_ENTRY}

    entries, failed, skipped = ts.refresh(
        ["a|q", "b|q", "c|q", "d|q"],
        previous,
        _fetch({"a|q": GOOD, "c|q": GOOD}),
        now=NOW,
        deadline=10.0,
        clock=lambda: next(ticks),
    )

    # a and c (new) go before b and d; the clock reaches 10 at b.
    assert failed == []
    assert skipped == ["b|q", "d|q"]
    assert entries["b|q"] == entries["d|q"] == OLD_ENTRY
    assert set(entries) == {"a|q", "b|q", "c|q", "d|q"}


def test_a_key_skipped_at_the_deadline_without_an_entry_stays_out() -> None:
    entries, _, skipped = ts.refresh(
        ["a|q"], {}, _fetch({}), now=NOW, deadline=0.0, clock=lambda: 0.0
    )

    assert skipped == ["a|q"] and entries == {}


def test_a_run_past_the_deadline_publishes_what_it_fetched(
    capsys: pytest.CaptureFixture[str],
) -> None:
    s3 = FakeS3()

    code = ts.run(
        pairs={("a", "gpu_1")},
        store=ts.S3Store("bucket", client=s3),
        fetch=_fetch({}),
        now=NOW,
        deadline=-1.0,
    )

    # Nothing fetched, so nothing published.
    assert code == 1 and s3.puts == []
    assert capsys.readouterr().out.splitlines() == [
        "1 keys (1 from the spans, 0 in the last snapshot): 0 fetched, 0 failed, "
        "1 left for the next run"
    ]


def test_main_gives_the_fetches_forty_minutes(monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("DATABASE_URL", "postgresql://example")
    monkeypatch.setattr(
        psycopg, "connect", lambda url, prepare_threshold: FakeConnection([[]])
    )
    monkeypatch.setattr(ts, "S3Store", lambda: None)

    def run(**kwargs: Any) -> int:
        calls.append(kwargs)
        return 0

    monkeypatch.setattr(ts, "run", run)

    ts.main([])

    assert abs(calls[0]["deadline"] - time.monotonic() - 40 * 60) < 5


def test_main_recording_failures_records_a_crash_and_a_failed_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import alerting.worker

    recorded: list[tuple[str, str]] = []
    monkeypatch.setattr(
        alerting.worker,
        "_record_failure",
        lambda run, error: recorded.append((run, error)),
    )

    monkeypatch.setattr(ts, "main", lambda: 1)
    assert ts.main_recording_failures() == 1
    monkeypatch.setattr(ts, "main", lambda: 0)
    assert ts.main_recording_failures() == 0

    def crash() -> int:
        raise OSError("s3 down")

    monkeypatch.setattr(ts, "main", crash)
    with pytest.raises(OSError):
        ts.main_recording_failures()
    assert recorded == [
        (
            "timings-snapshot",
            "no endpoint fetch succeeded; builds use the last snapshot",
        ),
        ("timings-snapshot", "OSError: s3 down"),
    ]


class NoSuchKey(Exception):
    pass


class FakeS3:
    class exceptions:
        NoSuchKey = NoSuchKey

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts: list[tuple[str, str]] = []
        self.fail_put: str | None = None

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]:
        if Key not in self.objects:
            raise NoSuchKey(Key)
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes) -> None:
        if Key == self.fail_put:
            raise OSError("access denied")
        self.puts.append((Bucket, Key))
        self.objects[Key] = Body


def _published(s3: FakeS3) -> dict[str, Any]:
    pointer = json.loads(s3.objects[ts.POINTER])
    snapshot: dict[str, Any] = json.loads(gzip.decompress(s3.objects[pointer["path"]]))
    assert pointer["published_at"] == snapshot["published_at"]
    return snapshot


def test_first_run_publishes_the_snapshot_before_the_pointer(
    capsys: pytest.CaptureFixture[str],
) -> None:
    s3 = FakeS3()
    store = ts.S3Store("bucket", client=s3)

    code = ts.run(
        pairs={("a", "gpu_1")}, store=store, fetch=_fetch({"a|gpu_1": GOOD}), now=NOW
    )

    assert code == 0
    assert s3.puts == [
        ("bucket", "ci/timings/2026-11-13T120000Z/timings.json.gz"),
        ("bucket", "ci/timings/latest.json"),
    ]
    snapshot = _published(s3)
    assert snapshot["tests_over_ms"] == 960_000
    assert snapshot["entries"]["a|gpu_1"]["response"] == GOOD
    assert capsys.readouterr().out.splitlines() == [
        "1 keys (1 from the spans, 0 in the last snapshot): 1 fetched, 0 failed, 0 left for the next run",
        "published s3://bucket/ci/timings/2026-11-13T120000Z/timings.json.gz",
    ]


def test_a_later_run_keeps_keys_main_no_longer_ran_and_refreshes_them(
    capsys: pytest.CaptureFixture[str],
) -> None:
    s3 = FakeS3()
    store = ts.S3Store("bucket", client=s3)
    ts.run(
        pairs={("a", "gpu_1")}, store=store, fetch=_fetch({"a|gpu_1": GOOD}), now=NOW
    )
    newer = {**GOOD, "setupMs": 5}
    capsys.readouterr()

    code = ts.run(
        pairs={("b", "gpu_1")},
        store=store,
        fetch=_fetch({"a|gpu_1": newer, "b|gpu_1": TimeoutError("slow")}),
        now=NOW + timedelta(hours=1),
    )

    assert code == 0
    snapshot = _published(s3)
    assert snapshot["published_at"] == "2026-11-13T13:00:00Z"
    assert snapshot["entries"] == {
        "a|gpu_1": {"fetched_at": "2026-11-13T13:00:00Z", "response": newer},
        "b|gpu_1": {"attempted_at": "2026-11-13T13:00:00Z"},
    }
    assert capsys.readouterr().out.splitlines()[0] == (
        "2 keys (1 from the spans, 1 in the last snapshot): 1 fetched, 1 failed, 0 left for the next run"
    )


def test_a_run_where_every_fetch_fails_leaves_the_pointer_alone(
    capsys: pytest.CaptureFixture[str],
) -> None:
    s3 = FakeS3()
    store = ts.S3Store("bucket", client=s3)
    ts.run(
        pairs={("a", "gpu_1")}, store=store, fetch=_fetch({"a|gpu_1": GOOD}), now=NOW
    )
    before = dict(s3.objects)
    capsys.readouterr()

    code = ts.run(
        pairs={("a", "gpu_1")},
        store=store,
        fetch=_fetch({"a|gpu_1": TimeoutError("down")}),
        now=NOW + timedelta(hours=1),
    )

    assert code == 1
    assert s3.objects == before
    assert capsys.readouterr().err.splitlines()[-1] == (
        "no fetch succeeded; latest.json still names the last snapshot"
    )


def test_a_failed_snapshot_upload_never_moves_the_pointer() -> None:
    s3 = FakeS3()
    s3.fail_put = "ci/timings/2026-11-13T120000Z/timings.json.gz"

    with pytest.raises(OSError):
        ts.run(
            pairs={("a", "gpu_1")},
            store=ts.S3Store("bucket", client=s3),
            fetch=_fetch({"a|gpu_1": GOOD}),
            now=NOW,
        )

    assert ts.POINTER not in s3.objects


def test_an_unreadable_last_snapshot_stops_the_run() -> None:
    s3 = FakeS3()
    s3.objects[ts.POINTER] = json.dumps(
        {"path": "ci/timings/gone/timings.json.gz"}
    ).encode()
    calls = []

    def fetch(step_key: str, queue: str) -> dict[str, Any] | None:
        calls.append(step_key)
        return GOOD

    # Publishing without the old entries would drop every key main skipped today.
    with pytest.raises(NoSuchKey):
        ts.run(
            pairs={("a", "gpu_1")},
            store=ts.S3Store("bucket", client=s3),
            fetch=fetch,
            now=NOW,
        )
    assert calls == []


def test_dry_run_fetches_but_uploads_nothing(
    capsys: pytest.CaptureFixture[str],
) -> None:
    s3 = FakeS3()

    code = ts.run(
        pairs={("a", "gpu_1")},
        store=ts.S3Store("bucket", client=s3),
        fetch=_fetch({"a|gpu_1": GOOD}),
        now=NOW,
        dry_run=True,
    )

    assert code == 0
    assert s3.puts == []
    assert (
        capsys.readouterr().out.splitlines()[-1] == "dry run: would publish 1 entries"
    )


def test_no_keys_at_all_publishes_an_empty_snapshot() -> None:
    s3 = FakeS3()

    code = ts.run(
        pairs=set(), store=ts.S3Store("bucket", client=s3), fetch=_fetch({}), now=NOW
    )

    assert code == 0
    assert _published(s3)["entries"] == {}


def _fake_boto3(monkeypatch: pytest.MonkeyPatch, s3: FakeS3) -> list[str]:
    clients: list[str] = []

    def client(name: str) -> FakeS3:
        clients.append(name)
        return s3

    boto3 = types.ModuleType("boto3")
    boto3.client = client  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "boto3", boto3)
    return clients


def test_the_store_defaults_to_the_public_bucket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s3 = FakeS3()
    clients = _fake_boto3(monkeypatch, s3)

    store = ts.S3Store()

    assert store.bucket == "vllm-ci-timings"
    assert store.client is s3
    assert clients == ["s3"]


def test_main_needs_a_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(RuntimeError, match="missing: DATABASE_URL"):
        ts.main([])


@pytest.mark.parametrize(
    "arguments, days, puts",
    [([], 14, 2), (["--days", "3"], 3, 2), (["--dry-run"], 14, 0)],
)
def test_main_lists_pairs_without_prepared_statements_and_publishes(
    monkeypatch: pytest.MonkeyPatch, arguments: list[str], days: int, puts: int
) -> None:
    connection = FakeConnection([[("a", "gpu_1")], [("b", "gpu_1")]])
    connects = []

    def connect(url: str, prepare_threshold: Any) -> FakeConnection:
        connects.append((url, prepare_threshold))
        return connection

    s3 = FakeS3()
    _fake_boto3(monkeypatch, s3)
    monkeypatch.setenv("DATABASE_URL", "postgresql://example")
    monkeypatch.setattr(psycopg, "connect", connect)
    monkeypatch.setattr(
        ts, "fetch_from_endpoint", _fetch({"a|gpu_1": GOOD, "b|gpu_1": GOOD})
    )

    assert ts.main(arguments) == 0
    assert connects == [("postgresql://example", None)]
    [params] = connection.params
    assert params["since"] < datetime.now(timezone.utc) - timedelta(
        days=days
    ) + timedelta(minutes=1)
    assert params["since"] > datetime.now(timezone.utc) - timedelta(
        days=days
    ) - timedelta(minutes=1)
    assert [key for _, key in s3.puts][-1:] == ([ts.POINTER] if puts else [])
    assert len(s3.puts) == puts
