export type AnalysisReviewChoice = "rules" | "llm" | "rejected";
export type AnalysisReviewChoices = Record<string, AnalysisReviewChoice>;

export const ANALYSIS_FULL_SAMPLE_LIMIT = 10000;
export const ANALYSIS_LLM_BATCH_SIZE = 15;
export const REVIEW_QUESTION_CHOICE_FIELD = "__question_choice__";
export const REVIEW_REJECTED_FIELD = "__question_rejected__";

type JsonRecord = Record<string, any>;

export function getAnalysisExecutionEstimate(
  brief: JsonRecord | null | undefined,
  fallbackSamples: JsonRecord[] = [],
) {
  const execution = brief?.execution && typeof brief.execution === "object"
    ? brief.execution
    : {};
  const samples = Array.isArray(brief?.input_package?.samples)
    ? brief.input_package.samples
    : fallbackSamples;
  const fallbackQuestionCount = new Set(
    samples
      .map((sample: JsonRecord) => String(sample?.question_id || "").trim())
      .filter(Boolean),
  ).size;
  const batchSize = Math.max(
    1,
    Number(execution.batch_size) || ANALYSIS_LLM_BATCH_SIZE,
  );
  const questionCount = Math.max(
    0,
    Number(execution.question_count) || fallbackQuestionCount,
  );
  const sampleCount = Math.max(
    0,
    Number(execution.sample_count) || samples.length,
  );
  const batchCount = Math.max(
    0,
    Number(execution.batch_count)
      || (questionCount ? Math.ceil(questionCount / batchSize) : 0),
  );
  return {
    sample_count: sampleCount,
    question_count: questionCount,
    batch_size: batchSize,
    batch_count: batchCount,
    estimated_paid_calls: Math.max(
      0,
      Number(execution.estimated_paid_calls) || batchCount,
    ),
    automatic_retry: execution.automatic_retry === true,
    resume_supported: execution.resume_supported !== false,
  };
}

export const ANALYSIS_COMPARE_FIELDS = [
  { field: "brand_mentioned", label: "品牌出现" },
  { field: "brand_recommended", label: "进入推荐" },
  { field: "risk_level", label: "风险等级" },
  { field: "competitors", label: "竞品与替代对象" },
  { field: "accurate_claims", label: "准确事实" },
  { field: "unverified_claims", label: "待核验事实" },
  { field: "high_risk_hallucinations", label: "高风险事实" },
  { field: "positioning_drift", label: "定位偏移" },
  { field: "recommended_fix", label: "建议修复" },
] as const;

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function analysisValuesEqual(left: any, right: any): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function extractAnalysisResultObject(rawText: string): JsonRecord | null {
  let text = String(rawText || "").trim();
  if (!text) return null;
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function buildAnalysisReviewRows(
  samples: JsonRecord[],
  rawResultText: string,
  questions: JsonRecord[] = [],
) {
  const result = extractAnalysisResultObject(rawResultText);
  const analyses = Array.isArray(result?.analyses) ? result.analyses : [];
  const llmByQuestion = new Map(
    analyses
      .filter((item: JsonRecord) => item && String(item.question_id || "").trim())
      .map((item: JsonRecord) => [String(item.question_id).trim(), item]),
  );
  const questionById = new Map(
    questions
      .filter(item => item && String(item.question_id || "").trim())
      .map(item => [String(item.question_id).trim(), item]),
  );
  const seen = new Set<string>();
  return samples.flatMap(sample => {
    const questionId = String(sample.question_id || "").trim();
    if (!questionId || seen.has(questionId)) return [];
    seen.add(questionId);
    const meta = questionById.get(questionId) || {};
    const rules = sample.rules_baseline && typeof sample.rules_baseline === "object"
      ? sample.rules_baseline
      : {};
    const llm = llmByQuestion.get(questionId) || null;
    const fields = ANALYSIS_COMPARE_FIELDS.map(definition => ({
      ...definition,
      rules_value: rules[definition.field],
      llm_value: llm?.[definition.field],
      different: !llm || !analysisValuesEqual(
        rules[definition.field],
        llm[definition.field],
      ),
    }));
    const missingLlm = !llm;
    const hasDifferences = missingLlm || fields.some(item => item.different);
    return [{
      question_id: questionId,
      question: sample.question || meta.question || "",
      category: sample.category || meta.category || "",
      scene_code: meta.scene_code || meta.generation_focus || sample.category || "other",
      scene_label: meta.scene_label
        || meta.generation_focus_label_current
        || meta.generation_focus_label
        || sample.category
        || "其他场景",
      rules,
      llm,
      fields,
      missing_llm: missingLlm,
      has_differences: hasDifferences,
      consistent: !hasDifferences,
    }];
  });
}

export function withDefaultConsistentChoices(
  rows: Array<{ question_id: string; consistent: boolean }>,
  previous: AnalysisReviewChoices = {},
): AnalysisReviewChoices {
  const next: AnalysisReviewChoices = {};
  for (const row of rows) {
    if (previous[row.question_id]) {
      next[row.question_id] = previous[row.question_id];
    } else if (row.consistent) {
      next[row.question_id] = "rules";
    }
  }
  return next;
}

export function reviewConflictKey(item: JsonRecord, _index = 0): string {
  return [
    item.question_id || "global",
    item.field || "unknown",
    JSON.stringify(stableValue(item.rules_value)),
    JSON.stringify(stableValue(item.llm_value)),
  ].join("::");
}

export function buildAnalysisReviewDecisions(
  conflicts: JsonRecord[],
  choices: AnalysisReviewChoices,
  globalDecisions: Record<string, "keep_rules" | "adopt_llm"> = {},
) {
  const decisions: JsonRecord[] = [];
  for (const questionId of Object.keys(choices).sort()) {
    const choice = choices[questionId];
    if (choice === "rejected") {
      decisions.push({
        question_id: questionId,
        field: REVIEW_REJECTED_FIELD,
        rules_value: "pending_human_review",
        llm_value: "rejected",
        action: "keep_rules",
      });
    } else {
      decisions.push({
        question_id: questionId,
        field: REVIEW_QUESTION_CHOICE_FIELD,
        rules_value: "rules",
        llm_value: "llm",
        action: choice === "rules" ? "keep_rules" : "adopt_llm",
      });
    }
  }
  conflicts.forEach((item, index) => {
    const questionId = String(item.question_id || "").trim();
    const choice = questionId ? choices[questionId] : undefined;
    if (choice === "rejected") return;
    const action = questionId
      ? choice === "rules"
        ? "keep_rules"
        : choice === "llm"
          ? "adopt_llm"
          : undefined
      : globalDecisions[reviewConflictKey(item, index)];
    if (!action) return;
    decisions.push({
      question_id: item.question_id || "",
      field: item.field,
      rules_value: item.rules_value,
      llm_value: item.llm_value,
      action,
    });
  });
  return decisions;
}
