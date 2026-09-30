"""Sampling executor persistence, recovery, and daemon orchestration.

The executor never implements Ark requests itself.  It only schedules the existing
``db_run_ark_websearch_window`` callback and persists ownership/runtime state.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_RUN_AT_LOCAL = "06:47"
DEFAULT_TICK_SECONDS = 30
DEFAULT_DAILY_TASK_BUDGET = 200
MAX_CONCURRENCY = 4
MAX_DAILY_TASK_BUDGET = 500
ARK_SAMPLER = "doubao_api_websearch"
# China Standard Time has no daylight-saving transition; a fixed UTC+08:00
# timezone also works on minimal Windows Python installs without the tzdata wheel.
SHANGHAI_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")

STATE_ADAPTIVE_LIMIT = "adaptive_limit"
STATE_CLEAN_WINDOWS = "clean_windows"
STATE_GLOBAL_PAUSE_UNTIL = "global_pause_until"
STATE_STARTUP_QUEUED_RUNS = "startup_queued_runs"
STATE_BLOCKED_RUN_PREFIX = "blocked_run:"
STATE_EXECUTOR_PAUSED = "executor_paused"
STATE_EXECUTOR_LAST_TICK = "executor_last_tick"
STATE_EXECUTOR_LAST_ERROR = "executor_last_error"
STATE_HANDOFF_RUN_PREFIX = "handoff_run:"
STATE_SCHEDULED_RUN_PREFIX = "scheduled_run:"
STATE_FAILURE_WINDOWS_PREFIX = "failure_windows:"
STATE_DEFERRED_UNTIL_PREFIX = "deferred_until:"
STATE_RUN_LAST_ERROR_PREFIX = "run_last_error:"
STATE_DAILY_TASK_COUNT_PREFIX = "daily_task_count_"

_TERMINAL_RUN_STATUSES = {"completed", "partial_failed", "failed", "cancelled"}
_EXECUTOR_LOOP: "SamplingExecutorLoop | None" = None
_EXECUTOR_LOOPS: dict[str, "SamplingExecutorLoop"] = {}
_EXECUTOR_LOOP_LOCK = threading.Lock()

SAMPLING_SCHEDULES_DDL = """
CREATE TABLE IF NOT EXISTS sampling_schedules (
  schedule_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  day_of_week INTEGER
    CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7),
  day_of_month INTEGER
    CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 28),
  run_at_local TEXT NOT NULL DEFAULT '06:47'
    CHECK (
      run_at_local GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(SUBSTR(run_at_local, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    ),
  source_run_id TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 4
    CHECK (max_concurrency BETWEEN 1 AND 4),
  daily_task_budget INTEGER NOT NULL DEFAULT 200
    CHECK (daily_task_budget BETWEEN 1 AND 500),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL DEFAULT '',
  last_run_id TEXT NOT NULL DEFAULT '',
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  UNIQUE (project_id, source_run_id, cadence),
  CHECK (
    (cadence = 'weekly' AND day_of_week IS NOT NULL AND day_of_month IS NULL)
    OR
    (cadence = 'monthly' AND day_of_month IS NOT NULL AND day_of_week IS NULL)
  )
)
"""

EXECUTOR_STATE_DDL = """
CREATE TABLE IF NOT EXISTS executor_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
)
"""

SAMPLING_SCHEDULES_DUE_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_sampling_schedules_due
ON sampling_schedules(enabled, next_run_at)
"""

_DEFAULT_DB_PATH: Path | None = None


def _sampler_values(sampler: Any) -> tuple[str, ...]:
    if isinstance(sampler, str):
        values = (sampler.strip(),)
    else:
        try:
            values = tuple(str(item or "").strip() for item in sampler)
        except TypeError:
            values = (str(sampler or "").strip(),)
    values = tuple(dict.fromkeys(item for item in values if item))
    return values or (ARK_SAMPLER,)


def _runtime_state_key(state_key: str, sampler: str) -> str:
    sampler = str(sampler or ARK_SAMPLER)
    return state_key if sampler == ARK_SAMPLER else f"{state_key}:{sampler}"


def _now_epoch(value: Any = None) -> float:
    if callable(value):
        value = value()
    if value is None:
        return time.time()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    return float(value)


