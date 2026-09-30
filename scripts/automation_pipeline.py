"""Persistent orchestration for the approved-question automation workflow.

This module never implements Ark requests or report publishing.  It coordinates
the existing sampling executor and the existing analysis/report callbacks while
persisting enough state to resume safely after a process restart.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable


DEFAULT_TICK_SECONDS = 15
DEFAULT_LEASE_SECONDS = 30 * 60
MAX_AUTOMATIC_SAMPLE_RETRIES = 2
MAX_AUTOMATIC_ANALYSIS_RECOVERIES = 1
ANALYSIS_BATCH_SIZE = 15
ARK_SAMPLER = "doubao_api_websearch"

SCENES = (
    ("demand_solution", "品类需求可见", 10, 3, 7),
    ("vendor_selection", "推荐名单可见", 12, 3, 9),
    ("budget_case_process", "采购决策可见", 10, 3, 7),
    ("competitor_compare", "竞品对比可见", 8, 3, 5),
)
SCENE_BY_CODE = {
    code: {
        "code": code,
        "label": label,
        "target": target,
        "core_target": core_target,
        "long_tail_target": long_tail_target,
    }
    for code, label, target, core_target, long_tail_target in SCENES
}
SCENE_ALIASES = {
    "brand_mention": "vendor_selection",
    "brand_recommend": "vendor_selection",
    "fact_accuracy": "risk_fact_check",
    "competitor_occupancy": "competitor_compare",
    "risk_misleading": "risk_fact_check",
    "service_coverage": "demand_solution",
    "local_recommend": "vendor_selection",
    "price_case": "budget_case_process",
    "retest_stability": "brand_named_check",
}
QUESTION_POLICY_RE = re.compile(
    r"\[question_policy:v1;origin=(manual|ai|legacy);fixed=([01])\]"
)

ACTIVE_STATUSES = {"queued", "running", "needs_attention"}
TERMINAL_STATUSES = {"ready_for_publish", "cancelled"}
PAID_STAGES = {"queued", "sampling", "sampling_retry", "llm_analysis", "report_polish"}
MANUAL_RETRY_ERROR_CODES = {
    "sampling_incomplete",
    "analysis_call_failed",
    "analysis_incomplete",
}

AUTOMATION_RUNS_DDL = """
CREATE TABLE IF NOT EXISTS automation_runs (
  automation_run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  preview_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT NOT NULL DEFAULT 'queued',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  selected_question_ids_json TEXT NOT NULL DEFAULT '[]',
  scene_counts_json TEXT NOT NULL DEFAULT '{}',
  tier_counts_json TEXT NOT NULL DEFAULT '{}',
  question_scope_hash TEXT NOT NULL DEFAULT '',
  context_hash TEXT NOT NULL DEFAULT '',
  policies_json TEXT NOT NULL DEFAULT '{}',
  cost_estimate_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT NOT NULL DEFAULT '{}',
  sample_run_id TEXT NOT NULL DEFAULT '',
  analysis_version_id TEXT NOT NULL DEFAULT '',
  report_draft_id TEXT NOT NULL DEFAULT '',
  report_type TEXT NOT NULL DEFAULT '',
  comparison_run_id TEXT NOT NULL DEFAULT '',
  sample_retry_rounds INTEGER NOT NULL DEFAULT 0,
  analysis_recovery_count INTEGER NOT NULL DEFAULT 0,
  manual_retry_count INTEGER NOT NULL DEFAULT 0,
  manual_retry_credits INTEGER NOT NULL DEFAULT 0,
  analysis_result_text TEXT NOT NULL DEFAULT '',
  analysis_validation_json TEXT NOT NULL DEFAULT '{}',
  analysis_execution_json TEXT NOT NULL DEFAULT '{}',
  analysis_llm_meta_json TEXT NOT NULL DEFAULT '{}',
  report_model_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
)
"""

AUTOMATION_EVENTS_DDL = """
CREATE TABLE IF NOT EXISTS automation_events (
  automation_event_id TEXT PRIMARY KEY,
  automation_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (automation_run_id) REFERENCES automation_runs(automation_run_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
)
"""

_PIPELINE_LOOP: "AutomationPipelineLoop | None" = None
_PIPELINE_LOOP_LOCK = threading.Lock()


class AutomationClaimLost(RuntimeError):
    """The claimed run changed state while the current stage was executing."""


def now_iso() -> str:
    return datetime.now().isoformat(timespec="microseconds")


def make_id(prefix: str) -> str:
    return f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"


def configured_tick_seconds(value: Any = None) -> int:
    raw = value if value is not None else os.environ.get("AUTOMATION_TICK_SECONDS")
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = DEFAULT_TICK_SECONDS
    return max(2, min(parsed, 300))


@contextmanager
def _connect(db_path: str | Path):
    connection = sqlite3.connect(Path(db_path), timeout=30)
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


def ensure_automation_tables(connection: sqlite3.Connection) -> None:
    connection.execute(AUTOMATION_RUNS_DDL)
    connection.execute(AUTOMATION_EVENTS_DDL)
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_idempotency
        ON automation_runs(project_id, idempotency_key)
        WHERE idempotency_key <> ''
        """
    )
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_project_active
        ON automation_runs(project_id)
        WHERE status IN ('queued', 'running', 'needs_attention')
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_automation_runs_project_created
        ON automation_runs(project_id, created_at DESC)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_automation_runs_status_stage
        ON automation_runs(status, current_stage, updated_at)
        """
    )
    connection.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_automation_events_run_created
        ON automation_events(automation_run_id, created_at)
        """
    )


def ensure_automation_database(db_path: str | Path) -> None:
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)


