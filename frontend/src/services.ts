import { api, get, patch, post, remove } from "./api";
import type { Json } from "./types";

export const projectPath = (projectId: string, resource: string) => `/api/projects/${encodeURIComponent(projectId)}/${resource}`;
export const customerPath = (customerId: string, resource: string) => `/api/customers/${encodeURIComponent(customerId)}/${resource}`;

export const workspaceService = {
  createCustomer: (payload: Json) => post("/api/customers", payload),
  createProject: (payload: Json) => post("/api/projects", payload),
  factBase: (customerId: string) => get(customerPath(customerId, "fact-base")),
  saveFactBase: (customerId: string, payload: Json) => post(customerPath(customerId, "fact-base"), payload),
  factVersions: (customerId: string) => get(customerPath(customerId, "fact-base/versions?limit=20")),
  saveMonitoringPlan: (projectId: string, payload: Json) => post(projectPath(projectId, "monitoring-plan"), payload),
};

export const knowledgeService = {
  createRun: (customerId: string, documentIds: string[]) => post(customerPath(customerId, "knowledge-import-runs"), { document_ids: documentIds }),
  runNext: (customerId: string, runId: string, retryFailed = false) => post(customerPath(customerId, `knowledge-import-runs/${encodeURIComponent(runId)}/run-next`), { retry_failed: retryFailed }),
  apply: (customerId: string, runId: string, selectedDraftIds: string[]) => post(customerPath(customerId, `knowledge-import-runs/${encodeURIComponent(runId)}/apply`), { selected_draft_ids: selectedDraftIds }),
};

export const questionService = {
  generate: (projectId: string, count: number, generationFocus: string) => post(projectPath(projectId, "questions/llm-generate"), { mode: "append", count, generation_focus: generationFocus }),
  generateScene: (projectId: string, payload: Json) => post(projectPath(projectId, "questions/generate-scene"), payload),
  regenerate: (projectId: string) => post(projectPath(projectId, "questions/regenerate"), {}),
  review: (projectId: string, questionId: string, payload: Json) => post(projectPath(projectId, `questions/${encodeURIComponent(questionId)}/quality`), payload),
  reviewBatch: (projectId: string, questionIds: string[], reviewStatus: string) => post(projectPath(projectId, "questions/quality-batch"), { question_ids: questionIds, review_status: reviewStatus }),
  profile: (customerId: string) => get(customerPath(customerId, "question-profile")),
  saveProfile: (customerId: string, payload: Json) => post(customerPath(customerId, "question-profile"), payload),
  previewManual: (projectId: string, payload: Json) => post(projectPath(projectId, "questions/manual/preview"), payload),
  commitManual: (projectId: string, payload: Json) => post(projectPath(projectId, "questions/manual"), payload),
  edit: (projectId: string, questionId: string, payload: Json) => post(projectPath(projectId, `questions/${encodeURIComponent(questionId)}/edit`), payload),
  monitoringPolicy: (projectId: string, questionId: string, fixed: boolean) => post(projectPath(projectId, `questions/${encodeURIComponent(questionId)}/monitoring-policy`), { fixed }),
};

export const samplingService = {
  createMonitoringCycle: (projectId: string, payload: Json) => post(projectPath(projectId, "monitoring-cycles"), payload),
  deleteRun: (projectId: string, runId: string) => remove(projectPath(projectId, `sampling-runs/${encodeURIComponent(runId)}`)),
  startWebsearch: (projectId: string, payload: Json) => post(projectPath(projectId, "websearch-batch/start"), payload),
  runWebsearchWindow: (projectId: string, runId: string, maxConcurrency = 4) => post(projectPath(projectId, "websearch-batch/run-window"), { run_id: runId, max_concurrency: maxConcurrency }),
  retryFailedWebsearch: (projectId: string, runId: string) => post(projectPath(projectId, "websearch-batch/retry-failed"), { run_id: runId }),
  startArk: (projectId: string, payload: Json) => post(projectPath(projectId, "ark-websearch-batch/start"), payload),
  runNextArk: (projectId: string, runId: string) => post(projectPath(projectId, "ark-websearch-batch/run-next"), { run_id: runId }),
  runArkWindow: (projectId: string, runId: string, maxConcurrency = 4) => post(projectPath(projectId, "ark-websearch-batch/run-window"), { run_id: runId, max_concurrency: maxConcurrency }),
  retryFailedArk: (projectId: string, runId: string) => post(projectPath(projectId, "ark-websearch-batch/retry-failed"), { run_id: runId }),
  startAssisted: (projectId: string, payload: Json) => post(projectPath(projectId, "assisted-batch/start"), payload),
  submitAssisted: (projectId: string, payload: Json) => post(projectPath(projectId, "assisted-batch/submit"), payload),
  saveManualSample: (projectId: string, payload: Json) => post(projectPath(projectId, "samples"), payload),
};

