import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise, ArrowLeft, ArrowRight, Check, CheckCircle, ClipboardText, DownloadSimple,
  Eye, FilePdf, FloppyDisk, Lock, MagicWand, Plus, UploadSimple, User,
  Warning, X,
} from "@phosphor-icons/react";
import { ApiError, api, download, downloadGet } from "./api";
import { withBasePath } from "./basePath";
import { reportService } from "./services";
import type { AppData, Json, Project, ViewMode } from "./types";
import {
  buildReportModel, modelFromVersion, reportMarkdown, withReportEvidence, withReportSourceSelection,
} from "./reportModel";
import type { ReportModel, ReportSectionId, ReportType } from "./reportModel";

const FORMAL_TYPES: Array<["client" | "weekly", string, string]> = [
  ["client", "首次诊断报告", "建立当前 GEO 可见度基线，解释看不见和被压制的原因。"],
  ["weekly", "周期跟踪报告", "对比本期与上期，说明变化、异常和下一步行动。"],
];

const STORY_NAV: Array<{ id: ReportSectionId; label: string; detail: string }> = [
  { id: "conclusion", label: "结论与指标", detail: "判断与核心数字" },
  { id: "scenes", label: "四场景诊断", detail: "场景表现" },
  { id: "evidence", label: "关键证据", detail: "真实问题与回答" },
  { id: "causes", label: "原因与影响", detail: "不可见与压制原因" },
  { id: "actions", label: "行动方案", detail: "内容资产建设" },
  { id: "retest", label: "复测验收", detail: "完成标准" },
  { id: "appendix", label: "方法附录", detail: "全量异常与边界" },
];

