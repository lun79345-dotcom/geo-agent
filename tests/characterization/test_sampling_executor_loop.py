import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

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
    def __init__(self, effective_limit=4, clean_windows=0):
        self._lock = threading.Lock()
        self._effective_limit = effective_limit
        self._clean_windows = clean_windows

    def snapshot(self):
        with self._lock:
            return {
                "adaptive_limit": self._effective_limit,
                "clean_windows": self._clean_windows,
                "degraded": self._effective_limit < 4,
            }


class FakeRequestLimiter:
    def __init__(self):
        self._dispatch_lock = threading.Lock()
        self._pause_until = 0.0
        self._clock = 0.0
        self._monotonic = lambda: self._clock

    def snapshot(self):
        return {
            "pause_remaining_seconds": max(0.0, self._pause_until - self._clock),
            "dispatch_interval_ms": 0,
        }


class FakeWindow:
    def __init__(self, database, outcome="success", tasks_per_window=4):
        self.database = database
        self.outcome = outcome
        self.tasks_per_window = tasks_per_window
        self.calls = []
        self.lock = threading.Lock()
        self.started = threading.Event()
        self.release = None

    def __call__(self, project_id, payload):
        if not self.lock.acquire(blocking=False):
            raise ValueError("当前批次已有采样窗口正在执行，请等待本窗口完成")
        try:
            self.calls.append((project_id, dict(payload)))
            self.started.set()
            if self.release is not None:
                self.release.wait(timeout=3)
            run_id = payload["run_id"]
            limit = min(int(payload["max_concurrency"]), self.tasks_per_window)
            with database_connection(self.database) as connection:
                tasks = connection.execute(
                    """
                    SELECT task_id, question_id
                    FROM sample_tasks
                    WHERE run_id = ? AND status = 'queued'
                    ORDER BY task_id
                    LIMIT ?
                    """,
                    (run_id, limit),
                ).fetchall()
                executed = []
                for task in tasks:
                    error = "" if self.outcome == "success" else "mock non-429 failure"
                    connection.execute(
                        """
                        UPDATE sample_tasks
                        SET status = ?, error = ?, completed_at = 'done'
                        WHERE task_id = ?
                        """,
                        (self.outcome, error, task["task_id"]),
                    )
                    executed.append(
                        {
                            "task_id": task["task_id"],
                            "question_id": task["question_id"],
                            "status": self.outcome,
                            "error": error,
                            "rate_limited": False,
                        }
                    )
                counts = {
                    row["status"]: int(row["count"])
                    for row in connection.execute(
                        """
                        SELECT status, COUNT(*) AS count
                        FROM sample_tasks
                        WHERE run_id = ?
                        GROUP BY status
                        """,
                        (run_id,),
                    )
                }
                queued = counts.get("queued", 0)
                failed = counts.get("failed", 0)
                status = "queued" if queued else ("partial_failed" if failed else "completed")
                connection.execute(
                    "UPDATE sample_runs SET status = ?, completed_at = ? WHERE run_id = ?",
                    (status, "" if queued else "done", run_id),
                )
            return {
                "ok": True,
                "executed_tasks": executed,
                "run": {
                    "run_id": run_id,
                    "status": status,
                    "queued_count": queued,
                    "failed_count": failed,
                },
                "summary": {"status": status},
            }
        finally:
            self.lock.release()