def _utc_iso(epoch: float) -> str:
    return (
        datetime.fromtimestamp(float(epoch), tz=timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _parse_iso_epoch(value: Any) -> float | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


@contextmanager
def _connect(db_path: str | Path):
    connection = sqlite3.connect(str(db_path))
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def ensure_executor_tables(connection: sqlite3.Connection) -> None:
    """Apply executor schema migrations without rewriting historical rows."""

    connection.execute(SAMPLING_SCHEDULES_DDL)
    connection.execute(EXECUTOR_STATE_DDL)
    connection.execute(SAMPLING_SCHEDULES_DUE_INDEX_DDL)
    sample_runs_exists = connection.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table' AND name = 'sample_runs'
        """
    ).fetchone()
    if sample_runs_exists:
        columns = {
            row[1]
            for row in connection.execute("PRAGMA table_info(sample_runs)").fetchall()
        }
        migrations = {
            "schedule_id": "TEXT",
            "cycle_id": "TEXT NOT NULL DEFAULT ''",
            "baseline_run_id": "TEXT NOT NULL DEFAULT ''",
            "model_name": "TEXT NOT NULL DEFAULT ''",
            "config_snapshot_json": "TEXT NOT NULL DEFAULT '{}'",
        }
        for column_name, definition in migrations.items():
            if column_name not in columns:
                connection.execute(
                    f"ALTER TABLE sample_runs ADD COLUMN {column_name} {definition}"
                )


def _state_upsert(
    connection: sqlite3.Connection,
    state_key: str,
    state_value: Any,
    updated_at: str,
) -> None:
    connection.execute(
        """
        INSERT INTO executor_state (state_key, state_value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          state_value = excluded.state_value,
          updated_at = excluded.updated_at
        """,
        (str(state_key), str(state_value), updated_at),
    )


def set_executor_state(
    db_path: str | Path,
    state_key: str,
    state_value: Any,
    *,
    now: Any = None,
) -> dict[str, str]:
    timestamp = _utc_iso(_now_epoch(now))
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        _state_upsert(connection, state_key, state_value, timestamp)
    return {
        "state_key": str(state_key),
        "state_value": str(state_value),
        "updated_at": timestamp,
    }


def get_executor_state(db_path: str | Path, state_key: str) -> dict[str, str] | None:
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        row = connection.execute(
            """
            SELECT state_key, state_value, updated_at
            FROM executor_state
            WHERE state_key = ?
            """,
            (str(state_key),),
        ).fetchone()
    return dict(row) if row else None


def _validated_schedule_values(schedule: dict[str, Any], now: Any = None) -> dict[str, Any]:
    schedule_id = str(schedule.get("schedule_id") or "").strip()
    project_id = str(schedule.get("project_id") or "").strip()
    source_run_id = str(schedule.get("source_run_id") or "").strip()
    if not schedule_id:
        raise ValueError("schedule_id is required")
    if not project_id:
        raise ValueError("project_id is required")
    if not source_run_id:
        raise ValueError("source_run_id is required")

    cadence = str(schedule.get("cadence") or "").strip().lower()
    if cadence not in {"weekly", "monthly"}:
        raise ValueError("cadence must be weekly or monthly")

    day_of_week = schedule.get("day_of_week")
    day_of_month = schedule.get("day_of_month")
    if cadence == "weekly":
        try:
            day_of_week = int(day_of_week)
        except (TypeError, ValueError) as exc:
            raise ValueError("weekly schedule requires day_of_week 1-7") from exc
        if day_of_week < 1 or day_of_week > 7:
            raise ValueError("day_of_week must be between 1 and 7")
        day_of_month = None
    else:
        try:
            day_of_month = int(day_of_month)
        except (TypeError, ValueError) as exc:
            raise ValueError("monthly schedule requires day_of_month 1-28") from exc
        if day_of_month < 1 or day_of_month > 28:
            raise ValueError("day_of_month must be between 1 and 28")
        day_of_week = None

    run_at_local = str(schedule.get("run_at_local") or DEFAULT_RUN_AT_LOCAL).strip()
    if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", run_at_local):
        raise ValueError("run_at_local must use HH:MM")

    try:
        max_concurrency = int(schedule.get("max_concurrency", MAX_CONCURRENCY))
    except (TypeError, ValueError) as exc:
        raise ValueError("max_concurrency must be between 1 and 4") from exc
    if max_concurrency < 1 or max_concurrency > MAX_CONCURRENCY:
        raise ValueError("max_concurrency must be between 1 and 4")

    try:
        daily_task_budget = int(schedule.get("daily_task_budget", 200))
    except (TypeError, ValueError) as exc:
        raise ValueError("daily_task_budget must be between 1 and 500") from exc
    if daily_task_budget < 1 or daily_task_budget > MAX_DAILY_TASK_BUDGET:
        raise ValueError("daily_task_budget must be between 1 and 500")

    try:
        enabled = int(schedule.get("enabled", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("enabled must be 0 or 1") from exc
    if enabled not in {0, 1}:
        raise ValueError("enabled must be 0 or 1")

    timestamp = _utc_iso(_now_epoch(now))
    return {
        "schedule_id": schedule_id,
        "project_id": project_id,
        "name": str(schedule.get("name") or "").strip(),
        "cadence": cadence,
        "day_of_week": day_of_week,
        "day_of_month": day_of_month,
        "run_at_local": run_at_local,
        "source_run_id": source_run_id,
        "max_concurrency": max_concurrency,
        "daily_task_budget": daily_task_budget,
        "enabled": enabled,
        "next_run_at": str(schedule.get("next_run_at") or "").strip(),
        "last_run_id": str(schedule.get("last_run_id") or "").strip(),
        "last_status": str(schedule.get("last_status") or "").strip(),
        "last_error": str(schedule.get("last_error") or "").strip(),
        "created_by": str(schedule.get("created_by") or "").strip(),
        "created_at": str(schedule.get("created_at") or timestamp).strip(),
        "updated_at": str(schedule.get("updated_at") or timestamp).strip(),
    }


def create_sampling_schedule(
    db_path: str | Path,
    schedule: dict[str, Any],
    *,
    now: Any = None,
) -> dict[str, Any]:
    values = _validated_schedule_values(dict(schedule or {}), now=now)
    columns = tuple(values)
    placeholders = ", ".join("?" for _ in columns)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute(
            f"""
            INSERT INTO sampling_schedules ({", ".join(columns)})
            VALUES ({placeholders})
            """,
            tuple(values[column] for column in columns),
        )
        row = connection.execute(
            "SELECT * FROM sampling_schedules WHERE schedule_id = ?",
            (values["schedule_id"],),
        ).fetchone()
    return dict(row)


def get_sampling_schedule(db_path: str | Path, schedule_id: str) -> dict[str, Any] | None:
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        row = connection.execute(
            "SELECT * FROM sampling_schedules WHERE schedule_id = ?",
            (str(schedule_id),),
        ).fetchone()
    return dict(row) if row else None


def _schedule_payload(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    item["enabled"] = bool(item.get("enabled"))
    item["max_concurrency"] = int(item.get("max_concurrency") or MAX_CONCURRENCY)
    item["daily_task_budget"] = int(
        item.get("daily_task_budget") or DEFAULT_DAILY_TASK_BUDGET
    )
    item["day_of_week"] = (
        int(item["day_of_week"]) if item.get("day_of_week") is not None else None
    )
    item["day_of_month"] = (
        int(item["day_of_month"]) if item.get("day_of_month") is not None else None
    )
    item["cadence_label"] = "每周" if item.get("cadence") == "weekly" else "每月"
    item["source_task_count"] = int(item.get("source_task_count") or 0)
    item["generated_run_count"] = int(item.get("generated_run_count") or 0)
    return item


def list_project_sampling_schedules(
    db_path: str | Path,
    project_id: str,
    *,
    sampler: Any = ARK_SAMPLER,
) -> dict[str, Any] | None:
    """Return project schedules and eligible web-search template batches."""

    project_id = str(project_id or "").strip()
    samplers = _sampler_values(sampler)
    placeholders = ", ".join("?" for _ in samplers)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        project = connection.execute(
            "SELECT project_id FROM projects WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if not project:
            return None
        rows = connection.execute(
            """
            SELECT
              ss.*,
              source.name AS source_run_name,
              source.status AS source_run_status,
              source.purpose AS source_run_purpose,
              source.sampler AS source_sampler,
              source.platform AS source_platform,
              (
                SELECT COUNT(*)
                FROM sample_tasks source_task
                WHERE source_task.run_id = ss.source_run_id
              ) AS source_task_count,
              latest.name AS last_run_name,
              latest.status AS current_last_run_status,
              (
                SELECT COUNT(*)
                FROM sample_runs generated
                WHERE generated.schedule_id = ss.schedule_id
              ) AS generated_run_count
            FROM sampling_schedules ss
            JOIN sample_runs source
              ON source.run_id = ss.source_run_id
             AND source.project_id = ss.project_id
            LEFT JOIN sample_runs latest
              ON latest.run_id = ss.last_run_id
            WHERE ss.project_id = ?
            ORDER BY ss.enabled DESC, ss.created_at DESC, ss.schedule_id
            """,
            (project_id,),
        ).fetchall()
        template_rows = connection.execute(
            """
            SELECT
              sr.run_id,
              sr.name,
              sr.status,
              sr.scope,
              sr.purpose,
              sr.sampler,
              sr.platform,
              sr.created_at,
              COUNT(st.task_id) AS task_count
            FROM sample_runs sr
            JOIN sample_tasks st ON st.run_id = sr.run_id
            WHERE sr.project_id = ? AND sr.sampler IN ({placeholders})
            GROUP BY
              sr.run_id, sr.name, sr.status, sr.scope, sr.purpose,
              sr.sampler, sr.platform, sr.created_at
            HAVING COUNT(st.task_id) > 0
            ORDER BY sr.created_at DESC, sr.run_id DESC
            """.format(placeholders=placeholders),
            (project_id, *samplers),
        ).fetchall()
    return {
        "project_id": project_id,
        "schedules": [_schedule_payload(row) for row in rows],
        "templates": [
            {
                **dict(row),
                "task_count": int(row["task_count"] or 0),
            }
            for row in template_rows
        ],
        "source": "sqlite",
    }


def _validated_source_run(
    connection: sqlite3.Connection,
    project_id: str,
    source_run_id: str,
    sampler: Any,
) -> sqlite3.Row:
    samplers = _sampler_values(sampler)
    source = connection.execute(
        """
        SELECT sr.*, COUNT(st.task_id) AS task_count
        FROM sample_runs sr
        LEFT JOIN sample_tasks st ON st.run_id = sr.run_id
        WHERE sr.project_id = ? AND sr.run_id = ?
        GROUP BY sr.run_id
        """,
        (project_id, source_run_id),
    ).fetchone()
    if not source:
        raise ValueError("模板批次不存在或不属于当前项目")
    if str(source["sampler"] or "") not in samplers:
        if samplers == (ARK_SAMPLER,):
            raise ValueError("模板批次必须是豆包火山方舟联网采样批次")
        raise ValueError("模板批次必须是受支持的联网 API 采样批次")
    if int(source["task_count"] or 0) <= 0:
        raise ValueError("模板批次没有可克隆的任务")
    return source


def create_project_sampling_schedule(
    db_path: str | Path,
    project_id: str,
    payload: dict[str, Any],
    *,
    created_by: str = "",
    sampler: str = ARK_SAMPLER,
    now: Any = None,
) -> dict[str, Any]:
    """Create a disabled-by-default project schedule from a validated run."""

    project_id = str(project_id or "").strip()
    payload = dict(payload or {})
    now_epoch = _now_epoch(now)
    source_run_id = str(payload.get("source_run_id") or "").strip()
    cadence = str(payload.get("cadence") or "weekly").strip().lower()
    schedule = {
        **payload,
        "schedule_id": _new_id("schedule", now_epoch),
        "project_id": project_id,
        "source_run_id": source_run_id,
        "cadence": cadence,
        "enabled": payload["enabled"] if "enabled" in payload else 0,
        "name": str(payload.get("name") or "").strip()
        or ("每周持续监测" if cadence == "weekly" else "每月持续监测"),
        "created_by": str(created_by or ""),
    }
    values = _validated_schedule_values(schedule, now=now_epoch)
    values["next_run_at"] = next_schedule_at(values, after=now_epoch)
    columns = tuple(values)
    placeholders = ", ".join("?" for _ in columns)
    try:
        with _connect(db_path) as connection:
            ensure_executor_tables(connection)
            project = connection.execute(
                "SELECT project_id FROM projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if not project:
                raise ValueError("项目不存在")
            _validated_source_run(
                connection,
                project_id,
                source_run_id,
                sampler,
            )
            connection.execute(
                f"""
                INSERT INTO sampling_schedules ({", ".join(columns)})
                VALUES ({placeholders})
                """,
                tuple(values[column] for column in columns),
            )
            row = connection.execute(
                "SELECT * FROM sampling_schedules WHERE schedule_id = ?",
                (values["schedule_id"],),
            ).fetchone()
    except sqlite3.IntegrityError as exc:
        if "UNIQUE" in str(exc).upper():
            raise ValueError("同一项目、模板批次和周期只能创建一个调度") from exc
        raise ValueError(f"调度配置不符合约束：{exc}") from exc
    return _schedule_payload(row)


def update_project_sampling_schedule(
    db_path: str | Path,
    project_id: str,
    schedule_id: str,
    payload: dict[str, Any],
    *,
    sampler: str = ARK_SAMPLER,
    now: Any = None,
) -> dict[str, Any] | None:
    """Patch mutable schedule settings; identical patches are no-ops."""

    project_id = str(project_id or "").strip()
    schedule_id = str(schedule_id or "").strip()
    payload = dict(payload or {})
    allowed = {
        "name",
        "cadence",
        "day_of_week",
        "day_of_month",
        "run_at_local",
        "max_concurrency",
        "daily_task_budget",
        "enabled",
    }
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ValueError("不支持修改字段：" + "、".join(unknown))
    now_epoch = _now_epoch(now)
    timestamp = _utc_iso(now_epoch)
    try:
        with _connect(db_path) as connection:
            ensure_executor_tables(connection)
            existing = connection.execute(
                """
                SELECT *
                FROM sampling_schedules
                WHERE project_id = ? AND schedule_id = ?
                """,
                (project_id, schedule_id),
            ).fetchone()
            if not existing:
                return None
            _validated_source_run(
                connection,
                project_id,
                existing["source_run_id"],
                sampler,
            )
            merged = {**dict(existing), **payload, "updated_at": timestamp}
            values = _validated_schedule_values(merged, now=now_epoch)
            schedule_fields = {
                "cadence",
                "day_of_week",
                "day_of_month",
                "run_at_local",
            }
            timing_changed = any(
                values[field] != existing[field] for field in schedule_fields
            )
            enabled_transition = bool(values["enabled"]) and not bool(existing["enabled"])
            if timing_changed or enabled_transition or not str(existing["next_run_at"] or ""):
                values["next_run_at"] = next_schedule_at(values, after=now_epoch)
            else:
                values["next_run_at"] = str(existing["next_run_at"] or "")
            mutable = (
                "name",
                "cadence",
                "day_of_week",
                "day_of_month",
                "run_at_local",
                "max_concurrency",
                "daily_task_budget",
                "enabled",
                "next_run_at",
            )
            changed = any(values[field] != existing[field] for field in mutable)
            if changed:
                connection.execute(
                    """
                    UPDATE sampling_schedules
                    SET name = ?,
                        cadence = ?,
                        day_of_week = ?,
                        day_of_month = ?,
                        run_at_local = ?,
                        max_concurrency = ?,
                        daily_task_budget = ?,
                        enabled = ?,
                        next_run_at = ?,
                        last_error = '',
                        updated_at = ?
                    WHERE project_id = ? AND schedule_id = ?
                    """,
                    (
                        values["name"],
                        values["cadence"],
                        values["day_of_week"],
                        values["day_of_month"],
                        values["run_at_local"],
                        values["max_concurrency"],
                        values["daily_task_budget"],
                        values["enabled"],
                        values["next_run_at"],
                        timestamp,
                        project_id,
                        schedule_id,
                    ),
                )
            row = connection.execute(
                "SELECT * FROM sampling_schedules WHERE schedule_id = ?",
                (schedule_id,),
            ).fetchone()
    except sqlite3.IntegrityError as exc:
        if "UNIQUE" in str(exc).upper():
            raise ValueError("同一项目、模板批次和周期只能创建一个调度") from exc
        raise ValueError(f"调度配置不符合约束：{exc}") from exc
    return {**_schedule_payload(row), "changed": changed}


def delete_project_sampling_schedule(
    db_path: str | Path,
    project_id: str,
    schedule_id: str,
) -> dict[str, Any] | None:
    """Delete only the schedule row; generated sample runs remain intact."""

    project_id = str(project_id or "").strip()
    schedule_id = str(schedule_id or "").strip()
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            """
            SELECT *
            FROM sampling_schedules
            WHERE project_id = ? AND schedule_id = ?
            """,
            (project_id, schedule_id),
        ).fetchone()
        if not existing:
            return None
        generated_run_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM sample_runs WHERE schedule_id = ?",
                (schedule_id,),
            ).fetchone()[0]
        )
        connection.execute(
            """
            DELETE FROM sampling_schedules
            WHERE project_id = ? AND schedule_id = ?
            """,
            (project_id, schedule_id),
        )
    return {
        "ok": True,
        "deleted": True,
        "schedule_id": schedule_id,
        "project_id": project_id,
        "generated_run_count": generated_run_count,
        "generated_runs_preserved": True,
    }


def _adaptive_values(adaptive_concurrency: Any) -> tuple[int, int]:
    snapshot = dict(adaptive_concurrency.snapshot())
    limit = int(snapshot.get("adaptive_limit") or MAX_CONCURRENCY)
    if limit not in {1, 2, 4}:
        limit = MAX_CONCURRENCY
    clean_windows = max(0, int(snapshot.get("clean_windows") or 0))
    return limit, clean_windows


def _limiter_pause_remaining(request_limiter: Any) -> float:
    dispatch_lock = getattr(request_limiter, "_dispatch_lock", None)
    monotonic_fn = getattr(request_limiter, "_monotonic", None)
    if dispatch_lock is not None and callable(monotonic_fn):
        with dispatch_lock:
            return max(
                0.0,
                float(getattr(request_limiter, "_pause_until", 0.0)) - float(monotonic_fn()),
            )
    snapshot = dict(request_limiter.snapshot())
    return max(0.0, float(snapshot.get("pause_remaining_seconds") or 0.0))


def executor_persist_runtime_state(
    db_path: str | Path,
    adaptive_concurrency: Any,
    request_limiter: Any,
    *,
    sampler: str = ARK_SAMPLER,
    now: Any = None,
) -> dict[str, Any]:
    """Persist adaptive and pause state once after an Ark window."""

    now_epoch = _now_epoch(now)
    timestamp = _utc_iso(now_epoch)
    adaptive_limit, clean_windows = _adaptive_values(adaptive_concurrency)
    pause_remaining = _limiter_pause_remaining(request_limiter)
    pause_until = now_epoch + pause_remaining if pause_remaining > 0 else 0.0
    pause_value = f"{pause_until:.6f}" if pause_until else "0"

    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        _state_upsert(
            connection,
            _runtime_state_key(STATE_ADAPTIVE_LIMIT, sampler),
            adaptive_limit,
            timestamp,
        )
        _state_upsert(
            connection,
            _runtime_state_key(STATE_CLEAN_WINDOWS, sampler),
            clean_windows,
            timestamp,
        )
        _state_upsert(
            connection,
            _runtime_state_key(STATE_GLOBAL_PAUSE_UNTIL, sampler),
            pause_value,
            timestamp,
        )
    return {
        "sampler": sampler,
        "adaptive_limit": adaptive_limit,
        "clean_windows": clean_windows,
        "global_pause_until": pause_until,
        "updated_at": timestamp,
    }


def _restore_adaptive_state(
    adaptive_concurrency: Any,
    adaptive_limit: Any,
    clean_windows: Any,
) -> None:
    try:
        parsed_limit = int(adaptive_limit)
    except (TypeError, ValueError):
        parsed_limit = None
    try:
        parsed_clean_windows = max(0, int(clean_windows))
    except (TypeError, ValueError):
        parsed_clean_windows = None

    lock = getattr(adaptive_concurrency, "_lock", None)
    if lock is None:
        return
    with lock:
        if parsed_limit in {1, 2, 4}:
            adaptive_concurrency._effective_limit = parsed_limit
        if parsed_clean_windows is not None:
            adaptive_concurrency._clean_windows = parsed_clean_windows


def _restore_limiter_pause(request_limiter: Any, remaining_seconds: float) -> None:
    dispatch_lock = getattr(request_limiter, "_dispatch_lock", None)
    monotonic_fn = getattr(request_limiter, "_monotonic", None)
    if dispatch_lock is None or not callable(monotonic_fn):
        if remaining_seconds > 0:
            request_limiter.pause(remaining_seconds)
        return
    with dispatch_lock:
        request_limiter._pause_until = (
            float(monotonic_fn()) + max(0.0, float(remaining_seconds))
            if remaining_seconds > 0
            else 0.0
        )


def executor_restore_runtime_state(
    db_path: str | Path,
    adaptive_concurrency: Any,
    request_limiter: Any,
    *,
    sampler: str = ARK_SAMPLER,
    now: Any = None,
) -> dict[str, Any]:
    """Restore persisted throttling state; expired pauses are cleared on disk."""

    now_epoch = _now_epoch(now)
    timestamp = _utc_iso(now_epoch)
    key_map = {
        STATE_ADAPTIVE_LIMIT: _runtime_state_key(STATE_ADAPTIVE_LIMIT, sampler),
        STATE_CLEAN_WINDOWS: _runtime_state_key(STATE_CLEAN_WINDOWS, sampler),
        STATE_GLOBAL_PAUSE_UNTIL: _runtime_state_key(
            STATE_GLOBAL_PAUSE_UNTIL,
            sampler,
        ),
    }
    keys = tuple(key_map.values())
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        rows = connection.execute(
            f"""
            SELECT state_key, state_value
            FROM executor_state
            WHERE state_key IN ({", ".join("?" for _ in keys)})
            """,
            keys,
        ).fetchall()
        raw_states = {row["state_key"]: row["state_value"] for row in rows}
        states = {
            logical_key: raw_states.get(storage_key)
            for logical_key, storage_key in key_map.items()
        }

        pause_until = 0.0
        try:
            pause_until = max(0.0, float(states.get(STATE_GLOBAL_PAUSE_UNTIL) or 0))
        except (TypeError, ValueError):
            pause_until = 0.0
        pause_remaining = max(0.0, pause_until - now_epoch)
        pause_storage_key = key_map[STATE_GLOBAL_PAUSE_UNTIL]
        if pause_storage_key in raw_states and pause_remaining <= 0:
            _state_upsert(connection, pause_storage_key, "0", timestamp)

    _restore_adaptive_state(
        adaptive_concurrency,
        states.get(STATE_ADAPTIVE_LIMIT),
        states.get(STATE_CLEAN_WINDOWS),
    )
    _restore_limiter_pause(request_limiter, pause_remaining)
    adaptive_limit, clean_windows = _adaptive_values(adaptive_concurrency)
    return {
        "sampler": sampler,
        "adaptive_limit": adaptive_limit,
        "clean_windows": clean_windows,
        "pause_remaining_seconds": pause_remaining,
        "pause_expired": bool(pause_until and pause_remaining <= 0),
    }


def _running_ark_runs(db_path: str | Path, sampler: str) -> list[dict[str, Any]]:
    with _connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT sr.project_id, sr.run_id, COUNT(*) AS running_task_count
            FROM sample_runs sr
            JOIN sample_tasks st ON st.run_id = sr.run_id
            WHERE sr.sampler = ? AND st.status = 'running'
            GROUP BY sr.project_id, sr.run_id
            ORDER BY sr.project_id, sr.run_id
            """,
            (sampler,),
        ).fetchall()
    return [dict(row) for row in rows]


def executor_queued_runs(
    db_path: str | Path,
    *,
    sampler: str = ARK_SAMPLER,
) -> list[dict[str, Any]]:
    """Return the restart continuation candidates without dispatching them."""

    with _connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT
              sr.project_id,
              sr.run_id,
              sr.status,
              COUNT(*) AS queued_task_count
            FROM sample_runs sr
            JOIN sample_tasks st ON st.run_id = sr.run_id
            WHERE sr.sampler = ? AND st.status = 'queued'
            GROUP BY sr.project_id, sr.run_id, sr.status
            ORDER BY sr.project_id, sr.run_id
            """,
            (sampler,),
        ).fetchall()
    return [dict(row) for row in rows]


def _mark_missed_schedules(
    db_path: str | Path,
    *,
    now_epoch: float,
    sampler: str = ARK_SAMPLER,
) -> list[dict[str, Any]]:
    timestamp = _utc_iso(now_epoch)
    reason = "服务启动时发现已错过调度；PR-1 仅记录，未自动补跑"
    missed: list[dict[str, Any]] = []
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        rows = connection.execute(
            """
            SELECT ss.schedule_id, ss.project_id, ss.next_run_at
            FROM sampling_schedules ss
            LEFT JOIN sample_runs source
              ON source.run_id = ss.source_run_id
             AND source.project_id = ss.project_id
            WHERE ss.enabled = 1
              AND COALESCE(ss.next_run_at, '') <> ''
              AND (source.sampler = ? OR source.run_id IS NULL)
            ORDER BY ss.next_run_at, ss.schedule_id
            """,
            (sampler,),
        ).fetchall()
        for row in rows:
            due_epoch = _parse_iso_epoch(row["next_run_at"])
            if due_epoch is None or due_epoch > now_epoch:
                continue
            cursor = connection.execute(
                """
                UPDATE sampling_schedules
                SET last_status = 'missed',
                    last_error = ?,
                    updated_at = ?
                WHERE schedule_id = ?
                  AND enabled = 1
                  AND next_run_at = ?
                  AND COALESCE(last_status, '') <> 'missed'
                """,
                (reason, timestamp, row["schedule_id"], row["next_run_at"]),
            )
            if cursor.rowcount == 1:
                missed.append(
                    {
                        "schedule_id": row["schedule_id"],
                        "project_id": row["project_id"],
                        "next_run_at": row["next_run_at"],
                    }
                )
    return missed


def executor_startup_recovery(
    db_path: str | Path,
    recover_interrupted_tasks: Callable[..., int],
    adaptive_concurrency: Any,
    request_limiter: Any,
    *,
    sampler: str = ARK_SAMPLER,
    safe_timeout_seconds: int = 20 * 60,
    now: Any = None,
) -> dict[str, Any]:
    """Migrate, restore runtime state, recover tasks, and record pending work."""

    global _DEFAULT_DB_PATH
    _DEFAULT_DB_PATH = Path(db_path)
    now_epoch = _now_epoch(now)

    with _connect(db_path) as connection:
        ensure_executor_tables(connection)

    restored_state = executor_restore_runtime_state(
        db_path,
        adaptive_concurrency,
        request_limiter,
        sampler=sampler,
        now=now_epoch,
    )
    running_runs = _running_ark_runs(db_path, sampler)
    recovered_task_count = 0
    force_recovery_epoch = int(now_epoch) + max(0, int(safe_timeout_seconds)) + 1
    for run in running_runs:
        recovered_task_count += int(
            recover_interrupted_tasks(
                project_id=run["project_id"],
                run_id=run["run_id"],
                now_epoch=force_recovery_epoch,
            )
            or 0
        )

    queued_runs = executor_queued_runs(db_path, sampler=sampler)
    observed_at = _utc_iso(now_epoch)
    set_executor_state(
        db_path,
        _runtime_state_key(STATE_STARTUP_QUEUED_RUNS, sampler),
        json.dumps(
            {"observed_at": observed_at, "runs": queued_runs},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        now=now_epoch,
    )
    missed_schedules = _mark_missed_schedules(
        db_path,
        now_epoch=now_epoch,
        sampler=sampler,
    )
    return {
        "restored_state": restored_state,
        "running_runs": running_runs,
        "recovered_task_count": recovered_task_count,
        "queued_runs": queued_runs,
        "missed_schedules": missed_schedules,
        "auto_dispatched": False,
    }


def executor_mark_blocked(
    run_id: str,
    reason: str,
    *,
    db_path: str | Path | None = None,
    now: Any = None,
) -> dict[str, Any]:
    """Persist the PR-1 circuit-breaker marker without deciding when to trip it."""

    target_db = Path(db_path) if db_path is not None else _DEFAULT_DB_PATH
    if target_db is None:
        raise RuntimeError("sampling executor database is not configured")
    run_id = str(run_id or "").strip()
    if not run_id:
        raise ValueError("run_id is required")
    reason = str(reason or "").strip()[:800]
    now_epoch = _now_epoch(now)
    timestamp = _utc_iso(now_epoch)
    state_key = f"{STATE_BLOCKED_RUN_PREFIX}{run_id}"

    with _connect(target_db) as connection:
        ensure_executor_tables(connection)
        run = connection.execute(
            "SELECT project_id, run_id FROM sample_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if not run:
            raise ValueError(f"Unknown run_id: {run_id}")
        connection.execute(
            "UPDATE sample_runs SET status = 'executor_blocked' WHERE run_id = ?",
            (run_id,),
        )
        connection.execute(
            """
            UPDATE sampling_schedules
            SET last_status = 'executor_blocked',
                last_error = ?,
                updated_at = ?
            WHERE last_run_id = ?
            """,
            (reason, timestamp, run_id),
        )
        marker = {
            "run_id": run_id,
            "project_id": run["project_id"],
            "status": "executor_blocked",
            "reason": reason,
            "marked_at": timestamp,
        }
        _state_upsert(
            connection,
            state_key,
            json.dumps(marker, ensure_ascii=False, separators=(",", ":")),
            timestamp,
        )
    return marker


def _state_value(
    connection: sqlite3.Connection,
    state_key: str,
    default: str = "",
) -> str:
    row = connection.execute(
        "SELECT state_value FROM executor_state WHERE state_key = ?",
        (state_key,),
    ).fetchone()
    return str(row["state_value"] if row else default)


def _state_int(
    connection: sqlite3.Connection,
    state_key: str,
    default: int = 0,
) -> int:
    try:
        return int(float(_state_value(connection, state_key, str(default)) or default))
    except (TypeError, ValueError):
        return int(default)


def _truthy_state(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _daily_state_key(now_epoch: float) -> str:
    local_date = datetime.fromtimestamp(now_epoch, tz=SHANGHAI_TIMEZONE).date()
    return f"{STATE_DAILY_TASK_COUNT_PREFIX}{local_date.isoformat()}"


def _new_id(prefix: str, now_epoch: float) -> str:
    stamp = datetime.fromtimestamp(now_epoch, tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{stamp}_{uuid.uuid4().hex[:6]}"


def configured_tick_seconds(value: Any = None) -> int:
    raw = os.environ.get("EXECUTOR_TICK_SECONDS", DEFAULT_TICK_SECONDS) if value is None else value
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = DEFAULT_TICK_SECONDS
    return min(max(parsed, 1), 3600)


def next_schedule_at(
    schedule: dict[str, Any],
    *,
    after: Any = None,
) -> str:
    """Return the next future schedule instant in Asia/Shanghai."""

    after_epoch = _now_epoch(after)
    local_now = datetime.fromtimestamp(after_epoch, tz=SHANGHAI_TIMEZONE)
    run_at = str(schedule.get("run_at_local") or DEFAULT_RUN_AT_LOCAL)
    try:
        hour, minute = (int(part) for part in run_at.split(":", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("run_at_local must use HH:MM") from exc

    cadence = str(schedule.get("cadence") or "")
    if cadence == "weekly":
        day_of_week = int(schedule.get("day_of_week") or 0)
        if day_of_week < 1 or day_of_week > 7:
            raise ValueError("weekly schedule requires day_of_week 1-7")
        days_ahead = (day_of_week - local_now.isoweekday()) % 7
        candidate_date = local_now.date() + timedelta(days=days_ahead)
        candidate = datetime(
            candidate_date.year,
            candidate_date.month,
            candidate_date.day,
            hour,
            minute,
            tzinfo=SHANGHAI_TIMEZONE,
        )
        if candidate <= local_now:
            candidate += timedelta(days=7)
    elif cadence == "monthly":
        day_of_month = int(schedule.get("day_of_month") or 0)
        if day_of_month < 1 or day_of_month > 28:
            raise ValueError("monthly schedule requires day_of_month 1-28")
        candidate = datetime(
            local_now.year,
            local_now.month,
            day_of_month,
            hour,
            minute,
            tzinfo=SHANGHAI_TIMEZONE,
        )
        if candidate <= local_now:
            if local_now.month == 12:
                year, month = local_now.year + 1, 1
            else:
                year, month = local_now.year, local_now.month + 1
            candidate = datetime(
                year,
                month,
                day_of_month,
                hour,
                minute,
                tzinfo=SHANGHAI_TIMEZONE,
            )
    else:
        raise ValueError("cadence must be weekly or monthly")
    return candidate.replace(microsecond=0).isoformat()


def executor_is_paused(db_path: str | Path) -> bool:
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        return _truthy_state(_state_value(connection, STATE_EXECUTOR_PAUSED, "0"))


def executor_pause(
    db_path: str | Path,
    *,
    now: Any = None,
) -> dict[str, Any]:
    state = set_executor_state(db_path, STATE_EXECUTOR_PAUSED, "1", now=now)
    return {"ok": True, "paused": True, "updated_at": state["updated_at"]}


def executor_resume(
    db_path: str | Path,
    *,
    now: Any = None,
) -> dict[str, Any]:
    state = set_executor_state(db_path, STATE_EXECUTOR_PAUSED, "0", now=now)
    return {"ok": True, "paused": False, "updated_at": state["updated_at"]}


def executor_handoff_run(
    db_path: str | Path,
    project_id: str,
    run_id: str,
    *,
    sampler: str = ARK_SAMPLER,
    handed_off_by: str = "",
    now: Any = None,
) -> dict[str, Any]:
    """Persist server ownership for a browser-created Ark run."""

    project_id = str(project_id or "").strip()
    run_id = str(run_id or "").strip()
    if not project_id or not run_id:
        raise ValueError("project_id and run_id are required")
    now_epoch = _now_epoch(now)
    timestamp = _utc_iso(now_epoch)
    state_key = f"{STATE_HANDOFF_RUN_PREFIX}{run_id}"
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        run = connection.execute(
            """
            SELECT run_id, project_id, sampler, scope, status
            FROM sample_runs
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if not run or str(run["project_id"]) != project_id:
            raise ValueError("采样批次不存在或不属于当前项目")
        if str(run["sampler"] or "") != sampler:
            if sampler == ARK_SAMPLER:
                raise ValueError("该批次不是豆包火山方舟联网 API 采样批次")
            raise ValueError("批次平台与采样执行器不一致")
        if str(run["scope"] or "") == "scheduled":
            return {
                "ok": True,
                "run_id": run_id,
                "project_id": project_id,
                "execution_source": "server",
                "already_handed_off": True,
                "handed_off_at": timestamp,
            }

        existing = _state_value(connection, state_key)
        if existing:
            try:
                marker = json.loads(existing)
            except (TypeError, ValueError, json.JSONDecodeError):
                marker = {}
            return {
                "ok": True,
                "run_id": run_id,
                "project_id": project_id,
                "execution_source": "server",
                "already_handed_off": True,
                "handed_off_at": marker.get("handed_off_at") or timestamp,
            }

        queued_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM sample_tasks WHERE run_id = ? AND status = 'queued'",
                (run_id,),
            ).fetchone()[0]
        )
        if queued_count <= 0:
            raise ValueError("当前批次没有待执行任务")
        if str(run["status"] or "") not in {"queued", "running", "partial_failed"}:
            raise ValueError("当前批次状态不允许转交服务端执行")

        marker = {
            "run_id": run_id,
            "project_id": project_id,
            "execution_source": "server",
            "handed_off_by": str(handed_off_by or ""),
            "handed_off_at": timestamp,
        }
        _state_upsert(
            connection,
            state_key,
            json.dumps(marker, ensure_ascii=False, separators=(",", ":")),
            timestamp,
        )
        if str(run["status"] or "") == "partial_failed":
            connection.execute(
                "UPDATE sample_runs SET status = 'queued', completed_at = '' WHERE run_id = ?",
                (run_id,),
            )
    return {
        "ok": True,
        **marker,
        "already_handed_off": False,
        "queued_task_count": queued_count,
    }