function cx(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
function pct(value: unknown) { const n = Number(value || 0); return `${Math.round(n <= 1 ? n * 100 : n)}%`; }
function formatDate(value: unknown) { if (!value) return "-"; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function reportTypeLabel(value: string) { return value === "weekly" ? "周期跟踪报告" : value === "client" ? "首次诊断报告" : "历史内部简报"; }
function statusLabel(value: string) { return value === "published" ? "已发布" : value === "superseded" ? "历史正式版" : value === "editing" ? "编辑中" : value === "draft" ? "检查点" : "草稿"; }
function reportLead(markdown: string, fallback: string) { return String(markdown || "").split(/\n{2,}/).map(row => row.trim()).find(row => row && !row.startsWith("#") && !row.startsWith("-") && !/^\d+\.\s/.test(row)) || fallback; }
function sectionBody(markdown: string) { return String(markdown || "").replace(/^##\s+\d+\.\s+[^\n]+\n*/u, "").trim(); }
function downloadText(filename: string, content: string) { const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }

function Button({ children, variant = "primary", icon: Icon, ...props }: any) {
  return <button className={cx("button", `button-${variant}`)} {...props}>{Icon && <Icon size={17} weight="bold" />}{children}</button>;
}

function Badge({ children, tone = "neutral" }: { children: any; tone?: string }) { return <span className={cx("badge", `badge-${tone}`)}>{children}</span>; }

function InlineMarkdown({ markdown }: { markdown: string }) {
  return <div className="report-markdown">{String(markdown || "").split("\n").map((raw, index) => {
    const line = raw.trim();
    if (!line) return <div className="report-markdown-space" key={index} />;
    if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
    if (line.startsWith("## ")) return <h2 key={index}>{line.replace(/^##\s+\d+\.\s*/, "").replace(/^##\s+/, "")}</h2>;
    if (/^\d+\.\s/.test(line)) return <div className="report-numbered" key={index}><span>{line.match(/^\d+/)?.[0]}</span><p>{line.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "")}</p></div>;
    if (line.startsWith("- ")) return <div className="report-bullet" key={index}><span>•</span><p>{line.slice(2).replace(/\*\*/g, "")}</p></div>;
    return <p key={index}>{line.replace(/\*\*/g, "")}</p>;
  })}</div>;
}

function MetricStrip({ model }: { model: ReportModel }) {
  const metrics = model.metrics || {};
  const ready = Number(metrics.total_samples || 0) > 0;
  return <div className="report-reader-metrics">
    <div><span>模拟样本</span><strong>{ready ? metrics.total_samples : "待采样"}</strong></div>
    <div><span>基础可见率</span><strong>{ready ? pct(metrics.brand_mention_rate) : "暂不可诊断"}</strong></div>
    <div><span>强可见率</span><strong>{ready ? pct(metrics.brand_recommendation_rate) : "暂不可诊断"}</strong></div>
    <div><span>未出现问题</span><strong>{ready ? `${metrics.missing_count || 0} 条` : "待采样"}</strong></div>
    <div><span>竞品压制</span><strong>{ready ? `${metrics.competitor_pressure_count || 0} 条` : "待采样"}</strong></div>
  </div>;
}

function EvidenceList({ items }: { items: Json[] }) {
  return <div className="report-reader-evidence">{items.length ? items.map(item => <article key={item.id}>
    <div><Badge>{item.sceneLabel}</Badge><strong>{item.questionId} · {item.question}</strong></div>
    <p>{item.answerExcerpt || "当前回答没有可展示的正文片段。"}</p>
    <div className="report-reader-tags"><Badge tone={item.brandMentioned ? "success" : "danger"}>{item.brandMentioned ? "品牌已出现" : "品牌未出现"}</Badge><Badge tone={item.brandRecommended ? "success" : "warning"}>{item.brandRecommended ? "进入推荐" : "未进入推荐"}</Badge>{item.competitors?.length > 0 && <span>竞品/替代对象：{item.competitors.join("、")}</span>}</div>
    {(item.verifiedSources || []).filter((source: Json) => source.selected !== false).length > 0 && <div className="report-verified-sources"><strong>已确认信源</strong>{item.verifiedSources.filter((source: Json) => source.selected !== false).map((source: Json) => <div key={source.id}><Badge tone="success">{source.sourceTypeLabel || "已确认"}</Badge><span>{source.url?.startsWith("http") ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</span>{source.sourceLocation && <small>{source.sourceLocation}</small>}<p>{source.excerpt}</p></div>)}</div>}
    {item.citations?.length > 0 && <details className="report-raw-citations"><summary>查看全部来源（{item.citations.length}）</summary><p>以下为 AI 原始引用，未经独立核验。</p><div className="report-reader-citations">{item.citations.map((citation: Json, index: number) => citation.url ? <a key={`${citation.url}-${index}`} href={citation.url} target="_blank" rel="noreferrer">{citation.title || "AI 原始引用"}</a> : <span key={`${citation.title}-${index}`}>{citation.title}</span>)}</div></details>}
  </article>) : <div className="report-reader-empty">当前没有可展示的代表证据。</div>}</div>;
}

export function ReportReader({ model, customerName = "", logoUrl = "", serviceBrand = true }: { model: ReportModel; customerName?: string; logoUrl?: string; serviceBrand?: boolean }) {
  const section = (id: ReportSectionId) => model.sections.find(item => item.id === id);
  return <article className="report-reader">
    <header className="report-reader-cover">
      <div className="report-reader-brand">{logoUrl ? <img src={logoUrl} alt={`${customerName || "客户"} Logo`} /> : <span>{customerName || model.title.split(" GEO")[0]}</span>}<Badge tone="success">模拟报告</Badge></div>
      <p>{model.typeLabel}</p><h1>{model.title}</h1><strong>{model.executiveSummary}</strong>
    </header>
    <section><span className="report-reader-index">01</span><h2>本期结论与核心指标</h2><InlineMarkdown markdown={sectionBody(section("conclusion")?.markdown || "")} /><MetricStrip model={model} /></section>
    <section><span className="report-reader-index">02</span><h2>四场景可见度诊断</h2><div className="report-reader-scenes">{model.scenes.map(scene => <article key={scene.id}><h3>{scene.label}</h3><strong>{scene.sampleCount} 条样本</strong><span>品牌出现率 {pct(scene.mentionRate)}</span><span>推荐进入率 {pct(scene.recommendationRate)}</span></article>)}</div></section>
    <section><span className="report-reader-index">03</span><h2>关键问题与回答证据</h2><EvidenceList items={model.evidence} /></section>
    <section><span className="report-reader-index">04</span><h2>不可见或被压制的原因</h2><InlineMarkdown markdown={sectionBody(section("causes")?.markdown || "")} /></section>
    <section><span className="report-reader-index">05</span><h2>内容资产行动方案</h2><InlineMarkdown markdown={sectionBody(section("actions")?.markdown || "")} /></section>
    <section><span className="report-reader-index">06</span><h2>复测与验收标准</h2><InlineMarkdown markdown={sectionBody(section("retest")?.markdown || "")} /></section>
    <details className="report-reader-appendix"><summary>查看全量异常证据与方法说明</summary><EvidenceList items={model.allAnomalies || []} /><InlineMarkdown markdown={sectionBody(section("appendix")?.markdown || "")} /></details>
    {serviceBrand && <footer><img src={withBasePath("/assets/geo-logo.svg")} alt="GEO Agent" /><span>GEO Agent · 虚构模拟演示</span></footer>}
  </article>;
}

function wholePolishPatches(model: ReportModel, result: Json) {
  const sections = Object.fromEntries(model.sections.map(item => [item.id, item.markdown])) as Record<ReportSectionId, string>;
  const findings = (result.key_findings || []).map((item: string) => `- ${item}`).join("\n");
  const actions = (result.next_actions || []).map((item: string, index: number) => `${index + 1}. ${item}`).join("\n");
  const caveats = (result.caveats || []).map((item: string) => `- ${item}`).join("\n");
  return {
    conclusion: `## 1. 本期诊断结论\n\n${result.executive_summary || model.executiveSummary}${findings ? `\n\n### 关键发现\n\n${findings}` : ""}`,
    causes: `${sections.causes}${result.recommendation_summary ? `\n\n### 诊断解释\n\n${result.recommendation_summary}` : ""}`,
    actions: `${sections.actions}${actions ? `\n\n### 优先执行顺序\n\n${actions}` : ""}`,
    retest: `${sections.retest}${caveats ? `\n\n### 数据边界与注意事项\n\n${caveats}` : ""}`,
  } as Partial<Record<ReportSectionId, string>>;
}

function applyPatches(model: ReportModel, patches: Partial<Record<ReportSectionId, string>>) {
  const sections = model.sections.map(item => patches[item.id] ? { ...item, markdown: patches[item.id]! } : item);
  const conclusion = sections.find(item => item.id === "conclusion")?.markdown || "";
  return { ...model, sections, executiveSummary: reportLead(conclusion, model.executiveSummary) };
}

function clientWarnings(model: ReportModel, statuses: Json) {
  const warnings: string[] = [];
  if (!Number(model.metrics?.total_samples || 0)) warnings.push("当前没有模拟样本。");
  if (!model.evidence?.length) warnings.push("尚未选择代表证据。");
  if (!(model.evidence || []).some(item => (item.verifiedSources || []).some(source => source.selected !== false))) warnings.push("正文尚未选用人工确认的公开信源或客户资料依据。");
  model.scenes.forEach(scene => { if (!model.evidence.some(item => item.sceneId === scene.id)) warnings.push(`${scene.label}尚未选择代表证据。`); });
  const pending = ["conclusion", "causes", "actions", "retest"].filter(id => !["reviewed", "ai_applied"].includes(statuses[id]));
  if (pending.length) warnings.push("仍有叙事章节未标记为已审核。");
  if (!model.actions?.length) warnings.push("当前没有结构化行动项。");
  return Array.from(new Set(warnings));
}

export function ReportCenter({ data, project, projectId, mode, notify }: { data: AppData; project?: Project; projectId: string; mode: ViewMode; notify: (message: string, type?: string) => void }) {
  const periods = data.trends?.periods || [];
  const defaultRun = String([...periods].reverse()[0]?.run_id || "");
  const [screen, setScreen] = useState<"center" | "wizard">("center");
  const [drafts, setDrafts] = useState<Json[]>([]);
  const [versions, setVersions] = useState<Json[]>(data.reportVersions || []);
  const [activeDraft, setActiveDraft] = useState<Json | null>(null);
  const [reportType, setReportType] = useState<"client" | "weekly">("client");
  const [runId, setRunId] = useState(defaultRun);
  const [comparisonRunId, setComparisonRunId] = useState("");
  const [activeSection, setActiveSection] = useState<ReportSectionId>("conclusion");
  const [busy, setBusy] = useState(false);
  const [aiState, setAiState] = useState<"idle" | "running" | "success" | "error">("idle");
  const [aiError, setAiError] = useState("");
  const [saveState, setSaveState] = useState("已保存");
  const [publishWarnings, setPublishWarnings] = useState<Json[]>([]);
  const [sectionSuggestion, setSectionSuggestion] = useState<Json | null>(null);
  const [previewVersion, setPreviewVersion] = useState<Json | null>(null);
  const [centerTypeFilter, setCenterTypeFilter] = useState("all");
  const [centerStatusFilter, setCenterStatusFilter] = useState("all");
  const [centerRunFilter, setCenterRunFilter] = useState("all");
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalAccount, setPortalAccount] = useState<Json>({ username: "", status: "active", password: "" });
  const [brand, setBrand] = useState<Json>({ logo_available: false });
  const saveTimer = useRef<number | null>(null);
  const draftRef = useRef<Json | null>(null);
  const saveQueue = useRef<Promise<Json | null>>(Promise.resolve(null));
  const saveSequence = useRef(0);

  useEffect(() => { draftRef.current = activeDraft; }, [activeDraft]);
  useEffect(() => { setRunId(defaultRun); }, [defaultRun, projectId]);

  async function refreshCenter() {
    if (!projectId) return;
    try {
      const [draftRows, clientRows, weeklyRows] = await Promise.all([
        reportService.listDrafts(projectId), reportService.listVersions(projectId, "client", "", 50), reportService.listVersions(projectId, "weekly", "", 50),
      ]);
      setDrafts(draftRows.drafts || []);
      setVersions([...(clientRows.versions || []), ...(weeklyRows.versions || [])]);
    } catch (error: any) { notify(error.message, "error"); }
  }

  useEffect(() => { setScreen("center"); setActiveDraft(null); setPreviewVersion(null); setPublishWarnings([]); setSectionSuggestion(null); setCenterRunFilter("all"); refreshCenter(); }, [projectId]);
  useEffect(() => {
    if (mode !== "internal" || !drafts.length) return;
    const requestedDraftId = new URLSearchParams(location.search).get("draft_id");
    if (!requestedDraftId) return;
    const requested = drafts.find(item => String(item.draft_id || "") === requestedDraftId);
    if (!requested) return;
    openDraft(requested);
    const url = new URL(location.href);
    url.searchParams.delete("draft_id");
    history.replaceState({}, "", url);
  }, [projectId, mode, drafts]);
  useEffect(() => {
    if (!project?.customer_id) { setBrand({ logo_available: false }); return; }
    reportService.customerBrand(project.customer_id)
      .then(response => setBrand(response.brand || { logo_available: false }))
      .catch(() => setBrand({ logo_available: false }));
  }, [project?.customer_id]);

  function defaultComparison(currentRunId: string) {
    const index = periods.findIndex((item: Json) => String(item.run_id || "") === currentRunId);
    return index > 0 ? String(periods[index - 1]?.run_id || "") : "";
  }

  async function persistDraft(nextReport: ReportModel, statuses: Json, step: number, silent = true) {
    const sequence = ++saveSequence.current;
    setSaveState("保存中…");
    const operation = saveQueue.current.then(async () => {
      const current = draftRef.current;
      if (!current?.draft_id) return null;
      try {
        const response = await reportService.saveDraft(projectId, current.draft_id, { revision: current.revision, report: nextReport, section_status: statuses, current_step: step, llm: current.llm_meta || {} });
        const local = draftRef.current;
        const hasNewerLocalEdit = sequence < saveSequence.current && local?.draft_id === response.draft?.draft_id;
        const nextDraft = hasNewerLocalEdit && local
          ? { ...response.draft, report: local.report, section_status: local.section_status, current_step: local.current_step }
          : response.draft;
        setActiveDraft(nextDraft);
        draftRef.current = nextDraft;
        setSaveState(sequence === saveSequence.current ? "已自动保存" : "等待保存…");
        if (!silent && sequence === saveSequence.current) notify("报告草稿已保存", "success");
        return nextDraft;
      } catch (error: any) {
        setSaveState(error instanceof ApiError && error.status === 409 ? "版本冲突，请刷新" : "保存失败");
        notify(error.message, "error");
        return null;
      }
    });
    saveQueue.current = operation;
    return operation;
  }

  function queueAutosave(nextReport: ReportModel, statuses: Json, step = Number(activeDraft?.current_step || 3)) {
    const next = { ...(draftRef.current || {}), report: nextReport, section_status: statuses, current_step: step };
    setActiveDraft(next); draftRef.current = next; setSaveState("等待保存…");
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      persistDraft(nextReport, statuses, step);
    }, 1500);
  }

  async function flushDraft(stepOverride?: number, silent = true) {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const current = draftRef.current;
    if (!current?.draft_id || !current.report) return null;
    return persistDraft(current.report as ReportModel, current.section_status || {}, stepOverride ?? Number(current.current_step || 3), silent);
  }

  async function returnToCenter() {
    await flushDraft();
    await refreshCenter();
    setScreen("center");
  }

  async function generateNarrative(draft: Json) {
    const model = draft.report as ReportModel;
    setAiState("running"); setAiError("");
    try {
      const response = await reportService.polish(projectId, { report_type: draft.report_type, report_markdown: reportMarkdown(model) });
      const nextReport = applyPatches(model, wholePolishPatches(model, response.result || {}));
      const statuses = { ...(draft.section_status || {}), conclusion: "ai_applied", causes: "ai_applied", actions: "ai_applied", retest: "ai_applied" };
      const saved = await reportService.saveDraft(projectId, draft.draft_id, { revision: draft.revision, report: nextReport, section_status: statuses, current_step: 3, llm: response.llm || {} });
      setActiveDraft(saved.draft); draftRef.current = saved.draft; setAiState("success"); setSaveState("已自动保存");
    } catch (error: any) {
      setAiState("error"); setAiError(error.message || "大模型生成失败");
      setActiveDraft({ ...draft, current_step: 3 }); draftRef.current = { ...draft, current_step: 3 };
    }
  }

  async function createDraft() {
    setBusy(true);
    try {
      const comparison = reportType === "weekly" ? (comparisonRunId || defaultComparison(runId)) : "";
      const model = buildReportModel(data, project, reportType, { runId, comparisonRunId: comparison });
      const response = await reportService.createDraft(projectId, { report_type: reportType, report: model, source_snapshot: model.sourceSnapshot, source_run_id: runId, comparison_run_id: comparison, current_step: 2 });
      setActiveDraft(response.draft); draftRef.current = response.draft; setScreen("wizard"); setActiveSection("conclusion");
      await generateNarrative(response.draft);
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function openDraft(draft: Json) { setActiveDraft(draft); draftRef.current = draft; setScreen("wizard"); setActiveSection("conclusion"); setAiState("idle"); setPublishWarnings([]); setSectionSuggestion(null); }
  async function copyVersion(version: Json) { setBusy(true); try { const response = await reportService.copyVersionToDraft(projectId, version.report_version_id); await refreshCenter(); await openDraft(response.draft); notify("已复制为新的工作草稿", "success"); } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); } }

  function updateNarrative(markdown: string) {
    if (!activeDraft?.report) return;
    const model = activeDraft.report as ReportModel;
    const sections = model.sections.map(item => item.id === activeSection ? { ...item, markdown } : item);
    const nextReport = { ...model, sections, executiveSummary: activeSection === "conclusion" ? reportLead(markdown, model.executiveSummary) : model.executiveSummary };
    const statuses = { ...(activeDraft.section_status || {}), [activeSection]: "edited" };
    queueAutosave(nextReport, statuses);
  }

  function markReviewed() {
    if (!activeDraft?.report) return;
    const statuses = { ...(activeDraft.section_status || {}), [activeSection]: "reviewed" };
    queueAutosave(activeDraft.report, statuses);
  }

  async function polishSection() {
    if (!activeDraft?.report) return;
    const model = activeDraft.report as ReportModel;
    const requestedSectionId = activeSection;
    const section = model.sections.find(item => item.id === requestedSectionId);
    if (!section?.editable) return;
    setBusy(true);
    try {
      const response = await reportService.polish(projectId, { report_type: activeDraft.report_type, section_id: requestedSectionId, section_markdown: section.markdown, evidence_context: { metrics: model.metrics, scenes: model.scenes, evidence: model.evidence, actions: model.actions, source_snapshot: model.sourceSnapshot } });
      setSectionSuggestion({ ...response.result, section_id: requestedSectionId });
      notify("AI 章节草稿已生成，请确认后应用", "success");
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  function applySectionSuggestion() {
    if (!activeDraft?.report || !sectionSuggestion?.section_markdown) return;
    const sectionId = String(sectionSuggestion.section_id || "") as ReportSectionId;
    if (sectionId !== activeSection) return;
    const nextReport = applyPatches(activeDraft.report as ReportModel, { [sectionId]: sectionSuggestion.section_markdown });
    const statuses = { ...(activeDraft.section_status || {}), [sectionId]: "ai_applied" };
    queueAutosave(nextReport, statuses);
    setSectionSuggestion(null);
  }

  function restoreSection() {
    if (!activeDraft?.report) return;
    const model = activeDraft.report as ReportModel;
    const original = model.originalSections?.[activeSection];
    if (!original) return;
    const nextReport = applyPatches(model, { [activeSection]: original });
    const statuses = { ...(activeDraft.section_status || {}), [activeSection]: "restored" };
    queueAutosave(nextReport, statuses);
    setSectionSuggestion(null);
    notify("已恢复该章节的规则原文", "success");
  }

  function toggleEvidence(id: string) {
    if (!activeDraft?.report) return;
    const model = activeDraft.report as ReportModel;
    const selected = new Set(model.evidence.map(item => item.id));
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    const nextReport = withReportEvidence(model, Array.from(selected));
    queueAutosave(nextReport, activeDraft.section_status || {});
  }

  function toggleVerifiedSource(sourceId: string, selected: boolean) {
    if (!activeDraft?.report) return;
    const nextReport = withReportSourceSelection(activeDraft.report as ReportModel, sourceId, selected);
    queueAutosave(nextReport, activeDraft.section_status || {});
  }

  async function checkpoint() {
    if (!activeDraft) return;
    setBusy(true);
    try {
      const current = await flushDraft();
      if (!current) return;
      await reportService.checkpointDraft(projectId, current.draft_id, current.revision);
      await refreshCenter();
      notify("已创建不可变检查点", "success");
    }
    catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function publish(acknowledgeWarnings = false) {
    if (!activeDraft) return;
    setBusy(true);
    try {
      const current = await flushDraft(4);
      if (!current) return;
      const response = await reportService.publishDraft(projectId, current.draft_id, current.revision, acknowledgeWarnings);
      setPublishWarnings([]); notify("正式报告与冻结 PDF 已发布", "success"); await refreshCenter(); setScreen("center"); setActiveDraft(response.draft);
    } catch (error: any) {
      const warnings = error instanceof ApiError ? error.payload?.publish_warnings : null;
      if (warnings?.length) setPublishWarnings(warnings);
      else notify(error.message, "error");
    } finally { setBusy(false); }
  }

  async function previewPdf() {
    if (!activeDraft?.report) return;
    const model = activeDraft.report as ReportModel;
    try { await download(`/api/projects/${projectId}/report-export/pdf`, { report_type: activeDraft.report_type, title: model.title, executive_summary: model.executiveSummary, markdown_text: reportMarkdown(model), metrics: model.metrics }, `${model.title}.pdf`); }
    catch (error: any) { notify(error.message, "error"); }
  }

  async function loadPortalSettings() {
    if (!project?.customer_id) return;
    setPortalOpen(value => !value);
    try {
      const [accountResponse, brandResponse] = await Promise.all([reportService.portalAccount(project.customer_id), reportService.customerBrand(project.customer_id)]);
      setPortalAccount({ ...(accountResponse.account || { username: "", status: "active" }), password: "" }); setBrand(brandResponse.brand || { logo_available: false });
    } catch (error: any) { notify(error.message, "error"); }
  }

  async function savePortalAccount() {
    if (!project?.customer_id) return;
    setBusy(true);
    try { const response = await reportService.savePortalAccount(project.customer_id, portalAccount); setPortalAccount({ ...response.account, password: "" }); notify("客户门户账号已保存", "success"); }
    catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function uploadLogo(file?: File) {
    if (!file || !project?.customer_id) return;
    setBusy(true);
    try {
      const response = await api(`/api/customers/${encodeURIComponent(project.customer_id)}/brand/logo`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) } });
      setBrand(response.brand || {}); notify("客户 Logo 已更新", "success");
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  const publishedVersions = versions.filter(item => ["published", "superseded"].includes(item.status) && ["client", "weekly"].includes(item.report_type)).sort((a, b) => String(b.published_at || b.updated_at).localeCompare(String(a.published_at || a.updated_at)));
  const brandLogoUrl = brand.logo_available && project?.customer_id
    ? withBasePath(`/api/customers/${encodeURIComponent(project.customer_id)}/brand/logo`)
    : "";
  const matchesCenterScope = (item: Json) => {
    if (centerTypeFilter !== "all" && item.report_type !== centerTypeFilter) return false;
    const sourceRun = String(item.source_run_id || item.source_snapshot?.run_id || item.report?.sourceSnapshot?.run_id || "");
    return centerRunFilter === "all" || sourceRun === centerRunFilter;
  };
  const workingDrafts = drafts.filter(item => item.status !== "published");
  const visibleDrafts = workingDrafts.filter(item => matchesCenterScope(item) && ["all", "editing"].includes(centerStatusFilter));
  const visibleVersions = versions.filter(item => matchesCenterScope(item) && (centerStatusFilter === "all" || item.status === centerStatusFilter));

  if (mode === "client") {
    const current = publishedVersions.find(item => item.status === "published") || publishedVersions[0];
    if (!current) return <div className="report-center-empty"><ClipboardText size={28} /><h2>诊断报告准备中</h2><p>正式报告发布后将在这里展示。</p></div>;
    const fallback = buildReportModel(data, project, current.report_type as ReportType);
    const model = modelFromVersion(current, fallback);
    return <div className="client-report-preview"><div className="client-report-actions"><div><Badge tone="success">正式发布版</Badge><strong>V{current.version_no} · {formatDate(current.published_at || current.updated_at)}</strong></div>{current.pdf_available && <Button icon={FilePdf} onClick={() => downloadGet(`/api/projects/${projectId}/report-versions/${current.report_version_id}/pdf`, `${current.title}.pdf`)}>下载正式 PDF</Button>}</div><ReportReader model={model} customerName={project?.customer_name} logoUrl={brandLogoUrl} />{publishedVersions.length > 1 && <section className="client-report-history"><h2>历史正式报告</h2>{publishedVersions.slice(1).map(version => <div key={version.report_version_id}><span>{reportTypeLabel(version.report_type)} · V{version.version_no}</span><small>{formatDate(version.published_at || version.updated_at)}</small>{version.pdf_available && <Button variant="ghost" onClick={() => downloadGet(`/api/projects/${projectId}/report-versions/${version.report_version_id}/pdf`, `${version.title}.pdf`)}>PDF</Button>}</div>)}</section>}</div>;
  }

  if (screen === "center" && previewVersion) {
    const fallback = buildReportModel(data, project, previewVersion.report_type as ReportType);
    const model = modelFromVersion(previewVersion, fallback);
    return <div className="report-version-preview"><div className="report-wizard-top"><Button variant="ghost" icon={ArrowLeft} onClick={() => setPreviewVersion(null)}>返回报告中心</Button><div><Badge tone={previewVersion.status === "published" ? "success" : "warning"}>{statusLabel(previewVersion.status)}</Badge><strong>{reportTypeLabel(previewVersion.report_type)} · V{previewVersion.version_no}</strong></div><div className="row-actions">{previewVersion.pdf_available && <Button variant="secondary" icon={DownloadSimple} onClick={() => downloadGet(`/api/projects/${projectId}/report-versions/${previewVersion.report_version_id}/pdf`, `${previewVersion.title}.pdf`)}>下载 PDF</Button>}<Button variant="secondary" onClick={() => copyVersion(previewVersion)}>复制为草稿</Button></div></div><ReportReader model={model} customerName={project?.customer_name} logoUrl={brandLogoUrl} /></div>;
  }

  if (screen === "center") return <div className="report-center">
    <section className="report-center-command">
      <div><Badge>报告交付</Badge><h2>诊断报告中心</h2><p>从锁定监测批次创建报告，完成审核后发布客户网页和冻结 PDF。</p></div>
      <div className="row-actions"><Button variant="secondary" icon={User} onClick={loadPortalSettings}>客户门户设置</Button><Button icon={Plus} onClick={() => { setScreen("wizard"); setActiveDraft(null); setReportType("client"); setRunId(defaultRun); setComparisonRunId(defaultComparison(defaultRun)); }}>创建报告</Button></div>
    </section>
    {portalOpen && <section className="portal-settings-panel">
      <div className="section-heading"><div><h2>客户门户设置</h2><p>一个客户对应一个固定账号；密码留空时保持不变。</p></div><button className="icon-button" onClick={() => setPortalOpen(false)} aria-label="关闭"><X size={18} /></button></div>
      <div className="portal-settings-grid"><label>客户账号<input value={portalAccount.username || ""} onChange={event => setPortalAccount({ ...portalAccount, username: event.target.value })} placeholder="例如 customer_demo" /></label><label>设置或重置密码<input type="password" value={portalAccount.password || ""} onChange={event => setPortalAccount({ ...portalAccount, password: event.target.value })} placeholder="至少 10 个字符；留空保持" /></label><label>账号状态<select value={portalAccount.status || "active"} onChange={event => setPortalAccount({ ...portalAccount, status: event.target.value })}><option value="active">启用</option><option value="disabled">停用</option></select></label><label className="portal-logo-upload">客户 Logo<span>{brand.logo_available ? "已上传，可重新选择" : "可选，未上传时显示客户名称"}</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={event => uploadLogo(event.target.files?.[0])} /><UploadSimple size={18} /></label></div>
      <div className="row-actions"><a className="button button-secondary" href={withBasePath("/portal.html")} target="_blank" rel="noreferrer">打开客户门户</a><Button onClick={savePortalAccount} disabled={busy}>保存账号</Button></div>
    </section>}
    <section className="report-center-summary"><div><span>进行中草稿</span><strong>{workingDrafts.length}</strong></div><div><span>待发布检查点</span><strong>{versions.filter(item => item.status === "draft").length}</strong></div><div><span>正式报告</span><strong>{publishedVersions.length}</strong></div><div><span>最近发布</span><strong className="report-summary-date">{publishedVersions[0] ? formatDate(publishedVersions[0].published_at || publishedVersions[0].updated_at) : "暂无"}</strong></div></section>
    <section className="report-center-filters" aria-label="报告筛选">
      <label>报告类型<select value={centerTypeFilter} onChange={event => setCenterTypeFilter(event.target.value)}><option value="all">全部类型</option><option value="client">首次诊断</option><option value="weekly">周期跟踪</option></select></label>
      <label>状态<select value={centerStatusFilter} onChange={event => setCenterStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="editing">编辑中</option><option value="draft">检查点</option><option value="published">已发布</option><option value="superseded">历史正式版</option></select></label>
      <label>监测周期<select value={centerRunFilter} onChange={event => setCenterRunFilter(event.target.value)}><option value="all">全部周期</option>{[...periods].reverse().map((period: Json) => <option key={period.run_id} value={period.run_id}>{period.label || period.run_id}</option>)}</select></label>
    </section>
    <section className="report-center-section"><div className="section-heading"><div><h2>工作草稿</h2><p>自动保存的报告制作进度</p></div></div>{visibleDrafts.length ? <div className="report-center-table">{visibleDrafts.map(draft => { const automationRunId = draft.source_snapshot?.automation_run_id || draft.report?.sourceSnapshot?.automation_run_id; return <article key={draft.draft_id}><div><span className="report-draft-badges"><Badge tone="warning">{statusLabel(draft.status)}</Badge>{automationRunId && <Badge tone="success">自动闭环生成</Badge>}</span><strong>{draft.title || reportTypeLabel(draft.report_type)}</strong><span>{reportTypeLabel(draft.report_type)} · 第 {draft.current_step}/4 步 · {formatDate(draft.updated_at)}</span></div><Button variant="secondary" onClick={() => openDraft(draft)}>{Number(draft.current_step || 0) === 4 ? "预览并人工发布" : "继续编辑"}</Button></article>; })}</div> : <div className="report-center-empty compact"><ClipboardText size={24} /><strong>当前筛选下没有工作草稿</strong><span>可调整筛选，或从最近完成的采样批次创建报告。</span></div>}</section>
    <section className="report-center-section"><div className="section-heading"><div><h2>正式与历史版本</h2><p>发布后的报告内容不可原地修改</p></div></div>{visibleVersions.length ? <div className="report-center-table">{[...visibleVersions].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map(version => <article key={version.report_version_id}><div><Badge tone={version.status === "published" ? "success" : version.status === "superseded" ? "neutral" : "warning"}>{statusLabel(version.status)}</Badge><strong>V{version.version_no} · {version.title}</strong><span>{reportTypeLabel(version.report_type)} · {formatDate(version.published_at || version.updated_at)}</span></div><div className="row-actions"><Button variant="ghost" icon={Eye} onClick={() => setPreviewVersion(version)}>预览</Button>{version.pdf_available && <Button variant="ghost" icon={DownloadSimple} onClick={() => downloadGet(`/api/projects/${projectId}/report-versions/${version.report_version_id}/pdf`, `${version.title}.pdf`)}>PDF</Button>}<Button variant="secondary" onClick={() => copyVersion(version)}>复制为草稿</Button></div></article>)}</div> : <div className="report-center-empty compact"><FilePdf size={24} /><strong>当前筛选下没有报告版本</strong><span>检查点和正式发布版会显示在这里。</span></div>}</section>
  </div>;

  if (!activeDraft) return <div className="report-wizard"><div className="report-wizard-top"><Button variant="ghost" icon={ArrowLeft} onClick={() => setScreen("center")}>返回报告中心</Button><div className="report-stepper">{["选择范围", "生成草稿", "编辑审核", "预览发布"].map((label, index) => <span className={index === 0 ? "active" : ""} key={label}><i>{index + 1}</i>{label}</span>)}</div></div><section className="report-scope"><Badge>第 1 步</Badge><h2>选择报告范围</h2><p>正式报告会锁定所选监测批次，后续实时数据不会静默改变已发布内容。</p><div className="report-type-choice">{FORMAL_TYPES.map(([id, label, detail]) => <button key={id} className={reportType === id ? "active" : ""} onClick={() => setReportType(id)}><span>{reportType === id ? <CheckCircle weight="fill" /> : <span className="choice-dot" />}</span><div><strong>{label}</strong><small>{detail}</small></div></button>)}</div><div className="report-scope-fields"><label>本期监测批次<select value={runId} onChange={event => { setRunId(event.target.value); if (reportType === "weekly") setComparisonRunId(defaultComparison(event.target.value)); }}>{periods.length ? [...periods].reverse().map((period: Json) => <option key={period.run_id} value={period.run_id}>{period.label || period.run_id} · {period.total_samples || 0} 条样本</option>) : <option value="">暂无完整批次</option>}</select></label>{reportType === "weekly" && <label>对比批次<select value={comparisonRunId} onChange={event => setComparisonRunId(event.target.value)}><option value="">无上期，生成基线报告</option>{periods.filter((period: Json) => String(period.run_id) !== runId).map((period: Json) => <option key={period.run_id} value={period.run_id}>{period.label || period.run_id} · {period.total_samples || 0} 条样本</option>)}</select></label>}</div><div className="report-scope-lock"><Lock size={20} /><div><strong>发布后锁定</strong><span>指标快照、证据 ID、来源批次、报告正文和 PDF 文件。</span></div></div><div className="report-wizard-actions"><Button variant="ghost" onClick={() => setScreen("center")}>取消</Button><Button icon={ArrowRight} onClick={createDraft} disabled={busy}>{busy ? "正在创建" : "生成报告草稿"}</Button></div></section></div>;

  const model = activeDraft.report as ReportModel;
  const step = Number(activeDraft.current_step || 3);
  const statuses = activeDraft.section_status || {};
  const currentSection = model.sections.find(item => item.id === activeSection);
  const editable = Boolean(currentSection?.editable);
  const selectedIds = new Set(model.evidence.map(item => item.id));
  const warnings = clientWarnings(model, statuses);

  if (step <= 2 || aiState === "running") return <div className="report-wizard"><div className="report-wizard-top"><Button variant="ghost" icon={ArrowLeft} onClick={() => setScreen("center")}>返回报告中心</Button><div className="report-stepper">{["选择范围", "生成草稿", "编辑审核", "预览发布"].map((label, index) => <span className={index <= 1 ? "active" : ""} key={label}><i>{index + 1}</i>{label}</span>)}</div></div><section className="report-generation"><MagicWand size={34} /><Badge tone={aiState === "error" ? "danger" : "success"}>{aiState === "running" ? "正在生成" : aiState === "error" ? "生成未完成" : "规则草稿已就绪"}</Badge><h2>{aiState === "running" ? "正在生成客户可读的诊断解释" : "报告草稿已建立"}</h2><p>{aiState === "running" ? "指标、场景和证据已经锁定，大模型只生成结论、原因、行动和复测说明。" : aiError || "现在可以进入章节审核。"}</p><div className="report-generation-checks"><span><Check /> 指标快照已锁定</span><span><Check /> 四场景与证据已生成</span><span className={aiState === "running" ? "working" : ""}>{aiState === "running" ? "生成解释性正文…" : aiState === "error" ? "可稍后重试 AI 生成" : "解释性正文已生成"}</span></div>{aiState !== "running" && <div className="row-actions">{aiState === "error" && <Button variant="secondary" onClick={() => generateNarrative(activeDraft)}>重试 AI 生成</Button>}<Button onClick={async () => { const saved = await flushDraft(3); if (saved) setActiveDraft(saved); }}>进入编辑审核</Button></div>}</section></div>;

  if (step === 4) return <div className="report-wizard"><div className="report-wizard-top"><Button variant="ghost" icon={ArrowLeft} onClick={() => flushDraft(3).then(saved => saved && setActiveDraft(saved))}>返回编辑</Button><div className="report-stepper">{["选择范围", "生成草稿", "编辑审核", "预览发布"].map((label, index) => <span className="active" key={label}><i>{index + 1}</i>{label}</span>)}</div><span className="report-save-state">{saveState}</span></div><div className="report-publish-layout"><section className="report-publish-check"><Badge>第 4 步</Badge><h2>发布前检查</h2><p>发布后将生成客户网页版本和不可变 PDF。</p>{warnings.length ? <div className="report-warning-list">{warnings.map(item => <div key={item}><Warning size={18} /><span>{item}</span></div>)}</div> : <div className="report-ready"><CheckCircle size={22} weight="fill" /><div><strong>报告已具备发布条件</strong><span>章节、证据和行动方案已完成检查。</span></div></div>}{publishWarnings.length > 0 && <div className="report-publish-confirm"><strong>确认带提醒发布</strong>{publishWarnings.map(item => <p key={item.code}>{item.message}</p>)}<Button variant="danger" onClick={() => publish(true)} disabled={busy}>确认并发布</Button></div>}<div className="report-publish-actions"><Button variant="secondary" icon={FloppyDisk} onClick={checkpoint} disabled={busy}>创建检查点</Button><Button variant="secondary" icon={FilePdf} onClick={previewPdf} disabled={busy}>下载预览 PDF</Button><Button icon={Check} onClick={() => publish(false)} disabled={busy}>{busy ? "正在发布" : "发布正式报告"}</Button></div><details className="report-more-actions"><summary>更多操作</summary><button onClick={() => navigator.clipboard.writeText(reportMarkdown(model))}>复制 Markdown</button><button onClick={() => downloadText(`${model.title}.md`, reportMarkdown(model))}>下载 Markdown</button><button onClick={() => window.print()}>打印当前预览</button></details></section><div className="report-publish-preview"><ReportReader model={model} customerName={project?.customer_name} logoUrl={brandLogoUrl} /></div></div></div>;

  return <div className="report-wizard report-editor">
    <div className="report-wizard-top"><Button variant="ghost" icon={ArrowLeft} onClick={returnToCenter}>返回报告中心</Button><div className="report-stepper">{["选择范围", "生成草稿", "编辑审核", "预览发布"].map((label, index) => <span className={index <= 2 ? "active" : ""} key={label}><i>{index + 1}</i>{label}</span>)}</div><span className={cx("report-save-state", saveState.includes("失败") && "error")}>{saveState}</span></div>
    <div className="report-editor-grid">
      <aside className="report-outline"><div><Badge>{reportTypeLabel(activeDraft.report_type)}</Badge><h2>{model.title}</h2><span>来源批次：{activeDraft.source_run_id || "待采样"}</span></div><nav>{STORY_NAV.map((item, index) => <button key={item.id} className={activeSection === item.id ? "active" : ""} onClick={() => setActiveSection(item.id)}><i>{String(index + 1).padStart(2, "0")}</i><span><strong>{item.label}</strong><small>{item.detail}</small></span>{item.id === "metrics" || !model.sections.find(row => row.id === item.id)?.editable ? <Lock size={14} /> : ["reviewed", "ai_applied"].includes(statuses[item.id]) ? <CheckCircle size={15} weight="fill" /> : null}</button>)}</nav></aside>
      <main className="report-editor-main">
        <div className="report-editor-heading"><div><Badge tone={editable ? "warning" : "neutral"}>{editable ? "叙事可编辑" : "事实已锁定"}</Badge><h2>{STORY_NAV.find(item => item.id === activeSection)?.label}</h2></div>{editable && <div className="row-actions"><Button variant="ghost" icon={ArrowCounterClockwise} onClick={restoreSection} disabled={!model.originalSections?.[activeSection]}>恢复原文</Button><Button variant="secondary" icon={MagicWand} onClick={polishSection} disabled={busy}>生成 AI 草稿</Button><Button icon={Check} onClick={markReviewed}>标记已审核</Button></div>}</div>
        {activeSection === "conclusion" ? <><textarea className="report-narrative-editor" value={currentSection?.markdown || ""} onChange={event => updateNarrative(event.target.value)} aria-label="本期结论编辑器" /><div className="report-locked-preview"><h3>锁定指标</h3><MetricStrip model={model} /></div></> : activeSection === "scenes" ? <div className="report-reader-scenes editor-scenes">{model.scenes.map(scene => <article key={scene.id}><h3>{scene.label}</h3><strong>{scene.sampleCount} 条样本</strong><span>品牌出现率 {pct(scene.mentionRate)}</span><span>推荐进入率 {pct(scene.recommendationRate)}</span></article>)}</div> : activeSection === "evidence" ? <EvidenceList items={model.evidence} /> : activeSection === "appendix" ? <><EvidenceList items={model.allAnomalies} /><InlineMarkdown markdown={currentSection?.markdown || ""} /></> : editable ? <textarea className="report-narrative-editor tall" value={currentSection?.markdown || ""} onChange={event => updateNarrative(event.target.value)} aria-label={`${currentSection?.title || "章节"}编辑器`} /> : <InlineMarkdown markdown={currentSection?.markdown || ""} />}
      </main>
      <aside className="report-inspector">
        <div className="report-inspector-head"><span>{activeSection === "evidence" ? "证据选择" : "章节依据"}</span><Badge tone={editable ? (["reviewed", "ai_applied"].includes(statuses[activeSection]) ? "success" : "warning") : "neutral"}>{editable ? ["reviewed", "ai_applied"].includes(statuses[activeSection]) ? "已审核" : "待审核" : "事实锁定"}</Badge></div>
        {activeSection === "evidence" ? <div className="report-evidence-picker"><p>每个场景最多选择 5 条，正文最多 20 条；已确认信源可单独决定是否随本条证据发布。</p>{model.allEvidence.map(item => <div className="report-evidence-picker-item" key={item.id}><label><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleEvidence(item.id)} /><span><strong>{item.questionId} · {item.question}</strong><small>{item.sceneLabel} · {item.brandMentioned ? "品牌已出现" : "品牌未出现"}</small></span></label>{(item.verifiedSources || []).length > 0 && <div className="report-source-picker">{item.verifiedSources.map(source => <label key={source.id}><input type="checkbox" checked={source.selected !== false} onChange={event => toggleVerifiedSource(source.id, event.target.checked)} /><span><strong>{source.title}</strong><small>{source.sourceTypeLabel} · {source.relationLabel}</small></span></label>)}</div>}</div>)}</div> : <div className="report-inspector-context"><Lock size={22} /><strong>事实边界</strong><p>指标、问题编号、样本状态、竞品名称和已确认信源均来自锁定批次，不能在报告中自由改写。</p>{editable && <><h3>编辑规则</h3><ul><li>可以调整判断表达和执行顺序。</li><li>不能新增未经确认的案例、排名或效果承诺。</li><li>修改后请标记为已审核。</li></ul></>}{editable && sectionSuggestion?.section_id === activeSection && <section className="report-ai-suggestion"><Badge tone="success">AI 草稿待确认</Badge><InlineMarkdown markdown={sectionSuggestion.section_markdown || ""} />{sectionSuggestion.change_summary && <p>{sectionSuggestion.change_summary}</p>}<div className="row-actions"><Button variant="ghost" onClick={() => setSectionSuggestion(null)}>放弃</Button><Button variant="secondary" icon={MagicWand} onClick={polishSection} disabled={busy}>重新生成</Button><Button icon={Check} onClick={applySectionSuggestion}>应用到正文</Button></div></section>}</div>}
      </aside>
    </div>
    <div className="report-editor-footer"><Button variant="secondary" icon={FloppyDisk} onClick={() => flushDraft(3, false)} disabled={busy}>立即保存</Button><Button icon={Eye} onClick={async () => { const saved = await flushDraft(4); if (saved) setActiveDraft(saved); }}>进入预览发布 <ArrowRight /></Button></div>
  </div>;
}
