import type { AppData, Json, Project } from "./types";

export type ReportType = "internal" | "client" | "weekly";
export type ReportSectionId = "conclusion" | "metrics" | "scenes" | "evidence" | "causes" | "actions" | "retest" | "appendix";

export type ReportSection = {
  id: ReportSectionId;
  title: string;
  markdown: string;
  editable: boolean;
};

export type ReportEvidence = {
  id: string;
  questionId: string;
  question: string;
  sceneId: string;
  sceneLabel: string;
  answerExcerpt: string;
  brandMentioned: boolean;
  brandRecommended: boolean;
  competitors: string[];
  citations: Array<{ title: string; url: string; snippet: string }>;
  verifiedSources: Array<{
    id: string;
    title: string;
    url: string;
    domain: string;
    sourceType: string;
    sourceTypeLabel: string;
    origin: string;
    originLabel: string;
    relation: string;
    relationLabel: string;
    excerpt: string;
    sourceLocation: string;
    retrievedAt: string;
    selected: boolean;
  }>;
  recommendedFix: string;
  riskLevel: string;
};

export type ReportScene = {
  id: string;
  label: string;
  sampleCount: number;
  mentionRate: number;
  recommendationRate: number;
  evidenceCount: number;
};

export type ReportAction = {
  id: string;
  title: string;
  action: string;
  acceptance: string;
  priority: string;
};

export type ReportModel = {
  schemaVersion: number;
  reportType: ReportType;
  title: string;
  typeLabel: string;
  executiveSummary: string;
  metrics: Json;
  sections: ReportSection[];
  originalSections?: Partial<Record<ReportSectionId, string>>;
  scenes: ReportScene[];
  evidence: ReportEvidence[];
  allEvidence: ReportEvidence[];
  allAnomalies: ReportEvidence[];
  actions: ReportAction[];
  sourceSnapshot: Json;
};

export type ReportScope = { runId?: string; comparisonRunId?: string };

const SCENES = [
  ["demand_solution", "品类需求可见"],
  ["vendor_selection", "推荐名单可见"],
  ["budget_case_process", "采购决策可见"],
  ["competitor_compare", "竞品对比可见"],
] as const;

const SECTION_TITLES: Record<ReportSectionId, string> = {
  conclusion: "本期诊断结论",
  metrics: "核心可见度指标",
  scenes: "四场景诊断",
  evidence: "问题与回答证据",
  causes: "不可见或被压制的原因",
  actions: "内容资产行动方案",
  retest: "复测与验收标准",
  appendix: "全量异常证据及方法附录",
};

function percent(value: unknown) {
  const number = Number(value || 0);
  return `${Math.round(number <= 1 ? number * 100 : number)}%`;
}

function truncate(value: unknown, max = 520) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }

function reportPeriodComparison(current: Json, previous: Json) {
  if (!current || !previous || !Object.keys(previous).length) return { comparable: false, code: "no_previous_period", reason: "当前还没有可比较的上期数据。" };
  const ids = (value: unknown) => array(value).map(item => String(item || "")).filter(Boolean).sort();
  const currentPlanned = ids(current.planned_question_ids);
  const previousPlanned = ids(previous.planned_question_ids);
  const currentSampled = ids(current.sampled_question_ids);
  const previousSampled = ids(previous.sampled_question_ids);
  if (!currentPlanned.length || !previousPlanned.length) return { comparable: false, code: "scope_unavailable", reason: "历史快照缺少问题范围，不能形成可靠环比。" };
  if (JSON.stringify(currentPlanned) !== JSON.stringify(previousPlanned)) return { comparable: false, code: "scope_changed", reason: "本期与上期的监测问题范围不同，暂不计算环比。" };
  if (JSON.stringify(currentSampled) !== JSON.stringify(currentPlanned) || JSON.stringify(previousSampled) !== JSON.stringify(previousPlanned)) return { comparable: false, code: "incomplete_samples", reason: "本期或上期存在未完成、缺失的同题样本，暂不计算环比。" };
  return { comparable: true, code: "same_question_scope", reason: "本期与上期使用相同问题范围且样本完整，可以进行环比。" };
}

