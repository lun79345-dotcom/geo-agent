export type MonitoringSetSceneCode =
  | "demand_solution"
  | "vendor_selection"
  | "budget_case_process"
  | "competitor_compare";

export const MONITORING_SET_SCENES: Array<{
  code: MonitoringSetSceneCode;
  label: string;
}> = [
  { code: "demand_solution", label: "品类需求可见" },
  { code: "vendor_selection", label: "推荐名单可见" },
  { code: "budget_case_process", label: "采购决策可见" },
  { code: "competitor_compare", label: "竞品对比可见" },
];

export const MONITORING_SET_FALLBACK_TEMPLATES = [
  {
    code: "standard_visibility",
    label: "标准可见度",
    set_type: "standard",
    total: 40,
    scene_targets: {
      demand_solution: 10,
      vendor_selection: 12,
      budget_case_process: 10,
      competitor_compare: 8,
    },
  },
  {
    code: "acquisition_recommendation",
    label: "获客推荐型",
    set_type: "standard",
    total: 40,
    scene_targets: {
      demand_solution: 8,
      vendor_selection: 16,
      budget_case_process: 10,
      competitor_compare: 6,
    },
  },
  {
    code: "procurement_decision",
    label: "采购决策型",
    set_type: "standard",
    total: 40,
    scene_targets: {
      demand_solution: 6,
      vendor_selection: 10,
      budget_case_process: 16,
      competitor_compare: 8,
    },
  },
  {
    code: "competitor_defense",
    label: "竞品攻防型",
    set_type: "standard",
    total: 40,
    scene_targets: {
      demand_solution: 6,
      vendor_selection: 8,
      budget_case_process: 10,
      competitor_compare: 16,
    },
  },
] as const;

export const MONITORING_SET_ANGLE_OPTIONS = [
  { code: "broad_core", label: "宽泛核心" },
  { code: "region", label: "地域" },
  { code: "industry", label: "行业" },
  { code: "audience", label: "提问人群" },
  { code: "use_case", label: "使用场景" },
  { code: "budget", label: "预算" },
  { code: "project_cycle", label: "项目周期" },
  { code: "case_quality", label: "案例/质量" },
  { code: "competitor", label: "竞品/替代" },
] as const;

export function monitoringSceneTargets(value: Record<string, unknown> | null | undefined) {
  return Object.fromEntries(
    MONITORING_SET_SCENES.map(scene => {
      const parsed = Number(value?.[scene.code] || 0);
      return [scene.code, Number.isFinite(parsed) ? Math.round(parsed) : 0];
    }),
  ) as Record<MonitoringSetSceneCode, number>;
}

export function monitoringTargetTotal(value: Record<string, unknown> | null | undefined) {
  const targets = monitoringSceneTargets(value);
  return MONITORING_SET_SCENES.reduce((sum, scene) => sum + targets[scene.code], 0);
}

export function monitoringTargetValidation(
  setType: string,
  value: Record<string, unknown> | null | undefined,
) {
  const targets = monitoringSceneTargets(value);
  const total = monitoringTargetTotal(targets);
  if (MONITORING_SET_SCENES.some(scene => targets[scene.code] < 0 || targets[scene.code] > 50)) {
    return { valid: false, message: "每个场景题量必须在 0-50 之间。" };
  }
  if (setType === "standard") {
    if (total !== 40) return { valid: false, message: `正式标准题集合计必须为 40 题，当前为 ${total} 题。` };
    if (MONITORING_SET_SCENES.some(scene => targets[scene.code] <= 0)) {
      return { valid: false, message: "正式标准题集的四个场景都必须至少保留 1 题。" };
    }
    return { valid: true, message: "四场景合计 40 题，可以进入逐题预览。" };
  }
  if (total < 1 || total > 50) {
    return { valid: false, message: `专项题集总量必须为 1-50 题，当前为 ${total} 题。` };
  }
  return { valid: true, message: `专项题集共 ${total} 题，将独立建立基线。` };
}

export function monitoringComparisonPresentation(
  comparison: Record<string, unknown> | null | undefined,
  deltaPoints: number | null = null,
) {
  const code = String(comparison?.code || "");
  if (code === "baseline_period") return { label: "基线期", tone: "neutral", code };
  if (code === "same_question_scope") {
    if (deltaPoints === null || Number.isNaN(deltaPoints)) return { label: "可环比", tone: "success", code };
    if (deltaPoints === 0) return { label: "持平", tone: "neutral", code };
    return {
      label: `${deltaPoints > 0 ? "↑" : "↓"} ${Math.abs(deltaPoints)}pp`,
      tone: deltaPoints > 0 ? "success" : "danger",
      code,
    };
  }
  if (code === "scope_changed") return { label: "范围不同，不能环比", tone: "warning", code };
  if (code === "scope_unavailable") return { label: "历史范围缺失", tone: "warning", code };
  if (code === "incomplete_samples") {
    const sampled = Number(comparison?.sampled_count ?? comparison?.current_sampled_count ?? 0);
    const planned = Number(comparison?.planned_count ?? comparison?.planned_question_count ?? 0);
    return {
      label: String(comparison?.label || (planned ? `样本不完整 ${sampled}/${planned}` : "样本不完整")),
      tone: "warning",
      code,
    };
  }
  if (code === "sampling") return { label: "采样中", tone: "warning", code };
  if (code === "baseline_changed") return { label: "基线配置已变化", tone: "warning", code };
  if (code === "independent_history") return { label: "历史独立批次", tone: "neutral", code };
  return {
    label: String(comparison?.label || comparison?.reason || "暂不可环比"),
    tone: "neutral",
    code: code || "unknown",
  };
}

export function monitoringTrendRows(periods: Array<Record<string, any>>) {
  let previousValid: Record<string, any> | null = null;
  return periods.map(period => {
    const comparison = period.comparison_to_previous || {};
    const deltaPoints = comparison.comparable && previousValid
      ? Math.round((Number(period.basic_visibility_rate || 0) - Number(previousValid.basic_visibility_rate || 0)) * 100)
      : null;
    const result = {
      ...period,
      comparison_presentation: monitoringComparisonPresentation(comparison, deltaPoints),
      visibility_delta_points: deltaPoints,
    };
    if (["baseline_period", "same_question_scope"].includes(String(comparison.code || "")) && period.basic_visibility_rate !== null && period.basic_visibility_rate !== undefined) {
      previousValid = period;
    }
    return result;
  });
}

export function monitoringQuestionRank(question: Record<string, any>) {
  const reviewRank = question.review_status === "approved" ? 0 : question.review_status === "pending" ? 1 : 2;
  return [question.fixed_monitoring ? 0 : 1, reviewRank, String(question.question_id || "")];
}