export const executorService = {
  status: () => get("/api/executor/status"),
  pause: () => post("/api/executor/pause", {}),
  resume: () => post("/api/executor/resume", {}),
  handoff: (projectId: string, runId: string) => post(projectPath(projectId, `sampling-runs/${encodeURIComponent(runId)}/handoff`), {}),
};

export const samplingScheduleService = {
  list: (projectId: string) => get(projectPath(projectId, "sampling-schedules")),
  create: (projectId: string, payload: Json) => post(projectPath(projectId, "sampling-schedules"), payload),
  update: (projectId: string, scheduleId: string, payload: Json) => patch(projectPath(projectId, `sampling-schedules/${encodeURIComponent(scheduleId)}`), payload),
  remove: (projectId: string, scheduleId: string) => remove(projectPath(projectId, `sampling-schedules/${encodeURIComponent(scheduleId)}`)),
};

export const monitoringSetService = {
  list: (projectId: string) => get(projectPath(projectId, "monitoring-sets")),
  preview: (projectId: string, payload: Json) => post(projectPath(projectId, "monitoring-sets/preview"), payload),
  create: (projectId: string, payload: Json) => post(projectPath(projectId, "monitoring-sets"), payload),
  nextPeriod: (projectId: string, baselineRunId: string, payload: Json = {}) => post(
    projectPath(projectId, `monitoring-sets/${encodeURIComponent(baselineRunId)}/next-period`),
    payload,
  ),
  trends: (projectId: string, baselineRunId = "", limit = 6) => get(
    projectPath(
      projectId,
      `monitoring-trends?limit=${limit}${baselineRunId ? `&baseline_run_id=${encodeURIComponent(baselineRunId)}` : ""}`,
    ),
  ),
};

export const automationService = {
  preview: (projectId: string, selectedQuestionIds?: string[]) => post(
    projectPath(projectId, "automation-runs/preview"),
    selectedQuestionIds === undefined ? {} : { selected_question_ids: selectedQuestionIds },
  ),
  start: (projectId: string, payload: Json) => post(projectPath(projectId, "automation-runs"), payload),
  list: (projectId: string, limit = 20) => get(projectPath(projectId, `automation-runs?limit=${limit}`)),
  get: (projectId: string, automationRunId: string) => get(projectPath(projectId, `automation-runs/${encodeURIComponent(automationRunId)}`)),
  resume: (projectId: string, automationRunId: string, acknowledgeCost: boolean) => post(
    projectPath(projectId, `automation-runs/${encodeURIComponent(automationRunId)}/resume`),
    { acknowledge_cost: acknowledgeCost },
  ),
  cancel: (projectId: string, automationRunId: string) => post(
    projectPath(projectId, `automation-runs/${encodeURIComponent(automationRunId)}/cancel`),
    {},
  ),
};

export const analysisService = {
  brief: (projectId: string, limit: number) => api(
    projectPath(projectId, `analysis-brief?limit=${limit}`),
    { cache: "no-store" },
  ),
  run: (projectId: string, payload: Json) => post(projectPath(projectId, "llm-analysis/run"), payload),
  validate: (projectId: string, payload: Json) => post(projectPath(projectId, "llm-analysis/validate"), payload),
  confirm: (projectId: string, payload: Json) => post(projectPath(projectId, "llm-analysis/confirm"), payload),
};

export const sourceService = {
  list: (projectId: string, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => Boolean(value))).toString();
    return get(projectPath(projectId, `source-evidence${query ? `?${query}` : ""}`));
  },
  listRuns: (projectId: string) => get(projectPath(projectId, "source-verification-runs?limit=50")),
  createRun: (projectId: string, questionIds: string[]) => post(projectPath(projectId, "source-verification-runs"), { question_ids: questionIds }),
  runNext: (projectId: string, runId: string) => post(projectPath(projectId, `source-verification-runs/${encodeURIComponent(runId)}/run-next`), {}),
  stop: (projectId: string, runId: string) => post(projectPath(projectId, `source-verification-runs/${encodeURIComponent(runId)}/stop`), {}),
  resume: (projectId: string, runId: string) => post(projectPath(projectId, `source-verification-runs/${encodeURIComponent(runId)}/resume`), {}),
  retryFailed: (projectId: string, runId: string) => post(projectPath(projectId, `source-verification-runs/${encodeURIComponent(runId)}/retry-failed`), {}),
  addManual: (projectId: string, payload: Json) => post(projectPath(projectId, "source-evidence/manual-url"), payload),
  retryEvidence: (projectId: string, evidenceId: string) => post(projectPath(projectId, `source-evidence/${encodeURIComponent(evidenceId)}/retry`), {}),
  decide: (projectId: string, evidenceId: string, payload: Json) => post(projectPath(projectId, `source-evidence/${encodeURIComponent(evidenceId)}/decision`), payload),
};