def _json_load(value: Any, default: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default
    return parsed if isinstance(parsed, type(default)) else default


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _normal_scene(value: Any) -> str:
    raw = str(value or "demand_solution").strip()
    return SCENE_ALIASES.get(raw, raw)


def _question_policy(value: Any) -> dict[str, Any]:
    text = str(value or "")
    match = QUESTION_POLICY_RE.search(text)
    return {
        "origin": match.group(1) if match else "legacy",
        "fixed": bool(match and match.group(2) == "1"),
    }


def _priority_rank(value: Any) -> int:
    text = str(value or "").strip().upper()
    if text in {"高", "P0", "本周P0"}:
        return 0
    if text in {"P1", "本周P1"}:
        return 1
    if text in {"中", "P2", ""}:
        return 2
    return 3


def _question_sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    question_id = str(item.get("question_id") or "")
    number_match = re.search(r"(\d+)$", question_id)
    number = int(number_match.group(1)) if number_match else 10**9
    return (
        0 if item.get("fixed_monitoring") else 1,
        _priority_rank(item.get("priority")),
        -int(item.get("commercial_value") or 0),
        number,
        question_id,
    )


def _eligible_questions(
    connection: sqlite3.Connection,
    project_id: str,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    project_row = connection.execute(
        """
        SELECT p.*, c.name AS customer_name, c.industry AS customer_industry,
               c.region AS customer_region, c.business_summary,
               c.target_customers, c.status AS customer_status
        FROM projects p
        JOIN customers c ON c.customer_id = p.customer_id
        WHERE p.project_id = ?
        """,
        (project_id,),
    ).fetchone()
    if not project_row:
        return None, []
    rows = connection.execute(
        """
        SELECT q.question_id, q.question, q.category, q.intent,
               q.commercial_value, q.is_core, q.updated_at AS question_updated_at,
               pq.priority, pq.target_positioning, pq.status,
               pq.review_status, pq.reviewed_at, pq.updated_at,
               pq.generation_focus, pq.generation_focus_label
        FROM project_questions pq
        JOIN question_pool q ON q.question_id = pq.question_id
        WHERE pq.project_id = ?
          AND pq.status = 'active'
          AND COALESCE(pq.review_status, 'pending') = 'approved'
        """,
        (project_id,),
    ).fetchall()
    questions: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        scene_code = _normal_scene(item.get("generation_focus"))
        if scene_code not in SCENE_BY_CODE:
            continue
        policy = _question_policy(item.get("target_positioning"))
        questions.append(
            {
                "question_id": item["question_id"],
                "question": item.get("question") or "",
                "category": item.get("category") or "",
                "intent": item.get("intent") or "",
                "commercial_value": int(item.get("commercial_value") or 0),
                "is_core": bool(item.get("is_core")),
                "question_tier": "core" if item.get("is_core") else "long_tail",
                "priority": item.get("priority") or "中",
                "scene_code": scene_code,
                "scene_label": SCENE_BY_CODE[scene_code]["label"],
                "fixed_monitoring": policy["fixed"],
                "question_origin": policy["origin"],
                "review_status": item.get("review_status") or "approved",
                "status": item.get("status") or "active",
                "reviewed_at": item.get("reviewed_at") or "",
                "updated_at": item.get("updated_at") or "",
                "question_updated_at": item.get("question_updated_at") or "",
            }
        )
    questions.sort(key=_question_sort_key)
    return dict(project_row), questions


def _context_snapshot(
    connection: sqlite3.Connection,
    project: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    customer_id = str(project.get("customer_id") or "")
    facts = [
        dict(row)
        for row in connection.execute(
            """
            SELECT fact_id, fact_type, fact_key, fact_value, visibility,
                   confidence, evidence_url, updated_at
            FROM customer_facts
            WHERE customer_id = ? AND fact_type <> 'question_profile'
            ORDER BY fact_type, fact_id
            """,
            (customer_id,),
        ).fetchall()
    ]
    competitors = [
        dict(row)
        for row in connection.execute(
            "SELECT * FROM competitors WHERE customer_id = ? ORDER BY competitor_id",
            (customer_id,),
        ).fetchall()
    ]
    forbidden_claims = [
        dict(row)
        for row in connection.execute(
            "SELECT * FROM forbidden_claims WHERE customer_id = ? ORDER BY claim_id",
            (customer_id,),
        ).fetchall()
    ]
    project_fields = {
        key: project.get(key)
        for key in (
            "project_id",
            "customer_id",
            "name",
            "platform",
            "language",
            "goal",
            "status",
            "customer_name",
            "customer_industry",
            "customer_region",
            "business_summary",
            "target_customers",
            "customer_status",
        )
    }
    return (
        {
            "project": project_fields,
            "customer_facts": facts,
            "competitors": competitors,
            "forbidden_claims": forbidden_claims,
        },
        bool(facts or competitors or forbidden_claims),
    )


def _question_snapshot(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    fields = (
        "question_id",
        "question",
        "scene_code",
        "question_tier",
        "priority",
        "fixed_monitoring",
        "review_status",
        "status",
        "updated_at",
        "question_updated_at",
    )
    return [{key: row.get(key) for key in fields} for row in rows]


def _recommended_questions(eligible: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for code, _label, target, _core_target, _long_tail_target in SCENES:
        selected.extend([row for row in eligible if row["scene_code"] == code][:target])
    return selected


def _scene_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    return {
        code: sum(1 for row in rows if row.get("scene_code") == code)
        for code, *_rest in SCENES
    }


def _tier_counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    per_scene: dict[str, Any] = {}
    for code, _label, _target, core_target, long_tail_target in SCENES:
        scene_rows = [row for row in rows if row.get("scene_code") == code]
        per_scene[code] = {
            "core": sum(1 for row in scene_rows if row.get("question_tier") == "core"),
            "long_tail": sum(
                1 for row in scene_rows if row.get("question_tier") == "long_tail"
            ),
            "core_target": core_target,
            "long_tail_target": long_tail_target,
        }
    return {
        "core": sum(1 for row in rows if row.get("question_tier") == "core"),
        "long_tail": sum(
            1 for row in rows if row.get("question_tier") == "long_tail"
        ),
        "target_core": 12,
        "target_long_tail": 28,
        "per_scene": per_scene,
    }


def _normalized_readiness(value: Any) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    today_used = max(0, int(raw.get("today_task_count") or 0))
    daily_limit = max(1, int(raw.get("daily_task_budget") or 200))
    return {
        "ark_api_key_set": bool(raw.get("ark_api_key_set")),
        "llm_configured": bool(raw.get("llm_configured")),
        "executor_paused": bool(raw.get("executor_paused")),
        "today_task_count": today_used,
        "daily_task_budget": daily_limit,
        "daily_budget_remaining": max(0, daily_limit - today_used),
        "effective_concurrency": int(raw.get("effective_concurrency") or 4),
    }


def preview_automation_run(
    db_path: str | Path,
    project_id: str,
    *,
    selected_question_ids: list[Any] | None = None,
    readiness: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    project_id = str(project_id or "").strip()
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        project, eligible = _eligible_questions(connection, project_id)
        if not project:
            return None
        context_snapshot, fact_base_ready = _context_snapshot(connection, project)

    by_id = {row["question_id"]: row for row in eligible}
    requested_ids: list[str] = []
    duplicate_ids: list[str] = []
    seen: set[str] = set()
    if selected_question_ids is not None:
        for value in selected_question_ids:
            question_id = str(value or "").strip()
            if not question_id:
                continue
            if question_id in seen:
                duplicate_ids.append(question_id)
                continue
            seen.add(question_id)
            requested_ids.append(question_id)
        selected = [by_id[question_id] for question_id in requested_ids if question_id in by_id]
    else:
        selected = _recommended_questions(eligible)
        requested_ids = [row["question_id"] for row in selected]

    ineligible_ids = [question_id for question_id in requested_ids if question_id not in by_id]
    selected_ids = [row["question_id"] for row in selected]
    counts = _scene_counts(selected)
    tier_counts = _tier_counts(selected)
    selected_id_set = set(selected_ids)
    unselected_fixed = [
        row for row in eligible if row["fixed_monitoring"] and row["question_id"] not in selected_id_set
    ]
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if duplicate_ids:
        blockers.append(
            {
                "code": "duplicate_question_ids",
                "message": "选题中存在重复题号：" + "、".join(duplicate_ids[:10]),
            }
        )
    if ineligible_ids:
        blockers.append(
            {
                "code": "ineligible_question_ids",
                "message": "以下问题未审核通过、已停用、属于高级题或不属于项目："
                + "、".join(ineligible_ids[:10]),
            }
        )
    if len(selected_ids) != 40:
        blockers.append(
            {
                "code": "question_count_mismatch",
                "message": f"必须精确选择 40 题，当前为 {len(selected_ids)} 题。",
            }
        )
    for code, label, _target, _core_target, _long_tail_target in SCENES:
        if counts.get(code, 0) <= 0:
            blockers.append(
                {
                    "code": f"scene_empty_{code}",
                    "message": f"{label}至少必须选择 1 题。",
                }
            )
    if not fact_base_ready:
        blockers.append(
            {
                "code": "fact_base_missing",
                "message": "客户尚无可用于分析的已确认事实、竞品或禁用表述。",
            }
        )
    safe_readiness = _normalized_readiness(readiness)
    if not safe_readiness["ark_api_key_set"]:
        blockers.append(
            {"code": "ark_api_key_missing", "message": "火山方舟 API Key 尚未配置。"}
        )
    if not safe_readiness["llm_configured"]:
        blockers.append(
            {"code": "llm_config_missing", "message": "分析与报告使用的 LLM 配置尚未完成。"}
        )
    if safe_readiness["executor_paused"]:
        blockers.append(
            {"code": "executor_paused", "message": "服务端采样执行器当前处于全局暂停状态。"}
        )
    if safe_readiness["daily_budget_remaining"] < 40:
        blockers.append(
            {
                "code": "daily_budget_insufficient",
                "message": "今日剩余采样预算不足以完成首轮 40 个任务。",
            }
        )
    if tier_counts["core"] != tier_counts["target_core"] or tier_counts["long_tail"] != tier_counts["target_long_tail"]:
        warnings.append(
            {
                "code": "tier_ratio_deviation",
                "message": (
                    f"当前核心题/长尾题为 {tier_counts['core']}/{tier_counts['long_tail']}，"
                    "建议目标为 12/28；该项仅提醒，不阻止启动。"
                ),
            }
        )
    if unselected_fixed:
        warnings.append(
            {
                "code": "fixed_questions_unselected",
                "message": f"有 {len(unselected_fixed)} 道固定监测题未进入本次 40 题。",
            }
        )

    question_hash = _fingerprint(_question_snapshot(selected))
    context_hash = _fingerprint(context_snapshot)
    policies = {
        "scene_targets": {code: int(counts.get(code, 0) or 0) for code, *_rest in SCENES},
        "tier_targets_are_blocking": False,
        "sample_retry_rounds": MAX_AUTOMATIC_SAMPLE_RETRIES,
        "analysis_recoveries": MAX_AUTOMATIC_ANALYSIS_RECOVERIES,
        "auto_conflict_policy": "adopt_llm",
        "report_publish": "manual",
    }
    preview_hash = _fingerprint(
        {
            "project_id": project_id,
            "selected_question_ids": selected_ids,
            "question_scope_hash": question_hash,
            "context_hash": context_hash,
            "policies": policies,
        }
    )
    estimate = {
        "base_sampling_tasks": 40,
        "automatic_sample_retry_rounds": MAX_AUTOMATIC_SAMPLE_RETRIES,
        "maximum_task_executions": 120,
        "analysis_batch_size": ANALYSIS_BATCH_SIZE,
        "analysis_base_calls": 3,
        "analysis_automatic_recoveries": MAX_AUTOMATIC_ANALYSIS_RECOVERIES,
        "analysis_estimated_max_calls": 4,
        "report_polish_calls": 1,
        "transport_retry_notice": "既有网络、429 和限流重试可能增加实际请求量。",
    }
    return {
        "ok": True,
        "project": {
            "project_id": project_id,
            "name": project.get("name") or "",
            "customer_id": project.get("customer_id") or "",
            "customer_name": project.get("customer_name") or "",
        },
        "eligible_questions": eligible,
        "recommended_question_ids": [
            row["question_id"] for row in _recommended_questions(eligible)
        ],
        "selected_question_ids": selected_ids,
        "selected_questions": selected,
        "unselected_fixed_questions": unselected_fixed,
        "scene_counts": counts,
        "scene_targets": {
            code: {
                "label": label,
                "target": int(counts.get(code, 0) or 0),
                "default_target": target,
                "core_target": core_target,
                "long_tail_target": long_tail_target,
            }
            for code, label, target, core_target, long_tail_target in SCENES
        },
        "tier_counts": tier_counts,
        "readiness": {**safe_readiness, "fact_base_ready": fact_base_ready},
        "cost_estimate": estimate,
        "warnings": warnings,
        "blockers": blockers,
        "can_start": not blockers,
        "question_scope_hash": question_hash,
        "context_hash": context_hash,
        "preview_hash": preview_hash,
        "policies": policies,
        "source": "sqlite",
    }


JSON_FIELDS = {
    "selected_question_ids_json": "selected_question_ids",
    "scene_counts_json": "scene_counts",
    "tier_counts_json": "tier_counts",
    "policies_json": "policies",
    "cost_estimate_json": "cost_estimate",
    "usage_json": "usage",
    "analysis_validation_json": "analysis_validation",
    "analysis_execution_json": "analysis_execution",
    "analysis_llm_meta_json": "analysis_llm_meta",
    "report_model_json": "report_model",
}


def automation_run_to_dict(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    item = dict(row)
    for stored_name, public_name in JSON_FIELDS.items():
        default: Any = [] if stored_name == "selected_question_ids_json" else {}
        item[public_name] = _json_load(item.get(stored_name), default)
        item.pop(stored_name, None)
    for name in (
        "sample_retry_rounds",
        "analysis_recovery_count",
        "manual_retry_count",
        "manual_retry_credits",
    ):
        item[name] = int(item.get(name) or 0)
    item["active"] = item.get("status") in ACTIVE_STATUSES
    item["terminal"] = item.get("status") in TERMINAL_STATUSES
    return item


def _safe_event_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    safe: dict[str, Any] = {}
    for key, item in value.items():
        normalized = str(key or "").lower()
        sensitive = any(token in normalized for token in ("password", "secret", "authorization"))
        sensitive = sensitive or (
            "api_key" in normalized and not normalized.endswith(("_set", "_configured"))
        )
        if sensitive:
            continue
        if isinstance(item, (str, int, float, bool)) or item is None:
            safe[str(key)] = item
        elif isinstance(item, list):
            safe[str(key)] = item[:50]
        elif isinstance(item, dict):
            safe[str(key)] = _safe_event_metadata(item)
    return safe


def _append_event(
    connection: sqlite3.Connection,
    run: dict[str, Any] | sqlite3.Row,
    *,
    stage: str,
    event_type: str,
    status: str,
    message: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO automation_events (
          automation_event_id, automation_run_id, project_id, stage,
          event_type, status, message, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            make_id("autoevent"),
            run["automation_run_id"],
            run["project_id"],
            stage,
            event_type,
            status,
            str(message or "")[:1200],
            _canonical_json(_safe_event_metadata(metadata or {})),
            now_iso(),
        ),
    )


def create_automation_run(
    db_path: str | Path,
    project_id: str,
    *,
    preview: dict[str, Any],
    preview_hash: str,
    idempotency_key: str,
    acknowledge_cost: bool,
    created_by: str,
) -> dict[str, Any]:
    project_id = str(project_id or "").strip()
    idempotency_key = str(idempotency_key or "").strip()[:120]
    if not idempotency_key:
        raise ValueError("缺少 idempotency_key")
    if not acknowledge_cost:
        raise ValueError("必须明确确认真实 API 费用风险")
    if not preview.get("can_start"):
        raise ValueError("启动预览仍有阻塞项，不能创建自动流程")
    if not preview_hash or preview_hash != preview.get("preview_hash"):
        raise ValueError("题库或配置已变化，请重新预览后再启动")

    timestamp = now_iso()
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        existing = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ? AND idempotency_key = ?
            """,
            (project_id, idempotency_key),
        ).fetchone()
        if existing:
            result = automation_run_to_dict(existing) or {}
            result["idempotent_replay"] = True
            return result
        active = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ?
              AND status IN ('queued', 'running', 'needs_attention')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if active:
            error = ValueError("当前项目已有未结束的自动流程")
            setattr(error, "existing_run", automation_run_to_dict(active))
            raise error
        automation_run_id = make_id("autorun")
        connection.execute(
            """
            INSERT INTO automation_runs (
              automation_run_id, project_id, idempotency_key, preview_hash,
              status, current_stage, trigger_type,
              selected_question_ids_json, scene_counts_json, tier_counts_json,
              question_scope_hash, context_hash, policies_json,
              cost_estimate_json, usage_json, created_by, started_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'queued', 'queued', 'manual',
                      ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)
            """,
            (
                automation_run_id,
                project_id,
                idempotency_key,
                preview_hash,
                _canonical_json(preview.get("selected_question_ids") or []),
                _canonical_json(preview.get("scene_counts") or {}),
                _canonical_json(preview.get("tier_counts") or {}),
                preview.get("question_scope_hash") or "",
                preview.get("context_hash") or "",
                _canonical_json(preview.get("policies") or {}),
                _canonical_json(preview.get("cost_estimate") or {}),
                str(created_by or "")[:120],
                timestamp,
                timestamp,
                timestamp,
            ),
        )
        row = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (automation_run_id,),
        ).fetchone()
        _append_event(
            connection,
            row,
            stage="queued",
            event_type="created",
            status="queued",
            message="人工已确认题目范围与费用风险，自动流程已创建。",
            metadata={
                "question_count": len(preview.get("selected_question_ids") or []),
                "scene_counts": preview.get("scene_counts") or {},
                "preview_hash": preview_hash,
            },
        )
        return automation_run_to_dict(row) or {}


def get_automation_run(
    db_path: str | Path,
    project_id: str,
    automation_run_id: str,
    *,
    include_events: bool = True,
) -> dict[str, Any] | None:
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        row = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ? AND automation_run_id = ?
            """,
            (str(project_id or "").strip(), str(automation_run_id or "").strip()),
        ).fetchone()
        if not row:
            return None
        result = automation_run_to_dict(row) or {}
        if include_events:
            result["events"] = [
                {
                    **dict(event),
                    "metadata": _json_load(event["metadata_json"], {}),
                }
                for event in connection.execute(
                    """
                    SELECT * FROM automation_events
                    WHERE automation_run_id = ?
                    ORDER BY created_at, rowid
                    """,
                    (automation_run_id,),
                ).fetchall()
            ]
            for event in result["events"]:
                event.pop("metadata_json", None)
        return result


def list_automation_runs(
    db_path: str | Path,
    project_id: str,
    *,
    limit: int = 20,
) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit or 20), 100))
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        rows = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ?
            ORDER BY created_at DESC, automation_run_id DESC
            LIMIT ?
            """,
            (str(project_id or "").strip(), safe_limit),
        ).fetchall()
    items = [automation_run_to_dict(row) for row in rows]
    items = [item for item in items if item]
    return {
        "ok": True,
        "items": items,
        "latest": items[0] if items else None,
        "active": next((item for item in items if item.get("active")), None),
        "source": "sqlite",
    }


def resume_automation_run(
    db_path: str | Path,
    project_id: str,
    automation_run_id: str,
    *,
    preview: dict[str, Any],
    acknowledge_cost: bool,
    resumed_by: str,
) -> dict[str, Any]:
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        row = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ? AND automation_run_id = ?
            """,
            (project_id, automation_run_id),
        ).fetchone()
        if not row:
            raise ValueError("自动流程不存在或不属于当前项目")
        if row["status"] == "ready_for_publish":
            result = automation_run_to_dict(row) or {}
            result["idempotent_replay"] = True
            return result
        if row["status"] == "cancelled":
            raise ValueError("已取消的自动流程不能恢复，请重新创建")
        if row["status"] != "needs_attention":
            result = automation_run_to_dict(row) or {}
            result["idempotent_replay"] = True
            return result
        if (
            preview.get("question_scope_hash") != row["question_scope_hash"]
            or preview.get("context_hash") != row["context_hash"]
        ):
            raise ValueError("题库或已确认事实与启动快照不一致，不能继续原流程")
        if any(
            blocker.get("code")
            in {
                "ark_api_key_missing",
                "llm_config_missing",
                "executor_paused",
                "daily_budget_insufficient",
                "fact_base_missing",
            }
            for blocker in (preview.get("blockers") or [])
        ):
            raise ValueError("运行配置仍有阻塞项，请修复后再恢复")
        if row["current_stage"] in PAID_STAGES and not acknowledge_cost:
            raise ValueError("恢复该阶段可能继续产生 API 费用，请明确确认")
        timestamp = now_iso()
        error_code = str(row["last_error_code"] or "")
        grant_retry_credit = error_code in MANUAL_RETRY_ERROR_CODES or (
            error_code == "stage_error" and row["current_stage"] == "report_polish"
        )
        updated = connection.execute(
            """
            UPDATE automation_runs
            SET status = 'running',
                manual_retry_count = manual_retry_count + 1,
                manual_retry_credits = manual_retry_credits + ?,
                last_error_code = ?,
                last_error = '',
                lease_token = '',
                lease_until = '',
                updated_at = ?
            WHERE automation_run_id = ? AND status = 'needs_attention'
            """,
            (
                1 if grant_retry_credit else 0,
                "manual_retry_pending" if grant_retry_credit else "",
                timestamp,
                automation_run_id,
            ),
        ).rowcount
        if updated != 1:
            current = connection.execute(
                "SELECT * FROM automation_runs WHERE automation_run_id = ?",
                (automation_run_id,),
            ).fetchone()
            if current and current["status"] == "cancelled":
                raise ValueError("已取消的自动流程不能恢复，请重新创建")
            result = automation_run_to_dict(current) or {}
            result["idempotent_replay"] = True
            return result
        refreshed = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (automation_run_id,),
        ).fetchone()
        _append_event(
            connection,
            refreshed,
            stage=refreshed["current_stage"],
            event_type="resumed",
            status="running",
            message="人工已修复阻塞项并恢复原流程。",
            metadata={
                "resumed_by": str(resumed_by or "")[:120],
                "cost_acknowledged": bool(acknowledge_cost),
                "retry_credit_granted": grant_retry_credit,
            },
        )
        return automation_run_to_dict(refreshed) or {}


def cancel_automation_run(
    db_path: str | Path,
    project_id: str,
    automation_run_id: str,
    *,
    cancelled_by: str,
) -> dict[str, Any]:
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        row = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ? AND automation_run_id = ?
            """,
            (project_id, automation_run_id),
        ).fetchone()
        if not row:
            raise ValueError("自动流程不存在或不属于当前项目")
        if row["status"] == "cancelled":
            result = automation_run_to_dict(row) or {}
            result["idempotent_replay"] = True
            return result
        if row["status"] == "ready_for_publish":
            raise ValueError("流程已生成待发布报告草稿，无需取消")
        timestamp = now_iso()
        updated = connection.execute(
            """
            UPDATE automation_runs
            SET status = 'cancelled', completed_at = ?, lease_token = '',
                lease_until = '', last_error_code = '', last_error = '',
                updated_at = ?
            WHERE automation_run_id = ?
              AND status NOT IN ('cancelled', 'ready_for_publish')
            """,
            (timestamp, timestamp, automation_run_id),
        ).rowcount
        if updated != 1:
            current = connection.execute(
                "SELECT * FROM automation_runs WHERE automation_run_id = ?",
                (automation_run_id,),
            ).fetchone()
            if current and current["status"] == "ready_for_publish":
                raise ValueError("流程已生成待发布报告草稿，无需取消")
            result = automation_run_to_dict(current) or {}
            result["idempotent_replay"] = True
            return result
        refreshed = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (automation_run_id,),
        ).fetchone()
        _append_event(
            connection,
            refreshed,
            stage=refreshed["current_stage"],
            event_type="cancelled",
            status="cancelled",
            message="自动流程已取消；已产生的数据和审计记录均保留。",
            metadata={"cancelled_by": str(cancelled_by or "")[:120]},
        )
        return automation_run_to_dict(refreshed) or {}


def _decode_json_column(row: sqlite3.Row | dict[str, Any], name: str, default: Any) -> Any:
    return _json_load(row[name] if name in row.keys() else None, default)


def _claim_next_run(
    db_path: str | Path,
    *,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> tuple[dict[str, Any], str] | None:
    timestamp = now_iso()
    lease_until = (
        datetime.now() + timedelta(seconds=max(60, lease_seconds))
    ).replace(microsecond=0).isoformat()
    token = uuid.uuid4().hex
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE status IN ('queued', 'running')
              AND (lease_until = '' OR lease_until <= ?)
            ORDER BY created_at, automation_run_id
            LIMIT 1
            """,
            (timestamp,),
        ).fetchone()
        if not row:
            return None
        updated = connection.execute(
            """
            UPDATE automation_runs
            SET status = 'running', lease_token = ?, lease_until = ?, updated_at = ?
            WHERE automation_run_id = ?
              AND (lease_until = '' OR lease_until <= ?)
            """,
            (token, lease_until, timestamp, row["automation_run_id"], timestamp),
        ).rowcount
        if not updated:
            return None
        refreshed = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (row["automation_run_id"],),
        ).fetchone()
        return dict(refreshed), token