function citationRows(value: unknown) {
  return array(value).map((item: any) => typeof item === "string"
    ? { title: item, url: item.startsWith("http") ? item : "", snippet: "" }
    : { title: String(item?.title || item?.name || item?.url || item?.source || "公开来源"), url: String(item?.url || item?.source_url || ""), snippet: String(item?.snippet || item?.summary || "") })
    .filter(item => item.title || item.url)
    .slice(0, 8);
}

function verifiedSourceRows(data: AppData, sampleId: string, questionId: string) {
  return array(data.sourceEvidence?.items)
    .filter((item: Json) => item.verification_status === "confirmed" && String(item.question_id || "") === questionId && (!item.sample_id || String(item.sample_id) === sampleId))
    .map((item: Json) => ({
      id: String(item.source_evidence_id || ""),
      title: String(item.title || item.domain || "已确认来源"),
      url: String(item.url || ""),
      domain: String(item.domain || "客户资料"),
      sourceType: String(item.source_type || "community_other"),
      sourceTypeLabel: String(item.source_type_label || "其他来源"),
      origin: String(item.origin || "independent_web"),
      originLabel: String(item.origin_label || "已确认来源"),
      relation: String(item.relation || "context"),
      relationLabel: String(item.relation_label || "背景信息"),
      excerpt: String(item.excerpt || ""),
      sourceLocation: String(item.source_location || ""),
      retrievedAt: String(item.retrieved_at || item.created_at || ""),
      selected: true,
    }))
    .filter(item => item.id && item.relation !== "contradicts");
}

function latestByQuestion(rows: Json[]) {
  const map = new Map<string, Json>();
  rows.forEach(row => {
    const id = String(row.question_id || "");
    if (!id) return;
    const previous = map.get(id);
    const currentTime = String(row.collected_at || row.analyzed_at || "");
    const previousTime = String(previous?.collected_at || previous?.analyzed_at || "");
    if (!previous || currentTime >= previousTime) map.set(id, row);
  });
  return map;
}

export function reportEvidenceMarkdown(items: ReportEvidence[], emptyText = "当前没有可展示的代表证据。", includeRawCitations = false) {
  if (!items.length) return `- ${emptyText}`;
  return items.map(item => {
    const status = `${item.brandMentioned ? "品牌已出现" : "品牌未出现"}；${item.brandRecommended ? "已进入推荐" : "未进入推荐"}`;
    const competitors = item.competitors.length ? `\n- 竞品/替代对象：${item.competitors.join("、")}` : "";
    const verified = (item.verifiedSources || []).filter(row => row.selected !== false);
    const sources = verified.length ? `\n- 已确认信源：${verified.map(row => row.url?.startsWith("http") ? `${row.title}（${row.url}）` : `${row.title}${row.sourceLocation ? ` · ${row.sourceLocation}` : ""}`).join("；")}` : "";
    const raw = includeRawCitations && item.citations.length ? `\n- AI 原始引用（未经独立核验）：${item.citations.map(row => row.url ? `${row.title}（${row.url}）` : row.title).join("；")}` : "";
    return `### ${item.questionId} · ${item.question}\n\n${item.answerExcerpt || "当前回答没有可展示的正文片段。"}\n\n- 判断：${status}${competitors}${sources}${raw}`;
  }).join("\n\n");
}

function actionMarkdown(actions: ReportAction[]) {
  if (!actions.length) return "1. 先补齐事实库、官网信息和首批模拟样本，再生成内容资产行动方案。";
  return actions.map((item, index) => `${index + 1}. **${item.title}**（${item.priority || "P1"}）\n   - 建设内容：${item.action}\n   - 完成标准：${item.acceptance}`).join("\n");
}