class SamplingExecutorLoopTests(unittest.TestCase):
    NOW = datetime(2026, 7, 25, 4, 30, tzinfo=timezone.utc).timestamp()

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory(prefix="geo-executor-loop-")
        self.addCleanup(self.tempdir.cleanup)
        self.database = Path(self.tempdir.name) / "geo_agent.db"
        with database_connection(self.database) as connection:
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
                  status TEXT NOT NULL DEFAULT 'queued',
                  is_mock INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT '',
                  started_at TEXT NOT NULL DEFAULT '',
                  completed_at TEXT NOT NULL DEFAULT '',
                  purpose TEXT NOT NULL DEFAULT 'monitoring',
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
                INSERT INTO projects (project_id) VALUES ('proj-test');
                INSERT INTO projects (project_id) VALUES ('proj-other');
                """
            )
            sampling_executor.ensure_executor_tables(connection)
        self.adaptive = FakeAdaptiveConcurrency()
        self.limiter = FakeRequestLimiter()

    def insert_run(
        self,
        run_id,
        *,
        project_id="proj-test",
        sampler=sampling_executor.ARK_SAMPLER,
        scope="manual",
        status="queued",
        task_count=4,
        task_status="queued",
    ):
        with database_connection(self.database) as connection:
            connection.execute(
                """
                INSERT INTO sample_runs (
                  run_id, project_id, name, platform, sampler, scope, category,
                  status, is_mock, created_at, purpose
                ) VALUES (?, ?, ?, '豆包火山方舟', ?, ?, '', ?, 0, ?, 'monitoring')
                """,
                (
                    run_id,
                    project_id,
                    f"批次 {run_id}",
                    sampler,
                    scope,
                    status,
                    "2026-07-25T00:00:00Z",
                ),
            )
            for index in range(task_count):
                connection.execute(
                    """
                    INSERT INTO sample_tasks (
                      task_id, run_id, question_id, status, created_at
                    ) VALUES (?, ?, ?, ?, '2026-07-25T00:00:00Z')
                    """,
                    (
                        f"task-{run_id}-{index:02d}",
                        run_id,
                        f"Q{index + 1:03d}",
                        task_status,
                    ),
                )

    def handoff(self, run_id):
        return sampling_executor.executor_handoff_run(
            self.database,
            "proj-test",
            run_id,
            handed_off_by="tester",
            now=self.NOW,
        )

    def loop(self, window, *, key_set=True, now=None, dispatch_guard=None):
        return sampling_executor.SamplingExecutorLoop(
            self.database,
            window,
            self.adaptive,
            self.limiter,
            lambda: {"api_key_set": key_set},
            run_dispatch_guard_fn=dispatch_guard,
            tick_seconds=30,
            now_fn=lambda: self.NOW if now is None else now,
            logger=lambda _message: None,
        )

    def test_dispatch_guard_prevents_window_and_releases_handoff(self):
        self.insert_run("run-guarded")
        self.handoff("run-guarded")
        window = FakeWindow(self.database)
        loop = self.loop(
            window,
            dispatch_guard=lambda _project_id, _run_id: {
                "allowed": False,
                "reason": "context_drift",
            },
        )
        result = loop.tick()
        self.assertEqual(window.calls, [])
        self.assertEqual(
            result["guarded_runs"],
            [{"run_id": "run-guarded", "reason": "context_drift"}],
        )
        self.assertIsNone(
            sampling_executor.get_executor_state(
                self.database,
                f"{sampling_executor.STATE_HANDOFF_RUN_PREFIX}run-guarded",
            )
        )

    def test_tick_is_idempotent_while_same_loop_tick_is_running(self):
        self.insert_run("run-idempotent")
        self.handoff("run-idempotent")
        window = FakeWindow(self.database)
        window.release = threading.Event()
        loop = self.loop(window)
        first_result = {}

        thread = threading.Thread(target=lambda: first_result.update(loop.tick()))
        thread.start()
        self.assertTrue(window.started.wait(timeout=2))
        second = loop.tick()
        window.release.set()
        thread.join(timeout=3)

        self.assertEqual(second["skipped"], "tick_in_progress")
        self.assertEqual(len(window.calls), 1)
        self.assertTrue(first_result["ok"])

    def test_two_fake_executors_never_double_run_same_window(self):
        self.insert_run("run-mutual")
        self.handoff("run-mutual")
        window = FakeWindow(self.database)
        window.release = threading.Event()
        first_loop = self.loop(window)
        second_loop = self.loop(window)
        first = {}

        thread = threading.Thread(target=lambda: first.update(first_loop.tick()))
        thread.start()
        self.assertTrue(window.started.wait(timeout=2))
        second = second_loop.tick()
        window.release.set()
        thread.join(timeout=3)

        self.assertEqual(len(window.calls), 1)
        self.assertEqual(second["yielded_runs"], ["run-mutual"])
        self.assertEqual(first["windows"][0]["run_id"], "run-mutual")

    def test_browser_window_busy_value_error_yields_without_marking_error(self):
        self.insert_run("run-browser")
        self.handoff("run-browser")

        def browser_busy(_project_id, _payload):
            raise ValueError("当前批次已有任务正在执行，请等待完成后再试")

        result = self.loop(browser_busy).tick()
        self.assertEqual(result["yielded_runs"], ["run-browser"])
        self.assertIsNone(
            sampling_executor.get_executor_state(
                self.database,
                f"{sampling_executor.STATE_RUN_LAST_ERROR_PREFIX}run-browser",
            )
        )

    def test_budget_limit_defers_run_exactly_one_hour(self):
        self.insert_run("run-budget")
        self.handoff("run-budget")
        sampling_executor.set_executor_state(
            self.database,
            "daily_task_count_2026-07-25",
            "200",
            now=self.NOW,
        )
        window = FakeWindow(self.database)
        result = self.loop(window).tick()

        self.assertEqual(len(window.calls), 0)
        self.assertEqual(
            result["deferred_runs"][0]["until"],
            "2026-07-25T05:30:00Z",
        )

    def test_missing_api_key_skips_and_records_boolean_safe_error(self):
        self.insert_run("run-no-key")
        self.handoff("run-no-key")
        window = FakeWindow(self.database)
        result = self.loop(window, key_set=False).tick()
        state = sampling_executor.get_executor_state(
            self.database,
            sampling_executor.STATE_EXECUTOR_LAST_ERROR,
        )

        self.assertEqual(result["skipped"], "api_key_missing")
        self.assertEqual(len(window.calls), 0)
        self.assertIn("API Key 未配置", state["state_value"])

    def test_three_all_failed_non_429_windows_trip_breaker(self):
        self.insert_run("run-breaker", task_count=4)
        self.handoff("run-breaker")
        window = FakeWindow(self.database, outcome="failed", tasks_per_window=1)
        loop = self.loop(window)

        self.assertFalse(loop.tick()["windows"][0]["blocked"])
        self.assertFalse(loop.tick()["windows"][0]["blocked"])
        third = loop.tick()
        with database_connection(self.database) as connection:
            status = connection.execute(
                "SELECT status FROM sample_runs WHERE run_id = 'run-breaker'"
            ).fetchone()["status"]

        self.assertTrue(third["windows"][0]["blocked"])
        self.assertEqual(third["blocked_runs"], ["run-breaker"])
        self.assertEqual(status, "executor_blocked")
        fourth = loop.tick()
        self.assertEqual(fourth["windows"], [])

    def test_missed_schedule_catches_up_once_and_does_not_chase(self):
        self.insert_run(
            "run-template",
            status="completed",
            task_count=2,
            task_status="success",
        )
        sampling_executor.create_sampling_schedule(
            self.database,
            {
                "schedule_id": "sched-missed",
                "project_id": "proj-test",
                "name": "周度服务端监测",
                "cadence": "weekly",
                "day_of_week": 6,
                "run_at_local": "06:47",
                "source_run_id": "run-template",
                "enabled": 1,
                "next_run_at": "2026-07-18T06:47:00+08:00",
                "last_run_id": "run-template",
                "last_status": "missed",
            },
            now=self.NOW,
        )
        window = FakeWindow(self.database)
        loop = self.loop(window)
        first = loop.tick()
        second = loop.tick()
        schedule = sampling_executor.get_sampling_schedule(
            self.database,
            "sched-missed",
        )
        with database_connection(self.database) as connection:
            run_count = connection.execute("SELECT COUNT(*) FROM sample_runs").fetchone()[0]

        self.assertEqual(len(first["created_runs"]), 1)
        self.assertEqual(len(second["created_runs"]), 0)
        self.assertEqual(run_count, 2)
        self.assertEqual(schedule["last_status"], "completed")
        self.assertGreater(
            datetime.fromisoformat(schedule["next_run_at"]).timestamp(),
            self.NOW,
        )

    def test_next_run_at_uses_asia_shanghai_for_weekly_and_monthly(self):
        weekly = sampling_executor.next_schedule_at(
            {
                "cadence": "weekly",
                "day_of_week": 6,
                "run_at_local": "06:47",
            },
            after=datetime(2026, 7, 25, 0, 0, tzinfo=timezone.utc),
        )
        monthly = sampling_executor.next_schedule_at(
            {
                "cadence": "monthly",
                "day_of_month": 25,
                "run_at_local": "06:47",
            },
            after=datetime(2026, 7, 25, 0, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(weekly, "2026-08-01T06:47:00+08:00")
        self.assertEqual(monthly, "2026-08-25T06:47:00+08:00")

    def test_handoff_validates_project_sampler_queue_and_is_idempotent(self):
        self.insert_run("run-handoff")
        with self.assertRaisesRegex(ValueError, "不属于当前项目"):
            sampling_executor.executor_handoff_run(
                self.database,
                "proj-other",
                "run-handoff",
            )
        first = self.handoff("run-handoff")
        second = self.handoff("run-handoff")
        with database_connection(self.database) as connection:
            marker_count = connection.execute(
                """
                SELECT COUNT(*) FROM executor_state
                WHERE state_key = ?
                """,
                (f"{sampling_executor.STATE_HANDOFF_RUN_PREFIX}run-handoff",),
            ).fetchone()[0]

        self.assertFalse(first["already_handed_off"])
        self.assertTrue(second["already_handed_off"])
        self.assertEqual(marker_count, 1)

        self.insert_run("run-wrong-sampler", sampler="other")
        with self.assertRaisesRegex(ValueError, "不是豆包"):
            self.handoff("run-wrong-sampler")
        self.insert_run(
            "run-no-queue",
            status="completed",
            task_status="success",
        )
        with self.assertRaisesRegex(ValueError, "没有待执行任务"):
            self.handoff("run-no-queue")

    def test_pause_and_resume_are_idempotent_and_tick_obeys_switch(self):
        self.insert_run("run-pause")
        self.handoff("run-pause")
        window = FakeWindow(self.database)
        sampling_executor.executor_pause(self.database, now=self.NOW)
        sampling_executor.executor_pause(self.database, now=self.NOW)
        paused = self.loop(window).tick()
        sampling_executor.executor_resume(self.database, now=self.NOW)
        sampling_executor.executor_resume(self.database, now=self.NOW)
        resumed = self.loop(window).tick()

        self.assertEqual(paused["skipped"], "paused")
        self.assertEqual(len(window.calls), 1)
        self.assertEqual(resumed["windows"][0]["run_id"], "run-pause")
        self.assertFalse(sampling_executor.executor_is_paused(self.database))

    def test_restart_continues_persisted_handoff_run(self):
        self.insert_run("run-restart", task_count=2)
        self.handoff("run-restart")
        first_process_window = FakeWindow(self.database, tasks_per_window=1)
        self.loop(first_process_window).tick()
        second_process_window = FakeWindow(self.database, tasks_per_window=1)
        restarted_loop = self.loop(second_process_window)
        result = restarted_loop.tick()

        self.assertEqual(len(second_process_window.calls), 1)
        self.assertEqual(result["windows"][0]["run_id"], "run-restart")
        with database_connection(self.database) as connection:
            status = connection.execute(
                "SELECT status FROM sample_runs WHERE run_id = 'run-restart'"
            ).fetchone()["status"]
        self.assertEqual(status, "completed")

    def test_status_reports_sources_budget_degradation_and_blocked_runs(self):
        self.insert_run("run-status", task_count=2)
        self.handoff("run-status")
        self.adaptive._effective_limit = 2
        sampling_executor.set_executor_state(
            self.database,
            "daily_task_count_2026-07-25",
            "7",
            now=self.NOW,
        )
        sampling_executor.executor_mark_blocked(
            "run-status",
            "mock breaker",
            db_path=self.database,
            now=self.NOW,
        )
        status = sampling_executor.executor_status(
            self.database,
            adaptive_concurrency=self.adaptive,
            api_key_status_fn=lambda: {"api_key_set": True},
            now=self.NOW,
        )

        self.assertEqual(status["effective_limit"], 2)
        self.assertEqual(status["today"]["task_count"], 7)
        self.assertTrue(status["api_key_set"])
        self.assertEqual(status["run_sources"]["run-status"], "executor_blocked")
        self.assertEqual(status["blocked_runs"][0]["reason"], "mock breaker")


if __name__ == "__main__":
    unittest.main(verbosity=2)