def _release_lease(
    db_path: str | Path,
    automation_run_id: str,
    token: str,
) -> None:
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        connection.execute(
            """
            UPDATE automation_runs
            SET lease_token = '', lease_until = '', updated_at = ?
            WHERE automation_run_id = ? AND lease_token = ?
            """,
            (now_iso(), automation_run_id, token),
        )


def _run_row(db_path: str | Path, automation_run_id: str) -> dict[str, Any] | None:
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        row = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (automation_run_id,),
        ).fetchone()
        return dict(row) if row else None


def _claim_token(run: dict[str, Any] | sqlite3.Row) -> str:
    return str(run["lease_token"] or "") if "lease_token" in run.keys() else ""


def _assert_active_claim(
    db_path: str | Path,
    run: dict[str, Any] | sqlite3.Row,
) -> dict[str, Any]:
    token = _claim_token(run)
    if not token:
        raise AutomationClaimLost("自动流程租约已失效，当前阶段提交已放弃")
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        row = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE automation_run_id = ? AND status = 'running' AND lease_token = ?
            """,
            (run["automation_run_id"], token),
        ).fetchone()
    if not row:
        raise AutomationClaimLost("自动流程状态或租约已变化，当前阶段提交已放弃")
    return dict(row)


def _update_stage(
    db_path: str | Path,
    run: dict[str, Any],
    stage: str,
    *,
    fields: dict[str, Any] | None = None,
    event_type: str = "stage_advanced",
    message: str = "",
) -> dict[str, Any]:
    token = _claim_token(run)
    if not token:
        raise AutomationClaimLost("自动流程租约已失效，阶段推进已放弃")
    updates = {"current_stage": stage, "status": "running", "last_error_code": "", "last_error": ""}
    updates.update(fields or {})
    updates["updated_at"] = now_iso()
    assignments = ", ".join(f"{name} = ?" for name in updates)
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        updated = connection.execute(
            (
                f"UPDATE automation_runs SET {assignments} "
                "WHERE automation_run_id = ? AND status = 'running' AND lease_token = ?"
            ),
            [*updates.values(), run["automation_run_id"], token],
        ).rowcount
        if updated != 1:
            raise AutomationClaimLost("自动流程状态或租约已变化，阶段推进已放弃")
        refreshed = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (run["automation_run_id"],),
        ).fetchone()
        _append_event(
            connection,
            refreshed,
            stage=stage,
            event_type=event_type,
            status=refreshed["status"],
            message=message or f"自动流程进入 {stage} 阶段。",
            metadata={key: value for key, value in (fields or {}).items() if not key.endswith("_json")},
        )
        return dict(refreshed)


def _mark_attention(
    db_path: str | Path,
    run: dict[str, Any],
    code: str,
    message: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    timestamp = now_iso()
    token = _claim_token(run)
    if not token:
        raise AutomationClaimLost("自动流程租约已失效，暂停提交已放弃")
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        updated = connection.execute(
            """
            UPDATE automation_runs
            SET status = 'needs_attention', last_error_code = ?, last_error = ?,
                lease_token = '', lease_until = '', updated_at = ?
            WHERE automation_run_id = ? AND status = 'running' AND lease_token = ?
            """,
            (
                str(code or "")[:120],
                str(message or "")[:1200],
                timestamp,
                run["automation_run_id"],
                token,
            ),
        ).rowcount
        if updated != 1:
            raise AutomationClaimLost("自动流程状态或租约已变化，暂停提交已放弃")
        refreshed = connection.execute(
            "SELECT * FROM automation_runs WHERE automation_run_id = ?",
            (run["automation_run_id"],),
        ).fetchone()
        _append_event(
            connection,
            refreshed,
            stage=refreshed["current_stage"],
            event_type="needs_attention",
            status="needs_attention",
            message=message,
            metadata={"code": code, **(metadata or {})},
        )
        return dict(refreshed)


def _current_preview(
    db_path: str | Path,
    run: dict[str, Any],
    readiness: dict[str, Any],
) -> dict[str, Any]:
    selected = _decode_json_column(run, "selected_question_ids_json", [])
    preview = preview_automation_run(
        db_path,
        run["project_id"],
        selected_question_ids=selected,
        readiness=readiness,
    )
    if preview is None:
        raise ValueError("项目不存在")
    return preview


def automation_sampling_dispatch_guard(
    db_path: str | Path,
    project_id: str,
    sample_run_id: str,
) -> dict[str, Any]:
    """Prevent an owned sampling window from starting with stale automation context."""
    safe_project_id = str(project_id or "").strip()
    safe_run_id = str(sample_run_id or "").strip()
    if not safe_project_id or not safe_run_id:
        return {"allowed": False, "reason": "invalid_run_scope"}
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        row = connection.execute(
            """
            SELECT * FROM automation_runs
            WHERE project_id = ? AND sample_run_id = ?
            ORDER BY created_at DESC, automation_run_id DESC
            LIMIT 1
            """,
            (safe_project_id, safe_run_id),
        ).fetchone()
    if not row:
        return {"allowed": True, "reason": "not_automation_owned"}
    run = dict(row)
    automation_run_id = str(run["automation_run_id"])
    if run["status"] not in {"queued", "running"}:
        return {
            "allowed": False,
            "reason": f"automation_{run['status']}",
            "automation_run_id": automation_run_id,
        }
    if run["current_stage"] not in {"sampling", "sampling_retry"}:
        return {
            "allowed": False,
            "reason": "automation_stage_not_sampling",
            "automation_run_id": automation_run_id,
        }
    preview = _current_preview(db_path, run, {})
    if (
        preview.get("question_scope_hash") == run.get("question_scope_hash")
        and preview.get("context_hash") == run.get("context_hash")
    ):
        return {
            "allowed": True,
            "reason": "automation_context_current",
            "automation_run_id": automation_run_id,
        }

    timestamp = now_iso()
    with _connect(db_path) as connection:
        ensure_automation_tables(connection)
        updated = connection.execute(
            """
            UPDATE automation_runs
            SET status = 'needs_attention',
                last_error_code = 'context_drift',
                last_error = ?,
                lease_token = '',
                lease_until = '',
                updated_at = ?
            WHERE automation_run_id = ?
              AND status IN ('queued', 'running')
              AND question_scope_hash = ?
              AND context_hash = ?
            """,
            (
                "题库或已确认事实与启动快照不一致，采样窗口未派发。",
                timestamp,
                automation_run_id,
                run["question_scope_hash"],
                run["context_hash"],
            ),
        ).rowcount
        if updated:
            refreshed = connection.execute(
                "SELECT * FROM automation_runs WHERE automation_run_id = ?",
                (automation_run_id,),
            ).fetchone()
            _append_event(
                connection,
                refreshed,
                stage=refreshed["current_stage"],
                event_type="needs_attention",
                status="needs_attention",
                message="题库或已确认事实已变化，服务端采样窗口在派发前安全暂停。",
                metadata={"code": "context_drift", "sample_run_id": safe_run_id},
            )
    return {
        "allowed": False,
        "reason": "context_drift",
        "automation_run_id": automation_run_id,
    }


def _find_named_sample_run(
    db_path: str | Path,
    project_id: str,
    automation_run_id: str,
) -> str:
    name = f"自动监测 · {automation_run_id}"
    with _connect(db_path) as connection:
        row = connection.execute(
            """
            SELECT run_id FROM sample_runs
            WHERE project_id = ? AND name = ?
            ORDER BY created_at DESC LIMIT 1
            """,
            (project_id, name),
        ).fetchone()
        return str(row["run_id"]) if row else ""


def _sample_run_state(
    db_path: str | Path,
    project_id: str,
    run_id: str,
) -> dict[str, Any] | None:
    with _connect(db_path) as connection:
        run = connection.execute(
            """
            SELECT * FROM sample_runs
            WHERE project_id = ? AND run_id = ?
            """,
            (project_id, run_id),
        ).fetchone()
        if not run:
            return None
        counts = {
            row["status"]: int(row["count"])
            for row in connection.execute(
                """
                SELECT status, COUNT(*) AS count
                FROM sample_tasks WHERE run_id = ? GROUP BY status
                """,
                (run_id,),
            ).fetchall()
        }
        task_count = sum(counts.values())
        sample_count = int(
            connection.execute(
                """
                SELECT COUNT(DISTINCT task_id)
                FROM samples
                WHERE project_id = ? AND run_id = ? AND sample_type = 'real'
                  AND LENGTH(TRIM(COALESCE(answer_text, ''))) > 0
                """,
                (project_id, run_id),
            ).fetchone()[0]
        )
        return {
            **dict(run),
            "task_count": task_count,
            "queued_count": counts.get("queued", 0),
            "running_count": counts.get("running", 0),
            "success_count": counts.get("success", 0),
            "failed_count": counts.get("failed", 0),
            "sample_count": sample_count,
        }


def _sample_ids_for_run(
    db_path: str | Path,
    project_id: str,
    run_id: str,
) -> list[str]:
    with _connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT s.sample_id, s.task_id, s.collected_at
            FROM samples s
            JOIN sample_tasks st
              ON st.run_id = s.run_id AND st.task_id = s.task_id
            WHERE s.project_id = ? AND s.run_id = ? AND s.sample_type = 'real'
              AND LENGTH(TRIM(COALESCE(s.answer_text, ''))) > 0
            ORDER BY st.created_at, st.task_id, s.collected_at DESC, s.sample_id DESC
            """,
            (project_id, run_id),
        ).fetchall()
    seen_tasks: set[str] = set()
    sample_ids: list[str] = []
    for row in rows:
        if row["task_id"] in seen_tasks:
            continue
        seen_tasks.add(row["task_id"])
        sample_ids.append(str(row["sample_id"]))
    return sample_ids


