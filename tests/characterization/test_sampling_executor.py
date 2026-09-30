import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

import backend_server as backend
import sampling_executor


@contextmanager
def database_connection(path):
    connection = sqlite3.connect(path)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


class FakeClock:
    def __init__(self, value=0.0):
        self.value = float(value)

    def monotonic(self):
        return self.value


class SamplingExecutorPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="geo-sampling-executor-")
        self.addCleanup(self.tempdir.cleanup)
        self.database = Path(self.tempdir.name) / "geo_agent.db"
        with database_connection(self.database) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.executescript(
                """
                CREATE TABLE projects (
                  project_id TEXT PRIMARY KEY
                );

                CREATE TABLE sample_runs (
                  run_id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL,
                  name TEXT NOT NULL DEFAULT '',
                  platform TEXT NOT NULL DEFAULT '',
                  sampler TEXT NOT NULL DEFAULT '',
                  scope TEXT NOT NULL DEFAULT '',
                  category TEXT NOT NULL DEFAULT '',
                  purpose TEXT NOT NULL DEFAULT 'monitoring',
                  status TEXT NOT NULL DEFAULT 'queued',
                  is_mock INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT '',
                  started_at TEXT NOT NULL DEFAULT '',
                  completed_at TEXT NOT NULL DEFAULT '',
                  FOREIGN KEY (project_id) REFERENCES projects(project_id)
                );

                CREATE TABLE sample_tasks (
                  task_id TEXT PRIMARY KEY,
                  run_id TEXT NOT NULL,
                  question_id TEXT NOT NULL DEFAULT '',
                  status TEXT NOT NULL DEFAULT 'queued',
                  answer_chars INTEGER NOT NULL DEFAULT 0,
                  error TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL DEFAULT '',
                  completed_at TEXT NOT NULL DEFAULT '',
                  FOREIGN KEY (run_id) REFERENCES sample_runs(run_id)
                );

                CREATE TABLE samples (
                  sample_id TEXT PRIMARY KEY,
                  project_id TEXT NOT NULL,
                  run_id TEXT NOT NULL DEFAULT '',
                  task_id TEXT NOT NULL DEFAULT '',
                  question_id TEXT NOT NULL DEFAULT '',
                  sample_type TEXT NOT NULL DEFAULT 'real',
                  answer_text TEXT NOT NULL DEFAULT '',
                  collected_at TEXT NOT NULL DEFAULT ''
                );

                INSERT INTO projects (project_id) VALUES ('proj-test');
                """
            )

    def ensure_tables(self):
        with database_connection(self.database) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            sampling_executor.ensure_executor_tables(connection)

    def schedule(self, **overrides):
        values = {
            "schedule_id": "sched-weekly",
            "project_id": "proj-test",
            "name": "周度监测",
            "cadence": "weekly",
            "day_of_week": 2,
            "source_run_id": "run-template",
            "next_run_at": "2026-07-28T06:47:00+08:00",
            "created_by": "tester",
        }
        values.update(overrides)
        return values

    def insert_run(self, run_id, status="queued", task_status=None, task_error=""):
        task_status = task_status or status
        with database_connection(self.database) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute(
                """
                INSERT INTO sample_runs (
                  run_id, project_id, sampler, status, created_at, started_at
                ) VALUES (?, 'proj-test', ?, ?, '2026-07-25T00:00:00Z', '2026-07-25T00:00:00Z')
                """,
                (run_id, backend.DOUBAO_API_WEBSEARCH_SAMPLER, status),
            )
            connection.execute(
                """
                INSERT INTO sample_tasks (
                  task_id, run_id, question_id, status, error, created_at
                ) VALUES (?, ?, 'Q-test', ?, ?, '2026-07-25T00:00:00Z')
                """,
                (f"task-{run_id}", run_id, task_status, task_error),
            )

    def runtime_objects(self, clock_value=0):
        clock = FakeClock(clock_value)
        adaptive = backend.ArkAdaptiveConcurrency()
        limiter = backend.ArkRequestLimiter(
            min_interval_seconds=0,
            monotonic_fn=clock.monotonic,
            sleep_fn=lambda _seconds: None,
        )
        return clock, adaptive, limiter

    def test_migration_creates_both_tables_and_due_index(self):
        self.ensure_tables()
        with database_connection(self.database) as connection:
            tables = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT name FROM sqlite_master
                    WHERE type = 'table'
                    """
                )
            }
            indexes = {
                row[0]
                for row in connection.execute(
                    """
                    SELECT name FROM sqlite_master
                    WHERE type = 'index'
                    """
                )
            }
            schedule_columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(sampling_schedules)")
            }
        self.assertIn("sampling_schedules", tables)
        self.assertIn("executor_state", tables)
        self.assertIn("idx_sampling_schedules_due", indexes)
        self.assertEqual(
            schedule_columns,
            {
                "schedule_id",
                "project_id",
                "name",
                "cadence",
                "day_of_week",
                "day_of_month",
                "run_at_local",
                "source_run_id",
                "max_concurrency",
                "daily_task_budget",
                "enabled",
                "next_run_at",
                "last_run_id",
                "last_status",
                "last_error",
                "created_by",
                "created_at",
                "updated_at",
            },
        )

    def test_migration_is_idempotent_and_preserves_existing_new_table_rows(self):
        self.ensure_tables()
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(),
            now=1000,
        )
        sampling_executor.set_executor_state(
            self.database,
            "test_state",
            "kept",
            now=1000,
        )
        with database_connection(self.database) as connection:
            schema_version_before = connection.execute("PRAGMA schema_version").fetchone()[0]
            schedule_before = connection.execute(
                "SELECT * FROM sampling_schedules"
            ).fetchall()
            state_before = connection.execute("SELECT * FROM executor_state").fetchall()
            sampling_executor.ensure_executor_tables(connection)
            sampling_executor.ensure_executor_tables(connection)
            schema_version_after = connection.execute("PRAGMA schema_version").fetchone()[0]
            schedule_after = connection.execute(
                "SELECT * FROM sampling_schedules"
            ).fetchall()
            state_after = connection.execute("SELECT * FROM executor_state").fetchall()
        self.assertEqual(schema_version_after, schema_version_before)
        self.assertEqual(schedule_after, schedule_before)
        self.assertEqual(state_after, state_before)

    def test_schedule_round_trip_uses_safe_disabled_defaults(self):
        saved = sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(),
            now=1000,
        )
        loaded = sampling_executor.get_sampling_schedule(
            self.database,
            saved["schedule_id"],
        )
        self.assertEqual(loaded, saved)
        self.assertEqual(saved["run_at_local"], "06:47")
        self.assertEqual(saved["max_concurrency"], 4)
        self.assertEqual(saved["daily_task_budget"], 200)
        self.assertEqual(saved["enabled"], 0)
        self.assertIsNone(saved["day_of_month"])

    def test_schedule_unique_constraint_rejects_duplicate_template_cadence(self):
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(),
            now=1000,
        )
        duplicate = self.schedule(schedule_id="sched-duplicate")
        with self.assertRaises(sqlite3.IntegrityError):
            sampling_executor.create_sampling_schedule(
                self.database,
                duplicate,
                now=1001,
            )

    def test_schedule_budget_hard_limit_is_500(self):
        accepted = sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(daily_task_budget=500),
            now=1000,
        )
        self.assertEqual(accepted["daily_task_budget"], 500)
        with self.assertRaisesRegex(ValueError, "between 1 and 500"):
            sampling_executor.create_sampling_schedule(
                self.database,
                self.schedule(
                    schedule_id="sched-over-budget",
                    source_run_id="other-template",
                    daily_task_budget=501,
                ),
                now=1001,
            )

    def test_schedule_foreign_key_is_enforced_and_database_is_clean(self):
        with self.assertRaises(sqlite3.IntegrityError):
            sampling_executor.create_sampling_schedule(
                self.database,
                self.schedule(
                    schedule_id="sched-invalid-project",
                    project_id="missing-project",
                ),
                now=1000,
            )
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(),
            now=1001,
        )
        with database_connection(self.database) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            violations = connection.execute("PRAGMA foreign_key_check").fetchall()
        self.assertEqual(violations, [])

    def test_adaptive_limit_and_clean_windows_round_trip(self):
        _, adaptive, limiter = self.runtime_objects()
        adaptive.record_window(True)
        adaptive.record_window(False)
        adaptive.record_window(False)
        persisted = sampling_executor.executor_persist_runtime_state(
            self.database,
            adaptive,
            limiter,
            now=1000,
        )
        self.assertEqual(persisted["adaptive_limit"], 2)
        self.assertEqual(persisted["clean_windows"], 2)

        _, restored_adaptive, restored_limiter = self.runtime_objects()
        restored = sampling_executor.executor_restore_runtime_state(
            self.database,
            restored_adaptive,
            restored_limiter,
            now=1001,
        )
        self.assertEqual(restored["adaptive_limit"], 2)
        self.assertEqual(restored["clean_windows"], 2)
        self.assertEqual(restored_adaptive.effective(4), 2)

    def test_active_pause_round_trips_as_wall_clock_deadline(self):
        _, adaptive, limiter = self.runtime_objects(clock_value=100)
        limiter.pause(90)
        sampling_executor.executor_persist_runtime_state(
            self.database,
            adaptive,
            limiter,
            now=1000,
        )
        pause_state = sampling_executor.get_executor_state(
            self.database,
            sampling_executor.STATE_GLOBAL_PAUSE_UNTIL,
        )
        self.assertAlmostEqual(float(pause_state["state_value"]), 1090, places=3)

        _, restored_adaptive, restored_limiter = self.runtime_objects(clock_value=200)
        restored = sampling_executor.executor_restore_runtime_state(
            self.database,
            restored_adaptive,
            restored_limiter,
            now=1020,
        )
        self.assertAlmostEqual(restored["pause_remaining_seconds"], 70, places=3)
        self.assertEqual(
            restored_limiter.snapshot()["pause_remaining_seconds"],
            70,
        )

    def test_expired_pause_is_cleared_in_memory_and_on_disk(self):
        sampling_executor.set_executor_state(
            self.database,
            sampling_executor.STATE_GLOBAL_PAUSE_UNTIL,
            "900",
            now=800,
        )
        _, adaptive, limiter = self.runtime_objects(clock_value=50)
        restored = sampling_executor.executor_restore_runtime_state(
            self.database,
            adaptive,
            limiter,
            now=1000,
        )
        stored = sampling_executor.get_executor_state(
            self.database,
            sampling_executor.STATE_GLOBAL_PAUSE_UNTIL,
        )
        self.assertTrue(restored["pause_expired"])
        self.assertEqual(limiter.snapshot()["pause_remaining_seconds"], 0)
        self.assertEqual(stored["state_value"], "0")

    def test_startup_recovery_reuses_backend_recovery_and_records_queued_run(self):
        marker = backend.ark_running_marker(started_epoch=1000)
        self.insert_run(
            "run-interrupted",
            status="running",
            task_status="running",
            task_error=marker,
        )
        _, adaptive, limiter = self.runtime_objects()
        with mock.patch.object(backend, "DB_FILE", self.database):
            recovery = sampling_executor.executor_startup_recovery(
                self.database,
                backend.recover_interrupted_ark_tasks,
                adaptive,
                limiter,
                sampler=backend.DOUBAO_API_WEBSEARCH_SAMPLER,
                safe_timeout_seconds=backend.ARK_RUNNING_SAFE_TIMEOUT_SECONDS,
                now=1000,
            )
        with database_connection(self.database) as connection:
            task_status = connection.execute(
                "SELECT status FROM sample_tasks WHERE run_id = 'run-interrupted'"
            ).fetchone()[0]
            run_status = connection.execute(
                "SELECT status FROM sample_runs WHERE run_id = 'run-interrupted'"
            ).fetchone()[0]
        queued_state = sampling_executor.get_executor_state(
            self.database,
            sampling_executor.STATE_STARTUP_QUEUED_RUNS,
        )
        queued_payload = json.loads(queued_state["state_value"])
        self.assertEqual(recovery["recovered_task_count"], 1)
        self.assertEqual(task_status, "queued")
        self.assertEqual(run_status, "queued")
        self.assertEqual(recovery["queued_runs"][0]["run_id"], "run-interrupted")
        self.assertEqual(queued_payload["runs"][0]["run_id"], "run-interrupted")
        self.assertFalse(recovery["auto_dispatched"])

    def test_startup_marks_only_due_enabled_schedule_as_missed(self):
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(
                schedule_id="sched-due",
                source_run_id="run-due",
                enabled=1,
                next_run_at="2026-07-25T00:00:00Z",
            ),
            now=1000,
        )
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(
                schedule_id="sched-future",
                source_run_id="run-future",
                enabled=1,
                next_run_at="2026-07-26T00:00:00Z",
            ),
            now=1000,
        )
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(
                schedule_id="sched-disabled",
                source_run_id="run-disabled",
                enabled=0,
                next_run_at="2026-07-24T00:00:00Z",
            ),
            now=1000,
        )
        now_epoch = datetime(2026, 7, 25, 1, tzinfo=timezone.utc).timestamp()
        _, adaptive, limiter = self.runtime_objects()
        recover = mock.Mock(return_value=0)
        recovery = sampling_executor.executor_startup_recovery(
            self.database,
            recover,
            adaptive,
            limiter,
            now=now_epoch,
        )
        due = sampling_executor.get_sampling_schedule(self.database, "sched-due")
        future = sampling_executor.get_sampling_schedule(self.database, "sched-future")
        disabled = sampling_executor.get_sampling_schedule(self.database, "sched-disabled")
        with database_connection(self.database) as connection:
            run_count = connection.execute("SELECT COUNT(*) FROM sample_runs").fetchone()[0]
        self.assertEqual([item["schedule_id"] for item in recovery["missed_schedules"]], ["sched-due"])
        self.assertEqual(due["last_status"], "missed")
        self.assertIn("未自动补跑", due["last_error"])
        self.assertEqual(future["last_status"], "")
        self.assertEqual(disabled["last_status"], "")
        self.assertEqual(run_count, 0)
        recover.assert_not_called()

    def test_executor_mark_blocked_persists_run_schedule_and_reason(self):
        self.insert_run("run-blocked", status="queued", task_status="queued")
        sampling_executor.create_sampling_schedule(
            self.database,
            self.schedule(
                schedule_id="sched-blocked",
                source_run_id="run-blocked",
                last_run_id="run-blocked",
            ),
            now=1000,
        )
        marker = sampling_executor.executor_mark_blocked(
            "run-blocked",
            "mock failure threshold reached",
            db_path=self.database,
            now=1100,
        )
        schedule = sampling_executor.get_sampling_schedule(
            self.database,
            "sched-blocked",
        )
        state = sampling_executor.get_executor_state(
            self.database,
            "blocked_run:run-blocked",
        )
        with database_connection(self.database) as connection:
            run_status = connection.execute(
                "SELECT status FROM sample_runs WHERE run_id = 'run-blocked'"
            ).fetchone()[0]
        self.assertEqual(marker["status"], "executor_blocked")
        self.assertEqual(run_status, "executor_blocked")
        self.assertEqual(schedule["last_status"], "executor_blocked")
        self.assertEqual(schedule["last_error"], "mock failure threshold reached")
        self.assertEqual(json.loads(state["state_value"])["reason"], marker["reason"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
