import type { ViewId } from "./types";

export type ProjectDataset =
  | "status"
  | "project"
  | "samples"
  | "results"
  | "trends"
  | "questions"
  | "recommendations"
  | "monitoringSets"
  | "runs"
  | "samplingSchedules"
  | "automationRuns"
  | "analysisVersions"
  | "retests"
  | "sourceEvidence"
  | "sourceVerificationRuns"
  | "sources"
  | "knowledgeRuns"
  | "customerFactBase"
  | "factVersions"
  | "llmConfig"
  | "samplerConfigs"
  | "executorStatus"
  | "reportVersions";

export const CORE_PROJECT_DATASETS: readonly ProjectDataset[] = [
  "status",
  "project",
  "trends",
];

const VIEW_PROJECT_DATASETS: Record<ViewId, readonly ProjectDataset[]> = {
  overview: ["samples", "results"],
  assets: ["sources", "knowledgeRuns", "customerFactBase", "factVersions", "samplerConfigs"],
  questions: ["questions", "automationRuns"],
  sampling: ["questions", "samples", "monitoringSets", "runs", "samplingSchedules", "automationRuns", "samplerConfigs", "executorStatus"],
  analysis: ["questions", "samples", "results", "analysisVersions", "llmConfig", "automationRuns"],
  sources: ["sourceEvidence", "sourceVerificationRuns"],
  optimization: ["questions", "recommendations", "retests", "sourceEvidence"],
  report: ["samples", "results", "recommendations", "sourceEvidence", "reportVersions", "automationRuns"],
  settings: ["llmConfig", "samplerConfigs", "executorStatus", "samplingSchedules"],
};

export function projectDatasetsForView(view: ViewId): readonly ProjectDataset[] {
  return VIEW_PROJECT_DATASETS[view] || [];
}