def _has_completed_project_run(db_path: str | Path, project_id: str) -> bool:
    with _connect(db_path) as connection:
        return bool(
            connection.execute(
                """
                SELECT 1 FROM sample_runs
                WHERE project_id = ? AND is_mock = 0 AND status = 'completed'
                LIMIT 1
                """,
                (project_id,),
            ).fetchone()
        )


def _find_analysis_version_by_automation(
    db_path: str | Path,
    project_id: str,
    automation_run_id: str,
) -> str:
    with _connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT analysis_version_id, llm_meta_json
            FROM analysis_result_versions
            WHERE project_id = ?
            ORDER BY version_no DESC
            """,
            (project_id,),
        ).fetchall()
    for row in rows:
        meta = _json_load(row["llm_meta_json"], {})
        if str(meta.get("automation_run_id") or "") == automation_run_id:
            return str(row["analysis_version_id"])
    return ""


def _find_report_draft_by_automation(
    db_path: str | Path,
    project_id: str,
    automation_run_id: str,
) -> str:
    with _connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT draft_id, source_snapshot_json
            FROM report_drafts
            WHERE project_id = ?
            ORDER BY created_at DESC
            """,
            (project_id,),
        ).fetchall()
    for row in rows:
        snapshot = _json_load(row["source_snapshot_json"], {})
        if str(snapshot.get("automation_run_id") or "") == automation_run_id:
            return str(row["draft_id"])
    return ""


def _percent(value: Any) -> str:
    number = float(value or 0)
    if number <= 1:
        number *= 100
    return f"{round(number)}%"


def _truncate(value: Any, maximum: int = 520) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text if len(text) <= maximum else text[: maximum - 1].rstrip() + "…"


def _citation_rows(value: Any) -> list[dict[str, str]]:
    rows = value if isinstance(value, list) else []
    result: list[dict[str, str]] = []
    for item in rows[:8]:
        if isinstance(item, str):
            result.append(
                {
                    "title": item,
                    "url": item if item.startswith("http") else "",
                    "snippet": "",
                }
            )
        elif isinstance(item, dict):
            result.append(
                {
                    "title": str(
                        item.get("title")
                        or item.get("name")
                        or item.get("url")
                        or item.get("source")
                        or "公开来源"
                    ),
                    "url": str(item.get("url") or item.get("source_url") or ""),
                    "snippet": str(item.get("snippet") or item.get("summary") or ""),
                }
            )
    return [row for row in result if row["title"] or row["url"]]


def _evidence_markdown(
    rows: list[dict[str, Any]],
    empty_text: str = "当前没有可展示的代表证据。",
    include_raw_citations: bool = False,
) -> str:
    if not rows:
        return f"- {empty_text}"
    blocks: list[str] = []
    for item in rows:
        status = (
            ("品牌已出现" if item["brandMentioned"] else "品牌未出现")
            + "；"
            + ("已进入推荐" if item["brandRecommended"] else "未进入推荐")
        )
        lines = [
            f"### {item['questionId']} · {item['question']}",
            "",
            item["answerExcerpt"] or "当前回答没有可展示的正文片段。",
            "",
            f"- 判断：{status}",
        ]
        if item["competitors"]:
            lines.append("- 竞品/替代对象：" + "、".join(item["competitors"]))
        confirmed = [
            source for source in item.get("verifiedSources", []) if source.get("selected", True)
        ]
        if confirmed:
            source_text = []
            for source in confirmed:
                if str(source.get("url") or "").startswith("http"):
                    source_text.append(f"{source['title']}（{source['url']}）")
                else:
                    suffix = (
                        f" · {source['sourceLocation']}"
                        if source.get("sourceLocation")
                        else ""
                    )
                    source_text.append(f"{source['title']}{suffix}")
            lines.append("- 已确认信源：" + "；".join(source_text))
        if include_raw_citations and item.get("citations"):
            lines.append(
                "- AI 原始引用（未经独立核验）："
                + "；".join(
                    f"{source['title']}（{source['url']}）"
                    if source.get("url")
                    else source["title"]
                    for source in item["citations"]
                )
            )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _report_markdown(model: dict[str, Any]) -> str:
    sections = {row["id"]: row["markdown"] for row in model.get("sections", [])}

    def body(section_id: str) -> str:
        text = str(sections.get(section_id) or "")
        return re.sub(r"^##\s+\d+\.\s+[^\n]+\n*", "", text).strip()

    return "\n\n".join(
        [
            f"# {model['title']}",
            f"## 1. 本期结论与核心指标\n\n{body('conclusion')}\n\n### 核心可见度指标\n\n{body('metrics')}",
            f"## 2. 四场景可见度诊断\n\n{body('scenes')}",
            f"## 3. 关键问题与回答证据\n\n{body('evidence')}",
            f"## 4. 不可见或被压制的原因\n\n{body('causes')}",
            f"## 5. 内容资产行动方案\n\n{body('actions')}",
            f"## 6. 复测与验收标准\n\n{body('retest')}",
            f"## 附录：全量异常证据与方法说明\n\n{body('appendix')}",
        ]
    )


def _monitoring_period_from_snapshot(
    run: sqlite3.Row,
    snapshot: sqlite3.Row,
) -> dict[str, Any]:
    metrics = _json_load(snapshot["metrics_json"], {})
    total = int(
        metrics.get("analyzed_count")
        or snapshot["success_count"]
        or snapshot["total_tasks"]
        or 0
    )
    mentions = int(snapshot["brand_mentions"] or metrics.get("brand_mentions") or 0)
    recommendations = int(
        snapshot["brand_recommendations"]
        or metrics.get("brand_recommendations")
        or 0
    )
    competitors = int(
        snapshot["competitor_mentions"] or metrics.get("competitor_mentions") or 0
    )
    high_risk = int(
        snapshot["high_risk_samples"] or metrics.get("high_risk_samples") or 0
    )
    mention_rate = metrics.get("brand_mention_rate")
    recommendation_rate = metrics.get("brand_recommendation_rate")
    return {
        "run_id": run["run_id"],
        "completed_at": run["completed_at"] or snapshot["updated_at"],
        "total_samples": total,
        "brand_mentions": mentions,
        "brand_recommendations": recommendations,
        "basic_visibility_rate": float(
            mention_rate if mention_rate is not None else (mentions / total if total else 0)
        ),
        "strong_visibility_rate": float(
            recommendation_rate
            if recommendation_rate is not None
            else (recommendations / total if total else 0)
        ),
        "missing_count": max(total - mentions, 0),
        "competitor_pressure_count": competitors,
        "high_risk_samples": high_risk,
        "planned_question_ids": sorted(
            str(item)
            for item in (metrics.get("planned_question_ids") or [])
            if str(item)
        ),
        "sampled_question_ids": sorted(
            str(item)
            for item in (metrics.get("sampled_question_ids") or [])
            if str(item)
        ),
    }


