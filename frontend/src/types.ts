export type ViewId = "overview" | "assets" | "questions" | "sampling" | "analysis" | "sources" | "optimization" | "report" | "settings";
export type ViewMode = "internal" | "client";
export type Json = Record<string, any>;

export interface Customer { customer_id: string; name: string; industry?: string; region?: string; business_summary?: string; }
export interface Project { project_id: string; customer_id: string; name: string; platform?: string; goal?: string; customer_name?: string; }
export interface AppData {
  status?: Json; project?: Json; questions: Json[]; samples: Json[]; results: Json[];
  recommendations: Json[]; actionTasks: Json[]; taskDrafts: Json[]; recommendationSummary: Json; trends: Json; runs: Json[]; sources: Json[]; knowledgeRuns: Json[];
  analysisVersions: Json[]; reportVersions: Json[]; factVersions: Json[]; retests: Json[];
  sourceEvidence: Json; sourceVerificationRuns: Json[];
  questionSummary?: Json; questionSceneSummary?: Json[]; questionProfile?: Json; questionProfileSaved?: boolean;
  llmConfig?: Json; samplerConfig?: Json; samplerConfigs?: Json; executorStatus?: Json; samplingSchedules?: Json; monitoringSets?: Json; automationRuns?: Json;
}