export const optimizationService = {
  saveTaskDraft: (projectId: string, recommendationId: string, payload: Json) => post(projectPath(projectId, `recommendations/${encodeURIComponent(recommendationId)}/task-drafts`), payload),
  approveTaskDraft: (projectId: string, recommendationId: string, draftId: string, payload: Json) => post(projectPath(projectId, `recommendations/${encodeURIComponent(recommendationId)}/task-drafts/${encodeURIComponent(draftId)}/approve`), payload),
  updateTask: (projectId: string, taskId: string, payload: Json) => post(projectPath(projectId, `action-tasks/${encodeURIComponent(taskId)}`), payload),
  saveRetestQuestions: (projectId: string, taskId: string, questionIds: string[]) => post(projectPath(projectId, `action-tasks/${encodeURIComponent(taskId)}/retest-questions`), { selected_question_ids: questionIds }),
  prepareRetest: (projectId: string, payload: Json) => post(projectPath(projectId, "retests/prepare"), payload),
  confirmRetestEffect: (projectId: string, retestRunId: string, payload: Json) => post(projectPath(projectId, `retests/${encodeURIComponent(retestRunId)}/confirm`), payload),
  runEnrichment: (projectId: string, payload: Json) => post(projectPath(projectId, "recommendations/enrich/run"), payload),
  confirmEnrichment: (projectId: string, payload: Json) => post(projectPath(projectId, "recommendations/enrich/confirm"), payload),
};

export const reportService = {
  polish: (projectId: string, payload: Json) => post(projectPath(projectId, "report-polish/run"), payload),
  saveVersion: (projectId: string, payload: Json) => post(projectPath(projectId, "report-versions"), payload),
  listVersions: (projectId: string, reportType: string, status = "", limit = 20) => get(projectPath(projectId, `report-versions?report_type=${encodeURIComponent(reportType)}${status ? `&status=${encodeURIComponent(status)}` : ""}&limit=${limit}`)),
  publishVersion: (projectId: string, versionId: string) => post(projectPath(projectId, `report-versions/${encodeURIComponent(versionId)}/publish`), {}),
  listDrafts: (projectId: string, reportType = "", status = "") => get(projectPath(projectId, `report-drafts${reportType || status ? `?${new URLSearchParams({ ...(reportType ? { report_type: reportType } : {}), ...(status ? { status } : {}) }).toString()}` : ""}`)),
  getDraft: (projectId: string, draftId: string) => get(projectPath(projectId, `report-drafts/${encodeURIComponent(draftId)}`)),
  createDraft: (projectId: string, payload: Json) => post(projectPath(projectId, "report-drafts"), payload),
  saveDraft: (projectId: string, draftId: string, payload: Json) => post(projectPath(projectId, `report-drafts/${encodeURIComponent(draftId)}/save`), payload),
  checkpointDraft: (projectId: string, draftId: string, revision: number) => post(projectPath(projectId, `report-drafts/${encodeURIComponent(draftId)}/checkpoint`), { revision }),
  publishDraft: (projectId: string, draftId: string, revision: number, acknowledgeWarnings = false) => post(projectPath(projectId, `report-drafts/${encodeURIComponent(draftId)}/publish`), { revision, acknowledge_warnings: acknowledgeWarnings }),
  copyVersionToDraft: (projectId: string, versionId: string) => post(projectPath(projectId, `report-versions/${encodeURIComponent(versionId)}/copy-to-draft`), {}),
  portalAccount: (customerId: string) => get(customerPath(customerId, "portal-account")),
  savePortalAccount: (customerId: string, payload: Json) => post(customerPath(customerId, "portal-account"), payload),
  customerBrand: (customerId: string) => get(customerPath(customerId, "brand")),
};

export const settingsService = {
  resetPreview: (projectId: string) => get(projectPath(projectId, "reset-preview")),
  resetProject: (projectId: string, payload: Json) => post(projectPath(projectId, "reset-test-data"), payload),
  deletePreview: (projectId: string) => get(projectPath(projectId, "delete-preview")),
  deleteProject: (projectId: string, payload: Json) => post(projectPath(projectId, "delete"), payload),
  resetFictional: (payload: Json) => post("/api/demo/fictional/reset-to-fact-ready", payload),
};
