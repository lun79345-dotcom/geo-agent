import csv
import json
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_FILE = ROOT / "schema" / "geo_agent_schema.sql"
DB_FILE = ROOT / "data" / "geo_agent.db"
QUESTIONS_FILE = ROOT / "02_doubao_question_bank.csv"
FACT_FILE = ROOT / "10_fictional_fact_base.json"
RAW_FILE = ROOT / "07_doubao_first10_raw.md"
MOCK_RAW_FILE = ROOT / "17_mock_sampling_raw.md"
RUNS_FILE = ROOT / "16_sampling_runs.json"
RESULTS_FILE = ROOT / "12_auto_analysis_results.json"

CUSTOMER_ID = "cust_fictional"
PROJECT_ID = "proj_fictional_doubao_demo"


def now_iso():
    return datetime.now().replace(microsecond=0).isoformat()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(read_text(path))


def as_json(value):
    return json.dumps(value if value is not None else [], ensure_ascii=False)


def split_raw_samples(raw_text: str):
    first = re.search(r"(?m)^##\s+Q\d+\s+", raw_text)
    if not first:
        return []
    body = raw_text[first.start() :].strip()
    chunks = re.split(r"\n---\s*(?:\n|$)", body)

    sections = []
    for chunk in chunks:
        chunk = chunk.strip()
        if not chunk:
            continue
        match = re.match(r"(?s)^##\s+(Q\d+)\s+(.+?)\s*\n\n(.*)$", chunk)
        if not match:
            continue
        sections.append(
            {
                "question_id": match.group(1).strip(),
                "question": match.group(2).strip(),
                "answer": match.group(3).strip(),
            }
        )
    return sections


def execute_schema(conn: sqlite3.Connection):
    conn.executescript(read_text(SCHEMA_FILE))


def clear_demo_data(conn: sqlite3.Connection):
    tables = [
        "retest_results",
        "retest_runs",
        "action_tasks",
        "recommendation_evidence",
        "recommendations",
        "analysis_results",
        "samples",
        "sample_tasks",
        "sample_runs",
        "question_generation_runs",
        "project_questions",
        "question_pool",
        "competitors",
        "forbidden_claims",
        "customer_facts",
        "projects",
        "customers",
    ]
    for table in tables:
        conn.execute(f"DELETE FROM {table}")


def insert_customer_and_project(conn: sqlite3.Connection, fact_base: dict):
    entity = fact_base.get("entity", {})
    positioning = fact_base.get("confirmed_positioning", {})
    timestamp = now_iso()
    conn.execute(
        """
        INSERT INTO customers (
          customer_id, name, industry, region, business_summary,
          target_customers, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            CUSTOMER_ID,
            entity.get("company_full_name") or entity.get("brand_name") or "星舟创意（虚构）",
            "AIGC视频 / 企业宣传片 / AI数字人",
            "、".join(entity.get("service_region", [])),
            positioning.get("primary_positioning", ""),
            "、".join(positioning.get("target_customers", [])),
            "active",
            timestamp,
            timestamp,
        ),
    )
    conn.execute(
        """
        INSERT INTO projects (
          project_id, customer_id, name, platform, language,
          goal, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            PROJECT_ID,
            CUSTOMER_ID,
            "星舟创意（虚构）豆包 GEO 监测 Demo",
            "豆包",
            entity.get("primary_language", "中文"),
            "监测品牌是否进入豆包推荐，并识别竞品占位与事实风险",
            "active",
            timestamp,
            timestamp,
        ),
    )