export function reportMarkdown(model: ReportModel, overrides: Partial<Record<ReportSectionId, string>> = {}) {
  const content = Object.fromEntries(model.sections.map(section => [section.id, overrides[section.id] || section.markdown])) as Record<ReportSectionId, string>;
  if (model.reportType === "internal") return [`# ${model.title}`, ...model.sections.map(section => content[section.id])].join("\n\n");
  const body = (id: ReportSectionId) => String(content[id] || "").replace(/^##\s+\d+\.\s+[^\n]+\n*/u, "").trim();
  return [
    `# ${model.title}`,
    `## 1. 本期结论与核心指标\n\n${body("conclusion")}\n\n### 核心可见度指标\n\n${body("metrics")}`,
    `## 2. 四场景可见度诊断\n\n${body("scenes")}`,
    `## 3. 关键问题与回答证据\n\n${body("evidence")}`,
    `## 4. 不可见或被压制的原因\n\n${body("causes")}`,
    `## 5. 内容资产行动方案\n\n${body("actions")}`,
    `## 6. 复测与验收标准\n\n${body("retest")}`,
    `## 附录：全量异常证据与方法说明\n\n${body("appendix")}`,
  ].join("\n\n");
}

export function buildReportModel(data: AppData, project: Project | undefined, reportType: ReportType, scope: ReportScope = {}): ReportModel {
  const summary = data.status?.analysis_summary || {};
  const customerName = project?.customer_name || data.project?.project?.customer_name || "客户";
  const periods = array(data.trends?.periods);
  const sampledRunIds = new Set((data.samples || []).map((item: Json) => String(item.run_id || "")).filter(Boolean));
  const requestedCurrent = scope.runId ? periods.find((item: Json) => String(item.run_id || "") === scope.runId) : null;
  const current = (requestedCurrent || [...periods].reverse().find((item: Json) => sampledRunIds.has(String(item.run_id || ""))) || data.trends?.current || periods.at(-1) || {}) as Json;
  const currentPeriodIndex = periods.findIndex((item: Json) => String(item.run_id || "") === String(current.run_id || ""));
  const requestedPrevious = scope.comparisonRunId ? periods.find((item: Json) => String(item.run_id || "") === scope.comparisonRunId) : null;
  const previous = (requestedPrevious || (currentPeriodIndex > 0
    ? [...periods.slice(0, currentPeriodIndex)].reverse().find((item: Json) => sampledRunIds.has(String(item.run_id || "")))
    : null)) as Json || {};
  const comparison = reportPeriodComparison(current, previous);
  const activeRunId = String(current.run_id || "");
  const scopedSamples = activeRunId ? (data.samples || []).filter((item: Json) => String(item.run_id || "") === activeRunId) : (data.samples || []);
  const scopedSampleIds = new Set(scopedSamples.map((item: Json) => String(item.sample_id || "")).filter(Boolean));
  const scopedResults = activeRunId ? (data.results || []).filter((item: Json) => scopedSampleIds.has(String(item.sample_id || ""))) : (data.results || []);
  const sampleMap = latestByQuestion(scopedSamples);
  const resultMap = latestByQuestion(scopedResults);
  const questionMap = new Map((data.questions || []).map((item: Json) => [String(item.question_id || ""), item]));
  const sceneScoreMap = new Map(array(data.status?.scene_score_breakdown).map((item: Json) => [String(item.code || ""), item]));
  const sceneLabelMap = new Map<string, string>(SCENES as any);
  const evidenceRows: ReportEvidence[] = [];

  resultMap.forEach((result, questionId) => {
    const sample = sampleMap.get(questionId) || {};
    const question = questionMap.get(questionId) || {};
    const sceneId = String(question.generation_focus || "");
    if (!sceneLabelMap.has(sceneId)) return;
    evidenceRows.push({
      id: String(result.analysis_id || result.sample_id || questionId),
      questionId,
      question: String(result.question || question.question || questionId),
      sceneId,
      sceneLabel: sceneLabelMap.get(sceneId) || sceneId,
      answerExcerpt: truncate(sample.answer_text || result.answer_text || "", 520),
      brandMentioned: Boolean(result.brand_mentioned),
      brandRecommended: Boolean(result.brand_recommended),
      competitors: array(result.competitors).map(String).filter(Boolean),
      citations: citationRows(sample.citations || result.citations),
      verifiedSources: verifiedSourceRows(data, String(sample.sample_id || result.sample_id || ""), questionId),
      recommendedFix: String(result.recommended_fix || "").trim(),
      riskLevel: String(result.risk_level || "").trim(),
    });
  });
  evidenceRows.sort((a, b) => a.questionId.localeCompare(b.questionId, "zh-CN", { numeric: true }));

  const anomalies = evidenceRows.filter(item => !item.brandMentioned || item.competitors.length || item.riskLevel.includes("高"));
  const selectedEvidence: ReportEvidence[] = [];
  SCENES.forEach(([sceneId]) => {
    const sceneRows = evidenceRows.filter(item => item.sceneId === sceneId);
    const preferred = [...sceneRows.filter(item => !item.brandMentioned || item.competitors.length), ...sceneRows.filter(item => item.brandMentioned && !item.competitors.length)];
    preferred.forEach(item => { if (selectedEvidence.length < 20 && selectedEvidence.filter(row => row.sceneId === sceneId).length < 5 && !selectedEvidence.some(row => row.id === item.id)) selectedEvidence.push(item); });
  });

  const scenes: ReportScene[] = SCENES.map(([id, label]) => {
    const score = activeRunId ? {} : (sceneScoreMap.get(id) || {});
    const rows = evidenceRows.filter(item => item.sceneId === id);
    return {
      id, label,
      sampleCount: Number(score.sample_count ?? rows.length ?? 0),
      mentionRate: Number(score.brand_mention_rate ?? score.surface_score ?? (rows.length ? rows.filter(item => item.brandMentioned).length / rows.length : 0)),
      recommendationRate: Number(score.brand_recommendation_rate ?? score.trusted_score ?? (rows.length ? rows.filter(item => item.brandRecommended).length / rows.length : 0)),
      evidenceCount: selectedEvidence.filter(item => item.sceneId === id).length,
    };
  });

  const recommendationById = new Map((data.recommendations || []).map(item => [String(item.recommendation_id), item]));
  const actions: ReportAction[] = (data.actionTasks || [])
    .filter((task: Json) => task.formal_approved && recommendationById.get(String(task.recommendation_id))?.approval_status === "approved")
    .slice(0, 8)
    .map((task: Json) => ({
      id: String(task.action_task_id || task.title),
      title: String(task.title || "待办行动"),
      action: String(task.deliverable || task.done_definition || "补充可引用内容资产"),
      acceptance: array(task.acceptance_criteria).join("；") || String(task.done_definition || "内容上线并完成人工验收后执行同题复测"),
      priority: String(task.priority || "P1"),
    }));

  const totalSamples = Number(current.total_samples ?? scopedSamples.length ?? 0);
  const missingCount = Number(current.missing_count ?? evidenceRows.filter(item => !item.brandMentioned).length);
  const pressureCount = Number(current.competitor_pressure_count ?? evidenceRows.filter(item => item.competitors.length).length);
  const highRiskCount = Number(current.high_risk_samples ?? evidenceRows.filter(item => item.riskLevel.includes("高")).length);
  const mentionRate = Number(current.basic_visibility_rate ?? summary.brand_mention_rate ?? 0);
  const recommendationRate = Number(current.strong_visibility_rate ?? summary.brand_recommendation_rate ?? 0);
  const metrics = {
    total_samples: totalSamples,
    brand_mention_rate: mentionRate,
    brand_recommendation_rate: recommendationRate,
    missing_count: missingCount,
    competitor_pressure_count: pressureCount,
    high_risk_count: highRiskCount,
  };
  const delta = comparison.comparable ? {
    basic_visibility_rate: { change: mentionRate - Number(previous.basic_visibility_rate || 0), change_points: Math.round((mentionRate - Number(previous.basic_visibility_rate || 0)) * 100) },
    strong_visibility_rate: { change: recommendationRate - Number(previous.strong_visibility_rate || 0), change_points: Math.round((recommendationRate - Number(previous.strong_visibility_rate || 0)) * 100) },
    missing_count: { change: missingCount - Number(previous.missing_count || 0) },
    competitor_pressure_count: { change: pressureCount - Number(previous.competitor_pressure_count || 0) },
    high_risk_samples: { change: highRiskCount - Number(previous.high_risk_samples || 0) },
  } : null;
  const reportAlerts = delta ? [
    delta.basic_visibility_rate.change <= -0.10 ? { title: "可见度下降", message: "基础可见率较上期下降 10 个百分点以上，需要优先检查未出现场景和内容资产。" } : null,
    delta.strong_visibility_rate.change <= -0.10 ? { title: "推荐能力下降", message: "强可见率较上期下降 10 个百分点以上，需要补充推荐名单、案例和服务证明。" } : null,
    delta.missing_count.change >= 5 ? { title: "未出现场景增加", message: "未出现问题较上期增加 5 条以上，需要补齐可被 AI 引用的内容资产。" } : null,
    delta.competitor_pressure_count.change >= 3 ? { title: "竞品压制增强", message: "出现竞品或替代对象的样本较上期增加 3 条以上，需要处理竞品对比场景。" } : null,
    delta.high_risk_samples.change >= 3 ? { title: "事实风险上升", message: "高风险样本较上期增加 3 条以上，需要复核事实库和纠偏内容。" } : null,
  ].filter(Boolean) as Json[] : [];
  const noSamples = totalSamples === 0;
  const baseSummary = noSamples
    ? "当前尚未完成真实采样，暂不形成诊断结论。建议先完善客户事实库并建立首批监测基线。"
    : `本期基于 ${totalSamples} 条模拟样本：基础可见率 ${percent(mentionRate)}，强可见率 ${percent(recommendationRate)}；${missingCount} 个模拟提问未出现品牌，${pressureCount} 个样本出现竞品或替代对象。`;
  const weeklySummary = comparison.comparable
    ? `${current.label || "本期"}对比${previous.label || "上期"}：${reportAlerts[0]?.message || "本期未触发明显下降或风险异常，建议继续观察推荐率和竞品压制变化。"}`
    : previous && Object.keys(previous).length
      ? `${baseSummary} ${comparison.reason}`
      : `${baseSummary} 当前为基线报告，等待下一期同题采样后形成环比。`;
  const executiveSummary = reportType === "weekly" ? weeklySummary : baseSummary;
  const typeLabel = reportType === "client" ? "首次诊断报告" : reportType === "weekly" ? (previous && Object.keys(previous).length ? "周期跟踪报告" : "基线跟踪报告") : "内部监测简报";
  const title = reportType === "client" ? `${customerName} GEO 可见度诊断报告` : reportType === "weekly" ? `${customerName} GEO 可见度${previous ? "周期" : "基线"}报告` : `${customerName} GEO 监测简报`;

  const sceneMarkdown = scenes.map(scene => `### ${scene.label}\n\n- 样本：${scene.sampleCount} 条\n- 品牌出现率：${percent(scene.mentionRate)}\n- 推荐进入率：${percent(scene.recommendationRate)}\n- 正文证据：${scene.evidenceCount} 条`).join("\n\n");
  const citationCoverage = evidenceRows.filter(item => item.citations.length).length;
  const fixLines = Array.from(new Set(anomalies.map(item => item.recommendedFix).filter(Boolean))).slice(0, 5);
  const baseCausesMarkdown = noSamples ? "- 当前缺少模拟样本，暂不能判断不可见原因。" : [
    `- 未出现场景：${missingCount} 条，说明客户品牌在部分真实需求中尚未进入回答候选。`,
    `- 竞品压制：${pressureCount} 条，需检查竞品是否拥有更清晰的品类、案例或第三方引用。`,
    `- 公开引用覆盖：${citationCoverage}/${evidenceRows.length} 条回答带有可核验来源。`,
    ...fixLines.map(value => `- 分析建议：${value}`),
  ].join("\n");
  const deltaLines = comparison.comparable ? [
    `- 基础可见率：${percent(previous.basic_visibility_rate)} → ${percent(current.basic_visibility_rate)}（${Number(delta?.basic_visibility_rate?.change_points || 0) >= 0 ? "+" : ""}${Number(delta?.basic_visibility_rate?.change_points || 0)} 个百分点）`,
    `- 强可见率：${percent(previous.strong_visibility_rate)} → ${percent(current.strong_visibility_rate)}（${Number(delta?.strong_visibility_rate?.change_points || 0) >= 0 ? "+" : ""}${Number(delta?.strong_visibility_rate?.change_points || 0)} 个百分点）`,
    `- 未出现问题：${Number(previous.missing_count || 0)} → ${missingCount}（${Number(delta?.missing_count?.change || 0) >= 0 ? "+" : ""}${Number(delta?.missing_count?.change || 0)} 条）`,
    `- 竞品压制：${Number(previous.competitor_pressure_count || 0)} → ${pressureCount}（${Number(delta?.competitor_pressure_count?.change || 0) >= 0 ? "+" : ""}${Number(delta?.competitor_pressure_count?.change || 0)} 条）`,
  ].join("\n") : previous && Object.keys(previous).length
    ? `- ${comparison.reason}`
    : "- 当前为首期基线，暂无可比较的上期数据。";
  const alertLines = reportAlerts.map((item: Json) => `- **${item.title || "异常提醒"}**：${item.message || item.summary || "请复核本期变化。"}`).join("\n") || "- 本期未触发显著异常。";
  const causesMarkdown = reportType === "weekly"
    ? `${baseCausesMarkdown}\n\n### 环比变化\n\n${deltaLines}\n\n### 异常提醒\n\n${alertLines}`
    : baseCausesMarkdown;
  const retestMarkdown = [
    "- 内容发布后，优先使用本期未出现问题和重点采购问题进行同题复测。",
    "- 复测必须保持平台、问题文本和采样方式一致。",
    "- 验收比较基础可见率、强可见率、未出现问题和竞品压制变化。",
    "- 未达到目标的行动保留证据并进入下一轮优化，不以单条偶然回答作为完成依据。",
  ].join("\n");
  const appendixMarkdown = `${reportEvidenceMarkdown(anomalies, "本期没有需要展开的异常样本。", true)}\n\n### 方法与边界\n\n- 正文只使用经人工确认的公开信源或明确标注的客户资料。\n- AI 原始引用仅保留在附录，未经独立核验时不作为事实背书。\n- 报告不代表平台私有排序算法，后续变化需要通过同题复测确认。`;
  const sections: ReportSection[] = [
    { id: "conclusion", title: SECTION_TITLES.conclusion, markdown: `## 1. ${SECTION_TITLES.conclusion}\n\n${executiveSummary}`, editable: true },
    { id: "metrics", title: SECTION_TITLES.metrics, markdown: `## 2. ${SECTION_TITLES.metrics}\n\n- 模拟样本：${totalSamples} 条\n- 基础可见率：${percent(mentionRate)}\n- 强可见率：${percent(recommendationRate)}\n- 未出现问题：${missingCount} 条\n- 竞品压制：${pressureCount} 条\n- 高风险样本：${highRiskCount} 条`, editable: false },
    { id: "scenes", title: SECTION_TITLES.scenes, markdown: `## 3. ${SECTION_TITLES.scenes}\n\n${sceneMarkdown || "- 当前四场景样本不足。"}`, editable: false },
    { id: "evidence", title: SECTION_TITLES.evidence, markdown: `## 4. ${SECTION_TITLES.evidence}\n\n${reportEvidenceMarkdown(selectedEvidence)}`, editable: false },
    { id: "causes", title: SECTION_TITLES.causes, markdown: `## 5. ${SECTION_TITLES.causes}\n\n${causesMarkdown}`, editable: true },
    { id: "actions", title: SECTION_TITLES.actions, markdown: `## 6. ${SECTION_TITLES.actions}\n\n${reportType === "weekly" ? "### 下期优先动作\n\n" : ""}${actionMarkdown(actions)}`, editable: true },
    { id: "retest", title: SECTION_TITLES.retest, markdown: `## 7. ${SECTION_TITLES.retest}\n\n${retestMarkdown}`, editable: true },
    { id: "appendix", title: SECTION_TITLES.appendix, markdown: `## 8. ${SECTION_TITLES.appendix}\n\n${appendixMarkdown}`, editable: false },
  ];
  const originalSections = Object.fromEntries(sections.map(section => [section.id, section.markdown])) as Partial<Record<ReportSectionId, string>>;

  return {
    schemaVersion: 3, reportType, title, typeLabel, executiveSummary, metrics, sections, originalSections, scenes,
    evidence: selectedEvidence, allEvidence: evidenceRows, allAnomalies: anomalies, actions,
    sourceSnapshot: {
      generated_at: new Date().toISOString(),
      run_id: current.run_id || "",
      comparison_run_id: previous.run_id || "",
      snapshot_id: current.snapshot_id || "",
      period: current,
      comparison_delta: delta,
      comparison,
      alerts: reportAlerts,
      total_samples: totalSamples,
      evidence_sample_count: scopedSamples.length,
      evidence_ids: anomalies.map(item => item.id),
      question_ids: anomalies.map(item => item.questionId),
      source_evidence_ids: anomalies.flatMap(item => item.verifiedSources.filter(source => source.selected !== false).map(source => source.id)),
      verified_sources: anomalies.flatMap(item => item.verifiedSources.filter(source => source.selected !== false).map(source => ({ ...source, questionId: item.questionId, sampleEvidenceId: item.id }))),
    },
  };
}

export function modelFromVersion(version: Json, fallback: ReportModel): ReportModel {
  const bundle = version?.report || version?.polish?.report_bundle;
  const savedType = ["internal", "client", "weekly"].includes(String(version?.report_type || bundle?.reportType || ""))
    ? String(version?.report_type || bundle?.reportType) as ReportType
    : fallback.reportType;
  if (!bundle || !Array.isArray(bundle.sections)) {
    return { ...fallback, reportType: savedType, title: version?.title || fallback.title, executiveSummary: version?.executive_summary || fallback.executiveSummary, metrics: version?.metrics || fallback.metrics };
  }
  return {
    ...fallback,
    ...bundle,
    reportType: savedType,
    title: version.title || bundle.title || fallback.title,
    executiveSummary: version.executive_summary || bundle.executiveSummary || fallback.executiveSummary,
    metrics: version.metrics || bundle.metrics || fallback.metrics,
  } as ReportModel;
}

export function reportBundle(model: ReportModel, sections: ReportSection[], statuses: Partial<Record<ReportSectionId, string>> = {}) {
  return {
    report_bundle: { ...model, sections },
    section_statuses: Object.fromEntries(sections.map(section => [section.id, statuses[section.id] || (section.editable ? "pending" : "locked")])),
  };
}

export function withReportEvidence(model: ReportModel, selectedIds: string[]): ReportModel {
  const allowed = new Set(selectedIds.map(String));
  const evidence = (model.allEvidence || []).filter(item => allowed.has(String(item.id))).slice(0, 20);
  const sceneCounts = new Map<string, number>();
  const limited = evidence.filter(item => {
    const count = sceneCounts.get(item.sceneId) || 0;
    if (count >= 5) return false;
    sceneCounts.set(item.sceneId, count + 1);
    return true;
  });
  const sections = model.sections.map(section => section.id === "evidence"
    ? { ...section, markdown: `## 4. ${SECTION_TITLES.evidence}\n\n${reportEvidenceMarkdown(limited)}` }
    : section);
  const scenes = model.scenes.map(scene => ({ ...scene, evidenceCount: limited.filter(item => item.sceneId === scene.id).length }));
  return { ...model, evidence: limited, scenes, sections };
}

export function withReportSourceSelection(model: ReportModel, sourceId: string, selected: boolean): ReportModel {
  const updateRows = (items: ReportEvidence[]) => items.map(item => ({
    ...item,
    verifiedSources: (item.verifiedSources || []).map(source => source.id === sourceId ? { ...source, selected } : source),
  }));
  const evidence = updateRows(model.evidence || []);
  const allEvidence = updateRows(model.allEvidence || []);
  const allAnomalies = updateRows(model.allAnomalies || []);
  const sections = model.sections.map(section => section.id === "evidence"
    ? { ...section, markdown: `## 4. ${SECTION_TITLES.evidence}\n\n${reportEvidenceMarkdown(evidence)}` }
    : section.id === "appendix"
      ? { ...section, markdown: `## 8. ${SECTION_TITLES.appendix}\n\n${reportEvidenceMarkdown(allAnomalies, "本期没有需要展开的异常样本。", true)}\n\n### 方法与边界\n\n- 正文只使用经人工确认的公开信源或明确标注的客户资料。\n- AI 原始引用仅保留在附录，未经独立核验时不作为事实背书。\n- 报告不代表平台私有排序算法，后续变化需要通过同题复测确认。` }
      : section);
  return { ...model, evidence, allEvidence, allAnomalies, sections };
}
