-- GEO 监测优化 Agent 当前新库参考 Schema（2026-08-06）
-- 正式升级仍走后端幂等 ensure/migration；本文件不得用于重建或覆盖历史数据库。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  business_summary TEXT NOT NULL DEFAULT '',
  target_customers TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '豆包',
  language TEXT NOT NULL DEFAULT '中文',
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS project_monitoring_plans (
  project_id TEXT PRIMARY KEY,
  primary_sampler TEXT NOT NULL DEFAULT 'doubao_api_websearch',
  samplers_json TEXT NOT NULL DEFAULT '["doubao_api_websearch"]',
  cadence TEXT NOT NULL DEFAULT 'manual',
  version INTEGER NOT NULL DEFAULT 1,
  baseline_locked_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS customer_facts (
  fact_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_key TEXT NOT NULL DEFAULT '',
  fact_value TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  evidence_url TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS customer_source_documents (
  document_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'file',
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  file_extension TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL DEFAULT '',
  extracted_path TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL DEFAULT '',
  parse_status TEXT NOT NULL DEFAULT 'queued',
  parse_warning TEXT NOT NULL DEFAULT '',
  extracted_chars INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS customer_knowledge_import_runs (
  import_run_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  document_ids_json TEXT NOT NULL DEFAULT '[]',
  work_items_json TEXT NOT NULL DEFAULT '[]',
  draft_items_json TEXT NOT NULL DEFAULT '[]',
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  completed_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  total_items INTEGER NOT NULL DEFAULT 0,
  llm_provider TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  applied_fact_base_version_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS forbidden_claims (
  claim_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS competitors (
  competitor_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  watch_reason TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS question_pool (
  question_id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '中文',
  platform TEXT NOT NULL DEFAULT '豆包',
  commercial_value INTEGER NOT NULL DEFAULT 3,
  competition_level INTEGER NOT NULL DEFAULT 3,
  is_core INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_questions (
  project_question_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT '中',
  fit_reason TEXT NOT NULL DEFAULT '',
  target_positioning TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  review_status TEXT NOT NULL DEFAULT 'pending',
  quality_note TEXT NOT NULL DEFAULT '',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
);

CREATE TABLE IF NOT EXISTS question_generation_runs (
  question_generation_run_id TEXT PRIMARY KEY,
  source_project_id TEXT NOT NULL,
  target_project_id TEXT NOT NULL,
  customer_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  requested_count INTEGER NOT NULL DEFAULT 0,
  generated_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  created_question_count INTEGER NOT NULL DEFAULT 0,
  reused_question_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  context_json TEXT NOT NULL DEFAULT '{}',
  llm_result_json TEXT NOT NULL DEFAULT '{}',
  quality_checks_json TEXT NOT NULL DEFAULT '{}',
  llm_provider TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  llm_usage_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_project_id) REFERENCES projects(project_id),
  FOREIGN KEY (target_project_id) REFERENCES projects(project_id),
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE INDEX IF NOT EXISTS idx_question_generation_runs_project
ON question_generation_runs(target_project_id, created_at);

CREATE TABLE IF NOT EXISTS sample_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '豆包',
  sampler TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  schedule_id TEXT,
  cycle_id TEXT NOT NULL DEFAULT '',
  baseline_run_id TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  config_snapshot_json TEXT NOT NULL DEFAULT '{}',
  purpose TEXT NOT NULL DEFAULT 'exploration',
  status TEXT NOT NULL DEFAULT 'queued',
  is_mock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS monitoring_cycles (
  cycle_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT 'baseline',
  question_ids_json TEXT NOT NULL DEFAULT '[]',
  samplers_json TEXT NOT NULL DEFAULT '[]',
  plan_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_cycles_project
ON monitoring_cycles(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sample_runs_cycle
ON sample_runs(project_id, cycle_id);

CREATE TABLE IF NOT EXISTS sample_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  answer_chars INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (run_id) REFERENCES sample_runs(run_id),
  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
);

CREATE TABLE IF NOT EXISTS samples (
  sample_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '豆包',
  answer_text TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  screenshot_path TEXT NOT NULL DEFAULT '',
  sample_type TEXT NOT NULL DEFAULT 'real',
  model_name TEXT NOT NULL DEFAULT '',
  raw_response_json TEXT NOT NULL DEFAULT '{}',
  citations_json TEXT NOT NULL DEFAULT '[]',
  search_enabled INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
);

CREATE TABLE IF NOT EXISTS analysis_results (
  analysis_id TEXT PRIMARY KEY,
  sample_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  brand_mentioned INTEGER NOT NULL DEFAULT 0,
  brand_recommended INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT '中',
  competitors_json TEXT NOT NULL DEFAULT '[]',
  accurate_claims_json TEXT NOT NULL DEFAULT '[]',
  unverified_claims_json TEXT NOT NULL DEFAULT '[]',
  high_risk_json TEXT NOT NULL DEFAULT '[]',
  positioning_drift_json TEXT NOT NULL DEFAULT '[]',
  recommended_fix TEXT NOT NULL DEFAULT '',
  analyzed_at TEXT NOT NULL,
  analyzer_version TEXT NOT NULL DEFAULT 'rules_v1',
  FOREIGN KEY (sample_id) REFERENCES samples(sample_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
);

CREATE TABLE IF NOT EXISTS recommendations (
  recommendation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P2',
  reason TEXT NOT NULL,
  action TEXT NOT NULL,
  owner TEXT NOT NULL DEFAULT '',
  expected_impact TEXT NOT NULL DEFAULT '',
  content_brief TEXT NOT NULL DEFAULT '',
  target_questions_json TEXT NOT NULL DEFAULT '[]',
  required_facts_json TEXT NOT NULL DEFAULT '[]',
  implementation_plan_json TEXT NOT NULL DEFAULT '{}',
  source_evidence_json TEXT NOT NULL DEFAULT '[]',
  enrichment_preview_json TEXT NOT NULL DEFAULT '{}',
  enrichment_status TEXT NOT NULL DEFAULT '',
  enrichment_model TEXT NOT NULL DEFAULT '',
  enriched_at TEXT NOT NULL DEFAULT '',
  generator TEXT NOT NULL DEFAULT 'rules_v1',
  validation_status TEXT NOT NULL DEFAULT 'pending',
  approval_status TEXT NOT NULL DEFAULT 'pending',
  execution_status TEXT NOT NULL DEFAULT 'not_started',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS recommendation_evidence (
  evidence_id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL,
  sample_id TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL DEFAULT '',
  evidence_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id)
);

CREATE TABLE IF NOT EXISTS action_tasks (
  action_task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P2',
  owner TEXT NOT NULL DEFAULT '',
  done_definition TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  execution_note TEXT NOT NULL DEFAULT '',
  evidence_url TEXT NOT NULL DEFAULT '',
  retest_status TEXT NOT NULL DEFAULT 'not_ready',
  started_at TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id)
);

CREATE TABLE IF NOT EXISTS retest_runs (
  retest_run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  baseline_run_id TEXT NOT NULL DEFAULT '',
  after_run_id TEXT NOT NULL DEFAULT '',
  related_recommendation_id TEXT NOT NULL DEFAULT '',
  related_action_task_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  conclusion TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS retest_results (
  retest_result_id TEXT PRIMARY KEY,
  retest_run_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  before_value REAL NOT NULL DEFAULT 0,
  after_value REAL NOT NULL DEFAULT 0,
  delta_value REAL NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (retest_run_id) REFERENCES retest_runs(retest_run_id)
);

CREATE TABLE IF NOT EXISTS recommendation_retest_questions (
  match_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL DEFAULT '',
  action_task_id TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'rules_v1',
  has_before_sample INTEGER NOT NULL DEFAULT 0,
  before_run_id TEXT NOT NULL DEFAULT '',
  in_baseline INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (recommendation_id) REFERENCES recommendations(recommendation_id),
  FOREIGN KEY (action_task_id) REFERENCES action_tasks(action_task_id),
  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
);

CREATE TABLE IF NOT EXISTS data_standard_versions (
  standard_version_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  description TEXT NOT NULL DEFAULT '',
  schema_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_category_standards (
  category_id TEXT PRIMARY KEY,
  standard_version_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  sample_goal TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (standard_version_id) REFERENCES data_standard_versions(standard_version_id)
);

CREATE TABLE IF NOT EXISTS metric_definitions (
  metric_id TEXT PRIMARY KEY,
  standard_version_id TEXT NOT NULL,
  name TEXT NOT NULL,
  numerator TEXT NOT NULL DEFAULT '',
  denominator TEXT NOT NULL DEFAULT '',
  formula_text TEXT NOT NULL DEFAULT '',
  target_direction TEXT NOT NULL DEFAULT '',
  usage_scope TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (standard_version_id) REFERENCES data_standard_versions(standard_version_id)
);

CREATE TABLE IF NOT EXISTS report_grade_definitions (
  grade_id TEXT PRIMARY KEY,
  standard_version_id TEXT NOT NULL,
  name TEXT NOT NULL,
  condition_text TEXT NOT NULL DEFAULT '',
  action_hint TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (standard_version_id) REFERENCES data_standard_versions(standard_version_id)
);

CREATE TABLE IF NOT EXISTS report_versions (
  report_version_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'internal',
  version_no INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  executive_summary TEXT NOT NULL DEFAULT '',
  markdown_text TEXT NOT NULL,
  markdown_chars INTEGER NOT NULL DEFAULT 0,
  applied_polish INTEGER NOT NULL DEFAULT 0,
  polish_json TEXT NOT NULL DEFAULT '{}',
  llm_meta_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'dashboard',
  status TEXT NOT NULL DEFAULT 'saved',
  report_json TEXT NOT NULL DEFAULT '{}',
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  publish_warnings_json TEXT NOT NULL DEFAULT '[]',
  pdf_storage_path TEXT NOT NULL DEFAULT '',
  pdf_sha256 TEXT NOT NULL DEFAULT '',
  pdf_bytes INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT '',
  draft_id TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS report_drafts (
  draft_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  report_type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  current_step INTEGER NOT NULL DEFAULT 1,
  source_run_id TEXT NOT NULL DEFAULT '',
  comparison_run_id TEXT NOT NULL DEFAULT '',
  source_snapshot_json TEXT NOT NULL DEFAULT '{}',
  report_json TEXT NOT NULL DEFAULT '{}',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  section_status_json TEXT NOT NULL DEFAULT '{}',
  llm_meta_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'editing',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS customer_portal_accounts (
  account_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS customer_brand_assets (
  customer_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  logo_path TEXT NOT NULL DEFAULT '',
  logo_mime TEXT NOT NULL DEFAULT '',
  logo_sha256 TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS source_verification_runs (
  verification_run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  question_ids_json TEXT NOT NULL DEFAULT '[]',
  work_items_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',
  total_questions INTEGER NOT NULL DEFAULT 0,
  completed_questions INTEGER NOT NULL DEFAULT 0,
  failed_questions INTEGER NOT NULL DEFAULT 0,
  llm_provider TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

CREATE TABLE IF NOT EXISTS source_evidence (
  source_evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  verification_run_id TEXT NOT NULL DEFAULT '',
  sample_id TEXT NOT NULL DEFAULT '',
  question_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'independent_web',
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'community_other',
  relation TEXT NOT NULL DEFAULT 'unverified',
  claim_text TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  source_location TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'matched',
  fetch_status TEXT NOT NULL DEFAULT 'not_checked',
  content_hash TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT NOT NULL DEFAULT '',
  confirmed_by TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL DEFAULT '',
  rejected_reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (question_id) REFERENCES question_pool(question_id)
);

CREATE TABLE IF NOT EXISTS sampling_run_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'archived',
  total_tasks INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  brand_mentions INTEGER NOT NULL DEFAULT 0,
  brand_recommendations INTEGER NOT NULL DEFAULT 0,
  high_risk_samples INTEGER NOT NULL DEFAULT 0,
  competitor_mentions INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL DEFAULT 'exploration',
  category_coverage_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  top_competitors_json TEXT NOT NULL DEFAULT '[]',
  key_questions_json TEXT NOT NULL DEFAULT '[]',
  conclusion TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (run_id) REFERENCES sample_runs(run_id)
);

CREATE TABLE IF NOT EXISTS fact_base_versions (
  fact_base_version_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  fact_count INTEGER NOT NULL DEFAULT 0,
  competitor_count INTEGER NOT NULL DEFAULT 0,
  forbidden_claim_count INTEGER NOT NULL DEFAULT 0,
  facts_json TEXT NOT NULL DEFAULT '[]',
  competitors_json TEXT NOT NULL DEFAULT '[]',
  forbidden_claims_json TEXT NOT NULL DEFAULT '[]',
  change_source TEXT NOT NULL DEFAULT 'dashboard',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE IF NOT EXISTS analysis_result_versions (
  analysis_version_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version_no INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'llm_confirm',
  analyzer_version TEXT NOT NULL DEFAULT '',
  analysis_count INTEGER NOT NULL DEFAULT 0,
  recommendation_count INTEGER NOT NULL DEFAULT 0,
  action_task_count INTEGER NOT NULL DEFAULT 0,
  question_ids_json TEXT NOT NULL DEFAULT '[]',
  input_package_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}',
  review_decisions_json TEXT NOT NULL DEFAULT '[]',
  llm_meta_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);

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
);

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
);

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
);

CREATE TABLE IF NOT EXISTS executor_state (
  state_key TEXT PRIMARY KEY,
  state_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(customer_id);
CREATE INDEX IF NOT EXISTS idx_project_questions_project ON project_questions(project_id);
CREATE INDEX IF NOT EXISTS idx_sample_runs_project ON sample_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_samples_project_question ON samples(project_id, question_id);
CREATE INDEX IF NOT EXISTS idx_analysis_project_question ON analysis_results(project_id, question_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_project ON recommendations(project_id);
CREATE INDEX IF NOT EXISTS idx_customer_source_documents_customer ON customer_source_documents(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_customer_knowledge_runs_customer ON customer_knowledge_import_runs(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_action_tasks_project ON action_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_retest_question_matches_task ON recommendation_retest_questions(project_id, action_task_id, score);
CREATE INDEX IF NOT EXISTS idx_report_versions_project ON report_versions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_versions_project_type ON report_versions(project_id, report_type, version_no);
CREATE INDEX IF NOT EXISTS idx_report_drafts_project ON report_drafts(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_source_verification_runs_project ON source_verification_runs(project_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_source_evidence_project_status ON source_evidence(project_id, verification_status, created_at);
CREATE INDEX IF NOT EXISTS idx_source_evidence_question ON source_evidence(project_id, question_id, origin);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_evidence_unique_url ON source_evidence(project_id, question_id, sample_id, origin, canonical_url);
CREATE INDEX IF NOT EXISTS idx_sampling_snapshots_project_run ON sampling_run_snapshots(project_id, run_id);
CREATE INDEX IF NOT EXISTS idx_fact_base_versions_customer ON fact_base_versions(customer_id, version_no);
CREATE INDEX IF NOT EXISTS idx_analysis_versions_project ON analysis_result_versions(project_id, version_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_idempotency ON automation_runs(project_id, idempotency_key) WHERE idempotency_key <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_project_active ON automation_runs(project_id) WHERE status IN ('queued', 'running', 'needs_attention');
CREATE INDEX IF NOT EXISTS idx_automation_runs_project_created ON automation_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status_stage ON automation_runs(status, current_stage, updated_at);
CREATE INDEX IF NOT EXISTS idx_automation_events_run_created ON automation_events(automation_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sampling_schedules_due ON sampling_schedules(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_question_category_standard_version ON question_category_standards(standard_version_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_metric_definitions_standard_version ON metric_definitions(standard_version_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_report_grade_standard_version ON report_grade_definitions(standard_version_id, sort_order);