def _period_comparison(current: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any]:
    if not previous:
        return {
            "comparable": False,
            "code": "no_previous_period",
            "reason": "当前还没有可比较的上期数据。",
        }
    current_planned = current.get("planned_question_ids") or []
    previous_planned = previous.get("planned_question_ids") or []
    if not current_planned or not previous_planned:
        return {
            "comparable": False,
            "code": "scope_unavailable",
            "reason": "历史快照缺少问题范围，不能形成可靠环比。",
        }
    if current_planned != previous_planned:
        return {
            "comparable": False,
            "code": "scope_changed",
            "reason": "本期与上期的监测问题范围不同，暂不计算环比。",
        }
    if (
        current.get("sampled_question_ids") != current_planned
        or previous.get("sampled_question_ids") != previous_planned
    ):
        return {
            "comparable": False,
            "code": "incomplete_samples",
            "reason": "本期或上期存在未完成、缺失的同题样本，暂不计算环比。",
        }
    return {
        "comparable": True,
        "code": "same_question_scope",
        "reason": "本期与上期使用相同问题范围且样本完整，可以进行环比。",
        "question_count": len(current_planned),
    }


def build_automation_report_model(
    db_path: str | Path,
    project_id: str,
    source_run_id: str,
    automation_run_id: str,
    analysis_version_id: str,
    question_scope_hash: str,
    context_hash: str,
) -> dict[str, Any]:
    with _connect(db_path) as connection:
        project_row = connection.execute(
            """
            SELECT p.*, c.name AS customer_name
            FROM projects p JOIN customers c ON c.customer_id = p.customer_id
            WHERE p.project_id = ?
            """,
            (project_id,),
        ).fetchone()
        if not project_row:
            raise ValueError("项目不存在")
        current_run = connection.execute(
            "SELECT * FROM sample_runs WHERE project_id = ? AND run_id = ?",
            (project_id, source_run_id),
        ).fetchone()
        current_snapshot = connection.execute(
            """
            SELECT * FROM sampling_run_snapshots
            WHERE project_id = ? AND run_id = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (project_id, source_run_id),
        ).fetchone()
        if not current_run or not current_snapshot:
            raise ValueError("当前采样批次尚未生成完整快照")
        current_period = _monitoring_period_from_snapshot(current_run, current_snapshot)
        history_rows = connection.execute(
            """
            SELECT sr.run_id
            FROM sample_runs sr
            JOIN sampling_run_snapshots ss
              ON ss.project_id = sr.project_id AND ss.run_id = sr.run_id
            WHERE sr.project_id = ? AND sr.run_id <> ? AND sr.status = 'completed'
              AND sr.is_mock = 0
              AND COALESCE(NULLIF(sr.completed_at, ''), sr.created_at)
                  < COALESCE(NULLIF(?, ''), ?)
            GROUP BY sr.run_id
            ORDER BY COALESCE(NULLIF(sr.completed_at, ''), sr.created_at) DESC
            """,
            (
                project_id,
                source_run_id,
                current_run["completed_at"],
                current_run["created_at"],
            ),
        ).fetchall()
        previous_period = None
        comparison = _period_comparison(current_period, None)
        for history_row in history_rows:
            prior_run = connection.execute(
                "SELECT * FROM sample_runs WHERE run_id = ?",
                (history_row["run_id"],),
            ).fetchone()
            prior_snapshot = connection.execute(
                """
                SELECT * FROM sampling_run_snapshots
                WHERE project_id = ? AND run_id = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (project_id, history_row["run_id"]),
            ).fetchone()
            if not prior_run or not prior_snapshot:
                continue
            candidate = _monitoring_period_from_snapshot(prior_run, prior_snapshot)
            candidate_comparison = _period_comparison(current_period, candidate)
            if candidate_comparison["comparable"]:
                previous_period = candidate
                comparison = candidate_comparison
                break

        sample_rows = connection.execute(
            """
            SELECT s.*, q.question, q.category, q.intent,
                   pq.generation_focus, pq.generation_focus_label,
                   ar.analysis_id, ar.brand_mentioned, ar.brand_recommended,
                   ar.risk_level, ar.competitors_json, ar.recommended_fix,
                   ar.unverified_claims_json, ar.high_risk_json
            FROM samples s
            JOIN question_pool q ON q.question_id = s.question_id
            JOIN project_questions pq
              ON pq.project_id = s.project_id AND pq.question_id = s.question_id
            JOIN analysis_results ar
              ON ar.project_id = s.project_id AND ar.question_id = s.question_id
             AND ar.sample_id = s.sample_id
            WHERE s.project_id = ? AND s.run_id = ? AND s.sample_type = 'real'
            ORDER BY s.question_id
            """,
            (project_id, source_run_id),
        ).fetchall()
        if len(sample_rows) != 40:
            raise ValueError(f"报告范围必须包含 40 条正式分析，当前为 {len(sample_rows)} 条")
        confirmed_sources = connection.execute(
            """
            SELECT * FROM source_evidence
            WHERE project_id = ? AND verification_status = 'confirmed'
              AND relation <> 'contradicts'
            ORDER BY question_id, created_at
            """,
            (project_id,),
        ).fetchall()
        approved_actions = connection.execute(
            """
            SELECT at.*, r.approval_status, r.action, r.implementation_plan_json
            FROM action_tasks at
            JOIN recommendations r ON r.recommendation_id = at.recommendation_id
            WHERE at.project_id = ? AND r.approval_status = 'approved'
            ORDER BY CASE at.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
                     at.created_at
            LIMIT 8
            """,
            (project_id,),
        ).fetchall()

    source_by_question: dict[str, list[dict[str, Any]]] = {}
    for row in confirmed_sources:
        item = dict(row)
        source_by_question.setdefault(str(item.get("question_id") or ""), []).append(item)
    evidence_rows: list[dict[str, Any]] = []
    for row in sample_rows:
        item = dict(row)
        scene_code = _normal_scene(item.get("generation_focus"))
        if scene_code not in SCENE_BY_CODE:
            continue
        sample_id = str(item.get("sample_id") or "")
        sources = []
        for source in source_by_question.get(str(item["question_id"]), []):
            if source.get("sample_id") and str(source.get("sample_id")) != sample_id:
                continue
            sources.append(
                {
                    "id": str(source.get("source_evidence_id") or ""),
                    "title": str(source.get("title") or source.get("domain") or "已确认来源"),
                    "url": str(source.get("url") or ""),
                    "domain": str(source.get("domain") or "客户资料"),
                    "sourceType": str(source.get("source_type") or "community_other"),
                    "sourceTypeLabel": str(source.get("source_type") or "其他来源"),
                    "origin": str(source.get("origin") or "independent_web"),
                    "originLabel": str(source.get("origin") or "已确认来源"),
                    "relation": str(source.get("relation") or "context"),
                    "relationLabel": str(source.get("relation") or "背景信息"),
                    "excerpt": str(source.get("excerpt") or ""),
                    "sourceLocation": str(source.get("source_location") or ""),
                    "retrievedAt": str(source.get("retrieved_at") or source.get("created_at") or ""),
                    "selected": True,
                }
            )
        evidence_rows.append(
            {
                "id": str(item.get("analysis_id") or item.get("sample_id") or item["question_id"]),
                "questionId": str(item["question_id"]),
                "question": str(item.get("question") or item["question_id"]),
                "sceneId": scene_code,
                "sceneLabel": SCENE_BY_CODE[scene_code]["label"],
                "answerExcerpt": _truncate(item.get("answer_text"), 520),
                "brandMentioned": bool(item.get("brand_mentioned")),
                "brandRecommended": bool(item.get("brand_recommended")),
                "competitors": [
                    str(value)
                    for value in _json_load(item.get("competitors_json"), [])
                    if str(value)
                ],
                "citations": _citation_rows(_json_load(item.get("citations_json"), [])),
                "verifiedSources": sources,
                "recommendedFix": str(item.get("recommended_fix") or ""),
                "riskLevel": str(item.get("risk_level") or ""),
            }
        )
    evidence_rows.sort(key=lambda item: item["questionId"])
    anomalies = [
        item
        for item in evidence_rows
        if not item["brandMentioned"] or item["competitors"] or "高" in item["riskLevel"]
    ]
    selected_evidence: list[dict[str, Any]] = []
    for code, _label, _target, _core, _tail in SCENES:
        scene_rows = [item for item in evidence_rows if item["sceneId"] == code]
        preferred = [
            *[
                item
                for item in scene_rows
                if not item["brandMentioned"] or item["competitors"]
            ],
            *[
                item
                for item in scene_rows
                if item["brandMentioned"] and not item["competitors"]
            ],
        ]
        for item in preferred:
            if len([row for row in selected_evidence if row["sceneId"] == code]) >= 5:
                break
            if item["id"] not in {row["id"] for row in selected_evidence}:
                selected_evidence.append(item)

    scenes = []
    for code, label, _target, _core, _tail in SCENES:
        rows = [item for item in evidence_rows if item["sceneId"] == code]
        scenes.append(
            {
                "id": code,
                "label": label,
                "sampleCount": len(rows),
                "mentionRate": (
                    sum(1 for item in rows if item["brandMentioned"]) / len(rows)
                    if rows
                    else 0
                ),
                "recommendationRate": (
                    sum(1 for item in rows if item["brandRecommended"]) / len(rows)
                    if rows
                    else 0
                ),
                "evidenceCount": len(
                    [item for item in selected_evidence if item["sceneId"] == code]
                ),
            }
        )
    actions = []
    for row in approved_actions:
        item = dict(row)
        actions.append(
            {
                "id": str(item.get("action_task_id") or item.get("title") or ""),
                "title": str(item.get("title") or "待办行动"),
                "action": str(item.get("action") or item.get("done_definition") or "补充内容资产"),
                "acceptance": str(
                    item.get("done_definition")
                    or "内容上线并完成人工验收后执行同题复测"
                ),
                "priority": str(item.get("priority") or "P1"),
            }
        )
    total = len(evidence_rows)
    mentions = sum(1 for item in evidence_rows if item["brandMentioned"])
    recommendations = sum(1 for item in evidence_rows if item["brandRecommended"])
    missing = total - mentions
    pressure = sum(1 for item in evidence_rows if item["competitors"])
    high_risk = sum(1 for item in evidence_rows if "高" in item["riskLevel"])
    mention_rate = mentions / total if total else 0
    recommendation_rate = recommendations / total if total else 0
    metrics = {
        "total_samples": total,
        "brand_mention_rate": mention_rate,
        "brand_recommendation_rate": recommendation_rate,
        "missing_count": missing,
        "competitor_pressure_count": pressure,
        "high_risk_count": high_risk,
    }
    report_type = "weekly" if comparison["comparable"] else "client"
    customer_name = str(project_row["customer_name"] or "客户")
    title = (
        f"{customer_name} GEO 可见度周期报告"
        if report_type == "weekly"
        else f"{customer_name} GEO 可见度诊断报告"
    )
    type_label = "周期跟踪报告" if report_type == "weekly" else "首次诊断报告"
    if report_type == "weekly" and previous_period:
        mention_delta = round(
            (mention_rate - float(previous_period["basic_visibility_rate"])) * 100
        )
        recommendation_delta = round(
            (
                recommendation_rate
                - float(previous_period["strong_visibility_rate"])
            )
            * 100
        )
        executive_summary = (
            f"本期基于 {total} 条同题真实样本：品牌出现率 {_percent(mention_rate)}，"
            f"推荐进入率 {_percent(recommendation_rate)}；较上期分别变化 "
            f"{mention_delta:+d} 和 {recommendation_delta:+d} 个百分点。"
        )
    else:
        executive_summary = (
            f"本期基于 {total} 条真实样本：品牌出现率 {_percent(mention_rate)}，"
            f"推荐进入率 {_percent(recommendation_rate)}；{missing} 个问题未出现品牌，"
            f"{pressure} 个样本出现竞品或替代对象。"
        )
    scene_markdown = "\n\n".join(
        [
            f"### {scene['label']}\n\n"
            f"- 样本：{scene['sampleCount']} 条\n"
            f"- 品牌出现率：{_percent(scene['mentionRate'])}\n"
            f"- 推荐进入率：{_percent(scene['recommendationRate'])}\n"
            f"- 正文证据：{scene['evidenceCount']} 条"
            for scene in scenes
        ]
    )
    fixes = []
    for item in anomalies:
        value = str(item.get("recommendedFix") or "").strip()
        if value and value not in fixes:
            fixes.append(value)
    causes_markdown = "\n".join(
        [
            f"- 未出现品牌的问题：{missing} 条，说明部分真实需求中尚未进入回答候选。",
            f"- 竞品或替代对象压制：{pressure} 条，需要补充更清晰的品类、案例和服务证据。",
            f"- 高风险样本：{high_risk} 条，需要复核事实边界和禁用表述。",
            *[f"- 分析建议：{value}" for value in fixes[:5]],
        ]
    )
    if report_type == "weekly" and previous_period:
        causes_markdown += (
            "\n\n### 环比范围\n\n"
            f"- {comparison['reason']}\n"
            f"- 上期批次：{previous_period['run_id']}\n"
            f"- 本期批次：{source_run_id}"
        )
    if actions:
        action_markdown = "\n".join(
            [
                f"{index}. **{item['title']}**（{item['priority']}）\n"
                f"   - 建设内容：{item['action']}\n"
                f"   - 完成标准：{item['acceptance']}"
                for index, item in enumerate(actions, start=1)
            ]
        )
    else:
        action_markdown = (
            "1. 当前没有已人工批准的正式行动任务；本报告中的 AI 行动建议仍需人工审核后执行。"
        )
    retest_markdown = "\n".join(
        [
            "- 内容发布后使用本期 40 道原题进行同题复测。",
            "- 复测必须保持平台、问题文本和采样方式一致。",
            "- 验收品牌出现率、推荐进入率、未出现问题和竞品压制变化。",
            "- 单条偶然回答不作为优化完成依据。",
        ]
    )
    appendix_markdown = (
        _evidence_markdown(
            anomalies,
            "本期没有需要展开的异常样本。",
            include_raw_citations=True,
        )
        + "\n\n### 方法与边界\n\n"
        "- 正文只使用人工已确认的公开信源或明确标注的客户资料。\n"
        "- AI 原始引用未经独立核验时只保留在附录，不作为事实背书。\n"
        "- 本报告不代表平台私有排序算法，变化必须通过同题复测确认。"
    )
    sections = [
        {
            "id": "conclusion",
            "title": "本期诊断结论",
            "markdown": f"## 1. 本期诊断结论\n\n{executive_summary}",
            "editable": True,
        },
        {
            "id": "metrics",
            "title": "核心可见度指标",
            "markdown": (
                "## 2. 核心可见度指标\n\n"
                f"- 真实样本：{total} 条\n"
                f"- 品牌出现率：{_percent(mention_rate)}\n"
                f"- 推荐进入率：{_percent(recommendation_rate)}\n"
                f"- 未出现问题：{missing} 条\n"
                f"- 竞品压制：{pressure} 条\n"
                f"- 高风险样本：{high_risk} 条"
            ),
            "editable": False,
        },
        {
            "id": "scenes",
            "title": "四场景诊断",
            "markdown": f"## 3. 四场景诊断\n\n{scene_markdown}",
            "editable": False,
        },
        {
            "id": "evidence",
            "title": "问题与回答证据",
            "markdown": f"## 4. 问题与回答证据\n\n{_evidence_markdown(selected_evidence)}",
            "editable": False,
        },
        {
            "id": "causes",
            "title": "不可见或被压制的原因",
            "markdown": f"## 5. 不可见或被压制的原因\n\n{causes_markdown}",
            "editable": True,
        },
        {
            "id": "actions",
            "title": "内容资产行动方案",
            "markdown": f"## 6. 内容资产行动方案\n\n{action_markdown}",
            "editable": True,
        },
        {
            "id": "retest",
            "title": "复测与验收标准",
            "markdown": f"## 7. 复测与验收标准\n\n{retest_markdown}",
            "editable": True,
        },
        {
            "id": "appendix",
            "title": "全量异常证据及方法附录",
            "markdown": f"## 8. 全量异常证据及方法附录\n\n{appendix_markdown}",
            "editable": False,
        },
    ]
    original_sections = {section["id"]: section["markdown"] for section in sections}
    source_snapshot = {
        "generated_at": now_iso(),
        "automation_run_id": automation_run_id,
        "analysis_version_id": analysis_version_id,
        "run_id": source_run_id,
        "comparison_run_id": previous_period["run_id"] if previous_period else "",
        "question_scope_hash": question_scope_hash,
        "context_hash": context_hash,
        "planned_question_ids": current_period["planned_question_ids"],
        "sampled_question_ids": current_period["sampled_question_ids"],
        "comparison": comparison,
    }
    return {
        "schemaVersion": 3,
        "reportType": report_type,
        "title": title,
        "typeLabel": type_label,
        "executiveSummary": executive_summary,
        "metrics": metrics,
        "sections": sections,
        "originalSections": original_sections,
        "scenes": scenes,
        "evidence": selected_evidence,
        "allEvidence": evidence_rows,
        "allAnomalies": anomalies,
        "actions": actions,
        "sourceSnapshot": source_snapshot,
    }