def insert_facts(conn: sqlite3.Connection, fact_base: dict):
    timestamp = now_iso()
    facts = []
    entity = fact_base.get("entity", {})
    positioning = fact_base.get("confirmed_positioning", {})

    for key, value in entity.items():
        facts.append(("entity", key, value))
    for key, value in positioning.items():
        facts.append(("positioning", key, value))
    for index, service in enumerate(fact_base.get("confirmed_services", []), start=1):
        facts.append(("service", service.get("service_name", f"service_{index}"), service))
    for index, claim in enumerate(fact_base.get("allowed_claims", []), start=1):
        facts.append(("allowed_claim", f"allowed_claim_{index:03d}", claim))
    preferred = fact_base.get("preferred_message", {})
    for key, value in preferred.items():
        facts.append(("preferred_message", key, value))

    for index, (fact_type, fact_key, value) in enumerate(facts, start=1):
        fact_id = f"fact_fictional_{index:04d}"
        fact_value = value if isinstance(value, str) else as_json(value)
        conn.execute(
            """
            INSERT INTO customer_facts (
              fact_id, customer_id, fact_type, fact_key, fact_value,
              visibility, evidence_url, confidence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fact_id,
                CUSTOMER_ID,
                fact_type,
                str(fact_key),
                fact_value,
                "public",
                "",
                "confirmed",
                timestamp,
                timestamp,
            ),
        )

    for index, item in enumerate(fact_base.get("unsupported_or_forbidden_claims", []), start=1):
        conn.execute(
            """
            INSERT INTO forbidden_claims (
              claim_id, customer_id, claim, severity, reason, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"claim_fictional_{index:04d}",
                CUSTOMER_ID,
                item.get("claim", ""),
                item.get("severity", "high"),
                item.get("reason", ""),
                timestamp,
                timestamp,
            ),
        )

    for index, item in enumerate(fact_base.get("competitor_watchlist", []), start=1):
        conn.execute(
            """
            INSERT INTO competitors (
              competitor_id, customer_id, name, category, watch_reason,
              aliases_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"comp_fictional_{index:04d}",
                CUSTOMER_ID,
                item.get("name", ""),
                item.get("category", ""),
                item.get("watch_reason", ""),
                as_json([]),
                timestamp,
                timestamp,
            ),
        )


def insert_questions(conn: sqlite3.Connection):
    timestamp = now_iso()
    with QUESTIONS_FILE.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        is_core = 1 if any(
            keyword in row.get("question", "")
            for keyword in ["AIGC", "企业宣传片", "TVC", "数字人", "AI视频"]
        ) else 0
        conn.execute(
            """
            INSERT INTO question_pool (
              question_id, question, category, intent, language, platform,
              commercial_value, competition_level, is_core, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["question_id"],
                row["question"],
                row.get("category", ""),
                row.get("intent", ""),
                "中文",
                "豆包",
                5 if row.get("priority") == "高" else 3,
                4 if row.get("category") in {"本地采购", "竞品对比"} else 3,
                is_core,
                timestamp,
                timestamp,
            ),
        )
        conn.execute(
            """
            INSERT INTO project_questions (
              project_question_id, project_id, question_id, priority,
              fit_reason, target_positioning, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"pq_{PROJECT_ID}_{row['question_id']}",
                PROJECT_ID,
                row["question_id"],
                row.get("priority", "中"),
                row.get("intent", ""),
                "星舟创意（虚构）高端AIGC视频与数字人内容服务商",
                "active",
                timestamp,
                timestamp,
            ),
        )


def insert_runs(conn: sqlite3.Connection):
    store = load_json(RUNS_FILE, {"runs": []})
    for run in store.get("runs", []):
        is_mock = 1 if run.get("sampler") == "mock_doubao" else 0
        conn.execute(
            """
            INSERT INTO sample_runs (
              run_id, project_id, name, platform, sampler, scope, category,
              status, is_mock, created_at, started_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run.get("run_id"),
                PROJECT_ID,
                run.get("name", ""),
                run.get("platform", "豆包"),
                run.get("sampler", ""),
                run.get("scope", ""),
                run.get("category", ""),
                run.get("status", ""),
                is_mock,
                run.get("created_at", ""),
                run.get("started_at", ""),
                run.get("completed_at", ""),
            ),
        )
        for task in run.get("tasks", []):
            conn.execute(
                """
                INSERT INTO sample_tasks (
                  task_id, run_id, question_id, status, answer_chars,
                  error, created_at, completed_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task.get("task_id"),
                    run.get("run_id"),
                    task.get("question_id"),
                    task.get("status", ""),
                    int(task.get("answer_chars") or task.get("answer_length") or 0),
                    task.get("error", ""),
                    task.get("created_at", ""),
                    task.get("completed_at", ""),
                ),
            )


def insert_samples(conn: sqlite3.Connection):
    timestamp = now_iso()
    imported = {}
    for sample_type, path in (("real", RAW_FILE), ("mock", MOCK_RAW_FILE)):
        if not path.exists():
            continue
        for section in split_raw_samples(read_text(path)):
            sample_id = f"sample_{sample_type}_{section['question_id']}"
            imported[(sample_type, section["question_id"])] = sample_id
            conn.execute(
                """
                INSERT INTO samples (
                  sample_id, project_id, run_id, task_id, question_id, platform,
                  answer_text, source_url, screenshot_path, sample_type, collected_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sample_id,
                    PROJECT_ID,
                    "",
                    "",
                    section["question_id"],
                    "豆包",
                    section["answer"],
                    "",
                    "",
                    sample_type,
                    timestamp,
                ),
            )
    return imported


