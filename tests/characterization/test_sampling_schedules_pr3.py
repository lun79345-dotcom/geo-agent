import sqlite3
import sys
import tempfile
import threading
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
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


class FakeAdaptiveConcurrency:
    def __init__(self):
        self._lock = threading.Lock()
        self._effective_limit = 4
        self._clean_windows = 0

    def snapshot(self):
        return {"adaptive_limit": 4, "clean_windows": 0}


class FakeRequestLimiter:
    def __init__(self):
        self._dispatch_lock = threading.Lock()
        self._pause_until = 0.0
        self._monotonic = lambda: 0.0

    def snapshot(self):
        return {"pause_remaining_seconds": 0}


class CompletingFakeWindow:
    def __init__(self, database):
        self.database = database
        self.calls = []

    def __call__(self, project_id, payload):
        self.calls.append((project_id, dict(payload)))
        with database_connection(self.database) as connection:
            tasks = connection.execute(
                """
                SELECT task_id, question_id
                FROM sample_tasks
                WHERE run_id = ? AND status = 'queued'
                ORDER BY task_id
                LIMIT ?
                """,
                (payload["run_id"], int(payload["max_concurrency"])),
            ).fetchall()
            executed = []
            for task in tasks:
                connection.execute(
                    """
                    UPDATE sample_tasks
                    SET status = 'success', answer_chars = 12, completed_at = 'done'
                    WHERE task_id = ?
                    """,
                    (task["task_id"],),
                )
                executed.append(
                    {
                        "task_id": task["task_id"],
                        "question_id": task["question_id"],
                        "status": "success",
                        "rate_limited": False,
                    }
                )
            queued = int(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM sample_tasks
                    WHERE run_id = ? AND status = 'queued'
                    """,
                    (payload["run_id"],),
                ).fetchone()[0]
            )
            status = "queued" if queued else "completed"
            connection.execute(
                """
                UPDATE sample_runs
                SET status = ?, completed_at = ?
                WHERE run_id = ?
                """,
                (status, "" if queued else "done", payload["run_id"]),
            )
        return {
            "ok": True,
            "executed_tasks": executed,
            "run": {"run_id": payload["run_id"], "status": status},
        }


class SamplingSchedulesPr3Tests(unittest.TestCase):
    NOW = datetime(2026, 7, 25, 4, 30, tzinfo=timezone.utc).timestamp()

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="geo-sampling-pr3-")
        self.addCleanup(self.tempdir.cleanup)
        self.database = Path(self.tempdir.name) / "geo_agent.db"
        with database_connection(self.database) as connection:
            connection.executescript(
                """
                CREATE TABLE projects (
                  project_id TEXT PRIMARY KEY
                );
                CREATE TABLE question_pool (
                  question_id TEXT PRIMARY KEY,
                  question TEXT NOT NULL DEFAULT '',
                  category TEXT NOT NULL DEFAULT ''
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
                  question_id TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'queued',
                  answer_chars INTEGER NOT NULL DEFAULT 0,
                  error TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL DEFAULT '',
                  completed_at TEXT NOT NULL DEFAULT '',
                  FOREIGN KEY (run_id) REFERENCES sample_runs(run_id),
                  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
                );
                INSERT INTO projects (project_id) VALUES ('proj-test');
                INSERT INTO projects (project_id) VALUES ('proj-other');
                INSERT INTO question_pool (question_id, question) VALUES
                  ('Q001', '测试问题一'),
                  ('Q002', '测试问题二'),
                  ('Q003', '测试问题三');
                """
            )
        self.insert_template()

    def insert_template(
        self,
        run_id="run-template",
        *,
        project_id="proj-test",
        sampler=sampling_executor.ARK_SAMPLER,
        purpose="monitoring",
        question_ids=("Q001", "Q002", "Q003"),
    ):
        with database_connection(self.database) as connection:
            connection.execute(
                """
                INSERT INTO sample_runs (
                  run_id, project_id, name, platform, sampler, scope, category,
                  purpose, status, is_mock, created_at
                ) VALUES (?, ?, ?, '豆包火山方舟', ?, 'manual', '四场景',
                          ?, 'completed', 0, '2026-07-20T00:00:00Z')
                """,
                (run_id, project_id, f"模板 {run_id}", sampler, purpose),
            )
            for index, question_id in enumerate(question_ids, start=1):
                connection.execute(
                    """
                    INSERT INTO sample_tasks (
                      task_id, run_id, question_id, status, created_at
                    ) VALUES (?, ?, ?, 'success', ?)
                    """,
                    (
                        f"source-task-{run_id}-{index}",
                        run_id,
                        question_id,
                        f"2026-07-20T00:00:0{index}Z",
                    ),
                )

    def ensure(self):
        with database_connection(self.database) as connection:
            sampling_executor.ensure_executor_tables(connection)

    def due_schedule(self, schedule_id="schedule-due", **overrides):
        values = {
            "schedule_id": schedule_id,
            "project_id": "proj-test",
            "name": "周度精确监测",
            "cadence": "weekly",
            "day_of_week": 2,
            "source_run_id": "run-template",
            "enabled": 1,
            "next_run_at": "2026-07-24T06:47:00+08:00",
            "created_by": "tester",
        }
        values.update(overrides)
        return sampling_executor.create_sampling_schedule(
            self.database,
            values,
            now=self.NOW,
        )

    def loop(self, window, *, key_set=True):
        return sampling_executor.SamplingExecutorLoop(
            self.database,
            window,
            FakeAdaptiveConcurrency(),
            FakeRequestLimiter(),
            lambda: {"api_key_set": key_set},
            now_fn=lambda: self.NOW,
            logger=lambda _message: None,
        )

    def test_migration_adds_nullable_schedule_id_and_is_idempotent(self):
        self.ensure()
        self.ensure()
        with database_connection(self.database) as connection:
            columns = {
                row["name"]: row
                for row in connection.execute("PRAGMA table_info(sample_runs)")
            }
            source = connection.execute(
                "SELECT schedule_id FROM sample_runs WHERE run_id = 'run-template'"
            ).fetchone()
        self.assertIn("schedule_id", columns)
        self.assertEqual(columns["schedule_id"]["notnull"], 0)
        self.assertIsNone(source["schedule_id"])

    def test_create_defaults_disabled_and_lists_template_metadata(self):
        self.ensure()
        created = sampling_executor.create_project_sampling_schedule(
            self.database,
            "proj-test",
            {
                "name": "每周真实监测",
                "source_run_id": "run-template",
                "cadence": "weekly",
                "day_of_week": 2,
                "run_at_local": "06:47",
                "daily_task_budget": 80,
            },
            created_by="tester",
            now=self.NOW,
        )
        payload = sampling_executor.list_project_sampling_schedules(
            self.database,
            "proj-test",
        )
        self.assertFalse(created["enabled"])
        self.assertTrue(created["next_run_at"].endswith("+08:00"))
        self.assertEqual(payload["schedules"][0]["source_task_count"], 3)
        template = next(
            item for item in payload["templates"] if item["run_id"] == "run-template"
        )
        self.assertEqual(template["task_count"], 3)

    def test_create_rejects_wrong_project_and_non_ark_template(self):
        self.ensure()
        self.insert_template(
            "run-other-project",
            project_id="proj-other",
            question_ids=("Q001",),
        )
        self.insert_template(
            "run-wrong-sampler",
            sampler="manual",
            question_ids=("Q001",),
        )
        base = {"cadence": "weekly", "day_of_week": 2}
        with self.assertRaisesRegex(ValueError, "不属于当前项目"):
            sampling_executor.create_project_sampling_schedule(
                self.database,
                "proj-test",
                {**base, "source_run_id": "run-other-project"},
                now=self.NOW,
            )
        with self.assertRaisesRegex(ValueError, "火山方舟"):
            sampling_executor.create_project_sampling_schedule(
                self.database,
                "proj-test",
                {**base, "source_run_id": "run-wrong-sampler"},
                now=self.NOW,
            )

    def test_unique_project_template_cadence_constraint_is_preserved(self):
        self.ensure()
        payload = {
            "source_run_id": "run-template",
            "cadence": "weekly",
            "day_of_week": 2,
        }
        sampling_executor.create_project_sampling_schedule(
            self.database,
            "proj-test",
            payload,
            now=self.NOW,
        )
        with self.assertRaisesRegex(ValueError, "只能创建一个调度"):
            sampling_executor.create_project_sampling_schedule(
                self.database,
                "proj-test",
                payload,
                now=self.NOW,
            )

    def test_patch_is_idempotent_and_recomputes_monthly_next_run(self):
        self.ensure()
        created = sampling_executor.create_project_sampling_schedule(
            self.database,
            "proj-test",
            {
                "source_run_id": "run-template",
                "cadence": "weekly",
                "day_of_week": 2,
            },
            now=self.NOW,
        )
        patch = {
            "cadence": "monthly",
            "day_of_week": None,
            "day_of_month": 15,
            "run_at_local": "06:47",
            "daily_task_budget": 90,
            "enabled": True,
        }
        changed = sampling_executor.update_project_sampling_schedule(
            self.database,
            "proj-test",
            created["schedule_id"],
            patch,
            now=self.NOW,
        )
        unchanged = sampling_executor.update_project_sampling_schedule(
            self.database,
            "proj-test",
            created["schedule_id"],
            patch,
            now=self.NOW,
        )
        self.assertTrue(changed["enabled"])
        self.assertTrue(changed["changed"])
        self.assertEqual(changed["next_run_at"], "2026-08-15T06:47:00+08:00")
        self.assertFalse(unchanged["changed"])
        self.assertEqual(unchanged["next_run_at"], changed["next_run_at"])

    def test_clone_preserves_exact_task_range_and_run_semantics(self):
        self.ensure()
        self.due_schedule()
        result = sampling_executor.clone_run_from_template(
            self.database,
            "schedule-due",
            now=self.NOW,
        )
        with database_connection(self.database) as connection:
            run = connection.execute(
                "SELECT * FROM sample_runs WHERE run_id = ?",
                (result["run_id"],),
            ).fetchone()
            tasks = connection.execute(
                """
                SELECT task_id, question_id
                FROM sample_tasks
                WHERE run_id = ?
                ORDER BY created_at, task_id
                """,
                (result["run_id"],),
            ).fetchall()
        self.assertEqual(run["schedule_id"], "schedule-due")
        self.assertEqual(run["scope"], "scheduled")
        self.assertEqual(run["is_mock"], 0)
        self.assertEqual(run["purpose"], "monitoring")
        self.assertIn("run-template", run["name"])
        self.assertEqual(
            [item["source_task_id"] for item in result["task_mapping"]],
            [
                "source-task-run-template-1",
                "source-task-run-template-2",
                "source-task-run-template-3",
            ],
        )
        self.assertEqual(
            [row["question_id"] for row in tasks],
            ["Q001", "Q002", "Q003"],
        )
        self.assertEqual(
            len({row["task_id"] for row in tasks}),
            len(result["task_mapping"]),
        )

    def test_clone_failure_rolls_back_run_tasks_and_schedule_pointer(self):
        self.ensure()
        self.due_schedule()
        with mock.patch.object(
            sampling_executor,
            "_new_id",
            side_effect=["run-rollback", "task-duplicate", "task-duplicate"],
        ):
            with self.assertRaises(sqlite3.IntegrityError):
                sampling_executor.clone_run_from_template(
                    self.database,
                    "schedule-due",
                    now=self.NOW,
                )
        with database_connection(self.database) as connection:
            run_count = connection.execute(
                "SELECT COUNT(*) FROM sample_runs WHERE run_id = 'run-rollback'"
            ).fetchone()[0]
            task_count = connection.execute(
                "SELECT COUNT(*) FROM sample_tasks WHERE run_id = 'run-rollback'"
            ).fetchone()[0]
            schedule = connection.execute(
                """
                SELECT last_run_id, last_status
                FROM sampling_schedules
                WHERE schedule_id = 'schedule-due'
                """
            ).fetchone()
        self.assertEqual(run_count, 0)
        self.assertEqual(task_count, 0)
        self.assertEqual(schedule["last_run_id"], "")
        self.assertEqual(schedule["last_status"], "")

    def test_due_scan_clones_executes_and_advances_full_fake_chain(self):
        self.ensure()
        self.due_schedule()
        window = CompletingFakeWindow(self.database)
        result = self.loop(window).tick()
        self.assertEqual(len(result["created_runs"]), 1)
        self.assertEqual(len(result["windows"]), 1)
        self.assertEqual(len(window.calls), 1)
        run_id = result["created_runs"][0]["run_id"]
        schedule = sampling_executor.get_sampling_schedule(
            self.database,
            "schedule-due",
        )
        with database_connection(self.database) as connection:
            run = connection.execute(
                "SELECT status, schedule_id FROM sample_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["schedule_id"], "schedule-due")
        self.assertEqual(schedule["last_status"], "completed")
        self.assertEqual(schedule["last_run_id"], run_id)
        self.assertGreater(
            datetime.fromisoformat(schedule["next_run_at"]).timestamp(),
            self.NOW,
        )

    def test_due_budget_check_precedes_missing_key_and_defers_without_clone(self):
        self.ensure()
        self.due_schedule(daily_task_budget=1)
        sampling_executor.set_executor_state(
            self.database,
            "daily_task_count_2026-07-25",
            "1",
            now=self.NOW,
        )
        result = self.loop(CompletingFakeWindow(self.database), key_set=False).tick()
        schedule = sampling_executor.get_sampling_schedule(
            self.database,
            "schedule-due",
        )
        with database_connection(self.database) as connection:
            scheduled_run_count = connection.execute(
                "SELECT COUNT(*) FROM sample_runs WHERE scope = 'scheduled'"
            ).fetchone()[0]
        self.assertEqual(result["skipped"], "api_key_missing")
        self.assertEqual(len(result["deferred_schedules"]), 1)
        self.assertEqual(result["skipped_schedules"], [])
        self.assertIn("预算", schedule["last_error"])
        self.assertEqual(schedule["next_run_at"], "2026-07-25T13:30:00+08:00")
        self.assertEqual(scheduled_run_count, 0)

    def test_weekly_and_monthly_progress_across_boundaries_in_shanghai(self):
        weekly_after = datetime(2026, 7, 28, 0, 0, tzinfo=timezone.utc)
        monthly_after = datetime(2026, 12, 31, 16, 1, tzinfo=timezone.utc)
        weekly = sampling_executor.next_schedule_at(
            {
                "cadence": "weekly",
                "day_of_week": 2,
                "run_at_local": "06:47",
            },
            after=weekly_after,
        )
        monthly = sampling_executor.next_schedule_at(
            {
                "cadence": "monthly",
                "day_of_month": 15,
                "run_at_local": "06:47",
            },
            after=monthly_after,
        )
        self.assertEqual(weekly, "2026-08-04T06:47:00+08:00")
        self.assertEqual(monthly, "2027-01-15T06:47:00+08:00")

    def test_delete_schedule_preserves_already_generated_run(self):
        self.ensure()
        self.due_schedule()
        cloned = sampling_executor.clone_run_from_template(
            self.database,
            "schedule-due",
            now=self.NOW,
        )
        deleted = sampling_executor.delete_project_sampling_schedule(
            self.database,
            "proj-test",
            "schedule-due",
        )
        with database_connection(self.database) as connection:
            run = connection.execute(
                "SELECT schedule_id, scope FROM sample_runs WHERE run_id = ?",
                (cloned["run_id"],),
            ).fetchone()
        self.assertTrue(deleted["generated_runs_preserved"])
        self.assertEqual(deleted["generated_run_count"], 1)
        self.assertEqual(run["schedule_id"], "schedule-due")
        self.assertEqual(run["scope"], "scheduled")

    def test_scheduled_periods_keep_existing_trend_integrity_gate(self):
        previous = {
            "scope": "manual",
            "planned_question_ids": ["Q001", "Q002"],
            "sampled_question_ids": ["Q001", "Q002"],
        }
        scheduled_same = {
            "scope": "scheduled",
            "schedule_id": "schedule-due",
            "planned_question_ids": ["Q002", "Q001"],
            "sampled_question_ids": ["Q002", "Q001"],
        }
        scheduled_changed = {
            **scheduled_same,
            "planned_question_ids": ["Q001", "Q003"],
            "sampled_question_ids": ["Q001", "Q003"],
        }
        self.assertEqual(
            backend.monitoring_period_comparison(scheduled_same, previous)["code"],
            "same_question_scope",
        )
        self.assertEqual(
            backend.monitoring_period_comparison(scheduled_changed, previous)["code"],
            "scope_changed",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