def apply_report_polish(
    model: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    patched = json.loads(json.dumps(model, ensure_ascii=False))
    sections = {item["id"]: item for item in patched.get("sections", [])}
    findings = "\n".join(f"- {item}" for item in result.get("key_findings", []))
    actions = "\n".join(
        f"{index}. {item}"
        for index, item in enumerate(result.get("next_actions", []), start=1)
    )
    caveats = "\n".join(f"- {item}" for item in result.get("caveats", []))
    if "conclusion" in sections:
        sections["conclusion"]["markdown"] = (
            "## 1. 本期诊断结论\n\n"
            + str(result.get("executive_summary") or patched.get("executiveSummary") or "")
            + (f"\n\n### 关键发现\n\n{findings}" if findings else "")
        )
        patched["executiveSummary"] = str(
            result.get("executive_summary") or patched.get("executiveSummary") or ""
        )
    if "causes" in sections and result.get("recommendation_summary"):
        sections["causes"]["markdown"] += (
            "\n\n### 诊断解释\n\n" + str(result["recommendation_summary"])
        )
    if "actions" in sections and actions:
        sections["actions"]["markdown"] += "\n\n### 优先执行顺序\n\n" + actions
    if "retest" in sections and caveats:
        sections["retest"]["markdown"] += "\n\n### 数据边界与注意事项\n\n" + caveats
    return patched


class AutomationPipelineLoop(threading.Thread):
    """Advance one persisted automation stage per tick."""

    def __init__(
        self,
        db_path: str | Path,
        callbacks: dict[str, Callable[..., Any]],
        *,
        tick_seconds: Any = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ):
        super().__init__(name="geo-automation-pipeline", daemon=True)
        self.db_path = Path(db_path)
        self.callbacks = dict(callbacks)
        self.tick_seconds = configured_tick_seconds(tick_seconds)
        self.lease_seconds = max(60, int(lease_seconds))
        self._stop_event = threading.Event()
        ensure_automation_database(self.db_path)

    def stop(self) -> None:
        self._stop_event.set()

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.tick()
            except Exception:
                # Per-run errors are persisted by tick.  A coordinator failure
                # must not stop the sampling executor or HTTP server.
                pass
            self._stop_event.wait(self.tick_seconds)

    def tick(self) -> dict[str, Any]:
        claimed = _claim_next_run(self.db_path, lease_seconds=self.lease_seconds)
        if not claimed:
            return {"ok": True, "advanced": False}
        run, token = claimed
        try:
            self._advance(run)
            return {
                "ok": True,
                "advanced": True,
                "automation_run_id": run["automation_run_id"],
            }
        except AutomationClaimLost:
            return {
                "ok": True,
                "advanced": False,
                "automation_run_id": run["automation_run_id"],
                "skipped": "claim_lost",
            }
        except Exception as exc:
            current = _run_row(self.db_path, run["automation_run_id"]) or run
            if (
                current.get("status") not in TERMINAL_STATUSES | {"needs_attention"}
                and str(current.get("lease_token") or "") == token
            ):
                try:
                    _mark_attention(
                        self.db_path,
                        run,
                        "stage_error",
                        str(exc),
                    )
                except AutomationClaimLost:
                    pass
            return {
                "ok": False,
                "advanced": False,
                "automation_run_id": run["automation_run_id"],
                "error": str(exc),
            }
        finally:
            _release_lease(self.db_path, run["automation_run_id"], token)

    def _runtime_status(self) -> dict[str, Any]:
        callback = self.callbacks.get("runtime_status")
        return _normalized_readiness(callback() if callback else {})

    def _release_handoff_safely(self, run: dict[str, Any], sample_run_id: str) -> None:
        release = self.callbacks.get("release_handoff")
        if not release or not sample_run_id:
            return
        try:
            release(run["project_id"], sample_run_id)
        except Exception:
            pass

    def _handoff_claimed(self, run: dict[str, Any], sample_run_id: str) -> bool:
        current = _assert_active_claim(self.db_path, run)
        if not self._verify_context(current):
            return False
        try:
            self.callbacks["handoff"](
                current["project_id"],
                sample_run_id,
                handed_off_by=f"automation:{current['automation_run_id']}",
            )
            current = _assert_active_claim(self.db_path, current)
            if not self._verify_context(current):
                return False
            return True
        except Exception:
            self._release_handoff_safely(current, sample_run_id)
            raise

    def _verify_context(self, run: dict[str, Any]) -> bool:
        preview = _current_preview(self.db_path, run, self._runtime_status())
        if (
            preview.get("question_scope_hash") == run.get("question_scope_hash")
            and preview.get("context_hash") == run.get("context_hash")
        ):
            return True
        release = self.callbacks.get("release_handoff")
        if release and run.get("sample_run_id"):
            release(run["project_id"], run["sample_run_id"])
        _mark_attention(
            self.db_path,
            run,
            "context_drift",
            "题库或已确认事实与启动快照不一致，自动流程已暂停。",
        )
        return False

    def _advance(self, run: dict[str, Any]) -> None:
        stage = str(run.get("current_stage") or "queued")
        if stage == "queued":
            self._stage_create_sampling(run)
        elif stage in {"sampling", "sampling_retry"}:
            self._stage_sampling(run)
        elif stage == "llm_analysis":
            self._stage_llm_analysis(run)
        elif stage == "llm_confirm":
            self._stage_llm_confirm(run)
        elif stage == "report_build":
            self._stage_report_build(run)
        elif stage == "report_polish":
            self._stage_report_polish(run)
        elif stage == "ready_for_publish":
            return
        else:
            raise ValueError(f"未知自动流程阶段：{stage}")

    def _stage_create_sampling(self, run: dict[str, Any]) -> None:
        if not self._verify_context(run):
            return
        runtime = self._runtime_status()
        if not runtime["ark_api_key_set"]:
            _mark_attention(
                self.db_path,
                run,
                "ark_api_key_missing",
                "火山方舟 API Key 未配置，尚未创建采样批次。",
            )
            return
        if not runtime["llm_configured"]:
            _mark_attention(
                self.db_path,
                run,
                "llm_config_missing",
                "LLM 配置未完成，尚未创建采样批次。",
            )
            return
        if runtime["executor_paused"]:
            _mark_attention(
                self.db_path,
                run,
                "executor_paused",
                "服务端采样执行器处于全局暂停状态。",
            )
            return
        sample_run_id = str(run.get("sample_run_id") or "")
        if not sample_run_id:
            sample_run_id = _find_named_sample_run(
                self.db_path,
                run["project_id"],
                run["automation_run_id"],
            )
        if not sample_run_id:
            create_batch = self.callbacks.get("create_automation_sampling_batch")
            purpose = None
            if create_batch is None:
                # Backward-compatible callback fallback for embedded/test users.
                # Production supplies the dedicated internal automation creator,
                # which preserves the public formal-retest guard.
                create_batch = self.callbacks["create_sampling_batch"]
                purpose = (
                    "retest"
                    if _has_completed_project_run(self.db_path, run["project_id"])
                    else "baseline"
                )
            run = _assert_active_claim(self.db_path, run)
            if not self._verify_context(run):
                return
            request_payload = {
                "name": f"自动监测 · {run['automation_run_id']}",
                "scope": "manual",
                "question_ids": _decode_json_column(
                    run, "selected_question_ids_json", []
                ),
            }
            if purpose:
                request_payload["purpose"] = purpose
            response = create_batch(
                run["project_id"],
                request_payload,
            )
            sample_run_id = str((response.get("run") or {}).get("run_id") or "")
            if not sample_run_id:
                raise ValueError("创建自动采样批次后未返回 run_id")
            current = _assert_active_claim(self.db_path, run)
            if not self._verify_context(current):
                return
            run = current
        current = _update_stage(
            self.db_path,
            run,
            "sampling",
            fields={"sample_run_id": sample_run_id},
            message="精确 40 题采样批次已创建并登记服务端接管。",
        )
        self._handoff_claimed(current, sample_run_id)

    def _stage_sampling(self, run: dict[str, Any]) -> None:
        if not self._verify_context(run):
            return
        sample_run_id = str(run.get("sample_run_id") or "")
        state = _sample_run_state(
            self.db_path, run["project_id"], sample_run_id
        )
        if not state:
            raise ValueError("自动流程关联的采样批次不存在")
        runtime = self._runtime_status()
        if state["status"] == "executor_blocked":
            _mark_attention(
                self.db_path,
                run,
                "executor_blocked",
                "采样执行器已熔断，等待人工检查后恢复。",
            )
            return
        if state["queued_count"] or state["running_count"]:
            if runtime["executor_paused"]:
                self.callbacks.get("release_handoff", lambda *_args: None)(
                    run["project_id"], sample_run_id
                )
                _mark_attention(
                    self.db_path,
                    run,
                    "executor_paused",
                    "服务端采样执行器已全局暂停，剩余任务不会继续派发。",
                )
                return
            if not runtime["ark_api_key_set"]:
                self.callbacks.get("release_handoff", lambda *_args: None)(
                    run["project_id"], sample_run_id
                )
                _mark_attention(
                    self.db_path,
                    run,
                    "ark_api_key_missing",
                    "火山方舟 API Key 不可用，剩余任务已暂停。",
                )
                return
            if (
                not state["running_count"]
                and runtime["daily_budget_remaining"] < state["queued_count"]
            ):
                self.callbacks.get("release_handoff", lambda *_args: None)(
                    run["project_id"], sample_run_id
                )
                _mark_attention(
                    self.db_path,
                    run,
                    "daily_budget_insufficient",
                    (
                        "今日剩余采样预算不足以完成当前批次："
                        f"剩余预算 {runtime['daily_budget_remaining']}，"
                        f"待执行 {state['queued_count']}。"
                    ),
                )
            return
        if state["failed_count"]:
            automatic_rounds = int(run.get("sample_retry_rounds") or 0)
            manual_credits = int(run.get("manual_retry_credits") or 0)
            if automatic_rounds >= MAX_AUTOMATIC_SAMPLE_RETRIES and manual_credits <= 0:
                _mark_attention(
                    self.db_path,
                    run,
                    "sampling_incomplete",
                    (
                        f"采样在 {MAX_AUTOMATIC_SAMPLE_RETRIES} 轮自动补采后仍有 "
                        f"{state['failed_count']} 题失败，未进入分析。"
                    ),
                    metadata={"failed_count": state["failed_count"]},
                )
                return
            updates: dict[str, Any] = {}
            retry_kind = "automatic"
            if automatic_rounds < MAX_AUTOMATIC_SAMPLE_RETRIES:
                updates["sample_retry_rounds"] = automatic_rounds + 1
            else:
                retry_kind = "manual"
                updates["manual_retry_credits"] = max(0, manual_credits - 1)
            current = _update_stage(
                self.db_path,
                run,
                "sampling_retry",
                fields=updates,
                event_type="sampling_retry",
                message=(
                    "失败题将在原批次重新排队，"
                    + ("执行自动补采。" if retry_kind == "automatic" else "执行人工确认的恢复尝试。")
                ),
            )
            self.callbacks["retry_failed"](
                run["project_id"], {"run_id": sample_run_id}
            )
            current = _assert_active_claim(self.db_path, current)
            if not self._verify_context(current):
                return
            self._handoff_claimed(current, sample_run_id)
            return
        if (
            state["task_count"] != 40
            or state["success_count"] != 40
            or state["sample_count"] != 40
        ):
            _mark_attention(
                self.db_path,
                run,
                "sampling_scope_incomplete",
                (
                    "采样批次终结但范围不完整："
                    f"任务 {state['task_count']}、成功 {state['success_count']}、"
                    f"有效样本 {state['sample_count']}。"
                ),
            )
            return
        _update_stage(
            self.db_path,
            run,
            "llm_analysis",
            message="40 题真实采样已完整结束，开始全量 LLM 复核。",
        )

    def _stage_llm_analysis(self, run: dict[str, Any]) -> None:
        if not self._verify_context(run):
            return
        runtime = self._runtime_status()
        if not runtime["llm_configured"]:
            _mark_attention(
                self.db_path,
                run,
                "llm_config_missing",
                "LLM 配置不可用，分析阶段已暂停。",
            )
            return
        sample_ids = _sample_ids_for_run(
            self.db_path, run["project_id"], run["sample_run_id"]
        )
        if len(sample_ids) != 40:
            _mark_attention(
                self.db_path,
                run,
                "analysis_sample_scope_incomplete",
                f"分析必须锁定 40 条样本，当前为 {len(sample_ids)} 条。",
            )
            return
        result_text = str(run.get("analysis_result_text") or "").strip()
        execution = _decode_json_column(run, "analysis_execution_json", {})
        llm_meta = _decode_json_column(run, "analysis_llm_meta_json", {})
        if result_text and execution.get("status") == "completed":
            validation = _decode_json_column(run, "analysis_validation_json", {})
            if not validation.get("accepted_for_review"):
                _mark_attention(
                    self.db_path,
                    run,
                    "analysis_validation_failed",
                    "LLM 结果未通过全量格式与覆盖校验。",
                )
                return
            _update_stage(
                self.db_path,
                run,
                "llm_confirm",
                message="LLM 已完整覆盖 40 题并通过校验，进入自动裁决。",
            )
            return

        recoveries = int(run.get("analysis_recovery_count") or 0)
        manual_credits = int(run.get("manual_retry_credits") or 0)
        is_partial_resume = bool(
            result_text and int(execution.get("completed_batches") or 0) > 0
        )
        retry_pending = str(run.get("last_error_code") or "") in {
            "llm_retry_pending",
            "manual_retry_pending",
        }
        manual_attempt = False
        if is_partial_resume:
            if recoveries >= MAX_AUTOMATIC_ANALYSIS_RECOVERIES:
                if manual_credits <= 0:
                    _mark_attention(
                        self.db_path,
                        run,
                        "analysis_incomplete",
                        "LLM 自动恢复后仍未完整覆盖 40 题。",
                    )
                    return
                manual_attempt = True
            else:
                recoveries += 1
                _update_stage(
                    self.db_path,
                    run,
                    "llm_analysis",
                    fields={"analysis_recovery_count": recoveries},
                    event_type="analysis_resume",
                    message="从已落盘的 LLM 部分结果继续剩余批次。",
                )
        elif retry_pending and recoveries >= MAX_AUTOMATIC_ANALYSIS_RECOVERIES:
            if manual_credits > 0:
                manual_attempt = True
            elif str(run.get("last_error_code") or "") != "llm_retry_pending":
                _mark_attention(
                    self.db_path,
                    run,
                    "analysis_incomplete",
                    "LLM 自动恢复机会已用尽。",
                )
                return
        if manual_attempt:
            token = _claim_token(run)
            with _connect(self.db_path) as connection:
                updated = connection.execute(
                    """
                    UPDATE automation_runs
                    SET manual_retry_credits = CASE
                          WHEN manual_retry_credits > 0 THEN manual_retry_credits - 1
                          ELSE 0 END,
                        last_error_code = '', last_error = '', updated_at = ?
                    WHERE automation_run_id = ? AND status = 'running'
                      AND lease_token = ? AND manual_retry_credits > 0
                    """,
                    (now_iso(), run["automation_run_id"], token),
                ).rowcount
                if updated != 1:
                    raise AutomationClaimLost(
                        "自动流程状态、租约或人工恢复额度已变化，分析重试已放弃"
                    )
        payload: dict[str, Any] = {"limit": 40}
        if is_partial_resume:
            payload.update(
                {
                    "resume_result_text": result_text,
                    "resume_execution": execution,
                    "resume_llm_meta": llm_meta,
                }
            )
        run = _assert_active_claim(self.db_path, run)
        if not self._verify_context(run):
            return
        try:
            response = self.callbacks["run_analysis"](
                run["project_id"], payload, sample_ids=sample_ids
            )
        except Exception as exc:
            current = _assert_active_claim(self.db_path, run)
            current_recoveries = int(current.get("analysis_recovery_count") or 0)
            if (
                not manual_attempt
                and current_recoveries < MAX_AUTOMATIC_ANALYSIS_RECOVERIES
            ):
                token = _claim_token(current)
                with _connect(self.db_path) as connection:
                    updated = connection.execute(
                        """
                        UPDATE automation_runs
                        SET analysis_recovery_count = analysis_recovery_count + 1,
                            last_error_code = 'llm_retry_pending',
                            last_error = ?, updated_at = ?
                        WHERE automation_run_id = ? AND status = 'running'
                          AND lease_token = ?
                        """,
                        (
                            str(exc)[:1200],
                            now_iso(),
                            run["automation_run_id"],
                            token,
                        ),
                    ).rowcount
                    if updated != 1:
                        raise AutomationClaimLost(
                            "自动流程状态或租约已变化，分析恢复已放弃"
                        )
                    refreshed = connection.execute(
                        "SELECT * FROM automation_runs WHERE automation_run_id = ?",
                        (run["automation_run_id"],),
                    ).fetchone()
                    _append_event(
                        connection,
                        refreshed,
                        stage="llm_analysis",
                        event_type="analysis_retry_scheduled",
                        status="running",
                        message="LLM 首次执行失败，将使用唯一一次自动恢复机会。",
                    )
                return
            _mark_attention(
                self.db_path,
                current,
                "analysis_call_failed",
                f"LLM 分析执行失败：{exc}",
            )
            return
        current = _assert_active_claim(self.db_path, run)
        if not self._verify_context(current):
            return
        response_execution = response.get("execution") or {}
        response_validation = response.get("validation") or {}
        response_llm = response.get("llm") or {}
        usage = _decode_json_column(current, "usage_json", {})
        usage["analysis"] = response_llm.get("usage") or {}
        token = _claim_token(current)
        with _connect(self.db_path) as connection:
            updated = connection.execute(
                """
                UPDATE automation_runs
                SET analysis_result_text = ?, analysis_validation_json = ?,
                    analysis_execution_json = ?, analysis_llm_meta_json = ?,
                    usage_json = ?, last_error_code = '', last_error = ?,
                    updated_at = ?
                WHERE automation_run_id = ? AND status = 'running'
                  AND lease_token = ?
                """,
                (
                    str(response.get("result_text") or ""),
                    _canonical_json(response_validation),
                    _canonical_json(response_execution),
                    _canonical_json(response_llm),
                    _canonical_json(usage),
                    str(response_execution.get("last_error") or "")[:1200],
                    now_iso(),
                    run["automation_run_id"],
                    token,
                ),
            ).rowcount
            if updated != 1:
                raise AutomationClaimLost(
                    "自动流程状态或租约已变化，分析结果未提交"
                )
            refreshed = connection.execute(
                "SELECT * FROM automation_runs WHERE automation_run_id = ?",
                (run["automation_run_id"],),
            ).fetchone()
            _append_event(
                connection,
                refreshed,
                stage="llm_analysis",
                event_type="analysis_result_saved",
                status="running",
                message=(
                    f"LLM 已完成 {int(response_execution.get('completed_batches') or 0)}/"
                    f"{int(response_llm.get('batch_count') or 0)} 个批次。"
                ),
                metadata={
                    "completed_batches": response_execution.get("completed_batches"),
                    "remaining_batch_count": response_execution.get("remaining_batch_count"),
                },
            )
        if response_execution.get("status") == "completed":
            current = _assert_active_claim(self.db_path, refreshed)
            if response_validation.get("accepted_for_review"):
                _update_stage(
                    self.db_path,
                    current,
                    "llm_confirm",
                    message="LLM 全量结果已落盘并通过校验。",
                )
            else:
                _mark_attention(
                    self.db_path,
                    current,
                    "analysis_validation_failed",
                    "LLM 返回已结束，但格式、覆盖或业务校验未通过。",
                )

    def _stage_llm_confirm(self, run: dict[str, Any]) -> None:
        if not self._verify_context(run):
            return
        version_id = str(run.get("analysis_version_id") or "")
        if not version_id:
            version_id = _find_analysis_version_by_automation(
                self.db_path,
                run["project_id"],
                run["automation_run_id"],
            )
        if version_id:
            _update_stage(
                self.db_path,
                run,
                "report_build",
                fields={"analysis_version_id": version_id},
                message="检测到已落盘的自动分析版本，继续生成报告。",
            )
            return
        validation = _decode_json_column(run, "analysis_validation_json", {})
        if not validation.get("accepted_for_review"):
            _mark_attention(
                self.db_path,
                run,
                "analysis_validation_failed",
                "LLM 结果尚未通过校验，不能自动确认。",
            )
            return
        conflicts = (
            (validation.get("checks") or {}).get("conflicts")
            if isinstance(validation.get("checks"), dict)
            else []
        ) or []
        decisions = [
            {
                "question_id": conflict.get("question_id"),
                "field": conflict.get("field"),
                "rules_value": conflict.get("rules_value"),
                "llm_value": conflict.get("llm_value"),
                "action": "adopt_llm",
            }
            for conflict in conflicts
            if isinstance(conflict, dict)
        ]
        sample_ids = _sample_ids_for_run(
            self.db_path, run["project_id"], run["sample_run_id"]
        )
        llm_meta = _decode_json_column(run, "analysis_llm_meta_json", {})
        llm_meta.update(
            {
                "automation_run_id": run["automation_run_id"],
                "confirmation_mode": "automation_llm_first",
                "human_reviewed": False,
            }
        )
        run = _assert_active_claim(self.db_path, run)
        if not self._verify_context(run):
            return
        response = self.callbacks["confirm_analysis"](
            run["project_id"],
            {
                "limit": 40,
                "result_text": run.get("analysis_result_text") or "",
                "review_decisions": decisions,
                "llm_meta": llm_meta,
                "note": "自动确认·LLM优先",
            },
            sample_ids=sample_ids,
            confirmation_mode="automation_llm_first",
        )
        current = _assert_active_claim(self.db_path, run)
        if not self._verify_context(current):
            return
        version_id = str(
            (response.get("analysis_version") or {}).get("analysis_version_id") or ""
        )
        if not version_id:
            raise ValueError("自动确认未返回 analysis_version_id")
        _update_stage(
            self.db_path,
            current,
            "report_build",
            fields={"analysis_version_id": version_id},
            message=(
                f"已生成“自动确认·LLM优先”分析版本，"
                f"自动裁决 {len(decisions)} 条冲突。"
            ),
        )

    def _stage_report_build(self, run: dict[str, Any]) -> None:
        if not self._verify_context(run):
            return
        model = build_automation_report_model(
            self.db_path,
            run["project_id"],
            run["sample_run_id"],
            run["automation_run_id"],
            run["analysis_version_id"],
            run["question_scope_hash"],
            run["context_hash"],
        )
        _update_stage(
            self.db_path,
            run,
            "report_polish",
            fields={
                "report_model_json": _canonical_json(model),
                "report_type": model["reportType"],
                "comparison_run_id": str(
                    (model.get("sourceSnapshot") or {}).get("comparison_run_id")
                    or ""
                ),
            },
            message="规则报告模型已锁定，开始生成解释性正文。",
        )

    def _stage_report_polish(self, run: dict[str, Any]) -> None:
        if not self._verify_context(run):
            return
        existing_draft_id = str(run.get("report_draft_id") or "")
        if not existing_draft_id:
            existing_draft_id = _find_report_draft_by_automation(
                self.db_path,
                run["project_id"],
                run["automation_run_id"],
            )
        if existing_draft_id:
            self._mark_ready(run, existing_draft_id)
            return
        runtime = self._runtime_status()
        if not runtime["llm_configured"]:
            _mark_attention(
                self.db_path,
                run,
                "llm_config_missing",
                "LLM 配置不可用，报告润色阶段已暂停。",
            )
            return
        model = _decode_json_column(run, "report_model_json", {})
        if not model:
            _update_stage(
                self.db_path,
                run,
                "report_build",
                message="报告模型缺失，返回规则构建阶段。",
            )
            return
        manual_credits = int(run.get("manual_retry_credits") or 0)
        if str(run.get("last_error_code") or "") == "manual_retry_pending" and manual_credits > 0:
            token = _claim_token(run)
            with _connect(self.db_path) as connection:
                updated = connection.execute(
                    """
                    UPDATE automation_runs
                    SET manual_retry_credits = manual_retry_credits - 1,
                        last_error_code = '', last_error = '', updated_at = ?
                    WHERE automation_run_id = ? AND status = 'running'
                      AND lease_token = ? AND manual_retry_credits > 0
                    """,
                    (now_iso(), run["automation_run_id"], token),
                ).rowcount
                if updated != 1:
                    raise AutomationClaimLost(
                        "自动流程状态、租约或人工恢复额度已变化，报告重试已放弃"
                    )
        run = _assert_active_claim(self.db_path, run)
        if not self._verify_context(run):
            return
        response = self.callbacks["polish_report"](
            run["project_id"],
            {
                "report_type": model["reportType"],
                "report_markdown": _report_markdown(model),
            },
        )
        current = _assert_active_claim(self.db_path, run)
        if not self._verify_context(current):
            return
        polished = apply_report_polish(model, response.get("result") or {})
        source_snapshot = dict(polished.get("sourceSnapshot") or {})
        source_snapshot.update(
            {
                "automation_run_id": run["automation_run_id"],
                "analysis_version_id": run["analysis_version_id"],
                "question_scope_hash": run["question_scope_hash"],
                "context_hash": run["context_hash"],
            }
        )
        llm_meta = dict(response.get("llm") or {})
        llm_meta.update(
            {
                "automation_run_id": run["automation_run_id"],
                "generation_mode": "rules_plus_single_llm_polish",
                "human_reviewed": False,
            }
        )
        draft_response = self.callbacks["create_report_draft"](
            run["project_id"],
            {
                "report_type": polished["reportType"],
                "title": polished["title"],
                "report": polished,
                "source_snapshot": source_snapshot,
                "source_run_id": run["sample_run_id"],
                "comparison_run_id": run.get("comparison_run_id") or "",
                "current_step": 4,
                "section_status": {
                    "conclusion": "ai_applied",
                    "causes": "ai_applied",
                    "actions": "ai_applied",
                    "retest": "ai_applied",
                },
                "llm": llm_meta,
            },
        )
        current = _assert_active_claim(self.db_path, current)
        if not self._verify_context(current):
            return
        draft_id = str((draft_response.get("draft") or {}).get("draft_id") or "")
        if not draft_id:
            raise ValueError("创建报告草稿后未返回 draft_id")
        usage = _decode_json_column(current, "usage_json", {})
        usage["report_polish"] = llm_meta.get("usage") or {}
        token = _claim_token(current)
        with _connect(self.db_path) as connection:
            updated = connection.execute(
                """
                UPDATE automation_runs
                SET usage_json = ?, report_model_json = ?, updated_at = ?
                WHERE automation_run_id = ? AND status = 'running'
                  AND lease_token = ?
                """,
                (
                    _canonical_json(usage),
                    _canonical_json(polished),
                    now_iso(),
                    run["automation_run_id"],
                    token,
                ),
            ).rowcount
            if updated != 1:
                raise AutomationClaimLost(
                    "自动流程状态或租约已变化，报告结果未提交"
                )
        self._mark_ready(current, draft_id)

    def _mark_ready(self, run: dict[str, Any], draft_id: str) -> None:
        timestamp = now_iso()
        token = _claim_token(run)
        if not token:
            raise AutomationClaimLost("自动流程租约已失效，完成状态未提交")
        with _connect(self.db_path) as connection:
            updated = connection.execute(
                """
                UPDATE automation_runs
                SET status = 'ready_for_publish', current_stage = 'ready_for_publish',
                    report_draft_id = ?, completed_at = ?, last_error_code = '',
                    last_error = '', lease_token = '', lease_until = '', updated_at = ?
                WHERE automation_run_id = ? AND status = 'running'
                  AND lease_token = ?
                """,
                (
                    draft_id,
                    timestamp,
                    timestamp,
                    run["automation_run_id"],
                    token,
                ),
            ).rowcount
            if updated != 1:
                raise AutomationClaimLost(
                    "自动流程状态或租约已变化，完成状态未提交"
                )
            refreshed = connection.execute(
                "SELECT * FROM automation_runs WHERE automation_run_id = ?",
                (run["automation_run_id"],),
            ).fetchone()
            _append_event(
                connection,
                refreshed,
                stage="ready_for_publish",
                event_type="completed",
                status="ready_for_publish",
                message="自动流程已完成，报告草稿等待人工预览与发布。",
                metadata={
                    "analysis_version_id": refreshed["analysis_version_id"],
                    "report_draft_id": draft_id,
                    "report_type": refreshed["report_type"],
                },
            )


def start_automation_pipeline_loop(
    db_path: str | Path,
    callbacks: dict[str, Callable[..., Any]],
    *,
    tick_seconds: Any = None,
) -> AutomationPipelineLoop:
    global _PIPELINE_LOOP
    with _PIPELINE_LOOP_LOCK:
        if _PIPELINE_LOOP and _PIPELINE_LOOP.is_alive():
            return _PIPELINE_LOOP
        _PIPELINE_LOOP = AutomationPipelineLoop(
            db_path,
            callbacks,
            tick_seconds=tick_seconds,
        )
        _PIPELINE_LOOP.start()
        return _PIPELINE_LOOP


__all__ = [
    "ANALYSIS_BATCH_SIZE",
    "AUTOMATION_EVENTS_DDL",
    "AUTOMATION_RUNS_DDL",
    "AutomationPipelineLoop",
    "SCENES",
    "apply_report_polish",
    "automation_sampling_dispatch_guard",
    "build_automation_report_model",
    "cancel_automation_run",
    "create_automation_run",
    "ensure_automation_database",
    "ensure_automation_tables",
    "get_automation_run",
    "list_automation_runs",
    "preview_automation_run",
    "resume_automation_run",
    "start_automation_pipeline_loop",
]