def insert_analysis(conn: sqlite3.Connection, sample_ids: dict):
    results = load_json(RESULTS_FILE, {"results": [], "generated_at": now_iso()})
    analyzed_at = results.get("generated_at") or now_iso()
    for item in results.get("results", []):
        question_id = item.get("question_id", "")
        sample_id = sample_ids.get(("mock", question_id))
        if not sample_id:
            continue
        conn.execute(
            """
            INSERT INTO analysis_results (
              analysis_id, sample_id, project_id, question_id, brand_mentioned,
              brand_recommended, risk_level, competitors_json, accurate_claims_json,
              unverified_claims_json, high_risk_json, positioning_drift_json,
              recommended_fix, analyzed_at, analyzer_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"analysis_{PROJECT_ID}_{question_id}",
                sample_id,
                PROJECT_ID,
                question_id,
                1 if item.get("brand_mentioned") else 0,
                1 if item.get("brand_recommended") else 0,
                item.get("risk_level", "中"),
                as_json(item.get("competitors", [])),
                as_json(item.get("accurate_claims", [])),
                as_json(item.get("unverified_claims", [])),
                as_json(item.get("high_risk_hallucinations", [])),
                as_json(item.get("positioning_drift", [])),
                item.get("recommended_fix", ""),
                analyzed_at,
                "rules_v1",
            ),
        )


def insert_recommendations(conn: sqlite3.Connection, sample_ids: dict):
    sys.path.insert(0, str(ROOT / "scripts"))
    from backend_server import build_optimization_recommendations

    timestamp = now_iso()
    data = {"items": [{"category":"事实覆盖", "title":"补充品牌事实页（模拟）", "priority":"P1", "reason":"部分虚构回答未提到目标品牌", "action":"整理服务范围和可核实证据", "expected_impact":"用于下一轮模拟复测", "evidence":["Q003"]}], "weekly_tasks":[{"task":"整理事实页（模拟）", "priority":"P1", "done_definition":"提供服务范围、证据与更新日期"}]}
    recommendation_ids = []
    for index, item in enumerate(data.get("items", []), start=1):
        recommendation_id = f"rec_{PROJECT_ID}_{index:03d}"
        recommendation_ids.append(recommendation_id)
        conn.execute(
            """
            INSERT INTO recommendations (
              recommendation_id, project_id, category, title, priority, reason,
              action, owner, expected_impact, generator, validation_status,
              approval_status, execution_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                recommendation_id,
                PROJECT_ID,
                item.get("category", ""),
                item.get("title", ""),
                item.get("priority", "P2"),
                item.get("reason", ""),
                item.get("action", ""),
                item.get("owner", ""),
                item.get("expected_impact", ""),
                "rules_v1",
                "pending",
                "pending",
                "not_started",
                timestamp,
                timestamp,
            ),
        )
        for evidence_index, evidence in enumerate(item.get("evidence", []), start=1):
            evidence_text = str(evidence)
            question_id = evidence_text if re.fullmatch(r"Q\d+", evidence_text) else ""
            conn.execute(
                """
                INSERT INTO recommendation_evidence (
                  evidence_id, recommendation_id, sample_id, question_id,
                  evidence_text, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    f"evi_{PROJECT_ID}_{index:03d}_{evidence_index:03d}",
                    recommendation_id,
                    sample_ids.get(("mock", question_id), None),
                    question_id,
                    evidence_text,
                    timestamp,
                ),
            )

    for index, task in enumerate(data.get("weekly_tasks", []), start=1):
        linked_recommendation_id = (
            recommendation_ids[min(index - 1, len(recommendation_ids) - 1)]
            if recommendation_ids
            else ""
        )
        conn.execute(
            """
            INSERT INTO action_tasks (
              action_task_id, project_id, recommendation_id, title, priority,
              owner, done_definition, status, due_date, completed_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"act_{PROJECT_ID}_{index:03d}",
                PROJECT_ID,
                linked_recommendation_id,
                task.get("task", ""),
                task.get("priority", "P2"),
                "GEO项目负责人",
                task.get("done_definition", ""),
                "todo",
                "",
                "",
                timestamp,
                timestamp,
            ),
        )


def table_counts(conn: sqlite3.Connection):
    tables = [
        "customers",
        "projects",
        "customer_facts",
        "forbidden_claims",
        "competitors",
        "question_pool",
        "project_questions",
        "sample_runs",
        "sample_tasks",
        "samples",
        "analysis_results",
        "recommendations",
        "recommendation_evidence",
        "action_tasks",
    ]
    return {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in tables
    }


def main():
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    fact_base = load_json(FACT_FILE, {})
    conn = sqlite3.connect(DB_FILE)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        execute_schema(conn)
        clear_demo_data(conn)
        insert_customer_and_project(conn, fact_base)
        insert_facts(conn, fact_base)
        insert_questions(conn)
        insert_runs(conn)
        sample_ids = insert_samples(conn)
        insert_analysis(conn, sample_ids)
        insert_recommendations(conn, sample_ids)
        conn.commit()
        print(json.dumps({"db": str(DB_FILE), "counts": table_counts(conn)}, ensure_ascii=False, indent=2))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
