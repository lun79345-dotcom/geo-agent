import type { Json } from "./types";

export const AUTOMATION_SCENES = [
  { code: "demand_solution", label: "品类需求可见", target: 10 },
  { code: "vendor_selection", label: "推荐名单可见", target: 12 },
  { code: "budget_case_process", label: "采购决策可见", target: 10 },
  { code: "competitor_compare", label: "竞品对比可见", target: 8 },
] as const;

export const AUTOMATION_STAGE_SEQUENCE = [
  { code: "sampling", label: "创建并完成采样" },
  { code: "sampling_retry", label: "失败题原批次补采" },
  { code: "llm_analysis", label: "LLM 全量复核" },
  { code: "llm_confirm", label: "自动确认分析" },
  { code: "report_build", label: "构建锁定报告" },
  { code: "report_polish", label: "整体润色" },
  { code: "ready_for_publish", label: "待人工预览发布" },
] as const;

const STAGE_INDEX = Object.fromEntries(
  AUTOMATION_STAGE_SEQUENCE.map((item, index) => [item.code, index]),
) as Record<string, number>;

export function automationSceneCode(question: Json) {
  return String(question.scene_code || question.generation_focus || "");
}

export function summarizeAutomationSelection(
  selectedQuestionIds: Iterable<string>,
  eligibleQuestions: Json[],
) {
  const selected = new Set(Array.from(selectedQuestionIds, value => String(value)));
  const selectedRows = eligibleQuestions.filter(item => selected.has(String(item.question_id)));
  const sceneCounts = Object.fromEntries(
    AUTOMATION_SCENES.map(scene => [
      scene.code,
      selectedRows.filter(item => automationSceneCode(item) === scene.code).length,
    ]),
  ) as Record<string, number>;
  const core = selectedRows.filter(item => String(item.question_tier || "") === "core" || Boolean(item.is_core)).length;
  const fixed = selectedRows.filter(item => Boolean(item.fixed_monitoring)).length;
  const exact = selectedRows.length === 40
    && AUTOMATION_SCENES.every(scene => sceneCounts[scene.code] > 0);
  return {
    selectedRows,
    selectedCount: selectedRows.length,
    sceneCounts,
    core,
    longTail: selectedRows.length - core,
    fixed,
    exact,
  };
}

export function automationStageLabel(stage: unknown) {
  const code = String(stage || "queued");
  if (code === "queued") return "等待服务端接管";
  return AUTOMATION_STAGE_SEQUENCE.find(item => item.code === code)?.label || code;
}

export function automationStatusLabel(status: unknown) {
  const value = String(status || "");
  if (value === "queued") return "排队中";
  if (value === "running") return "自动执行中";
  if (value === "needs_attention") return "需要人工处理";
  if (value === "cancelled") return "已取消";
  if (value === "ready_for_publish") return "报告待预览发布";
  return value || "未知状态";
}

export function automationProgressPercent(run: Json | null | undefined) {
  if (!run) return 0;
  if (run.status === "ready_for_publish" || run.current_stage === "ready_for_publish") return 100;
  if (run.current_stage === "queued") return 2;
  const index = STAGE_INDEX[String(run.current_stage || "")];
  if (index === undefined) return 0;
  return Math.max(5, Math.round((index / (AUTOMATION_STAGE_SEQUENCE.length - 1)) * 100));
}

export function automationTone(status: unknown) {
  const value = String(status || "");
  if (value === "ready_for_publish") return "success";
  if (value === "needs_attention") return "danger";
  if (value === "cancelled") return "neutral";
  return "warning";
}