def executor_release_handoff_run(
    db_path: str | Path,
    project_id: str,
    run_id: str,
    *,
    now: Any = None,
) -> dict[str, Any]:
    """Release server ownership without deleting tasks, samples, or the run."""

    project_id = str(project_id or "").strip()
    run_id = str(run_id or "").strip()
    if not project_id or not run_id:
        raise ValueError("project_id and run_id are required")
    timestamp = _utc_iso(_now_epoch(now))
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        run = connection.execute(
            "SELECT project_id, scope FROM sample_runs WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if not run or str(run["project_id"]) != project_id:
            raise ValueError("采样批次不存在或不属于当前项目")
        if str(run["scope"] or "") == "scheduled":
            raise ValueError("周期调度批次不能通过 handoff 释放服务端执行权")
        deleted = connection.execute(
            "DELETE FROM executor_state WHERE state_key = ?",
            (f"{STATE_HANDOFF_RUN_PREFIX}{run_id}",),
        ).rowcount
    return {
        "ok": True,
        "project_id": project_id,
        "run_id": run_id,
        "execution_source": "browser",
        "already_released": not bool(deleted),
        "released_at": timestamp,
    }


def executor_resume_handoff_run(
    db_path: str | Path,
    project_id: str,
    run_id: str,
    *,
    handed_off_by: str = "",
    now: Any = None,
) -> dict[str, Any]:
    """Clear an executor circuit breaker and restore handoff ownership."""

    project_id = str(project_id or "").strip()
    run_id = str(run_id or "").strip()
    if not project_id or not run_id:
        raise ValueError("project_id and run_id are required")
    timestamp = _utc_iso(_now_epoch(now))
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        run = connection.execute(
            """
            SELECT project_id, sampler, scope, status
            FROM sample_runs WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if not run or str(run["project_id"]) != project_id:
            raise ValueError("采样批次不存在或不属于当前项目")
        if str(run["sampler"] or "") != ARK_SAMPLER:
            raise ValueError("该批次不是豆包火山方舟联网 API 采样批次")
        queued_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM sample_tasks WHERE run_id = ? AND status = 'queued'",
                (run_id,),
            ).fetchone()[0]
        )
        connection.execute(
            """
            DELETE FROM executor_state
            WHERE state_key IN (?, ?, ?, ?)
            """,
            (
                f"{STATE_BLOCKED_RUN_PREFIX}{run_id}",
                f"{STATE_FAILURE_WINDOWS_PREFIX}{run_id}",
                f"{STATE_DEFERRED_UNTIL_PREFIX}{run_id}",
                f"{STATE_RUN_LAST_ERROR_PREFIX}{run_id}",
            ),
        )
        marker = {
            "run_id": run_id,
            "project_id": project_id,
            "execution_source": "server",
            "handed_off_by": str(handed_off_by or ""),
            "handed_off_at": timestamp,
        }
        _state_upsert(
            connection,
            f"{STATE_HANDOFF_RUN_PREFIX}{run_id}",
            json.dumps(marker, ensure_ascii=False, separators=(",", ":")),
            timestamp,
        )
        if queued_count > 0:
            connection.execute(
                """
                UPDATE sample_runs
                SET status = 'queued', completed_at = ''
                WHERE run_id = ? AND status = 'executor_blocked'
                """,
                (run_id,),
            )
    return {
        "ok": True,
        **marker,
        "queued_task_count": queued_count,
        "unblocked": True,
    }


def _owned_active_runs(
    connection: sqlite3.Connection,
    sampler: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
          sr.project_id,
          sr.run_id,
          sr.status,
          sr.scope,
          COUNT(CASE WHEN st.status = 'queued' THEN 1 END) AS queued_task_count,
          ss.schedule_id,
          COALESCE(ss.max_concurrency, ?) AS max_concurrency,
          COALESCE(ss.daily_task_budget, ?) AS daily_task_budget,
          CASE
            WHEN ss.schedule_id IS NOT NULL OR sr.scope = 'scheduled' THEN 'scheduled'
            ELSE 'handoff'
          END AS ownership
        FROM sample_runs sr
        JOIN sample_tasks st ON st.run_id = sr.run_id
        LEFT JOIN sampling_schedules ss ON ss.schedule_id = sr.schedule_id
        LEFT JOIN executor_state handoff
          ON handoff.state_key = ? || sr.run_id
        LEFT JOIN executor_state blocked
          ON blocked.state_key = ? || sr.run_id
        WHERE sr.sampler = ?
          AND sr.status IN ('queued', 'running')
          AND blocked.state_key IS NULL
          AND (
            ss.schedule_id IS NOT NULL
            OR sr.scope = 'scheduled'
            OR handoff.state_key IS NOT NULL
          )
        GROUP BY
          sr.project_id, sr.run_id, sr.status, sr.scope,
          ss.schedule_id, ss.max_concurrency, ss.daily_task_budget
        HAVING COUNT(CASE WHEN st.status = 'queued' THEN 1 END) > 0
        ORDER BY sr.created_at, sr.run_id
        """,
        (
            MAX_CONCURRENCY,
            DEFAULT_DAILY_TASK_BUDGET,
            STATE_HANDOFF_RUN_PREFIX,
            STATE_BLOCKED_RUN_PREFIX,
            sampler,
        ),
    ).fetchall()
    return [dict(row) for row in rows]


def _record_schedule_error(
    db_path: str | Path,
    schedule_id: str,
    message: str,
    now_epoch: float,
) -> None:
    timestamp = _utc_iso(now_epoch)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute(
            """
            UPDATE sampling_schedules
            SET last_error = ?, updated_at = ?
            WHERE schedule_id = ?
            """,
            (str(message or "")[:800], timestamp, schedule_id),
        )


def _record_run_error(
    db_path: str | Path,
    run_id: str,
    message: str,
    now_epoch: float,
) -> None:
    set_executor_state(
        db_path,
        f"{STATE_RUN_LAST_ERROR_PREFIX}{run_id}",
        str(message or "")[:800],
        now=now_epoch,
    )
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute(
            """
            UPDATE sampling_schedules
            SET last_error = ?, updated_at = ?
            WHERE last_run_id = ?
            """,
            (str(message or "")[:800], _utc_iso(now_epoch), run_id),
        )


def _sync_schedule_statuses(
    db_path: str | Path,
    *,
    now_epoch: float,
) -> list[dict[str, Any]]:
    """Advance completed schedule runs exactly once and skip missed periods."""

    changed: list[dict[str, Any]] = []
    timestamp = _utc_iso(now_epoch)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        schedules = connection.execute(
            """
            SELECT *
            FROM sampling_schedules
            WHERE COALESCE(last_run_id, '') <> ''
            ORDER BY schedule_id
            """
        ).fetchall()
        for row in schedules:
            run = connection.execute(
                """
                SELECT
                  sr.status,
                  COUNT(CASE WHEN st.status = 'queued' THEN 1 END) AS queued_count,
                  COUNT(CASE WHEN st.status = 'running' THEN 1 END) AS running_count
                FROM sample_runs sr
                LEFT JOIN sample_tasks st ON st.run_id = sr.run_id
                WHERE sr.run_id = ?
                GROUP BY sr.run_id, sr.status
                """,
                (row["last_run_id"],),
            ).fetchone()
            if not run:
                continue
            status = str(run["status"] or "")
            queued_count = int(run["queued_count"] or 0)
            running_count = int(run["running_count"] or 0)
            blocked_marker = _state_value(
                connection,
                f"{STATE_BLOCKED_RUN_PREFIX}{row['last_run_id']}",
            )
            if status == "executor_blocked" or blocked_marker:
                if str(row["last_status"] or "") != "executor_blocked":
                    connection.execute(
                        """
                        UPDATE sampling_schedules
                        SET last_status = ?, updated_at = ?
                        WHERE schedule_id = ?
                        """,
                        ("executor_blocked", timestamp, row["schedule_id"]),
                    )
                continue
            if queued_count or running_count:
                if str(row["last_status"] or "") != status:
                    connection.execute(
                        """
                        UPDATE sampling_schedules
                        SET last_status = ?, updated_at = ?
                        WHERE schedule_id = ?
                        """,
                        (status, timestamp, row["schedule_id"]),
                    )
                continue
            if status not in _TERMINAL_RUN_STATUSES:
                continue
            # PR-1 marks a due schedule as ``missed`` but intentionally keeps
            # the previous terminal run id.  That marker means PR-2 must create
            # one catch-up run; advancing the old run here would silently skip it.
            if str(row["last_status"] or "") == "missed":
                continue
            if str(row["last_status"] or "") == status:
                continue
            next_run_at = next_schedule_at(dict(row), after=now_epoch)
            last_error = (
                "调度批次已结束，但仍有失败任务"
                if status == "partial_failed"
                else ""
            )
            connection.execute(
                """
                UPDATE sampling_schedules
                SET last_status = ?,
                    last_error = ?,
                    next_run_at = ?,
                    updated_at = ?
                WHERE schedule_id = ? AND last_run_id = ?
                """,
                (
                    status,
                    last_error,
                    next_run_at,
                    timestamp,
                    row["schedule_id"],
                    row["last_run_id"],
                ),
            )
            changed.append(
                {
                    "schedule_id": row["schedule_id"],
                    "run_id": row["last_run_id"],
                    "status": status,
                    "next_run_at": next_run_at,
                }
            )
    return changed


def clone_run_from_template(
    db_path: str | Path,
    schedule: str | dict[str, Any],
    *,
    now: Any = None,
    sampler: Any = ARK_SAMPLER,
    require_due: bool = True,
) -> dict[str, Any]:
    """Clone a schedule template and its exact task range in one transaction."""

    schedule_id = str(
        schedule.get("schedule_id") if isinstance(schedule, dict) else schedule
    ).strip()
    if not schedule_id:
        raise ValueError("schedule_id is required")
    now_epoch = _now_epoch(now)
    timestamp = _utc_iso(now_epoch)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        schedule_row = connection.execute(
            "SELECT * FROM sampling_schedules WHERE schedule_id = ?",
            (schedule_id,),
        ).fetchone()
        if not schedule_row or int(schedule_row["enabled"] or 0) != 1:
            raise ValueError("调度不存在或未启用")
        due_epoch = _parse_iso_epoch(schedule_row["next_run_at"])
        if require_due and (due_epoch is None or due_epoch > now_epoch):
            return {}

        if str(schedule_row["last_status"] or "") in {
            "queued",
            "running",
            "executor_blocked",
        }:
            queued = connection.execute(
                """
                SELECT COUNT(*)
                FROM sample_tasks
                WHERE run_id = ? AND status IN ('queued', 'running')
                """,
                (schedule_row["last_run_id"],),
            ).fetchone()[0]
            if int(queued or 0) > 0:
                return {}

        source = _validated_source_run(
            connection,
            schedule_row["project_id"],
            schedule_row["source_run_id"],
            sampler,
        )
        source_sampler = str(source["sampler"] or "")
        try:
            source_config = json.loads(str(source["config_snapshot_json"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            source_config = {}
        monitoring_meta = (
            source_config.get("_monitoring_set")
            if isinstance(source_config, dict)
            else None
        )
        source_purpose = str(source["purpose"] or "baseline")
        baseline_run_id = ""
        if isinstance(monitoring_meta, dict):
            root_run_id = str(monitoring_meta.get("root_run_id") or "").strip()
            if int(monitoring_meta.get("schema_version") or 0) != 1 or not root_run_id:
                raise ValueError("监测题集模板元数据不完整，已阻止调度克隆")
            root_exists = connection.execute(
                "SELECT 1 FROM sample_runs WHERE project_id = ? AND run_id = ?",
                (schedule_row["project_id"], root_run_id),
            ).fetchone()
            if not root_exists:
                raise ValueError("监测题集基线不存在，已阻止调度克隆")
            baseline_run_id = root_run_id
            source_purpose = "monitoring"
        tasks = connection.execute(
            """
            SELECT task_id, question_id
            FROM sample_tasks
            WHERE run_id = ?
            ORDER BY created_at, task_id
            """,
            (schedule_row["source_run_id"],),
        ).fetchall()
        if not tasks:
            raise ValueError("调度模板没有可克隆的问题")
        if isinstance(monitoring_meta, dict):
            frozen_ids = [
                str(item.get("question_id") or "")
                for item in monitoring_meta.get("questions") or []
                if isinstance(item, dict) and str(item.get("question_id") or "")
            ]
            tasks_by_question = {
                str(task["question_id"] or ""): task for task in tasks
            }
            if (
                not frozen_ids
                or len(tasks) != len(frozen_ids)
                or set(tasks_by_question) != set(frozen_ids)
            ):
                raise ValueError("调度模板任务范围与冻结监测题集不一致")
            tasks = [tasks_by_question[question_id] for question_id in frozen_ids]

        run_id = _new_id("run", now_epoch)
        local_time = datetime.fromtimestamp(
            now_epoch,
            tz=SHANGHAI_TIMEZONE,
        ).strftime("%Y-%m-%d %H:%M")
        schedule_name = str(
            schedule_row["name"] or source["name"] or "服务端周期采样"
        )
        run_name = (
            f"{schedule_name} · 模板 {schedule_row['source_run_id']} · {local_time}"
        )
        connection.execute(
            """
            INSERT INTO sample_runs (
              run_id, project_id, name, platform, sampler, scope, category,
              schedule_id, status, is_mock, created_at, started_at, completed_at,
              purpose, cycle_id, baseline_run_id, model_name, config_snapshot_json
            ) VALUES (
              ?, ?, ?, ?, ?, 'scheduled', ?, ?, 'queued', 0, ?, '', '', ?, '', ?, ?, ?
            )
            """,
            (
                run_id,
                schedule_row["project_id"],
                run_name,
                source["platform"],
                source_sampler,
                source["category"],
                schedule_id,
                timestamp,
                source_purpose,
                baseline_run_id,
                source["model_name"],
                source["config_snapshot_json"],
            ),
        )
        task_mapping = []
        for index, task in enumerate(tasks, start=1):
            task_id = _new_id(f"task_{index:04d}", now_epoch)
            connection.execute(
                """
                INSERT INTO sample_tasks (
                  task_id, run_id, question_id, status, answer_chars,
                  error, created_at, completed_at
                ) VALUES (?, ?, ?, 'queued', 0, '', ?, '')
                """,
                (
                    task_id,
                    run_id,
                    task["question_id"],
                    timestamp,
                ),
            )
            task_mapping.append(
                {
                    "source_task_id": task["task_id"],
                    "task_id": task_id,
                    "question_id": task["question_id"],
                }
            )
        connection.execute(
            """
            UPDATE sampling_schedules
            SET last_run_id = ?,
                last_status = 'queued',
                last_error = '',
                updated_at = ?
            WHERE schedule_id = ?
            """,
            (run_id, timestamp, schedule_id),
        )
        marker = {
            "run_id": run_id,
            "schedule_id": schedule_id,
            "project_id": schedule_row["project_id"],
            "source_run_id": schedule_row["source_run_id"],
            "created_at": timestamp,
        }
        _state_upsert(
            connection,
            f"{STATE_SCHEDULED_RUN_PREFIX}{run_id}",
            json.dumps(marker, ensure_ascii=False, separators=(",", ":")),
            timestamp,
        )
    return {
        **marker,
        "status": "queued",
        "purpose": source_purpose,
        "baseline_run_id": baseline_run_id,
        "task_count": len(tasks),
        "task_mapping": task_mapping,
        "execution_source": "server",
    }


def _create_schedule_run(
    db_path: str | Path,
    schedule_id: str,
    *,
    now_epoch: float,
    sampler: str,
) -> dict[str, Any]:
    """Compatibility wrapper for PR-2 internal callers."""

    return clone_run_from_template(
        db_path,
        schedule_id,
        now=now_epoch,
        sampler=sampler,
        require_due=True,
    )


def _defer_schedule_for_budget(
    db_path: str | Path,
    schedule_id: str,
    now_epoch: float,
) -> dict[str, Any]:
    defer_at = datetime.fromtimestamp(
        now_epoch + 3600,
        tz=SHANGHAI_TIMEZONE,
    ).replace(microsecond=0)
    defer_iso = defer_at.isoformat()
    timestamp = _utc_iso(now_epoch)
    message = f"今日调度预算已用尽，下一次检查推迟至 {defer_iso}"
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute(
            """
            UPDATE sampling_schedules
            SET next_run_at = ?, last_error = ?, updated_at = ?
            WHERE schedule_id = ? AND enabled = 1
            """,
            (defer_iso, message, timestamp, schedule_id),
        )
    return {
        "schedule_id": schedule_id,
        "until": defer_iso,
        "reason": "daily_task_budget",
    }


def _create_due_schedule_runs(
    db_path: str | Path,
    *,
    now_epoch: float,
    sampler: str,
    api_key_set: bool,
    platform_label: str = "联网采样",
) -> dict[str, list[dict[str, Any]]]:
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        rows = connection.execute(
            """
            SELECT ss.*
            FROM sampling_schedules ss
            JOIN sample_runs source
              ON source.run_id = ss.source_run_id
             AND source.project_id = ss.project_id
            WHERE ss.enabled = 1
              AND COALESCE(ss.next_run_at, '') <> ''
              AND source.sampler = ?
            ORDER BY next_run_at, schedule_id
            """,
            (sampler,),
        ).fetchall()
    created: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for row in rows:
        due_epoch = _parse_iso_epoch(row["next_run_at"])
        if due_epoch is None or due_epoch > now_epoch:
            continue
        daily_count = _daily_task_count(db_path, now_epoch)
        budget = min(
            max(
                1,
                int(
                    row["daily_task_budget"]
                    or DEFAULT_DAILY_TASK_BUDGET
                ),
            ),
            MAX_DAILY_TASK_BUDGET,
        )
        if daily_count >= budget:
            deferred.append(
                _defer_schedule_for_budget(
                    db_path,
                    row["schedule_id"],
                    now_epoch,
                )
            )
            continue
        if not api_key_set:
            message = f"{platform_label} API Key 未配置，调度暂未创建批次"
            _record_schedule_error(
                db_path,
                row["schedule_id"],
                message,
                now_epoch,
            )
            skipped.append(
                {
                    "schedule_id": row["schedule_id"],
                    "reason": "api_key_missing",
                }
            )
            continue
        try:
            result = clone_run_from_template(
                db_path,
                row["schedule_id"],
                now=now_epoch,
                sampler=sampler,
            )
        except ValueError as exc:
            _record_schedule_error(db_path, row["schedule_id"], str(exc), now_epoch)
            continue
        if result:
            created.append(result)
    return {
        "created_runs": created,
        "deferred_schedules": deferred,
        "skipped_schedules": skipped,
    }


def _daily_task_count(db_path: str | Path, now_epoch: float) -> int:
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        return max(0, _state_int(connection, _daily_state_key(now_epoch), 0))


def _increment_daily_task_count(
    db_path: str | Path,
    amount: int,
    now_epoch: float,
) -> int:
    amount = max(0, int(amount or 0))
    timestamp = _utc_iso(now_epoch)
    state_key = _daily_state_key(now_epoch)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        current = max(0, _state_int(connection, state_key, 0))
        updated = current + amount
        _state_upsert(connection, state_key, updated, timestamp)
    return updated


def _deferred_until(
    db_path: str | Path,
    run_id: str,
) -> float:
    row = get_executor_state(db_path, f"{STATE_DEFERRED_UNTIL_PREFIX}{run_id}")
    try:
        return max(0.0, float((row or {}).get("state_value") or 0))
    except (TypeError, ValueError):
        return 0.0


def _defer_for_budget(
    db_path: str | Path,
    run: dict[str, Any],
    now_epoch: float,
) -> str:
    defer_until = now_epoch + 3600
    defer_iso = _utc_iso(defer_until)
    set_executor_state(
        db_path,
        f"{STATE_DEFERRED_UNTIL_PREFIX}{run['run_id']}",
        f"{defer_until:.6f}",
        now=now_epoch,
    )
    message = f"今日执行预算已用尽，批次推迟至 {defer_iso}"
    _record_run_error(db_path, run["run_id"], message, now_epoch)
    return defer_iso


def _record_failure_window(
    db_path: str | Path,
    run_id: str,
    executed_tasks: list[dict[str, Any]],
    *,
    now_epoch: float,
) -> dict[str, Any]:
    if not executed_tasks:
        return {"count": None, "blocked": False}
    all_failed = all(str(item.get("status") or "") == "failed" for item in executed_tasks)
    # The existing Ark window normalizes HTTP 429 into this explicit flag.
    # Avoid guessing from free-form error text, which can contain phrases such
    # as "non-429" and would otherwise suppress a legitimate breaker count.
    has_429 = any(bool(item.get("rate_limited")) for item in executed_tasks)
    state_key = f"{STATE_FAILURE_WINDOWS_PREFIX}{run_id}"
    timestamp = _utc_iso(now_epoch)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        previous = max(0, _state_int(connection, state_key, 0))
        count = previous + 1 if all_failed and not has_429 else 0
        _state_upsert(connection, state_key, count, timestamp)
    if count < 3:
        return {"count": count, "blocked": False}
    marker = executor_mark_blocked(
        run_id,
        "连续 3 个采样窗口全部任务失败（非 429），已等待人工处理",
        db_path=db_path,
        now=now_epoch,
    )
    return {"count": count, "blocked": True, "marker": marker}


def _run_source_rows(
    connection: sqlite3.Connection,
    sampler: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT
          sr.run_id,
          sr.project_id,
          sr.status,
          sr.scope,
          ss.schedule_id,
          handoff.state_value AS handoff_state,
          blocked.state_value AS blocked_state
        FROM sample_runs sr
        LEFT JOIN sampling_schedules ss ON ss.schedule_id = sr.schedule_id
        LEFT JOIN executor_state handoff
          ON handoff.state_key = ? || sr.run_id
        LEFT JOIN executor_state blocked
          ON blocked.state_key = ? || sr.run_id
        WHERE sr.sampler = ?
        ORDER BY sr.created_at DESC, sr.run_id DESC
        LIMIT 100
        """,
        (STATE_HANDOFF_RUN_PREFIX, STATE_BLOCKED_RUN_PREFIX, sampler),
    ).fetchall()
    results = []
    for row in rows:
        source = "browser"
        if str(row["status"] or "") == "executor_blocked" or row["blocked_state"]:
            source = "executor_blocked"
        elif row["schedule_id"] or str(row["scope"] or "") == "scheduled" or row["handoff_state"]:
            source = "server"
        results.append(
            {
                "run_id": row["run_id"],
                "project_id": row["project_id"],
                "status": row["status"],
                "execution_source": source,
                "schedule_id": row["schedule_id"] or "",
            }
        )
    return results


def executor_status(
    db_path: str | Path,
    *,
    adaptive_concurrency: Any = None,
    api_key_status_fn: Callable[[], Any] | None = None,
    sampler: str = ARK_SAMPLER,
    now: Any = None,
    tick_seconds: Any = None,
) -> dict[str, Any]:
    now_epoch = _now_epoch(now)
    daily_key = _daily_state_key(now_epoch)
    with _connect(db_path) as connection:
        ensure_executor_tables(connection)
        paused = _truthy_state(_state_value(connection, STATE_EXECUTOR_PAUSED, "0"))
        active_runs = _owned_active_runs(connection, sampler)
        source_rows = _run_source_rows(connection, sampler)
        blocked_rows = connection.execute(
            """
            SELECT sr.run_id, sr.project_id, sr.status, es.state_value
            FROM sample_runs sr
            LEFT JOIN executor_state es
              ON es.state_key = ? || sr.run_id
            WHERE sr.sampler = ?
              AND (sr.status = 'executor_blocked' OR es.state_key IS NOT NULL)
            ORDER BY sr.created_at DESC, sr.run_id DESC
            """,
            (STATE_BLOCKED_RUN_PREFIX, sampler),
        ).fetchall()
        today_count = max(0, _state_int(connection, daily_key, 0))
        persisted_limit = _state_int(
            connection,
            _runtime_state_key(STATE_ADAPTIVE_LIMIT, sampler),
            MAX_CONCURRENCY,
        )
        clean_windows = _state_int(
            connection,
            _runtime_state_key(STATE_CLEAN_WINDOWS, sampler),
            0,
        )
        pause_until = _state_value(
            connection,
            _runtime_state_key(STATE_GLOBAL_PAUSE_UNTIL, sampler),
            "0",
        )
        last_tick = _state_value(
            connection,
            _runtime_state_key(STATE_EXECUTOR_LAST_TICK, sampler),
            "",
        )
        last_error = _state_value(
            connection,
            _runtime_state_key(STATE_EXECUTOR_LAST_ERROR, sampler),
            "",
        )

    if adaptive_concurrency is not None:
        try:
            adaptive_snapshot = dict(adaptive_concurrency.snapshot())
            effective_limit = int(
                adaptive_snapshot.get("adaptive_limit")
                or adaptive_snapshot.get("effective_limit")
                or persisted_limit
            )
            clean_windows = int(adaptive_snapshot.get("clean_windows") or clean_windows)
        except Exception:
            effective_limit = persisted_limit
    else:
        effective_limit = persisted_limit

    api_key_set = None
    if api_key_status_fn is not None:
        try:
            status_value = api_key_status_fn()
            api_key_set = bool(
                status_value.get("api_key_set")
                if isinstance(status_value, dict)
                else status_value
            )
        except Exception:
            api_key_set = False

    blocked_runs = []
    for row in blocked_rows:
        marker: dict[str, Any] = {}
        try:
            marker = json.loads(str(row["state_value"] or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError):
            marker = {}
        blocked_runs.append(
            {
                "run_id": row["run_id"],
                "project_id": row["project_id"],
                "status": row["status"],
                "reason": marker.get("reason") or "执行器已熔断，等待人工处理",
                "marked_at": marker.get("marked_at") or "",
            }
        )
    run_sources = {row["run_id"]: row["execution_source"] for row in source_rows}
    return {
        "ok": True,
        "sampler": sampler,
        "paused": paused,
        "tick_seconds": configured_tick_seconds(tick_seconds),
        "api_key_set": api_key_set,
        "active_runs": [
            {
                **run,
                "execution_source": "server",
                "deferred_until": _utc_iso(deferred)
                if (deferred := _deferred_until(db_path, run["run_id"])) > now_epoch
                else "",
            }
            for run in active_runs
        ],
        "running_run_count": len(active_runs),
        "today": {
            "date": daily_key.removeprefix(STATE_DAILY_TASK_COUNT_PREFIX),
            "task_count": today_count,
            "hard_limit": MAX_DAILY_TASK_BUDGET,
        },
        "effective_limit": effective_limit if effective_limit in {1, 2, 4} else MAX_CONCURRENCY,
        "clean_windows": max(0, clean_windows),
        "rate_limit_pause_until": pause_until,
        "blocked_runs": blocked_runs,
        "run_sources": run_sources,
        "run_source_rows": source_rows,
        "last_tick": last_tick,
        "last_error": last_error,
        "checked_at": _utc_iso(now_epoch),
    }


class SamplingExecutorLoop(threading.Thread):
    """Single daemon coordinator; the existing Ark window owns request execution."""

    def __init__(
        self,
        db_path: str | Path,
        run_window_fn: Callable[[str, dict[str, Any]], dict[str, Any]],
        adaptive_concurrency: Any,
        request_limiter: Any,
        api_key_status_fn: Callable[[], Any],
        *,
        run_dispatch_guard_fn: Callable[[str, str], Any] | None = None,
        sampler: str = ARK_SAMPLER,
        platform_label: str = "联网采样",
        tick_seconds: Any = None,
        now_fn: Callable[[], float] = time.time,
        logger: Callable[[str], Any] | None = None,
    ):
        super().__init__(name=f"sampling-executor-{sampler}", daemon=True)
        self.db_path = Path(db_path)
        self.run_window_fn = run_window_fn
        self.adaptive_concurrency = adaptive_concurrency
        self.request_limiter = request_limiter
        self.api_key_status_fn = api_key_status_fn
        self.run_dispatch_guard_fn = run_dispatch_guard_fn
        self.sampler = sampler
        self.platform_label = str(platform_label or "联网采样")
        self.tick_seconds = configured_tick_seconds(tick_seconds)
        self.now_fn = now_fn
        self.logger = logger or (lambda message: print(message, flush=True))
        self._stop_event = threading.Event()
        self._tick_lock = threading.Lock()

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        while not self._stop_event.is_set():
            started = time.monotonic()
            try:
                self.tick()
            except Exception as exc:
                try:
                    set_executor_state(
                        self.db_path,
                        _runtime_state_key(STATE_EXECUTOR_LAST_ERROR, self.sampler),
                        f"{type(exc).__name__}: 执行器 tick 失败",
                    )
                except Exception:
                    pass
                self.logger(f"Sampling executor tick failed: {type(exc).__name__}")
            elapsed = max(0.0, time.monotonic() - started)
            self._stop_event.wait(max(0.0, self.tick_seconds - elapsed))

    def _api_key_set(self) -> bool:
        status_value = self.api_key_status_fn()
        if isinstance(status_value, dict):
            return bool(status_value.get("api_key_set"))
        return bool(status_value)

    def _save_tick(self, payload: dict[str, Any], now_epoch: float) -> None:
        set_executor_state(
            self.db_path,
            _runtime_state_key(STATE_EXECUTOR_LAST_TICK, self.sampler),
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            now=now_epoch,
        )

    def tick(self) -> dict[str, Any]:
        if not self._tick_lock.acquire(blocking=False):
            return {"ok": True, "skipped": "tick_in_progress"}
        try:
            now_epoch = _now_epoch(self.now_fn)
            result: dict[str, Any] = {
                "ok": True,
                "checked_at": _utc_iso(now_epoch),
                "created_runs": [],
                "windows": [],
                "yielded_runs": [],
                "guarded_runs": [],
                "deferred_runs": [],
                "blocked_runs": [],
            }
            if executor_is_paused(self.db_path):
                result["skipped"] = "paused"
                self._save_tick(result, now_epoch)
                return result

            result["advanced_schedules"] = _sync_schedule_statuses(
                self.db_path,
                now_epoch=now_epoch,
            )
            try:
                key_is_set = self._api_key_set()
            except Exception:
                key_is_set = False
            due_result = _create_due_schedule_runs(
                self.db_path,
                now_epoch=now_epoch,
                sampler=self.sampler,
                api_key_set=key_is_set,
                platform_label=self.platform_label,
            )
            result["created_runs"] = due_result["created_runs"]
            result["deferred_schedules"] = due_result["deferred_schedules"]
            result["skipped_schedules"] = due_result["skipped_schedules"]
            if not key_is_set:
                message = f"{self.platform_label} API Key 未配置，执行器已跳过"
                set_executor_state(
                    self.db_path,
                    _runtime_state_key(STATE_EXECUTOR_LAST_ERROR, self.sampler),
                    message,
                    now=now_epoch,
                )
                with _connect(self.db_path) as connection:
                    ensure_executor_tables(connection)
                    active_runs = _owned_active_runs(connection, self.sampler)
                for run in active_runs:
                    _record_run_error(self.db_path, run["run_id"], message, now_epoch)
                result["skipped"] = "api_key_missing"
                self._save_tick(result, now_epoch)
                return result

            set_executor_state(
                self.db_path,
                _runtime_state_key(STATE_EXECUTOR_LAST_ERROR, self.sampler),
                "",
                now=now_epoch,
            )
            with _connect(self.db_path) as connection:
                ensure_executor_tables(connection)
                candidates = _owned_active_runs(connection, self.sampler)

            for run in candidates:
                run_id = run["run_id"]
                if self.run_dispatch_guard_fn:
                    release_guarded_handoff = True
                    try:
                        guard_result = self.run_dispatch_guard_fn(
                            run["project_id"], run_id
                        )
                        if isinstance(guard_result, dict):
                            guard_allowed = bool(guard_result.get("allowed"))
                            guard_reason = str(
                                guard_result.get("reason") or "dispatch_guard_denied"
                            )
                        else:
                            guard_allowed = bool(guard_result)
                            guard_reason = (
                                "dispatch_guard_allowed"
                                if guard_allowed
                                else "dispatch_guard_denied"
                            )
                    except Exception as exc:
                        guard_allowed = False
                        guard_reason = f"dispatch_guard_error:{type(exc).__name__}"
                        release_guarded_handoff = False
                    if not guard_allowed:
                        if (
                            release_guarded_handoff
                            and run.get("ownership") == "handoff"
                        ):
                            try:
                                executor_release_handoff_run(
                                    self.db_path,
                                    run["project_id"],
                                    run_id,
                                )
                            except ValueError:
                                pass
                        result["guarded_runs"].append(
                            {"run_id": run_id, "reason": guard_reason}
                        )
                        continue
                candidate_epoch = _now_epoch(self.now_fn)
                defer_until = _deferred_until(self.db_path, run_id)
                if defer_until > candidate_epoch:
                    result["deferred_runs"].append(
                        {"run_id": run_id, "until": _utc_iso(defer_until)}
                    )
                    continue
                daily_count = _daily_task_count(self.db_path, candidate_epoch)
                budget = min(
                    max(1, int(run.get("daily_task_budget") or DEFAULT_DAILY_TASK_BUDGET)),
                    MAX_DAILY_TASK_BUDGET,
                )
                remaining_budget = budget - daily_count
                if remaining_budget <= 0:
                    result["deferred_runs"].append(
                        {
                            "run_id": run_id,
                            "until": _defer_for_budget(self.db_path, run, candidate_epoch),
                        }
                    )
                    continue
                max_concurrency = min(
                    MAX_CONCURRENCY,
                    max(1, int(run.get("max_concurrency") or MAX_CONCURRENCY)),
                    max(1, int(run.get("queued_task_count") or 1)),
                    remaining_budget,
                )
                try:
                    window = self.run_window_fn(
                        run["project_id"],
                        {
                            "run_id": run_id,
                            "max_concurrency": max_concurrency,
                        },
                    )
                except ValueError as exc:
                    message = str(exc)
                    if "正在执行" in message or "采样窗口" in message:
                        result["yielded_runs"].append(run_id)
                        continue
                    _record_run_error(
                        self.db_path,
                        run_id,
                        f"{type(exc).__name__}: 采样窗口未执行",
                        candidate_epoch,
                    )
                    continue
                except Exception as exc:
                    _record_run_error(
                        self.db_path,
                        run_id,
                        f"{type(exc).__name__}: 采样窗口执行失败",
                        candidate_epoch,
                    )
                    continue

                window_end_epoch = _now_epoch(self.now_fn)
                try:
                    executor_persist_runtime_state(
                        self.db_path,
                        self.adaptive_concurrency,
                        self.request_limiter,
                        sampler=self.sampler,
                        now=window_end_epoch,
                    )
                except Exception as exc:
                    self.logger(
                        f"Sampling executor state persistence failed: {type(exc).__name__}"
                    )
                executed_tasks = list((window or {}).get("executed_tasks") or [])
                new_daily_count = _increment_daily_task_count(
                    self.db_path,
                    len(executed_tasks),
                    window_end_epoch,
                )
                failure = _record_failure_window(
                    self.db_path,
                    run_id,
                    executed_tasks,
                    now_epoch=window_end_epoch,
                )
                if failure.get("blocked"):
                    result["blocked_runs"].append(run_id)
                result["windows"].append(
                    {
                        "run_id": run_id,
                        "executed_task_count": len(executed_tasks),
                        "daily_task_count": new_daily_count,
                        "failure_windows": failure.get("count"),
                        "blocked": bool(failure.get("blocked")),
                    }
                )
                result["advanced_schedules"].extend(
                    _sync_schedule_statuses(
                        self.db_path,
                        now_epoch=window_end_epoch,
                    )
                )

            self._save_tick(result, now_epoch)
            return result
        finally:
            self._tick_lock.release()


def start_sampling_executor_loop(
    db_path: str | Path,
    run_window_fn: Callable[[str, dict[str, Any]], dict[str, Any]],
    adaptive_concurrency: Any,
    request_limiter: Any,
    api_key_status_fn: Callable[[], Any],
    *,
    run_dispatch_guard_fn: Callable[[str, str], Any] | None = None,
    sampler: str = ARK_SAMPLER,
    platform_label: str = "联网采样",
    tick_seconds: Any = None,
    logger: Callable[[str], Any] | None = None,
) -> SamplingExecutorLoop:
    global _EXECUTOR_LOOP
    with _EXECUTOR_LOOP_LOCK:
        existing = _EXECUTOR_LOOPS.get(sampler)
        if existing is not None and existing.is_alive():
            return existing
        loop = SamplingExecutorLoop(
            db_path,
            run_window_fn,
            adaptive_concurrency,
            request_limiter,
            api_key_status_fn,
            run_dispatch_guard_fn=run_dispatch_guard_fn,
            sampler=sampler,
            platform_label=platform_label,
            tick_seconds=tick_seconds,
            logger=logger,
        )
        _EXECUTOR_LOOPS[sampler] = loop
        if sampler == ARK_SAMPLER:
            _EXECUTOR_LOOP = loop
        loop.start()
        return loop


__all__ = [
    "DEFAULT_RUN_AT_LOCAL",
    "DEFAULT_TICK_SECONDS",
    "EXECUTOR_STATE_DDL",
    "SamplingExecutorLoop",
    "SAMPLING_SCHEDULES_DDL",
    "clone_run_from_template",
    "configured_tick_seconds",
    "create_sampling_schedule",
    "create_project_sampling_schedule",
    "delete_project_sampling_schedule",
    "ensure_executor_tables",
    "executor_handoff_run",
    "executor_is_paused",
    "executor_mark_blocked",
    "executor_pause",
    "executor_persist_runtime_state",
    "executor_queued_runs",
    "executor_release_handoff_run",
    "executor_resume",
    "executor_resume_handoff_run",
    "executor_restore_runtime_state",
    "executor_startup_recovery",
    "executor_status",
    "get_executor_state",
    "get_sampling_schedule",
    "list_project_sampling_schedules",
    "next_schedule_at",
    "set_executor_state",
    "start_sampling_executor_loop",
    "update_project_sampling_schedule",
]
