import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Pulse, ArrowClockwise, ArrowRight, BookOpenText, Buildings,
  Check, CheckCircle, ClipboardText, CloudArrowUp, Database, FileDoc, FilePdf, FilePpt,
  Gear, House, LinkSimple, ListChecks, MagnifyingGlass, MonitorPlay, Plus, Question, SignOut, Sparkle,
  SquaresFour, Target, Trash, TrendDown, TrendUp, UploadSimple, Users, Warning, X,
} from "@phosphor-icons/react";
import { ApiError, api, download, get, post } from "./api";
import { withBasePath } from "./basePath";
import {
  ANALYSIS_FULL_SAMPLE_LIMIT,
  buildAnalysisReviewDecisions,
  buildAnalysisReviewRows,
  getAnalysisExecutionEstimate,
  reviewConflictKey,
  withDefaultConsistentChoices,
} from "./analysisReview";
import type { AnalysisReviewChoices } from "./analysisReview";
import {
  AUTOMATION_SCENES,
  AUTOMATION_STAGE_SEQUENCE,
  automationProgressPercent,
  automationStageLabel,
  automationStatusLabel,
  automationTone,
  summarizeAutomationSelection,
} from "./automationFlow";
import {
  MONITORING_SET_ANGLE_OPTIONS,
  MONITORING_SET_FALLBACK_TEMPLATES,
  MONITORING_SET_SCENES,
  monitoringComparisonPresentation,
  monitoringSceneTargets,
  monitoringTargetTotal,
  monitoringTargetValidation,
  monitoringTrendRows,
} from "./monitoringSets";
import type { AppData, Customer, Json, Project, ViewId, ViewMode } from "./types";
import { CORE_PROJECT_DATASETS, projectDatasetsForView } from "./projectLoadPlan";
import type { ProjectDataset } from "./projectLoadPlan";
import { mergeFactValueLines } from "./factBase";
import { analysisService, automationService, executorService, knowledgeService, monitoringSetService, questionService, reportService, samplingScheduleService, samplingService, settingsService, workspaceService } from "./services";
import { buildReportModel, modelFromVersion, reportBundle, reportMarkdown } from "./reportModel";
import type { ReportModel, ReportSection, ReportSectionId, ReportType } from "./reportModel";
import { ReportCenter } from "./ReportCenter";
import { SourceCenter } from "./SourceCenter";
import { TaskCenter } from "./TaskCenter";

const EMPTY_DATA: AppData = {
  questions: [], samples: [], results: [], recommendations: [], actionTasks: [], taskDrafts: [], recommendationSummary: {}, trends: {}, runs: [], sources: [],
  knowledgeRuns: [], analysisVersions: [], reportVersions: [], factVersions: [], retests: [],
  sourceEvidence: {}, sourceVerificationRuns: [],
  questionSummary: {}, questionSceneSummary: [], questionProfile: {}, questionProfileSaved: false,
  samplerConfigs: { items: [], by_sampler: {}, default_sampler: "doubao_api_websearch" },
  executorStatus: {}, samplingSchedules: { schedules: [], templates: [] },
  monitoringSets: { sets: [], templates: [], angle_options: [], historical_independent_runs: [] },
  automationRuns: { items: [], latest: null, active: null },
};

async function loadSamplingSchedulesCompat(projectId: string): Promise<Json> {
  try {
    return await get(`/api/projects/${projectId}/sampling-schedules`);
  } catch (error) {
    if (error instanceof ApiError && [404, 501].includes(error.status)) {
      return { project_id: projectId, schedules: [], templates: [], backend_available: false };
    }
    throw error;
  }
}

async function loadMonitoringSetsCompat(projectId: string): Promise<Json> {
  try {
    return await monitoringSetService.list(projectId);
  } catch (error) {
    if (error instanceof ApiError && [404, 501].includes(error.status)) {
      return {
        project_id: projectId,
        sets: [],
        templates: MONITORING_SET_FALLBACK_TEMPLATES,
        angle_options: MONITORING_SET_ANGLE_OPTIONS,
        historical_independent_runs: [],
        backend_available: false,
      };
    }
    throw error;
  }
}

const SAMPLING_AUTO_PREFIX = "geo-agent:sampling:auto:";
const SAMPLING_LEASE_PREFIX = "geo-agent:sampling:lease:";
const SAMPLING_TAB_ID_KEY = "geo-agent:sampling:tab-id";
const SAMPLING_LEASE_MS = 30_000;
const SAMPLING_NETWORK_RETRY_DELAYS = [15, 45, 120];
const WEBSEARCH_SAMPLERS = new Set([
  "doubao_api_websearch",
  "deepseek_api_websearch",
  "kimi_api_websearch",
  "qwen_api_websearch",
]);

function isWebsearchSampler(value: any) {
  return WEBSEARCH_SAMPLERS.has(String(value || ""));
}

function readLocalJson(key: string): Json {
  try { return JSON.parse(localStorage.getItem(key) || "{}") as Json; } catch { return {}; }
}

function samplingTabId() {
  const create = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  try {
    const existing = sessionStorage.getItem(SAMPLING_TAB_ID_KEY);
    if (existing) return existing;
    const value = create();
    sessionStorage.setItem(SAMPLING_TAB_ID_KEY, value);
    return value;
  } catch {
    return create();
  }
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

function samplingFatalError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  const status = error instanceof ApiError ? error.status : 0;
  return status === 401 || status === 403 || ["api key", "未配置", "未开通", "鉴权", "unauthorized", "forbidden"].some(value => message.includes(value));
}

const NAV_GROUPS = [
  { label: "总览", items: [
    { id: "overview", label: "可见度总览", icon: SquaresFour },
  ] },
  { label: "建档", items: [
    { id: "assets", label: "内容资产", icon: Buildings },
    { id: "questions", label: "问题题库", icon: Question },
  ] },
  { label: "监测", items: [
    { id: "sampling", label: "样本采集", icon: MonitorPlay },
    { id: "analysis", label: "复核分析", icon: Pulse },
    { id: "sources", label: "信源中心", icon: LinkSimple },
  ] },
  { label: "行动", items: [
    { id: "optimization", label: "任务中心", icon: Target },
  ] },
  { label: "交付", items: [
    { id: "report", label: "报告中心", icon: ClipboardText },
  ] },
] as const;

const CLIENT_NAV = [
  { id: "overview", label: "总览", icon: SquaresFour },
  { id: "optimization", label: "行动方案", icon: Target },
  { id: "report", label: "报告", icon: ClipboardText },
] as const;

const TITLES: Record<ViewId, [string, string]> = {
  overview: ["GEO 可见度总览", "从真实提问中判断品牌是否被看见、推荐，以及被谁压制。"],
  assets: ["客户资料建档", "上传资料并生成可审核的知识库草稿。"],
  questions: ["四场景题库", "管理真实提问、质量审核与批量生成。"],
  sampling: ["采样工作台", "创建多平台监测轮次，并跟踪各平台联网回答采集状态。"],
  analysis: ["大模型复核", "校验自动分析结果，确认后写入正式诊断。"],
  sources: ["信源中心", "核验模型引用、独立公开信源和客户资料依据。"],
  optimization: ["客户行动方案", "把诊断结果转成可交付、可验收、可复测的内容任务。"],
  report: ["GEO 可见度诊断报告", "面向客户的结论、证据、行动和复测标准。"],
  settings: ["系统设置", "管理运行环境、大模型与采样配置。"],
};

function queryState(): { mode: ViewMode; view: ViewId } {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") === "client" ? "client" : "internal";
  const raw = params.get("view") as ViewId | null;
  const allowed: ViewId[] = mode === "client" ? ["overview", "optimization", "report"] : Object.keys(TITLES) as ViewId[];
  return { mode, view: raw && allowed.includes(raw) ? raw : "overview" };
}

function setQuery(mode: ViewMode, view: ViewId) {
  const url = new URL(location.href); url.searchParams.set("mode", mode); url.searchParams.set("view", view);
  if (view !== "optimization") url.searchParams.delete("baseline_run_id");
  history.pushState({}, "", url);
}

function cn(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
function pct(value: any) { const n = Number(value || 0); return `${Math.round(n <= 1 ? n * 100 : n)}%`; }
function formatDate(value: any) { if (!value) return "-"; const d = new Date(value); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function downloadTextFile(filename: string, content: string, type = "text/plain") { const blob = new Blob([content], { type: `${type};charset=utf-8` }); const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = filename; anchor.click(); URL.revokeObjectURL(href); }
async function copyText(text: string, label = "文本") { try { await navigator.clipboard.writeText(text); } catch { await post("/api/copy-text", { text, label }); } }

function Button({ children, variant = "primary", icon: Icon, ...props }: any) {
  return <button className={cn("button", `button-${variant}`)} {...props}>{Icon && <Icon size={17} weight="bold" />}{children}</button>;
}

function Badge({ children, tone = "neutral" }: { children: any; tone?: string }) { return <span className={cn("badge", `badge-${tone}`)}>{children}</span>; }

function SelectionCheckbox({ checked, indeterminate = false, label, onChange, disabled = false }: { checked: boolean; indeterminate?: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (inputRef.current) inputRef.current.indeterminate = indeterminate; }, [indeterminate]);
  return <label className="question-checkbox-control" title={label}><input ref={inputRef} type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={event => onChange(event.target.checked)} /></label>;
}

function StatePanel({ kind, title, description, action }: { kind: "loading" | "empty" | "error" | "success"; title: string; description?: string; action?: any }) {
  const icons = { loading: Pulse, empty: BookOpenText, error: Warning, success: CheckCircle };
  const Icon = icons[kind];
  return <div className={cn("state-panel", `state-${kind}`)}><Icon size={24} /><div><strong>{title}</strong>{description && <p>{description}</p>}</div>{action}</div>;
}

function Modal({ open, onOpenChange, title, description, children }: any) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content
      className="dialog-content"
      onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement as HTMLElement; }}
      onCloseAutoFocus={event => {
        if (!returnFocusRef.current) return;
        event.preventDefault();
        returnFocusRef.current.focus();
      }}
    >
      <div className="dialog-head"><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div><Dialog.Close asChild><button className="icon-button" aria-label="关闭"><X size={18} /></button></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

function AppShell({ mode, view, customers, projects, customerId, projectId, onCustomer, onProject, onView, onMode, overviewMeta, questionMeta, onRefresh, children }: any) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = mode === "client" ? [{ label: "客户视图", items: CLIENT_NAV }] : NAV_GROUPS;
  return <div className="app-shell">
    <aside className={cn("sidebar", mobileOpen && "sidebar-open")}>
      <div className="brand"><img className="brand-logo" src={withBasePath("/assets/geo-logo.svg")} alt="GEO Agent" /><button className="icon-button mobile-only" onClick={() => setMobileOpen(false)} aria-label="关闭导航"><X /></button></div>
      <nav aria-label="工作区导航">{nav.map((group: any) => <div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div>{group.items.map((item: any) => { const Icon = item.icon; return <button key={item.id} className={cn("nav-item", view === item.id && "active")} onClick={() => { onView(item.id); setMobileOpen(false); }}><Icon size={18} weight={view === item.id ? "fill" : "regular"} /><span>{item.label}</span></button>; })}</div>)}</nav>
      {mode === "internal" && <div className="sidebar-bottom"><button className={cn("nav-item", view === "settings" && "active")} onClick={() => onView("settings")}><Gear size={18} /><span>系统设置</span></button><button className="nav-item" onClick={onMode}><Users size={18} /><span>客户模式</span></button><button className="nav-item" onClick={() => post("/api/auth/logout", {}).finally(() => location.href = withBasePath("/login"))}><SignOut size={18} /><span>退出登录</span></button><div className="quick-search"><MagnifyingGlass size={15} /><span>快速搜索</span><kbd>⌘ K</kbd></div></div>}
      {mode === "client" && <div className="sidebar-bottom"><button className="nav-item" onClick={onMode}><Users size={18} /><span>返回工作台</span></button><div className="quick-search"><MagnifyingGlass size={15} /><span>快速搜索</span><kbd>⌘ K</kbd></div></div>}
    </aside>
    <main className="main-stage">
      <header className="context-bar">
        <button className="icon-button mobile-only" onClick={() => setMobileOpen(true)} aria-label="打开导航"><ListChecks size={20} /></button>
        <div className="context-select"><label>当前客户</label><select value={customerId} onChange={e => onCustomer(e.target.value)}>{customers.map((c: Customer) => <option key={c.customer_id} value={c.customer_id}>{c.name}</option>)}</select></div>
        <div className="context-select context-project"><label>当前项目</label><select value={projectId} onChange={e => onProject(e.target.value)}>{projects.map((p: Project) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}</select></div>
        {view === "overview" ? <div className="overview-context"><h1>GEO 可见度总览</h1><span><Users size={14} />{overviewMeta.customerName}</span><span><Database size={14} />{overviewMeta.sampleCount} 条模拟样本</span><span className="overview-context-time">最近采样 {overviewMeta.sampledAt || "待建立"}</span><button className="icon-button" onClick={onRefresh} aria-label="刷新总览"><ArrowClockwise size={17} /></button></div> : view === "questions" ? <div className="overview-context question-context"><h1>四场景题库</h1><span><Question size={14} />{questionMeta.primaryCount} 道可见度题</span><span><ListChecks size={14} />{questionMeta.pendingCount} 道待审核</span><span className="overview-context-time">{questionMeta.advancedCount} 道高级题目</span><button className="icon-button" onClick={onRefresh} aria-label="刷新题库"><ArrowClockwise size={17} /></button></div> : <Badge tone={mode === "client" ? "success" : "neutral"}>{mode === "client" ? "客户模式" : "演示工作台"}</Badge>}
      </header>
      {children}
    </main>
  </div>;
}

function PageHeader({ view, onRefresh, busy }: { view: ViewId; onRefresh: () => void; busy: boolean }) {
  return <div className="page-header"><div><h1>{TITLES[view][0]}</h1><p>{TITLES[view][1]}</p></div><Button variant="secondary" icon={ArrowClockwise} onClick={onRefresh} disabled={busy}>{busy ? "载入中" : "刷新"}</Button></div>;
}

function Metric({ label, value, detail, delta, deltaUnit = "", inverse = false }: any) {
  const deltaPositive = inverse ? Number(delta) <= 0 : Number(delta) >= 0;
  return <div className="metric"><span>{label}</span><strong>{value}</strong><div className="metric-detail">{delta !== undefined && <Badge tone={deltaPositive ? "success" : "danger"}>{Number(delta) >= 0 ? <TrendUp /> : <TrendDown />}{Math.abs(Number(delta))}{deltaUnit}</Badge>}{detail}</div></div>;
}

function MonitoringComparisonIndicator({ comparison, deltaPoints = null }: { comparison?: Json; deltaPoints?: number | null }) {
  const presentation = monitoringComparisonPresentation(comparison || {}, deltaPoints);
  const Icon = presentation.code === "same_question_scope"
    ? deltaPoints === 0 ? ArrowRight : Number(deltaPoints) > 0 ? TrendUp : TrendDown
    : presentation.code === "sampling" ? Pulse
      : presentation.code === "baseline_period" ? Target
        : presentation.tone === "warning" || presentation.tone === "danger" ? Warning : ArrowRight;
  return <span className={cn("monitoring-comparison", `comparison-${presentation.tone}`)} title={String(comparison?.reason || presentation.label)}><Icon size={13} weight="bold" />{presentation.label}</span>;
}

function Overview({ data, project, reload, onNavigate }: { data: AppData; project?: Project; reload: () => void; onNavigate: (view: ViewId) => void }) {
  const [issueTab, setIssueTab] = useState<"missing" | "pressure">("missing");
  const [trendData, setTrendData] = useState<Json>(data.trends || {});
  const [trendBusy, setTrendBusy] = useState(false);
  const [trendError, setTrendError] = useState("");
  const projectId = String(project?.project_id || "");
  useEffect(() => { setTrendData(data.trends || {}); }, [projectId, data.trends?.active_baseline_run_id, data.trends?.current?.updated_at, data.trends?.periods?.length]);
  async function selectTrendSeries(baselineRunId: string) {
    if (!projectId || !baselineRunId || baselineRunId === trendData.active_baseline_run_id) return;
    setTrendBusy(true);
    setTrendError("");
    try { setTrendData(await monitoringSetService.trends(projectId, baselineRunId, 6)); }
    catch (error: any) { setTrendError(error.message || "趋势载入失败"); }
    finally { setTrendBusy(false); }
  }
  const summary = data.status?.analysis_summary || {};
  const samples = data.samples;
  const sampleCount = samples.length || Number(data.status?.sample_row_count || summary.total_samples || 0);
  const hasSamples = sampleCount > 0;
  const current = trendData?.current || trendData?.periods?.at(-1);
  const previous = trendData?.previous || trendData?.periods?.at(-2);
  const missing = (samples.length ? samples.filter(s => !s.brand_mentioned).length : 0) || current?.missing_count || Math.max(0, Number(summary.total_samples || 0) - Number(summary.brand_mentions || 0));
  const pressure = (samples.length ? samples.filter(s => (s.competitors || []).length).length : 0) || current?.competitor_pressure_count || 0;
  const scenes = (data.status?.scene_score_breakdown || []).filter((s: Json) => ["demand_solution", "vendor_selection", "budget_case_process", "competitor_compare"].includes(s.code));
  const periods = trendData?.periods || [];
  const trendRows = monitoringTrendRows(periods).slice(-6).reverse();
  const comparison = trendData?.comparison || current?.comparison_to_previous || {};
  const hasComparablePrevious = Boolean(current && previous && comparison.comparable);
  const rateDelta = comparison.comparable && trendData.delta?.basic_visibility_rate ? Number(trendData.delta.basic_visibility_rate.change_points || 0) : null;
  const recommendationDelta = comparison.comparable && trendData.delta?.strong_visibility_rate ? Number(trendData.delta.strong_visibility_rate.change_points || 0) : null;
  const missingDelta = comparison.comparable && trendData.delta?.missing_count ? Number(trendData.delta.missing_count.change || 0) : null;
  const pressureDelta = comparison.comparable && trendData.delta?.competitor_pressure_count ? Number(trendData.delta.competitor_pressure_count.change || 0) : null;
  const missingIssues = data.results.filter(result => !result.brand_mentioned).slice(0, 10);
  const pressureIssues = data.results.filter(result => (result.competitors || []).length).slice(0, 10);
  const issueItems = issueTab === "missing" ? missingIssues : pressureIssues;
  return <>
    <section className="metric-grid overview-metrics">
      <Metric label="看得见" value={hasSamples ? pct(summary.brand_mention_rate) : "待采样"} detail={hasSamples ? `${summary.brand_mentions || 0}/${sampleCount} 条回答出现品牌` : "完成真实采样后计算"} delta={hasSamples && rateDelta !== null ? rateDelta : undefined} deltaUnit="pp" />
      <Metric label="推不推荐" value={hasSamples ? pct(summary.brand_recommendation_rate) : "待采样"} detail={hasSamples ? `${summary.brand_recommendations || 0}/${sampleCount} 条进入推荐名单` : "完成真实采样后计算"} delta={hasSamples && recommendationDelta !== null ? recommendationDelta : undefined} deltaUnit="pp" />
      <Metric label="看不见" value={hasSamples ? `${missing} 条` : "待采样"} detail={hasSamples ? "模拟提问未出现品牌" : "暂不可诊断"} delta={hasSamples && missingDelta !== null ? missingDelta : undefined} deltaUnit="条" inverse />
      <Metric label="被谁压制" value={hasSamples ? `${pressure} 条` : "待采样"} detail={hasSamples ? "出现竞品或替代对象" : "暂不可诊断"} delta={hasSamples && pressureDelta !== null ? pressureDelta : undefined} deltaUnit="条" inverse />
    </section>
    <section className={cn("overview-verdict", hasSamples && missing ? "verdict-warning" : "verdict-neutral")}>
      <Warning size={25} weight="regular" /><div><span>当前判断</span><strong>{!hasSamples ? "待采样，暂不可诊断" : previous && !hasComparablePrevious ? comparison.reason || "监测范围变化，暂不进行环比" : missingDelta && missingDelta > 0 ? "未出现场景增加，需要优先补齐内容资产" : missing ? "仍有未出现场景，需要持续补齐内容资产" : "本期可见度稳定"}</strong></div>{hasSamples && <button className="text-action" onClick={() => onNavigate("optimization")}>查看行动方案 <ArrowRight size={15} /></button>}
    </section>
    {(trendData?.notice || trendError) && <div className="monitoring-trend-notice"><Warning size={17} /><span>{trendError || trendData.notice}</span></div>}
    <section className="overview-monitoring-grid">
      <div className="monitoring-panel trend-table-panel">
        <div className="section-heading compact-heading"><div><h2>持续监测趋势</h2><p>只连接同一不可变题集、相同平台配置且样本完整的周期</p></div><div className="monitoring-series-control">{(trendData.series || []).length > 1 && <select aria-label="选择监测题集趋势" value={trendData.active_baseline_run_id || ""} disabled={trendBusy} onChange={event => selectTrendSeries(event.target.value)}>{(trendData.series || []).map((item: Json) => <option value={item.root_run_id} key={item.root_run_id}>{item.name} · V{item.version} · {item.question_count} 题</option>)}</select>}<Badge>{trendBusy ? "加载中" : `${periods.length || 0} 期`}</Badge></div></div>
        {!current ? <StatePanel kind="empty" title="待建立固定题集基线" description="在采样工作台冻结题集并完成第一期真实采样后显示趋势。" /> : <><div className="monitoring-table-wrap"><table className="monitoring-table"><thead><tr><th>监测周期</th><th>看得见</th><th>推不推荐</th><th>看不见</th><th>被压制</th></tr></thead><tbody>{trendRows.map((period: Json) => { const metricsReady = period.basic_visibility_rate !== null && period.basic_visibility_rate !== undefined; return <tr key={period.run_id}><td><strong>{period.label || `第 ${period.period_number || period.index} 期`}</strong><span>{period.total_samples || 0}/{period.total_tasks || period.total_samples || 0} 条样本 · {period.schedule_name ? `调度：${period.schedule_name}` : period.is_baseline ? "题集基线" : "手动周期"}</span><MonitoringComparisonIndicator comparison={period.comparison_to_previous} deltaPoints={period.visibility_delta_points} /></td><td><strong>{metricsReady ? pct(period.basic_visibility_rate) : "—"}</strong></td><td><strong>{metricsReady ? pct(period.strong_visibility_rate) : "—"}</strong></td><td><strong>{metricsReady ? `${period.missing_count || 0} 条` : "—"}</strong></td><td><strong>{metricsReady ? `${period.competitor_pressure_count || 0} 条` : "—"}</strong></td></tr>; })}</tbody></table></div><div className="monitoring-conclusion"><span>趋势结论</span><strong>{trendData?.verdict?.summary || current.conclusion || "已建立持续监测基线"}</strong><small>{comparison.reason || `当前题集已记录 ${periods.length} 期。`}</small></div></>}
        {(trendData.historical_independent_runs || []).length > 0 && <details className="monitoring-independent-history"><summary>历史独立批次（{trendData.historical_independent_runs.length}）</summary><div>{trendData.historical_independent_runs.slice(0, 8).map((run: Json) => <span key={run.run_id}><strong>{run.name || run.run_id}</strong><small>{run.total_tasks || 0} 题 · {run.comparison_to_previous?.label || "历史独立批次"}</small></span>)}</div></details>}
      </div>
      <div className="monitoring-panel issue-panel"><div className="section-heading compact-heading"><div><h2>未出现场景与竞品压制</h2><p>优先查看影响最大的模拟问题</p></div></div>
        <div className="issue-tabs"><button className={issueTab === "missing" ? "active" : ""} onClick={() => setIssueTab("missing")}>未出现场景 ({missingIssues.length})</button><button className={issueTab === "pressure" ? "active" : ""} onClick={() => setIssueTab("pressure")}>竞品压制 ({pressureIssues.length})</button></div>
        <div className="issue-list">{issueItems.length ? issueItems.map((item: Json, index: number) => <div className="issue-row" key={item.analysis_id || item.question_id}><span className="issue-rank">{index + 1}</span><div><strong>{item.question || item.question_id}</strong><small>{issueTab === "pressure" ? (item.competitors || []).join("、") : item.recommended_fix || "建议补充可引用内容资产"}</small></div><Badge tone={String(item.risk_level).includes("高") ? "danger" : String(item.risk_level).includes("中") ? "warning" : "neutral"}>{item.risk_level || "低"}</Badge></div>) : <StatePanel kind="empty" title={issueTab === "missing" ? "暂无未出现场景" : "暂无竞品压制样本"} />}</div>
      </div>
    </section>
    <SampleTable samples={samples} />
    <section className="section-block scene-detail-section"><div className="section-heading"><div><h2>四个提问场景</h2><p>客户侧统一按四个决策场景查看</p></div></div><div className="scene-grid">{scenes.length ? scenes.map((s: Json) => <div className="scene-card" key={s.code}><div><h3>{({ demand_solution: "品类需求可见", vendor_selection: "推荐名单可见", budget_case_process: "采购决策可见", competitor_compare: "竞品对比可见" } as Json)[s.code]}</h3><Badge tone={s.status === "stable" ? "success" : "warning"}>{s.status_label}</Badge></div><strong>{s.surface_score}/100</strong><div className="progress"><i style={{ width: `${s.surface_score}%` }} /></div><p>{s.summary_text}</p></div>) : <StatePanel kind="empty" title="暂无场景诊断" description="采样并完成分析后显示。" />}</div></section>
  </>;
}

function SampleTable({ samples }: { samples: Json[] }) {
  const [filter, setFilter] = useState("all"); const [page, setPage] = useState(1); const size = 10;
  const filtered = samples.filter(s => filter === "all" || (filter === "mentioned" ? s.brand_mentioned : filter === "missing" ? !s.brand_mentioned : String(s.risk_level).includes("高")));
  const pages = Math.max(1, Math.ceil(filtered.length / size)); const rows = filtered.slice((page - 1) * size, page * size);
  useEffect(() => setPage(1), [filter]);
  return <section className="section-block"><div className="section-heading"><div><h2>监测样本</h2><p>{filtered.length} 条模拟回答</p></div><div className="segmented">{[["all", "全部"], ["mentioned", "提到品牌"], ["missing", "未提到"], ["risk", "高风险"]].map(([id, label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    <div className="table-wrap"><table><thead><tr><th>问题</th><th>品牌出现</th><th>推荐</th><th>风险</th><th>采样时间</th></tr></thead><tbody>{rows.map((s, i) => <tr key={s.sample_id || i}><td><strong>{s.question_id}</strong><span>{s.question}</span></td><td><Badge tone={s.brand_mentioned ? "success" : "neutral"}>{s.brand_mentioned ? "已出现" : "未出现"}</Badge></td><td>{s.brand_recommended ? "是" : "否"}</td><td><Badge tone={String(s.risk_level).includes("高") ? "danger" : "neutral"}>{s.risk_level || "低"}</Badge></td><td>{formatDate(s.collected_at || s.sampled_at || s.created_at)}</td></tr>)}</tbody></table>{!rows.length && <StatePanel kind="empty" title="当前筛选下暂无样本" />}</div>
    {!!rows.length && <div className="pagination"><span>{(page - 1) * size + 1}-{Math.min(page * size, filtered.length)} / {filtered.length} 条，第 {page} / {pages} 页</span><div><Button variant="ghost" disabled={page <= 1} onClick={() => setPage(v => v - 1)}>上一页</Button><Button variant="ghost" disabled={page >= pages} onClick={() => setPage(v => v + 1)}>下一页</Button></div></div>}
  </section>;
}

function Assets({ data, customerId, projectId, customers, projects, reload, reloadGlobal, notify }: any) {
  const input = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [activeRunId, setActiveRunId] = useState("");
  const [runProgress, setRunProgress] = useState("");
  const [customerForm, setCustomerForm] = useState({ name: "", industry: "", region: "", business_summary: "" });
  const [projectForm, setProjectForm] = useState({ customer_id: customerId, name: "", language: "zh-CN", goal: "AI 可见度基线监测" });
  const monitoringPlan = data.project?.monitoring_plan || {};
  const planProviderOptions = data.samplerConfigs?.items || monitoringPlan.provider_options || [];
  const [planForm, setPlanForm] = useState<Json>({ samplers: ["doubao_api_websearch"], primary_sampler: "doubao_api_websearch", cadence: "manual" });
  useEffect(() => setProjectForm(value => ({ ...value, customer_id: customerId })), [customerId]);
  useEffect(() => { setSelectedSources(new Set(data.sources.filter((item: Json) => item.parse_status === "ready").map((item: Json) => item.document_id))); }, [customerId, data.sources]);
  useEffect(() => {
    const samplers = monitoringPlan.samplers?.length ? monitoringPlan.samplers : ["doubao_api_websearch"];
    setPlanForm({ samplers, primary_sampler: monitoringPlan.primary_sampler || samplers[0], cadence: monitoringPlan.cadence || "manual" });
  }, [projectId, monitoringPlan.version, (monitoringPlan.samplers || []).join("|"), monitoringPlan.primary_sampler, monitoringPlan.cadence]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files);
    if (list.length > 10) return notify("单批最多上传 10 个文件", "error");
    if (list.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) return notify("单批文件总量不能超过 100MB", "error");
    setBusy(true); const batch = `ui-${Date.now()}`; let success = 0; const errors: string[] = [];
    try {
      for (const file of list) {
        try { await api(`/api/customers/${customerId}/source-documents/upload`, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name), "X-Upload-Batch-Id": batch } }); success += 1; }
        catch (e: any) { errors.push(`${file.name}：${e.message}`); }
      }
      notify(errors.length ? `已完成 ${success}/${list.length} 个文件；${errors.join("；")}` : `已上传并解析 ${success} 个文件`, errors.length ? "error" : "success");
      await reload();
    } finally { setBusy(false); if (input.current) input.current.value = ""; }
  }
  async function addUrl() {
    const values = Array.from(new Set(urls.split(/\r?\n/).map(value => value.trim()).filter(Boolean)));
    if (!values.length) return notify("请填写至少一个具体网页 URL", "error");
    if (values.length > 10) return notify("单次最多导入 10 个 URL", "error");
    setBusy(true); let success = 0; const errors: string[] = []; const batch = `url-${Date.now()}`;
    try {
      for (const url of values) { try { await post(`/api/customers/${customerId}/source-documents/url`, { url, batch_id: batch }); success += 1; } catch (e: any) { errors.push(`${url}：${e.message}`); } }
      if (!errors.length) setUrls("");
      notify(errors.length ? `已完成 ${success}/${values.length} 个网页；${errors.join("；")}` : `已导入 ${success} 个网页`, errors.length ? "error" : "success");
      await reload();
    } finally { setBusy(false); }
  }
  async function processRun(runId: string, retryFailed = false) {
    setBusy(true); let attempts = 100; let latest: Json = {};
    try {
      while (attempts-- > 0) {
        const result = await knowledgeService.runNext(customerId, runId, retryFailed); latest = result.run || latest;
        setRunProgress(`已处理 ${latest.completed_items || 0}/${latest.total_items || 0}，失败 ${latest.failed_items || 0}`);
        if (result.step?.fatal || !latest.has_more || (retryFailed && result.step?.error)) break;
      }
      notify(Number(latest.failed_items || 0) ? "知识草稿部分完成，可重试失败片段" : "知识草稿已生成，请逐项审核", Number(latest.failed_items || 0) ? "error" : "success");
      await reload(); setDraftOpen(true);
    } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); }
  }
  async function createDraft() {
    const documentIds = Array.from(selectedSources);
    if (!documentIds.length) return notify("请至少选择一份可建档资料", "error");
    setBusy(true);
    try { const result = await knowledgeService.createRun(customerId, documentIds); const runId = result.run?.import_run_id; setActiveRunId(runId || ""); notify("知识库草稿任务已创建", "success"); if (runId) await processRun(runId); }
    catch (e: any) { notify(e.message, "error"); setBusy(false); }
  }
  async function createCustomer() {
    if (!customerForm.name.trim()) return notify("请填写客户名称", "error");
    setBusy(true); try { const result = await workspaceService.createCustomer({ ...customerForm, name: customerForm.name.trim(), target_customers: "" }); setCustomerForm({ name: "", industry: "", region: "", business_summary: "" }); await reloadGlobal("", result.customer?.customer_id || ""); notify("客户已创建，可继续创建项目", "success"); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); }
  }
  async function createProject() {
    if (!projectForm.customer_id || !projectForm.name.trim()) return notify("请选择客户并填写项目名称", "error");
    setBusy(true); try { const result = await workspaceService.createProject({ ...projectForm, name: projectForm.name.trim() }); setProjectForm(value => ({ ...value, name: "" })); await reloadGlobal(result.project?.project_id || "", projectForm.customer_id); notify("项目已创建，请继续完成事实库与题库", "success"); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); }
  }
  function togglePlanSampler(sampler: string) {
    const current = new Set<string>(planForm.samplers || []);
    current.has(sampler) ? current.delete(sampler) : current.add(sampler);
    if (!current.size) return notify("默认监测方案至少保留一个平台", "error");
    const samplers = Array.from(current);
    setPlanForm({ ...planForm, samplers, primary_sampler: samplers.includes(planForm.primary_sampler) ? planForm.primary_sampler : samplers[0] });
  }
  async function saveMonitoringPlan() {
    if (!projectId) return;
    setBusy(true);
    try {
      const result = await workspaceService.saveMonitoringPlan(projectId, planForm);
      notify(result.message || "默认监测方案已保存", result.requires_new_baseline ? "info" : "success");
      await reload();
    } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); }
  }
  return <>
    <Tabs.Root defaultValue={projectId ? "sources" : "facts"}><Tabs.List className="tabs"><Tabs.Trigger value="workspace">客户与项目</Tabs.Trigger><Tabs.Trigger value="sources">资料来源</Tabs.Trigger><Tabs.Trigger value="knowledge">知识库草稿</Tabs.Trigger><Tabs.Trigger value="facts">已确认事实</Tabs.Trigger></Tabs.List>
      <Tabs.Content value="workspace"><div className="settings-grid"><section className="settings-card"><div><h2>新建客户</h2><p>先建立客户主体，再创建独立监测项目。</p></div><label>客户名称<input value={customerForm.name} onChange={e => setCustomerForm({ ...customerForm, name: e.target.value })} /></label><label>行业<input value={customerForm.industry} onChange={e => setCustomerForm({ ...customerForm, industry: e.target.value })} /></label><label>地区<input value={customerForm.region} onChange={e => setCustomerForm({ ...customerForm, region: e.target.value })} /></label><label>业务简介<textarea value={customerForm.business_summary} onChange={e => setCustomerForm({ ...customerForm, business_summary: e.target.value })} /></label><Button icon={Plus} onClick={createCustomer} disabled={busy}>创建客户</Button></section><section className="settings-card"><div><h2>新建项目</h2><p>项目只确定客户与目标；平台在项目监测方案中维护，后续仍可调整。</p></div><label>所属客户<select value={projectForm.customer_id} onChange={e => setProjectForm({ ...projectForm, customer_id: e.target.value })}>{customers.map((item: Customer) => <option value={item.customer_id} key={item.customer_id}>{item.name}</option>)}</select></label><label>项目名称<input value={projectForm.name} onChange={e => setProjectForm({ ...projectForm, name: e.target.value })} /></label><label>项目目标<textarea value={projectForm.goal} onChange={e => setProjectForm({ ...projectForm, goal: e.target.value })} /></label><Button icon={Plus} onClick={createProject} disabled={busy}>创建项目</Button></section></div>{projectId && <section className="monitoring-plan-card"><div className="monitoring-plan-head"><div><span className="eyebrow">项目默认值</span><h2>监测方案</h2><p>采样工作台会默认选中这里的平台。正式复测不读取当前方案，而是严格继承对应基线。</p></div><div className="row-meta"><Badge>方案 v{monitoringPlan.version || 1}</Badge><Badge tone={monitoringPlan.baseline_required ? "warning" : "success"}>{monitoringPlan.baseline_required ? "需要建立基线" : "基线已锁定"}</Badge></div></div><div className="monitoring-plan-options">{planProviderOptions.map((item: Json) => { const selected = (planForm.samplers || []).includes(item.sampler); return <button type="button" key={item.sampler} className={selected ? "active" : ""} aria-pressed={selected} onClick={() => togglePlanSampler(item.sampler)} disabled={busy}><span>{item.label}</span><small>{item.api_key_set ? "Key 已配置" : "Key 未配置"}</small></button>; })}</div><div className="monitoring-plan-fields"><label>主平台<select value={planForm.primary_sampler} onChange={e => setPlanForm({ ...planForm, primary_sampler: e.target.value })}>{planProviderOptions.filter((item: Json) => (planForm.samplers || []).includes(item.sampler)).map((item: Json) => <option key={item.sampler} value={item.sampler}>{item.label}</option>)}</select></label><label>默认频率<select value={planForm.cadence} onChange={e => setPlanForm({ ...planForm, cadence: e.target.value })}><option value="manual">手动</option><option value="weekly">每周</option><option value="monthly">每月</option></select></label><Button onClick={saveMonitoringPlan} disabled={busy || !(planForm.samplers || []).length}>保存监测方案</Button></div>{monitoringPlan.baseline_required && Number(monitoringPlan.version || 1) > 1 && <div className="sampling-picker-warning">平台范围已变化。请用当前方案建立新基线，旧基线仍保留但不再与新方案混做环比。</div>}</section>}<div className="section-heading"><div><h2>当前工作区</h2><p>{customers.length} 个客户 · {projects.length} 个项目 · 当前项目 {projectId || "未选择"}</p></div></div></Tabs.Content>
      <Tabs.Content value="sources"><div className="asset-actions"><div className="action-card"><div className="file-visual"><UploadSimple size={24} /></div><div><h3>上传客户资料</h3><p>支持 PDF、PPTX、DOCX、MD、TXT 与 HTML，单文件不超过 20MB。</p><input ref={input} hidden multiple type="file" accept=".pdf,.pptx,.docx,.md,.txt,.html,.htm" onChange={e => upload(e.target.files)} /><Button icon={CloudArrowUp} onClick={() => input.current?.click()} disabled={busy}>选择文件</Button></div></div><div className="action-card"><div className="file-visual"><ArrowRight size={24} /></div><div><h3>导入指定网页</h3><p>每行一个公开网址，最多 10 个；不会自动爬取整站。</p><div className="inline-form"><textarea value={urls} onChange={e => setUrls(e.target.value)} placeholder="https://example.com/about" /><Button onClick={addUrl} disabled={busy}>导入网页</Button></div></div></div></div>
        <div className="section-heading"><div><h2>来源资料</h2><p>选择要用于本轮建档的资料；提取文字会发送到共享大模型。</p></div><Button icon={Sparkle} onClick={createDraft} disabled={busy || !selectedSources.size}>生成知识库草稿</Button></div><SourceTable items={data.sources} customerId={customerId} selected={selectedSources} onSelected={setSelectedSources} reload={reload} notify={notify} /></Tabs.Content>
      <Tabs.Content value="knowledge"><KnowledgeRuns items={data.knowledgeRuns} busy={busy} progress={runProgress} onOpen={(run: Json) => { setActiveRunId(run.import_run_id); setDraftOpen(true); }} onContinue={(run: Json, retry: boolean) => { setActiveRunId(run.import_run_id); processRun(run.import_run_id, retry); }} /></Tabs.Content>
      <Tabs.Content value="facts"><FactsPanel project={data.project} versions={data.factVersions} customerId={customerId} reload={reload} notify={notify} /></Tabs.Content>
    </Tabs.Root>
    <KnowledgeDialog open={draftOpen} onOpenChange={setDraftOpen} runs={data.knowledgeRuns} activeRunId={activeRunId} customerId={customerId} reload={reload} notify={notify} />
  </>;
}

function SourceTable({ items, customerId, selected, onSelected, reload, notify }: any) {
  const icons: Json = { pdf: FilePdf, pptx: FilePpt, docx: FileDoc };
  if (!items.length) return <StatePanel kind="empty" title="尚未上传资料" description="上传官网资料、公司介绍或产品文档后开始建档。" />;
  return <div className="table-wrap"><table><thead><tr><th><span className="sr-only">选择</span></th><th>资料</th><th>类型</th><th>解析状态</th><th>文字量</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{items.map((item: Json) => { const ext = String(item.file_ext || item.extension || "docx").replace(".", ""); const Icon = icons[ext] || FileDoc; const checked = selected.has(item.document_id); return <tr key={item.document_id}><td><input type="checkbox" checked={checked} disabled={item.parse_status !== "ready"} aria-label={`选择 ${item.display_name || item.original_name}`} onChange={e => { const next = new Set(selected); e.target.checked ? next.add(item.document_id) : next.delete(item.document_id); onSelected(next); }} /></td><td><div className="file-name"><Icon size={22} /><div><strong>{item.display_name || item.original_name}</strong><span>{item.source_url || "本地上传"}</span></div></div></td><td>{ext.toUpperCase()}</td><td><Badge tone={item.parse_status === "ready" ? "success" : item.parse_status === "failed" ? "danger" : "warning"}>{item.parse_status || "已解析"}</Badge></td><td>{item.extracted_chars || 0} 字</td><td>{formatDate(item.updated_at)}</td><td><div className="row-actions">{item.download_available && <a className="button button-ghost" href={withBasePath(`/api/customers/${encodeURIComponent(customerId)}/source-documents/${encodeURIComponent(item.document_id)}/download`)}>下载</a>}<Tooltip.Root><Tooltip.Trigger asChild><button className="icon-button danger" aria-label="删除资料" onClick={async () => { if (!confirm("删除这份尚未建档的资料？")) return; try { await post(`/api/customers/${customerId}/source-documents/${item.document_id}/delete`, {}); await reload(); } catch (e: any) { notify(e.message, "error"); } }}><Trash /></button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip">删除资料</Tooltip.Content></Tooltip.Portal></Tooltip.Root></div></td></tr>; })}</tbody></table></div>;
}

function KnowledgeRuns({ items, busy, progress, onOpen, onContinue }: any) { return <div className="stack">{progress && <div className="status-line" role="status">{progress}</div>}{items.length ? items.map((run: Json) => <div className="run-row" key={run.import_run_id}><button className="run-main" onClick={() => onOpen(run)}><div><strong>{run.name || "知识库草稿"}</strong><span>{run.completed_items || 0}/{run.total_items || 0} 个资料片段 · 草稿 {run.draft_items?.length || 0} 条</span></div></button><Badge tone={run.status === "ready" || run.status === "applied" ? "success" : run.status === "failed" ? "danger" : "warning"}>{run.status}</Badge><div className="row-actions">{run.has_more && <Button variant="secondary" onClick={() => onContinue(run, false)} disabled={busy}>继续</Button>}{Number(run.failed_items || 0) > 0 && <Button variant="secondary" onClick={() => onContinue(run, true)} disabled={busy}>重试失败</Button>}<button className="icon-button" onClick={() => onOpen(run)} aria-label="审核草稿"><ArrowRight /></button></div></div>) : <StatePanel kind="empty" title="尚无知识库草稿" description="在“资料来源”中选择资料并生成草稿。" />}</div>; }

function KnowledgeDialog({ open, onOpenChange, runs, activeRunId, customerId, reload, notify }: any) {
  const run = runs.find((item: Json) => item.import_run_id === activeRunId) || runs[0]; const drafts = run?.draft_items || run?.items || [];
  const safeDefaults = useMemo(() => new Set<string>(drafts.filter((d: Json) => d.selected !== false && !d.conflict && !d.requires_review).map((d: Json) => String(d.draft_id))), [run?.import_run_id, drafts.length]);
  const [selected, setSelected] = useState<Set<string>>(safeDefaults);
  useEffect(() => setSelected(safeDefaults), [safeDefaults]);
  async function apply() { if (!run || !selected.size) return notify("请至少勾选一条已核对的知识草稿", "error"); try { await knowledgeService.apply(customerId, run.import_run_id, Array.from(selected)); notify("已确认内容写入客户知识库并生成新版本", "success"); await reload(); onOpenChange(false); } catch (e: any) { notify(e.message, "error"); } }
  return <Modal open={open} onOpenChange={onOpenChange} title="审核知识库草稿" description="AI 只生成草稿。冲突、案例和资质默认不选，必须由内部人员确认后入库。"><div className="draft-list">{drafts.length ? drafts.map((d: Json) => <label className="draft-item" key={d.draft_id}><div><Badge tone={d.conflict ? "danger" : d.requires_review ? "warning" : "success"}>{d.conflict ? "存在冲突" : d.requires_review ? "需要重点确认" : `${Math.round((d.confidence || 0) * 100)}% 置信度`}</Badge><strong>{d.fact_value}</strong><p>{d.evidence_quote}</p><small>{d.source_name} · {d.source_location}</small></div><input type="checkbox" checked={selected.has(d.draft_id)} aria-label="选择此事实" onChange={e => { const next = new Set(selected); e.target.checked ? next.add(d.draft_id) : next.delete(d.draft_id); setSelected(next); }} /></label>) : <StatePanel kind="empty" title="草稿仍在生成" description="关闭窗口后点击继续或重试失败片段。" />}</div><div className="dialog-actions"><Dialog.Close asChild><Button variant="secondary">暂不应用</Button></Dialog.Close><Button icon={Check} onClick={apply} disabled={!selected.size}>确认写入 {selected.size} 条</Button></div></Modal>;
}

type ConfirmedFactItem = {
  id: string;
  label: string;
  value: string;
  description?: string;
  evidenceUrl?: string;
};

type ConfirmedFactGroup = {
  id: string;
  title: string;
  layout: "details" | "list";
  items: ConfirmedFactItem[];
};

const FACT_GROUPS = [
  { id: "company", title: "企业基本信息", layout: "details" },
  { id: "positioning", title: "品牌定位与目标客户", layout: "details" },
  { id: "offering", title: "产品与服务", layout: "list" },
  { id: "allowed", title: "允许公开表述", layout: "list" },
  { id: "message", title: "推荐介绍", layout: "list" },
  { id: "proof", title: "案例与证明", layout: "list" },
  { id: "competitor", title: "竞品与替代对象", layout: "list" },
  { id: "forbidden", title: "禁用表述", layout: "list" },
  { id: "other", title: "其他已确认信息", layout: "list" },
] as const;

const FACT_KEY_LABELS: Record<string, string> = {
  brand_name: "品牌简称",
  company_full_name: "公司全称",
  website_status: "官网状态",
  public_case_status: "公开案例状态",
  primary_language: "主要语言",
  market_type: "市场类型",
  service_region: "服务地区",
  industry: "所属行业",
  primary_positioning: "核心定位",
  positioning: "核心定位",
  business_keywords: "业务关键词",
  target_customers: "目标客户",
  price_positioning: "价格定位",
  not_positioning_as: "定位边界",
  one_sentence: "一句话介绍",
  short_intro: "简短介绍",
  risk_safe_intro: "审慎介绍",
  contact_phone: "联系电话",
  contact_email: "联系邮箱",
  website: "官方网站",
};

const FACT_TYPE_FALLBACK_LABELS: Record<string, string> = {
  entity: "企业信息",
  industry: "所属行业",
  region: "服务地区",
  positioning: "定位信息",
  target_customer: "目标客户",
  service: "服务内容",
  product: "产品",
  capability: "核心能力",
  allowed_claim: "允许公开表述",
  preferred_message: "推荐介绍",
  proof: "证明材料",
  case: "公开案例",
  qualification: "资质证明",
  contact: "联系方式",
  website: "官方网站",
  custom: "补充信息",
};

function factGroupId(type: string) {
  if (["entity", "industry", "region", "contact", "website"].includes(type)) return "company";
  if (["positioning", "target_customer"].includes(type)) return "positioning";
  if (["service", "product", "capability"].includes(type)) return "offering";
  if (type === "allowed_claim") return "allowed";
  if (type === "preferred_message") return "message";
  if (["proof", "case", "qualification"].includes(type)) return "proof";
  if (type === "competitor") return "competitor";
  if (type === "forbidden_claim") return "forbidden";
  return "other";
}

function splitFactText(value: any) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(line => line.replace(/^(?:[-•·]\s+)/, "").trim())
    .filter(Boolean);
}

function normalizedFactText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
}

function flattenStructuredFactValue(value: any): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(flattenStructuredFactValue).filter(Boolean).join("、");
  if (typeof value === "object") return Object.values(value).map(flattenStructuredFactValue).filter(Boolean).join("；");
  return String(value).trim();
}

function presentFactValue(rawValue: string, fallbackLabel: string) {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return { label: fallbackLabel, value: trimmed, description: "" };
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { label: fallbackLabel, value: flattenStructuredFactValue(parsed), description: "" };
    if (parsed && typeof parsed === "object") {
      const name = String(parsed.service_name || parsed.product_name || parsed.name || "").trim();
      const summary = String(parsed.description || parsed.summary || parsed.value || "").trim();
      const scenarios = flattenStructuredFactValue(parsed.allowed_scenarios || parsed.scenarios || parsed.use_cases);
      const value = name && summary ? `${name}：${summary}` : name || summary || flattenStructuredFactValue(parsed);
      return { label: fallbackLabel, value, description: scenarios ? `适用场景：${scenarios}` : "" };
    }
  } catch {
    return { label: fallbackLabel, value: trimmed, description: "" };
  }
  return { label: fallbackLabel, value: trimmed, description: "" };
}

function buildConfirmedFactGroups(facts: Json[], competitors: Json[], forbidden: Json[]): ConfirmedFactGroup[] {
  const grouped = new Map<string, Map<string, ConfirmedFactItem>>();
  FACT_GROUPS.forEach(group => grouped.set(group.id, new Map()));

  function add(groupId: string, item: ConfirmedFactItem) {
    const values = grouped.get(groupId)!;
    const dedupeKey = normalizedFactText(item.value);
    if (!dedupeKey) return;
    const existing = values.get(dedupeKey);
    if (existing) {
      if (!existing.evidenceUrl && item.evidenceUrl) existing.evidenceUrl = item.evidenceUrl;
      if (!existing.description && item.description) existing.description = item.description;
      return;
    }
    values.set(dedupeKey, item);
  }

  facts.forEach((fact: Json) => {
    const type = String(fact.fact_type || "custom");
    const groupId = factGroupId(type);
    const label = FACT_KEY_LABELS[String(fact.fact_key || "")] || FACT_TYPE_FALLBACK_LABELS[type] || "补充信息";
    splitFactText(fact.fact_value).forEach((rawValue, index) => {
      const presented = presentFactValue(rawValue, label);
      add(groupId, {
        id: `${fact.fact_id || type}-${index}`,
        label: presented.label,
        value: presented.value,
        description: presented.description,
        evidenceUrl: fact.evidence_url || "",
      });
    });
  });

  competitors.forEach((item: Json, index: number) => {
    const value = String(item.name || item.brand_name || item.competitor_name || "").trim();
    const description = [
      item.category ? `类别：${item.category}` : "",
      item.watch_reason ? `关注原因：${item.watch_reason}` : "",
      Array.isArray(item.aliases) && item.aliases.length ? `常见名称：${item.aliases.join("、")}` : "",
    ].filter(Boolean).join("；");
    add("competitor", { id: String(item.competitor_id || `competitor-${index}`), label: "竞品或替代对象", value, description });
  });

  forbidden.forEach((item: Json, index: number) => {
    const value = String(item.claim || item.statement || "").trim();
    const description = [
      item.severity ? `风险级别：${({ high: "高", medium: "中", low: "低" } as Record<string, string>)[String(item.severity).toLowerCase()] || "待确认"}` : "",
      item.reason ? `禁用原因：${item.reason}` : "",
    ].filter(Boolean).join("；");
    add("forbidden", { id: String(item.claim_id || item.forbidden_claim_id || `forbidden-${index}`), label: "禁止对外使用", value, description });
  });

  return FACT_GROUPS.map(group => ({
    ...group,
    layout: group.layout as "details" | "list",
    items: Array.from(grouped.get(group.id)!.values()),
  })).filter(group => group.items.length);
}

function ConfirmedFactsView({ facts, competitors, forbidden, versions, onEdit }: any) {
  const groups = useMemo(() => buildConfirmedFactGroups(facts, competitors, forbidden), [facts, competitors, forbidden]);
  const knowledgeCount = groups.filter(group => !["competitor", "forbidden"].includes(group.id)).reduce((total, group) => total + group.items.length, 0);
  const competitorCount = groups.find(group => group.id === "competitor")?.items.length || 0;
  const forbiddenCount = groups.find(group => group.id === "forbidden")?.items.length || 0;
  const versionStatus: Record<string, string> = { saved: "已保存", active: "当前版本", draft: "草稿", archived: "已归档" };

  return <><div className="section-heading"><div><h2>已确认事实</h2><p>{knowledgeCount} 条有效内容 · {competitorCount} 个竞品 · {forbiddenCount} 条禁用表述，重复内容已自动合并</p></div><Button variant="secondary" onClick={onEdit}>编辑事实库</Button></div>
    {groups.length ? <div className="fact-business-groups">{groups.map(group => <section className="fact-business-group" key={group.id}>
      <div className="fact-business-heading"><div><h3>{group.title}</h3><p>{group.items.length} 项已确认内容</p></div><Badge tone={group.id === "forbidden" ? "danger" : group.id === "allowed" ? "success" : "neutral"}>{group.items.length} 项</Badge></div>
      <div className={cn("fact-business-items", group.layout === "details" ? "fact-business-details" : "fact-business-list")}>{group.items.map((item, index) => <article className="fact-business-item" key={item.id}>
        {group.layout === "list" && <span className="fact-business-index">{index + 1}</span>}
        <div className="fact-business-content">{!["allowed", "competitor", "forbidden"].includes(group.id) && <span className="fact-business-label">{item.label}</span>}<p>{item.value}</p>{item.description && <small className="fact-business-description">{item.description}</small>}<small className="fact-business-source">{item.evidenceUrl ? <a href={item.evidenceUrl} target="_blank" rel="noreferrer">已有公开来源 · 查看来源</a> : "已人工确认"}</small></div>
      </article>)}</div>
    </section>)}</div> : <StatePanel kind="empty" title="暂无已确认事实" />}
    <div className="section-heading"><div><h2>事实库版本</h2><p>每次保存都会保留版本记录。</p></div></div><div className="run-table">{versions.length ? versions.map((version: Json) => <div className="run-row" key={version.fact_base_version_id}><div><strong>V{version.version_no}</strong><span>{formatDate(version.created_at)} · {version.change_summary || "事实库更新"}</span></div><Badge>{versionStatus[String(version.status || "saved")] || "已保存"}</Badge></div>) : <StatePanel kind="empty" title="暂无事实库版本" />}</div>
  </>;
}

function FactsPanel({ project, versions, customerId, reload, notify }: any) {
  const facts = project?.customer_facts || []; const competitors = project?.competitors || []; const forbidden = project?.forbidden_claims || [];
  const factValue = (type: string, key: string) => facts.find((item: Json) => item.fact_type === type && item.fact_key === key)?.fact_value || "";
  const initial = useMemo(() => ({ brand_name: factValue("entity", "brand_name"), company_full_name: factValue("entity", "company_full_name"), website_status: factValue("entity", "website_status"), service_region: factValue("entity", "service_region"), target_customers: factValue("positioning", "target_customers"), positioning: factValue("positioning", "primary_positioning"), services: mergeFactValueLines(facts, "service"), allowed_claims: mergeFactValueLines(facts, "allowed_claim"), competitors_text: competitors.map((item: Json) => [item.name, item.category, item.watch_reason, (item.aliases || []).join("、")].filter(Boolean).join(" | ")).join("\n"), forbidden_claims_text: forbidden.map((item: Json) => [item.claim, item.severity, item.reason].filter(Boolean).join(" | ")).join("\n"), evidence_url: facts.find((item: Json) => item.evidence_url)?.evidence_url || "", evidence_summary: "" }), [project]);
  const [form, setForm] = useState<Json>(initial); const [editing, setEditing] = useState(false);
  useEffect(() => setForm(initial), [initial]);
  async function save() { try { const result = await workspaceService.saveFactBase(customerId, form); notify(`事实库已保存${result.fact_base_version?.version_no ? `，生成 V${result.fact_base_version.version_no}` : ""}`, "success"); setEditing(false); await reload(); } catch (e: any) { notify(e.message, "error"); } }
  if (!editing) return <ConfirmedFactsView facts={facts} competitors={competitors} forbidden={forbidden} versions={versions} onEdit={() => setEditing(true)} />;
  const fields = [["brand_name", "品牌简称"], ["company_full_name", "公司全称"], ["website_status", "官网状态"], ["service_region", "服务地区"], ["target_customers", "目标客户"], ["positioning", "核心定位"], ["services", "服务/产品（每行一项）"], ["allowed_claims", "允许表述（每行一项）"], ["competitors_text", "竞品（名称 | 类别 | 关注原因 | 别名）"], ["forbidden_claims_text", "禁用表述（声明 | 严重度 | 原因）"], ["evidence_url", "公开证据链接"], ["evidence_summary", "本次修改说明"]];
  return <div className="fact-editor"><div className="section-heading"><div><h2>编辑事实库</h2><p>保存前核对案例、资质、排名和效果承诺。</p></div><Button variant="ghost" onClick={() => { setForm(initial); setEditing(false); }}>取消</Button></div><div className="form-grid">{fields.map(([key, label]) => <label key={key}>{label}{["services", "allowed_claims", "competitors_text", "forbidden_claims_text", "positioning", "target_customers", "evidence_summary"].includes(key) ? <textarea value={form[key] || ""} onChange={e => setForm({ ...form, [key]: e.target.value })} /> : <input value={form[key] || ""} onChange={e => setForm({ ...form, [key]: e.target.value })} />}</label>)}</div><div className="dialog-actions"><Button icon={Check} onClick={save}>保存事实库并生成版本</Button></div></div>;
}

function newAutomationIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `automation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function AutomationLaunchDialog({ open, onOpenChange, projectId, notify, reload, initialQuestionIds = [] }: any) {
  const [preview, setPreview] = useState<Json | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQueryText] = useState("");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [acknowledgeCost, setAcknowledgeCost] = useState(false);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    setPreview(null);
    setSelected(new Set());
    setQueryText("");
    setSceneFilter("all");
    setAcknowledgeCost(false);
    setSelectionDirty(false);
    setIdempotencyKey(newAutomationIdempotencyKey());
    setBusy(true);
    const preferredQuestionIds = Array.isArray(initialQuestionIds)
      ? initialQuestionIds.map(String).filter(Boolean)
      : [];
    automationService.preview(
      projectId,
      preferredQuestionIds.length ? preferredQuestionIds : undefined,
    )
      .then(result => {
        if (cancelled) return;
        setPreview(result);
        setSelected(new Set((result.selected_question_ids || []).map(String)));
      })
      .catch((error: any) => {
        if (!cancelled) notify(error.message, "error");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [open, projectId, Array.isArray(initialQuestionIds) ? initialQuestionIds.join("|") : ""]);

  const eligible = preview?.eligible_questions || [];
  const selection = useMemo(
    () => summarizeAutomationSelection(selected, eligible),
    [selected, eligible],
  );
  const visibleQuestions = eligible.filter((item: Json) => {
    const matchesScene = sceneFilter === "all" || item.scene_code === sceneFilter;
    const search = query.trim().toLowerCase();
    return matchesScene && (!search || `${item.question_id} ${item.question}`.toLowerCase().includes(search));
  });
  const configurationBlockers = (preview?.blockers || []).filter(
    (item: Json) => !String(item.code || "").startsWith("scene_quota_")
      && !String(item.code || "").startsWith("scene_empty_")
      && !["question_count_mismatch", "duplicate_question_ids", "ineligible_question_ids"].includes(String(item.code || "")),
  );
  const visibleBlockers = selectionDirty ? configurationBlockers : (preview?.blockers || []);
  const canAttemptStart = Boolean(preview && selection.exact && !configurationBlockers.length && acknowledgeCost);

  function toggleQuestion(questionId: string, checked: boolean) {
    const next = new Set(selected);
    checked ? next.add(questionId) : next.delete(questionId);
    setSelected(next);
    setSelectionDirty(true);
  }

  async function revalidate() {
    const result = await automationService.preview(projectId, Array.from(selected));
    setPreview(result);
    setSelected(new Set((result.selected_question_ids || []).map(String)));
    setSelectionDirty(false);
    return result;
  }

  async function start() {
    if (!selection.exact) {
      notify("请精确选择 40 题，并确保四个场景都至少有 1 题", "error");
      return;
    }
    if (!acknowledgeCost) {
      notify("请先确认真实 API 费用风险", "error");
      return;
    }
    setBusy(true);
    try {
      const checked = await revalidate();
      if (!checked.can_start) {
        notify((checked.blockers || []).map((item: Json) => item.message).join("；") || "启动条件尚未满足", "error");
        return;
      }
      const response = await automationService.start(projectId, {
        selected_question_ids: checked.selected_question_ids,
        preview_hash: checked.preview_hash,
        idempotency_key: idempotencyKey,
        acknowledge_cost: true,
      });
      notify(`自动监测已创建：${response.run?.automation_run_id || "服务端已接管"}`, "success");
      onOpenChange(false);
      await reload();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return <Modal
    open={open}
    onOpenChange={onOpenChange}
    title="启动自动监测"
    description="确认精确 40 题与费用风险后，服务端自动完成采样、复核和报告草稿；报告仍需人工预览发布。"
  >
    <div className="automation-launch-body">
      {busy && !preview ? <StatePanel kind="loading" title="正在核验题目与安全配置" /> : preview ? <>
        <div className="automation-selection-summary">
          {AUTOMATION_SCENES.map(scene => {
            const count = selection.sceneCounts[scene.code] || 0;
            return <div className={count > 0 ? "is-ready" : "is-mismatch"} key={scene.code} title={`系统默认模板 ${scene.target} 题，正式题集可自定义`}>
              <span>{scene.label}</span>
              <strong>{count} 题</strong>
            </div>;
          })}
          <div className={selection.selectedCount === 40 ? "is-ready" : "is-mismatch"}><span>合计</span><strong>{selection.selectedCount}/40</strong></div>
        </div>

        <div className="automation-coverage-row">
          <Badge tone={selection.core === 12 && selection.longTail === 28 ? "success" : "warning"}>核心/长尾 {selection.core}/{selection.longTail}（建议 12/28）</Badge>
          <Badge tone="success">固定监测题 {selection.fixed}</Badge>
          <span>结构比例仅提醒，不阻止启动。</span>
        </div>

        <div className="automation-question-filters">
          <label>搜索题号或问题<input value={query} onChange={event => setQueryText(event.target.value)} placeholder="例如 Q030 或 采购预算" /></label>
          <label>场景<select value={sceneFilter} onChange={event => setSceneFilter(event.target.value)}><option value="all">全部四场景</option>{AUTOMATION_SCENES.map(scene => <option value={scene.code} key={scene.code}>{scene.label}</option>)}</select></label>
          {selectionDirty && <Button variant="secondary" onClick={() => revalidate().catch((error: any) => notify(error.message, "error"))} disabled={busy}>重新核验选择</Button>}
        </div>

        <div className="automation-question-list" role="list" aria-label="自动监测题目范围">
          {visibleQuestions.map((item: Json) => <label className={cn("automation-question-item", selected.has(String(item.question_id)) && "is-selected")} key={item.question_id}>
            <input type="checkbox" checked={selected.has(String(item.question_id))} onChange={event => toggleQuestion(String(item.question_id), event.target.checked)} />
            <span><strong>{item.question_id} · {item.question}</strong><small>{item.scene_label} · {item.question_tier === "core" ? "核心题" : "长尾题"} · {item.fixed_monitoring ? "固定监测" : "普通监测"}</small></span>
          </label>)}
          {!visibleQuestions.length && <StatePanel kind="empty" title="当前筛选下没有可选题" />}
        </div>

        <div className="automation-preflight-grid">
          <section>
            <h3>配置状态</h3>
            <div className="automation-readiness-list">
              <span><Badge tone={preview.readiness?.ark_api_key_set ? "success" : "danger"}>{preview.readiness?.ark_api_key_set ? "已就绪" : "未配置"}</Badge>火山方舟采样 Key</span>
              <span><Badge tone={preview.readiness?.llm_configured ? "success" : "danger"}>{preview.readiness?.llm_configured ? "已就绪" : "未配置"}</Badge>分析与报告 LLM</span>
              <span><Badge tone={!preview.readiness?.executor_paused ? "success" : "danger"}>{preview.readiness?.executor_paused ? "已暂停" : "运行中"}</Badge>服务端执行器</span>
              <span><Badge tone={Number(preview.readiness?.daily_budget_remaining || 0) >= 40 ? "success" : "danger"}>{preview.readiness?.daily_budget_remaining || 0} 次</Badge>今日剩余任务预算</span>
            </div>
          </section>
          <section>
            <h3>费用上限提示</h3>
            <ul>
              <li>基础采样 40 个任务；失败题自动补采最多 2 轮。</li>
              <li>任务执行最多 120 次；既有限流与网络重试可能增加请求量。</li>
              <li>40 题分析拆为 3 批，自动恢复最多 1 次。</li>
              <li>报告整体润色 1 次；不会自动发布或生成冻结 PDF。</li>
            </ul>
          </section>
        </div>

        {visibleBlockers.length > 0 && <div className="automation-blocker-list">{visibleBlockers.map((item: Json) => <div key={item.code}><Warning size={17} /><span>{item.message}</span></div>)}</div>}
        {(preview.warnings || []).length > 0 && <div className="automation-warning-list">{(preview.warnings || []).map((item: Json) => <div key={item.code}><Warning size={17} /><span>{item.message}</span></div>)}</div>}
        <label className="automation-cost-confirm"><input type="checkbox" checked={acknowledgeCost} onChange={event => setAcknowledgeCost(event.target.checked)} /><span><strong>我已核对以上 40 题，并确认会产生真实 API 费用</strong><small>流程只停在报告第 4 步“待人工预览发布”，不会自动发布、创建检查点或生成冻结 PDF。</small></span></label>
      </> : <StatePanel kind="error" title="无法生成启动预览" description="请关闭后重试。" />}
    </div>
    <div className="dialog-actions">
      <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
      <Button icon={Check} onClick={start} disabled={busy || !canAttemptStart}>{busy ? "服务端核验中…" : "确认并启动自动监测"}</Button>
    </div>
  </Modal>;
}

function AutomationFlowBanner({ data, projectId, onNavigate, notify, reload }: any) {
  const latest = data.automationRuns?.latest || null;
  const [run, setRun] = useState<Json | null>(latest);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setRun(latest); }, [projectId, latest?.automation_run_id, latest?.updated_at]);
  useEffect(() => {
    const automationRunId = String(run?.automation_run_id || latest?.automation_run_id || "");
    if (!projectId || !automationRunId) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await automationService.get(projectId, automationRunId);
        if (!cancelled) setRun(response.run || null);
      } catch {
        // 主页面刷新仍可恢复状态；轮询失败不覆盖现有进度。
      }
    };
    refresh();
    const active = ["queued", "running", "needs_attention"].includes(String(run?.status || latest?.status || ""));
    const timer = active ? window.setInterval(refresh, 15_000) : 0;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [projectId, run?.automation_run_id, run?.status, latest?.automation_run_id]);

  if (!run) return null;
  const activeRun = run;
  const progress = automationProgressPercent(run);
  const currentIndex = AUTOMATION_STAGE_SEQUENCE.findIndex(item => item.code === run.current_stage);
  const events = (run.events || []).slice(-8).reverse();
  const samplingNotCreated = run.status === "needs_attention" && run.current_stage === "queued" && !run.sample_run_id;
  const fixedRetestGuardError = samplingNotCreated
    && run.last_error_code === "stage_error"
    && String(run.last_error || "").includes("正式复测必须从优化任务进入");
  const visibleAutomationError = fixedRetestGuardError
    ? "上次启动被旧版复测守卫拦截；兼容修复已加载，可重新启动。"
    : run.last_error;

  async function resume() {
    if (!confirm("恢复会增加一次明确记录的人工恢复机会，并可能产生额外 API 费用。确认继续？")) return;
    setBusy(true);
    try {
      const response = await automationService.resume(projectId, activeRun.automation_run_id, true);
      setRun(response.run || activeRun);
      notify("自动流程已恢复，服务端将从已落盘阶段继续", "success");
      await reload();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm("取消只会停止后续阶段并释放服务端采样接管；已有任务、样本、分析和审计记录都会保留。确认取消？")) return;
    setBusy(true);
    try {
      const response = await automationService.cancel(projectId, activeRun.automation_run_id);
      setRun(response.run || activeRun);
      notify("自动流程已取消，历史数据已保留", "success");
      await reload();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function openReportDraft() {
    if (activeRun.report_draft_id) {
      const url = new URL(location.href);
      url.searchParams.set("draft_id", String(activeRun.report_draft_id));
      history.replaceState({}, "", url);
    }
    onNavigate("report");
  }

  return <section className={cn("automation-flow-banner", `automation-${run.status}`)}>
    <div className="automation-flow-head">
      <div>
        <Badge tone={automationTone(run.status)}>{automationStatusLabel(run.status)}</Badge>
        <h2>自动监测闭环</h2>
        <p>{automationStageLabel(run.current_stage)} · {run.automation_run_id}</p>
      </div>
      <div className="row-actions">
        {run.status === "needs_attention" && <Button onClick={resume} disabled={busy}>{samplingNotCreated ? "确认费用并重试启动" : "确认费用并恢复"}</Button>}
        {["queued", "running", "needs_attention"].includes(run.status) && <Button variant="secondary" onClick={cancel} disabled={busy}>取消后续流程</Button>}
        {run.analysis_version_id && <Button variant="ghost" onClick={() => onNavigate("analysis")}>查看正式分析</Button>}
        {run.report_draft_id && <Button variant="secondary" icon={ArrowRight} onClick={openReportDraft}>打开待发布报告草稿</Button>}
      </div>
    </div>
    <div className="automation-flow-progress"><i style={{ width: `${progress}%` }} /></div>
    <div className="automation-stage-strip">
      {AUTOMATION_STAGE_SEQUENCE.map((stage, index) => <span className={cn(index < currentIndex && "is-complete", index === currentIndex && "is-active")} key={stage.code}><i>{index < currentIndex ? <Check size={12} /> : index + 1}</i>{stage.label}</span>)}
    </div>
    {visibleAutomationError && <div className="automation-flow-error"><Warning size={18} /><span>{visibleAutomationError}{samplingNotCreated && <small>当前尚未创建采样批次，也未产生采样任务；确认恢复后才会开始产生真实 API 费用。</small>}</span></div>}
    <details className="automation-event-timeline" open={run.status === "needs_attention"}>
      <summary>审计时间线{events.length ? `（最近 ${events.length} 条）` : ""}</summary>
      <div>{events.length ? events.map((event: Json) => <article key={event.automation_event_id}><i /><span><strong>{event.message || event.event_type}</strong><small>{formatDate(event.created_at)} · {automationStageLabel(event.stage)}</small></span></article>) : <p>流程事件正在写入，稍后自动刷新。</p>}</div>
    </details>
  </section>;
}

function Questions({ data, projectId, customerId, reload, notify }: any) {
  const scenes: Array<[string, string]> = [["demand_solution", "品类需求可见"], ["vendor_selection", "推荐名单可见"], ["budget_case_process", "采购决策可见"], ["competitor_compare", "竞品对比可见"]];
  const allScenes: Array<[string, string]> = [...scenes, ["brand_named_check", "品牌点名核验"], ["risk_fact_check", "风险/事实核验"]];
  const primaryCodes = scenes.map(([id]) => id); const advancedCodes = ["brand_named_check", "risk_fact_check"];
  const profileFields: Array<[string, string, string]> = [
    ["core_topics", "核心主题", "每行一个核心产品、服务或业务主题"], ["regions", "地区", "服务城市、区域或市场范围"],
    ["industries", "行业", "客户重点覆盖的行业"], ["audiences", "提问人群", "采购、市场、品牌等真实提问角色"],
    ["use_cases", "用途与需求", "招商、企业介绍、展会等使用场景"], ["decision_factors", "决策条件", "预算、周期、案例、质量、验收等"],
    ["competitors", "竞品与替代方案", "明确竞品、工具或替代对象"],
  ];
  const [busy, setBusy] = useState(false); const [entryMode, setEntryMode] = useState<"primary" | "manual" | "advanced">("primary");
  const [statusFilter, setStatusFilter] = useState("all"); const [scopeFilter, setScopeFilter] = useState<"primary" | "advanced">("primary"); const [page, setPage] = useState(1);
  const [advancedFocus, setAdvancedFocus] = useState("brand_named_check"); const [advancedCount, setAdvancedCount] = useState(5);
  const [generationResults, setGenerationResults] = useState<Json>({}); const [selectedQuestions, setSelectedQuestions] = useState<Set<string>>(new Set()); const stopGeneration = useRef(false);
  const [profileOpen, setProfileOpen] = useState(false); const [profileBusy, setProfileBusy] = useState(false); const [profilePayload, setProfilePayload] = useState<Json | null>(null); const [profileDraft, setProfileDraft] = useState<Json>({}); const [activeProfile, setActiveProfile] = useState<Json | null>(null);
  const [manualOpen, setManualOpen] = useState(false); const [manualText, setManualText] = useState(""); const [manualDefaultScene, setManualDefaultScene] = useState(""); const [manualPriority, setManualPriority] = useState("中"); const [manualFixed, setManualFixed] = useState(true); const [manualPreview, setManualPreview] = useState<Json | null>(null); const [manualDirty, setManualDirty] = useState(false);
  const [editQuestion, setEditQuestion] = useState<Json | null>(null); const [editForm, setEditForm] = useState<Json>({});
  const [automationOpen, setAutomationOpen] = useState(false);
  const pageSize = 20;
  const questionScene = (q: Json) => String(q.scene_code || q.generation_focus || "demand_solution");
  const isStopped = (q: Json) => ["disabled", "discarded"].includes(q.review_status) || q.project_question_status === "inactive";
  const primaryItems = data.questions.filter((q: Json) => primaryCodes.includes(questionScene(q))); const advancedItems = data.questions.filter((q: Json) => advancedCodes.includes(questionScene(q)));
  const fallbackTargets: Json = { demand_solution: [10, 3, 7], vendor_selection: [12, 3, 9], budget_case_process: [10, 3, 7], competitor_compare: [8, 3, 5] };
  const sceneSummary = scenes.map(([code, label]) => {
    const fromApi = (data.questionSceneSummary || []).find((item: Json) => item.code === code); if (fromApi) return fromApi;
    const active = primaryItems.filter((q: Json) => questionScene(q) === code && !isStopped(q)); const [target, coreTarget, tailTarget] = fallbackTargets[code];
    return { code, label, target, core_target: coreTarget, long_tail_target: tailTarget, effective_count: active.length, sampleable_count: active.filter((q: Json) => q.review_status === "approved").length, gap: Math.max(target - active.length, 0), core_count: active.filter((q: Json) => Boolean(q.is_core)).length, long_tail_count: active.filter((q: Json) => !q.is_core).length, structure_warnings: [] };
  });
  const profileForRequest = activeProfile || (data.questionProfileSaved ? data.questionProfile : null); const profileReady = Boolean(profileForRequest);
  const fatalGenerationError = (message: string) => ["api key", "endpoint", "model", "配置", "鉴权", "余额不足", "quota", "401", "403"].some(value => message.toLowerCase().includes(value));
  const scopedItems = scopeFilter === "primary" ? primaryItems : advancedItems; const items = scopedItems.filter((q: Json) => statusFilter === "all" || (statusFilter === "disabled" ? isStopped(q) : q.review_status === statusFilter));
  const pages = Math.max(1, Math.ceil(items.length / pageSize)); const rows = items.slice((page - 1) * pageSize, page * pageSize); const start = items.length ? (page - 1) * pageSize + 1 : 0; const end = Math.min(page * pageSize, items.length);
  const currentPageSelectedCount = rows.filter((q: Json) => selectedQuestions.has(q.question_id)).length; const allCurrentPageSelected = rows.length > 0 && currentPageSelectedCount === rows.length; const someCurrentPageSelected = currentPageSelectedCount > 0 && !allCurrentPageSelected; const allFilteredSelected = items.length > 0 && items.every((q: Json) => selectedQuestions.has(q.question_id)); const canSelectAllFiltered = items.length <= 200; const selectionExceedsBatchLimit = selectedQuestions.size > 200;
  useEffect(() => { setPage(1); setSelectedQuestions(new Set()); }, [statusFilter, scopeFilter, projectId]);
  useEffect(() => { if (page > pages) setPage(pages); }, [page, pages]);
  useEffect(() => { setActiveProfile(null); setGenerationResults({}); setManualPreview(null); setEditQuestion(null); setAutomationOpen(false); }, [projectId]);

  function normalizedProfileDraft() { return Object.fromEntries(profileFields.map(([key]) => [key, (profileDraft[key] || []).map((item: any) => String(item || "").trim()).filter(Boolean)])); }
  async function openProfileEditor() { setProfileOpen(true); setProfileBusy(true); try { const result = await questionService.profile(customerId); setProfilePayload(result); setProfileDraft(result.profile || result.suggestions || {}); } catch (e: any) { notify(e.message, "error"); setProfileOpen(false); } finally { setProfileBusy(false); } }
  function useTemporaryProfile() { const profile = normalizedProfileDraft(); if (!profile.core_topics?.length) return notify("提问画像至少需要 1 个核心主题", "error"); setActiveProfile(profile); setProfileOpen(false); notify("已应用本轮临时提问画像，未写入客户事实库", "info"); }
  async function saveProfile() { const profile = normalizedProfileDraft(); if (!profile.core_topics?.length) return notify("提问画像至少需要 1 个核心主题", "error"); setProfileBusy(true); try { const result = await questionService.saveProfile(customerId, { profile }); setProfileOpen(false); notify(`客户提问画像已保存并生成事实库 V${result.fact_base_version?.version_no || "新版本"}`, "success"); await reload(); setActiveProfile(null); } catch (e: any) { notify(e.message, "error"); } finally { setProfileBusy(false); } }

  async function performSceneGeneration(scene: Json) {
    const code = String(scene.code); const count = Number(scene.gap || 0); if (!count) return null;
    setGenerationResults((current: Json) => ({ ...current, [code]: { label: scene.label, status: "running", requested: count, inserted: 0, error: "" } }));
    try {
      const result = await questionService.generateScene(projectId, { scene_code: code, count, ...(profileForRequest ? { profile: profileForRequest } : {}) });
      const inserted = Number(result.inserted_count || 0); const missing = Number(result.missing_count ?? Math.max(count - inserted, 0));
      setGenerationResults((current: Json) => ({ ...current, [code]: { label: scene.label, status: missing ? "partial" : "success", requested: count, inserted, missing, error: "" } })); return result;
    } catch (e: any) { setGenerationResults((current: Json) => ({ ...current, [code]: { label: scene.label, status: "failed", requested: count, inserted: 0, error: e.message } })); throw e; }
  }
  async function generateSceneOnly(scene: Json) { if (!profileReady) { notify("请先确认客户提问画像", "info"); return openProfileEditor(); } setBusy(true); try { const result = await performSceneGeneration(scene); if (result) notify(result.missing_count ? `已保留 ${result.inserted_count}/${result.requested_count} 道合格题，缺口由你决定是否继续补` : `${scene.label}缺口已补齐`, result.inserted_count ? "success" : "error"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function generateAll() {
    if (!profileReady) { notify("请先确认客户提问画像", "info"); return openProfileEditor(); }
    const targets = sceneSummary.filter((scene: Json) => Number(scene.gap || 0) > 0); if (!targets.length) return notify("四个场景均已达到目标题量", "success");
    setBusy(true); stopGeneration.current = false; let inserted = 0; let fatal = "";
    try {
      for (const scene of targets) {
        if (stopGeneration.current) break;
        notify(`正在补题：${scene.label}，本次只调用一个场景`, "info");
        try { const result = await performSceneGeneration(scene); inserted += Number(result?.inserted_count || 0); }
        catch (e: any) { if (fatalGenerationError(e.message || "")) { fatal = e.message; break; } }
      }
      await reload(); notify(fatal ? `因配置问题停止：${fatal}；已写入 ${inserted} 道题` : stopGeneration.current ? `已在当前场景完成后停止，共写入 ${inserted} 道题` : `四场景缺口处理完成，共写入 ${inserted} 道题；未补足部分不会自动追加调用`, fatal ? "error" : "success");
    } finally { setBusy(false); stopGeneration.current = false; }
  }
  async function generateAdvanced() { setBusy(true); try { const result = await questionService.generate(projectId, advancedCount, advancedFocus); notify(`已写入 ${result.inserted_count || 0}/${result.requested_count || advancedCount} 道高级候选题`, result.inserted_count ? "success" : "error"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }

  function openManualEditor() { setManualOpen(true); setManualPreview(null); setManualDirty(false); }
  async function previewManual(rowsOverride?: Json[]) { setBusy(true); try { const payload = rowsOverride ? { rows: rowsOverride } : { text: manualText, default_scene_code: manualDefaultScene, priority: manualPriority, fixed: manualFixed }; const result = await questionService.previewManual(projectId, { ...payload, ...(profileForRequest ? { profile: profileForRequest } : {}) }); setManualPreview(result); setManualDirty(false); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  function updateManualPreviewRow(index: number, patch: Json) { if (!manualPreview) return; const next = (manualPreview.rows || []).map((row: Json, rowIndex: number) => rowIndex === index ? { ...row, ...patch } : row); setManualPreview({ ...manualPreview, rows: next, can_commit: false }); setManualDirty(true); }
  async function commitManual() { if (!manualPreview?.can_commit || manualDirty) return; setBusy(true); try { const result = await questionService.commitManual(projectId, { rows: manualPreview.rows, ...(profileForRequest ? { profile: profileForRequest } : {}) }); notify(`已原子写入 ${result.inserted_count || 0} 道项目专属题，默认待审核`, "success"); setManualOpen(false); setManualText(""); setManualPreview(null); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }

  function openEdit(q: Json) { setEditQuestion(q); setEditForm({ question: q.question, scene_code: questionScene(q), priority: q.priority || "中", question_tier: q.question_tier || (q.is_core ? "core" : "long_tail"), fixed: Boolean(q.fixed_monitoring) }); }
  async function saveEdit() { if (!editQuestion) return; setBusy(true); try { const result = await questionService.edit(projectId, editQuestion.question_id, editForm); notify(result.versioned ? `已创建新版本 ${result.new_question_id}，旧题历史关联保持不变` : `已安全更新 ${result.new_question_id}，内容变更后回到待审核`, "success"); setEditQuestion(null); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function review(q: Json, status: string) { try { await questionService.review(projectId, q.question_id, { review_status: status, question: q.question, priority: q.priority, quality_note: status === "approved" ? "V2 审核通过" : "V2 暂停采样" }); await reload(); } catch (e: any) { notify(e.message, "error"); } }
  async function reviewBatch(status: string) { if (!selectedQuestions.size) return; if (selectionExceedsBatchLimit) return notify("单次最多批量处理 200 道题，请取消部分选择后重试", "error"); if (status === "disabled" && !confirm(`确认停用已选择的 ${selectedQuestions.size} 道题？相关待执行采样任务将被跳过，历史样本不会删除。`)) return; setBusy(true); try { const result = await questionService.reviewBatch(projectId, Array.from(selectedQuestions), status); const updatedCount = Number(result.updated_count ?? selectedQuestions.size); const missingCount = Array.isArray(result.missing_question_ids) ? result.missing_question_ids.length : 0; const skippedCount = Number(result.skipped_tasks?.skipped_task_count || 0); const messages = [`已批量更新 ${updatedCount} 道题`]; if (missingCount) messages.push(`未找到 ${missingCount} 道题`); if (status === "disabled" && skippedCount) messages.push(`跳过 ${skippedCount} 个待执行采样任务`); notify(messages.join("，"), missingCount ? "error" : "success"); setSelectedQuestions(new Set()); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  const statusLabel = (q: Json) => q.review_status === "approved" ? "可采样" : q.review_status === "pending" ? "待审核" : isStopped(q) ? "已停用" : (q.review_status_meta?.label || q.review_status); const priorityLabel = (value: string) => ({ high: "高", medium: "中", low: "低" } as Json)[value] || value || "-";
  const activeAutomation = data.automationRuns?.active;

  return <>
    <section className="question-automation-command">
      <div>
        <Badge tone={activeAutomation ? "warning" : "success"}>{activeAutomation ? "流程进行中" : "人工审题后可启动"}</Badge>
        <h2>采样—分析—报告自动闭环</h2>
        <p>系统推荐精确 40 题，你可手工换题；确认一次后由服务端执行，最终停在报告第 4 步等待人工发布。</p>
      </div>
      <Button
        icon={MonitorPlay}
        onClick={() => setAutomationOpen(true)}
        disabled={Boolean(activeAutomation)}
      >
        {activeAutomation ? "当前项目已有自动流程" : "启动自动监测"}
      </Button>
    </section>

    <div className="question-entry-tabs" role="tablist" aria-label="题库入口">
      <button className={entryMode === "primary" ? "active" : ""} onClick={() => { setEntryMode("primary"); setScopeFilter("primary"); }}><Sparkle size={18} /><span><strong>四场景生成</strong><small>按缺口补齐目标 40 题</small></span></button>
      <button className={entryMode === "manual" ? "active" : ""} onClick={() => { setEntryMode("manual"); setScopeFilter("primary"); }}><Plus size={18} /><span><strong>手工录入</strong><small>单题或一行一道批量粘贴</small></span></button>
      <button className={entryMode === "advanced" ? "active" : ""} onClick={() => { setEntryMode("advanced"); setScopeFilter("advanced"); }}><ListChecks size={18} /><span><strong>高级题目</strong><small>品牌点名与风险事实核验</small></span></button>
    </div>

    {entryMode === "primary" && <>
      <div className="question-command-bar"><div className="question-command-copy"><Sparkle size={21} /><div><h2>补齐目标题库</h2><p>按当前有效题计算四场景缺口，串行调用；未补足时保留合格结果，不自动追加付费调用。</p></div></div><div className="question-generation-controls"><Badge tone={activeProfile ? "warning" : data.questionProfileSaved ? "success" : "neutral"}>{activeProfile ? "本轮临时画像" : data.questionProfileSaved ? "画像已确认" : "画像待确认"}</Badge><Button variant="secondary" onClick={openProfileEditor} disabled={profileBusy}>客户提问画像</Button><Button onClick={generateAll} disabled={busy}>{busy ? "补题中…" : `补齐全部缺口 ${sceneSummary.reduce((sum: number, scene: Json) => sum + Number(scene.gap || 0), 0)} 题`}</Button></div></div>
      {!!Object.keys(generationResults).length && <div className="generation-progress" role="status"><div>{scenes.map(([id, label]) => { const item = generationResults[id] || {}; return <span key={id}><strong>{label}</strong><Badge tone={item.status === "success" ? "success" : item.status === "failed" ? "danger" : item.status === "partial" ? "warning" : "neutral"}>{item.status === "running" ? "生成中" : item.status === "success" ? `写入 ${item.inserted}` : item.status === "partial" ? `${item.inserted}/${item.requested}` : item.status === "failed" ? "失败" : "未调用"}</Badge></span>; })}</div>{busy && <Button variant="secondary" onClick={() => { stopGeneration.current = true; notify("将在当前场景完成后停止", "info"); }}>停止</Button>}</div>}
      <div className="question-scene-grid">{sceneSummary.map((scene: Json) => <article className="question-scene-card" key={scene.code}><header><div><strong>{scene.label}</strong><span>目标 {scene.target} 题</span></div><Badge tone={scene.gap ? "warning" : "success"}>{scene.gap ? `缺口 ${scene.gap}` : "已达标"}</Badge></header><div className="question-scene-metrics"><span><small>有效题</small><b>{scene.effective_count}</b></span><span><small>可采样</small><b>{scene.sampleable_count}</b></span><span><small>核心题</small><b>{scene.core_count}/{scene.core_target}</b></span><span><small>长尾题</small><b>{scene.long_tail_count}/{scene.long_tail_target}</b></span></div><div className="question-scene-progress"><i style={{ width: `${Math.min(100, Number(scene.effective_count || 0) / Number(scene.target || 1) * 100)}%` }} /></div><p>{scene.structure_warnings?.length ? `结构提醒：${scene.structure_warnings.join("；")}` : "核心与长尾覆盖符合目标结构。"}</p><Button variant="secondary" onClick={() => generateSceneOnly(scene)} disabled={busy || !scene.gap}>{scene.gap ? `单场景补 ${scene.gap} 题` : "无需补题"}</Button></article>)}</div>
    </>}

    {entryMode === "manual" && <div className="question-command-bar question-manual-entry"><div className="question-command-copy"><Plus size={21} /><div><h2>手工固定题库</h2><p>先做无写入预览，再原子入库；默认固定监测、优先级中、状态待审核。</p></div></div><Button onClick={openManualEditor}>录入题目</Button></div>}
    {entryMode === "advanced" && <div className="question-command-bar"><div className="question-command-copy"><ListChecks size={21} /><div><h2>高级题目</h2><p>保留品牌点名和风险/事实核验能力，与正式四场景配额分开管理。</p></div></div><div className="question-generation-controls"><select aria-label="高级题目场景" value={advancedFocus} onChange={e => setAdvancedFocus(e.target.value)}>{allScenes.filter(([id]) => advancedCodes.includes(id)).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select><select aria-label="高级生成数量" value={advancedCount} onChange={e => setAdvancedCount(Number(e.target.value))}>{[1, 5, 10].map(value => <option value={value} key={value}>{value} 道</option>)}</select><Button onClick={generateAdvanced} disabled={busy}>生成高级候选题</Button></div></div>}

    <div className="question-toolbar"><div><h2>问题审核</h2><p>{items.length} 道题符合当前筛选 · 历史重复仅提示，不自动修改</p></div><div className="question-filter-groups"><div className="segmented question-scope-filter">{[["primary", `四场景题目 ${primaryItems.length}`], ["advanced", `高级题目 ${advancedItems.length}`]].map(([id, label]) => <button className={scopeFilter === id ? "active" : ""} onClick={() => { setScopeFilter(id as "primary" | "advanced"); setEntryMode(id === "advanced" ? "advanced" : "primary"); }} key={id}>{label}</button>)}</div><div className="segmented">{[["all", "全部"], ["pending", "待审核"], ["approved", "可采样"], ["disabled", "已停用"]].map(([id, label]) => <button className={statusFilter === id ? "active" : ""} onClick={() => setStatusFilter(id)} key={id}>{label}</button>)}</div></div></div>
    {!!selectedQuestions.size && <div className="bulk-bar"><div className="bulk-selection-summary"><strong>{allFilteredSelected ? `已选择当前筛选全部 ${items.length} 道题` : `已选择 ${selectedQuestions.size} 道题`}</strong><span>当前页 {currentPageSelectedCount}/{rows.length} · 当前筛选共 {items.length} 道</span></div>{allCurrentPageSelected && !allFilteredSelected && canSelectAllFiltered && <Button variant="ghost" onClick={() => setSelectedQuestions(new Set(items.map((q: Json) => q.question_id)))}>选择全部 {items.length} 道</Button>}{allCurrentPageSelected && !allFilteredSelected && !canSelectAllFiltered && <span className="bulk-limit-note">当前筛选超过 200 道，请按页处理</span>}{selectionExceedsBatchLimit && <span className="bulk-limit-note danger">单次最多处理 200 道</span>}<Button variant="secondary" onClick={() => reviewBatch("approved")} disabled={busy || selectionExceedsBatchLimit}>批量通过</Button><Button variant="secondary" onClick={() => reviewBatch("disabled")} disabled={busy || selectionExceedsBatchLimit}>批量停用</Button><Button variant="ghost" onClick={() => setSelectedQuestions(new Set())}>清除选择</Button></div>}
    {rows.length ? <div className="question-table" role="table" aria-label="题库审核列表"><div className="question-table-header" role="row"><span className="question-header-main"><SelectionCheckbox label="选择当前页" checked={allCurrentPageSelected} indeterminate={someCurrentPageSelected} onChange={checked => { const next = new Set(selectedQuestions); rows.forEach((q: Json) => checked ? next.add(q.question_id) : next.delete(q.question_id)); setSelectedQuestions(next); }} /><span>问题</span><small>选择当前页</small></span><span>场景</span><span>优先级</span><span>真实样本</span><span>质量提示</span><span>审核状态</span><span>操作</span></div>{rows.map((q: Json) => <div className="question-table-row" role="row" key={q.question_id}>
      <div className="question-main-cell" role="cell"><strong><SelectionCheckbox label={`选择 ${q.question_id}`} checked={selectedQuestions.has(q.question_id)} onChange={checked => { const next = new Set(selectedQuestions); checked ? next.add(q.question_id) : next.delete(q.question_id); setSelectedQuestions(next); }} /><span>{q.question_id}</span>{q.question}</strong><div className="question-inline-meta"><Badge>{q.question_tier === "core" ? "核心题" : "长尾题"}</Badge>{q.fixed_monitoring && <Badge tone="success">固定监测</Badge>}{q.question_origin === "manual" && <Badge>手工题</Badge>}</div><p>{q.intent || q.fit_reason || "暂无意图说明"}</p>{q.related_question_ids?.length > 0 && <small className="question-duplicate-note">近义关联：{q.related_question_ids.join("、")}（仅提示，需人工决定）</small>}</div>
      <div className="question-cell question-scene-cell-data" role="cell" data-label="场景"><Badge>{q.scene_label || q.generation_focus_label_current || q.category || "未分类"}</Badge></div>
      <div className="question-cell" role="cell" data-label="优先级"><Badge tone={priorityLabel(q.priority) === "高" ? "warning" : "neutral"}>{priorityLabel(q.priority)}</Badge></div>
      <div className="question-cell question-number-cell" role="cell" data-label="真实样本"><strong>{q.real_sample_count || 0}</strong><span>条</span></div>
      <div className="question-cell question-quality-cell" role="cell" data-label="质量提示"><Badge tone={Number(q.quality_flag_count || 0) > 0 ? "warning" : "success"}>{Number(q.quality_flag_count || 0) > 0 ? `${q.quality_flag_count} 项` : "无异常"}</Badge></div>
      <div className="question-cell" role="cell" data-label="审核状态"><Badge tone={q.review_status === "approved" ? "success" : q.review_status === "pending" ? "warning" : "neutral"}>{statusLabel(q)}</Badge></div>
      <div className="question-table-actions" role="cell"><Button variant="ghost" onClick={() => review(q, "disabled")} disabled={isStopped(q)}>停用</Button><Button variant="ghost" onClick={() => openEdit(q)}>编辑</Button><Button variant="secondary" icon={Check} onClick={() => review(q, "approved")} disabled={q.review_status === "approved"}>通过</Button></div>
    </div>)}</div> : <StatePanel kind="empty" title={data.questions.length ? "当前筛选下暂无题目" : "尚无题目"} description={data.questions.length ? "切换题目范围或审核状态后查看。" : "先确认提问画像，再补齐四场景或手工录入题目。"} />}
    {items.length > 0 && <div className="pagination question-pagination"><span>{start}-{end} / {items.length} 条，第 {page} / {pages} 页</span><div><Button variant="secondary" onClick={() => setPage(value => Math.max(1, value - 1))} disabled={page === 1}>上一页</Button><Button variant="secondary" onClick={() => setPage(value => Math.min(pages, value + 1))} disabled={page === pages}>下一页</Button></div></div>}

    <Modal open={profileOpen} onOpenChange={setProfileOpen} title="客户提问画像" description="离线建议来自已确认事实、地区、目标客户、竞品和项目目标；确认后才用于生成。"><div className="question-dialog-body">{profileBusy && !profilePayload ? <StatePanel kind="loading" title="正在整理离线建议" /> : <><div className="question-profile-status"><div><strong>{profilePayload?.saved ? "当前客户已有已确认画像" : "当前为离线建议，尚未保存"}</strong><span>同客户项目默认复用；你也可以只在本轮临时调整。</span></div>{profilePayload?.suggestions && <Button variant="ghost" onClick={() => setProfileDraft(profilePayload.suggestions)}>恢复离线建议</Button>}</div><div className="question-profile-grid">{profileFields.map(([key, label, hint]) => <label key={key}><span>{label}<small>{hint}</small></span><textarea value={(profileDraft[key] || []).join("\n")} onChange={e => setProfileDraft({ ...profileDraft, [key]: e.target.value.split("\n") })} /></label>)}</div></>}</div><div className="dialog-actions"><Button variant="ghost" onClick={() => setProfileOpen(false)}>取消</Button><Button variant="secondary" onClick={useTemporaryProfile} disabled={profileBusy}>仅用于本轮</Button><Button icon={Check} onClick={saveProfile} disabled={profileBusy}>确认保存并复用</Button></div></Modal>

    <Modal open={manualOpen} onOpenChange={setManualOpen} title="手工录入题库" description="单题直接输入；批量时一行一道，单批最多 200 题。预览不会写入数据库。"><div className="question-dialog-body"><div className="question-manual-controls"><label className="question-manual-text">题目<textarea value={manualText} onChange={e => { setManualText(e.target.value); setManualPreview(null); }} placeholder={"示例城市制造业企业宣传片公司怎么选\n企业做 AI 数字人一般需要多少预算"} /></label><div><label>默认场景<select value={manualDefaultScene} onChange={e => setManualDefaultScene(e.target.value)}><option value="">自动判断</option>{allScenes.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label>默认优先级<select value={manualPriority} onChange={e => setManualPriority(e.target.value)}><option>高</option><option>中</option><option>低</option></select></label><label className="question-manual-check"><input type="checkbox" checked={manualFixed} onChange={e => setManualFixed(e.target.checked)} />默认设为固定监测题</label><Button variant="secondary" onClick={() => previewManual()} disabled={busy || !manualText.trim()}>无写入预览</Button></div></div>{manualPreview && <div className="question-manual-preview"><div className="question-preview-summary"><strong>{manualPreview.summary?.total || 0} 题</strong><span>{manualPreview.summary?.valid || 0} 题可入库 · {manualPreview.summary?.error || 0} 题有错误 · {manualPreview.summary?.warning || 0} 题有提醒</span>{manualDirty && <Badge tone="warning">修改后需重新检查</Badge>}</div>{(manualPreview.rows || []).map((row: Json, index: number) => <div className={cn("question-preview-row", row.valid ? "" : "has-error")} key={`${row.line_number}-${index}`}><div><strong>第 {row.line_number} 行 · {row.question}</strong><span>{row.errors?.join("；") || row.warnings?.join("；") || "检查通过"}</span>{row.conflicts?.length > 0 && <small>关联：{row.conflicts.map((item: Json) => item.question_id || `第 ${item.line_number} 行`).join("、")}</small>}</div><select aria-label={`第 ${row.line_number} 行场景`} value={row.scene_code} onChange={e => updateManualPreviewRow(index, { scene_code: e.target.value, scene_label: allScenes.find(([id]) => id === e.target.value)?.[1] })}>{allScenes.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select><select aria-label={`第 ${row.line_number} 行题型`} value={row.question_tier} onChange={e => updateManualPreviewRow(index, { question_tier: e.target.value })}><option value="core">核心题</option><option value="long_tail">长尾题</option></select><label><input type="checkbox" checked={Boolean(row.fixed)} onChange={e => updateManualPreviewRow(index, { fixed: e.target.checked })} />固定</label></div>)}</div>}</div><div className="dialog-actions"><Button variant="ghost" onClick={() => setManualOpen(false)}>取消</Button>{manualPreview && <Button variant="secondary" onClick={() => previewManual(manualPreview.rows)} disabled={busy}>重新检查</Button>}<Button icon={Check} onClick={commitManual} disabled={busy || !manualPreview?.can_commit || manualDirty}>确认原子入库</Button></div></Modal>

    <Modal open={Boolean(editQuestion)} onOpenChange={(open: boolean) => { if (!open) setEditQuestion(null); }} title={`安全编辑 ${editQuestion?.question_id || "问题"}`} description="无历史引用时原地编辑；已有任务、样本或跨项目引用时自动创建新版本并停用旧题。"><div className="question-dialog-body"><div className="question-edit-grid"><label className="question-edit-text">问题<textarea value={editForm.question || ""} onChange={e => setEditForm({ ...editForm, question: e.target.value })} /></label><label>场景<select value={editForm.scene_code || "demand_solution"} onChange={e => setEditForm({ ...editForm, scene_code: e.target.value })}>{allScenes.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label>题型<select value={editForm.question_tier || "long_tail"} onChange={e => setEditForm({ ...editForm, question_tier: e.target.value })}><option value="core">核心题</option><option value="long_tail">长尾题</option></select></label><label>优先级<select value={editForm.priority || "中"} onChange={e => setEditForm({ ...editForm, priority: e.target.value })}><option>高</option><option>中</option><option>低</option></select></label><label className="question-manual-check"><input type="checkbox" checked={Boolean(editForm.fixed)} onChange={e => setEditForm({ ...editForm, fixed: e.target.checked })} />固定监测题</label></div>{editQuestion?.related_question_ids?.length > 0 && <div className="question-edit-warning"><Warning size={18} /><span>历史近义题：{editQuestion?.related_question_ids?.join("、")}。保存不会自动停用这些历史题。</span></div>}</div><div className="dialog-actions"><Button variant="ghost" onClick={() => setEditQuestion(null)}>取消</Button><Button icon={Check} onClick={saveEdit} disabled={busy || !String(editForm.question || "").trim()}>保存安全版本</Button></div></Modal>
    <AutomationLaunchDialog open={automationOpen} onOpenChange={setAutomationOpen} projectId={projectId} notify={notify} reload={reload} />
  </>;
}

const MONITORING_SET_CREATION_MODES = [
  { code: "template", label: "系统模板", description: "按预设结构优先选择固定题和已审核题" },
  { code: "custom", label: "自定义结构", description: "自行设置四场景题量和生成角度" },
  { code: "copy", label: "复制已有题集", description: "以不可变题集为起点创建独立新版本" },
  { code: "manual", label: "完全手工选择", description: "从题库逐题挑选并校验" },
];

function emptyMonitoringAngleTargets() {
  return Object.fromEntries(MONITORING_SET_SCENES.map(scene => [
    scene.code,
    Object.fromEntries(MONITORING_SET_ANGLE_OPTIONS.map(option => [option.code, 0])),
  ]));
}

function monitoringSetSceneLabel(code: string) {
  return MONITORING_SET_SCENES.find(scene => scene.code === code)?.label || code || "未分类";
}

function MonitoringSetManager({ data, projectId, notify, reload, onNavigate, onRunCreated }: any) {
  const payload = data.monitoringSets || {};
  const sets = payload.sets || [];
  const templates = payload.templates?.length ? payload.templates : MONITORING_SET_FALLBACK_TEMPLATES;
  const angleOptions = payload.angle_options?.length ? payload.angle_options : MONITORING_SET_ANGLE_OPTIONS;
  const samplerConfigs = data.samplerConfigs?.items || [];
  const defaultSampler = data.project?.monitoring_plan?.primary_sampler || data.samplerConfigs?.default_sampler || samplerConfigs[0]?.sampler || "doubao_api_websearch";
  const defaultTemplate = templates[0] || MONITORING_SET_FALLBACK_TEMPLATES[0];
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [form, setForm] = useState<Json>({
    name: "",
    set_type: "standard",
    mode: "template",
    template_code: defaultTemplate.code,
    scene_targets: monitoringSceneTargets(defaultTemplate.scene_targets),
    angle_targets: emptyMonitoringAngleTargets(),
    sampler: defaultSampler,
    copy_from_baseline_run_id: "",
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Json | null>(null);
  const [previewDirty, setPreviewDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [detailSet, setDetailSet] = useState<Json | null>(null);
  const [editQuestion, setEditQuestion] = useState<Json | null>(null);
  const [editForm, setEditForm] = useState<Json>({});
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState<Json>({ question: "", scene_code: "demand_solution", question_tier: "long_tail", priority: "中", fixed: false });
  const [manualPreview, setManualPreview] = useState<Json | null>(null);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [automationQuestionIds, setAutomationQuestionIds] = useState<string[]>([]);

  useEffect(() => {
    if (!wizardOpen) return;
    setForm((current: Json) => ({ ...current, sampler: current.sampler || defaultSampler }));
  }, [wizardOpen, defaultSampler]);

  const selectedQuestions = useMemo(() => {
    const candidates = preview?.candidate_questions || [];
    const byId = new Map(candidates.map((item: Json) => [String(item.question_id), item]));
    return Array.from(selectedIds).map(id => byId.get(id)).filter(Boolean) as Json[];
  }, [preview?.candidate_questions, Array.from(selectedIds).join("|")]);
  const selectedSceneCounts = useMemo(() => Object.fromEntries(MONITORING_SET_SCENES.map(scene => [
    scene.code,
    selectedQuestions.filter(item => item.scene_code === scene.code).length,
  ])), [selectedQuestions]);
  const targetValidation = monitoringTargetValidation(form.set_type, form.scene_targets);
  const filteredCandidates = (preview?.candidate_questions || []).filter((item: Json) => (
    (sceneFilter === "all" || item.scene_code === sceneFilter)
    && (!search || `${item.question_id} ${item.question}`.toLowerCase().includes(search.toLowerCase()))
  ));

  function resetWizard(copySource?: Json) {
    const source = copySource || {};
    const sourceTemplate = templates.find((item: Json) => item.code === source.template_code) || defaultTemplate;
    const copying = Boolean(copySource);
    setForm({
      name: copying ? `${source.name} V${Number(source.version || 1) + 1}` : "",
      set_type: copying ? source.set_type : "standard",
      mode: copying ? "copy" : "template",
      template_code: copying ? source.template_code : sourceTemplate.code,
      scene_targets: monitoringSceneTargets(copying ? source.scene_counts : sourceTemplate.scene_targets),
      angle_targets: copying ? (source.angle_targets || emptyMonitoringAngleTargets()) : emptyMonitoringAngleTargets(),
      sampler: copying ? source.sampler : defaultSampler,
      copy_from_baseline_run_id: copying ? source.root_run_id : "",
    });
    setSelectedIds(new Set(source.questions?.map((item: Json) => String(item.question_id)) || []));
    setPreview(null);
    setPreviewDirty(false);
    setWizardStep(1);
    setSearch("");
    setSceneFilter("all");
    setWizardOpen(true);
  }

  function updateStructure(updates: Json) {
    setForm((current: Json) => ({ ...current, ...updates }));
    setPreview(null);
    setPreviewDirty(true);
    setWizardStep(1);
  }

  function applyTemplate(template: Json) {
    updateStructure({
      mode: "template",
      set_type: "standard",
      template_code: template.code,
      scene_targets: monitoringSceneTargets(template.scene_targets),
    });
  }

  function previewPayload(questionIds?: string[]) {
    const result: Json = {
      name: form.name,
      set_type: form.set_type,
      mode: form.mode,
      template_code: form.template_code,
      scene_targets: monitoringSceneTargets(form.scene_targets),
      angle_targets: form.angle_targets || {},
      sampler: form.sampler,
      copy_from_baseline_run_id: form.mode === "copy" ? form.copy_from_baseline_run_id : "",
    };
    if (questionIds !== undefined) result.question_ids = questionIds;
    return result;
  }

  async function runPreview(finalStep = false, explicitIds?: string[]) {
    if (!targetValidation.valid) return notify(targetValidation.message, "error");
    if (!form.sampler) return notify("请选择一个联网采样平台", "error");
    if (form.mode === "copy" && !form.copy_from_baseline_run_id) return notify("请选择要复制的监测题集", "error");
    setBusy(true);
    try {
      const ids = explicitIds !== undefined
        ? explicitIds
        : (preview || form.mode === "manual") ? Array.from(selectedIds) : undefined;
      const result = await monitoringSetService.preview(projectId, previewPayload(ids));
      setPreview(result);
      setSelectedIds(new Set((result.selected_question_ids || []).map(String)));
      setPreviewDirty(false);
      setWizardStep(finalStep ? 3 : 2);
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleCandidate(questionId: string, checked: boolean) {
    const next = new Set(selectedIds);
    checked ? next.add(questionId) : next.delete(questionId);
    if (next.size > 50) return notify("单个题集最多 50 题", "error");
    setSelectedIds(next);
    setPreviewDirty(true);
    if (wizardStep === 3) setWizardStep(2);
  }

  async function freezeSet() {
    if (!preview || previewDirty || !preview.can_freeze) return notify("请先完成最终校验并处理所有阻塞项", "error");
    if (!confirm("冻结后题目、平台、模型和安全配置不可原地修改。创建只会生成待执行基线批次，不会自动调用采样接口。确认冻结？")) return;
    setBusy(true);
    try {
      const result = await monitoringSetService.create(projectId, {
        ...previewPayload(Array.from(selectedIds)),
        preview_hash: preview.preview_hash,
        idempotency_key: globalThis.crypto?.randomUUID?.() || `monitoring-set-${Date.now()}`,
      });
      setWizardOpen(false);
      notify(result.message || "监测题集已冻结，基线批次尚未执行", "success");
      await reload();
      if (result.run?.run_id) await onRunCreated(result.run.run_id);
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function collectNext(item: Json) {
    if (!item.can_collect_next) return notify(item.next_period_blocker || "当前不能创建下一期", "error");
    if (!confirm(`将精确复制“${item.name}”的 ${item.question_count} 道题与冻结配置，创建待执行批次；此操作不会立即调用 API。继续？`)) return;
    setBusy(true);
    try {
      const result = await monitoringSetService.nextPeriod(projectId, item.root_run_id, {});
      notify(result.message || "下一期待执行批次已创建", "success");
      await reload();
      if (result.run?.run_id) await onRunCreated(result.run.run_id);
    } catch (error: any) {
      notify(error.message, "error");
    } finally { setBusy(false); }
  }

  function openOptimization(item: Json) {
    const url = new URL(location.href);
    url.searchParams.set("baseline_run_id", String(item.root_run_id));
    history.replaceState({}, "", url);
    notify("请在已完成的优化任务中发起正式复测；系统会继续执行任务中心质量门。", "info");
    onNavigate("optimization");
  }

  function openAutomation(item: Json) {
    setAutomationQuestionIds((item.questions || []).map((question: Json) => String(question.question_id)));
    setAutomationOpen(true);
  }

  function openQuestionEdit(question: Json) {
    setEditQuestion(question);
    setEditForm({
      question: question.question,
      scene_code: question.scene_code,
      question_tier: question.question_tier,
      priority: question.priority || "中",
      fixed: Boolean(question.fixed_monitoring),
    });
  }

  async function saveQuestionEdit() {
    if (!editQuestion || !String(editForm.question || "").trim()) return;
    setBusy(true);
    try {
      const result = await questionService.edit(projectId, editQuestion.question_id, editForm);
      const nextIds = Array.from(selectedIds).map(id => id === editQuestion.question_id ? String(result.new_question_id) : id);
      setSelectedIds(new Set(nextIds));
      setEditQuestion(null);
      notify(result.versioned ? `已创建安全新版本 ${result.new_question_id}；请审核通过后再冻结` : "题目已安全更新", "success");
      await reload();
      await runPreview(false, nextIds);
    } catch (error: any) {
      notify(error.message, "error");
    } finally { setBusy(false); }
  }

  async function previewManualQuestion() {
    if (!String(manualForm.question || "").trim()) return notify("请输入题目", "error");
    setBusy(true);
    try {
      const result = await questionService.previewManual(projectId, {
        text: manualForm.question,
        default_scene_code: manualForm.scene_code,
        priority: manualForm.priority,
        fixed: manualForm.fixed,
      });
      if (result.rows?.[0]) result.rows[0].question_tier = manualForm.question_tier;
      setManualPreview(result);
    } catch (error: any) { notify(error.message, "error"); }
    finally { setBusy(false); }
  }

  async function commitManualQuestion() {
    if (!manualPreview?.can_commit) return;
    setBusy(true);
    try {
      const result = await questionService.commitManual(projectId, { rows: manualPreview.rows });
      const insertedIds = (result.questions || []).map((item: Json) => String(item.question_id));
      const nextIds = [...Array.from(selectedIds), ...insertedIds];
      setSelectedIds(new Set(nextIds));
      setManualOpen(false);
      setManualPreview(null);
      setManualForm({ question: "", scene_code: "demand_solution", question_tier: "long_tail", priority: "中", fixed: false });
      notify(`已加入 ${insertedIds.length} 道手工候选题；新题默认待审核，审核通过后才能冻结`, "success");
      await reload();
      await runPreview(false, nextIds);
    } catch (error: any) { notify(error.message, "error"); }
    finally { setBusy(false); }
  }

  async function generateSceneGap(sceneCode: string) {
    const target = Number(form.scene_targets?.[sceneCode] || 0);
    const activePoolCount = (preview?.candidate_questions || []).filter((item: Json) => item.scene_code === sceneCode && item.active).length;
    const gap = Math.max(0, target - activePoolCount);
    if (!gap) return notify("该场景题库已有足够候选，请优先选择或审核现有题目", "info");
    if (!confirm(`将调用共享大模型为“${monitoringSetSceneLabel(sceneCode)}”补 ${gap} 道题，可能产生真实费用；本次只调用一次，不会隐藏追加调用。继续？`)) return;
    setBusy(true);
    try {
      const sceneSummary = (data.questionSceneSummary || []).find((item: Json) => item.code === sceneCode) || {};
      const currentEffective = Number(sceneSummary.effective_count || 0);
      const result = await questionService.generateScene(projectId, {
        scene_code: sceneCode,
        count: gap,
        target_count: Math.min(50, currentEffective + gap),
        core_target: Math.round((currentEffective + gap) * 0.3),
        angle_targets: form.angle_targets?.[sceneCode] || {},
      });
      notify(`本次保留 ${result.inserted_count || 0}/${result.requested_count || gap} 道候选题；需人工审核后才能进入题集`, result.inserted_count ? "success" : "error");
      await reload();
      await runPreview(false, Array.from(selectedIds));
    } catch (error: any) { notify(error.message, "error"); }
    finally { setBusy(false); }
  }

  return <section className="monitoring-set-manager">
    <div className="monitoring-set-manager-head"><div><span className="eyebrow">固定基线</span><h2>监测题集</h2><p>题集冻结监测目的、精确题目和平台配置；后续周期只复制同一范围，才能形成可靠环比。</p></div><Button icon={Plus} onClick={() => resetWizard()} disabled={busy || payload.backend_available === false}>创建监测题集</Button></div>
    {payload.backend_available === false && <StatePanel kind="error" title="当前后端尚未提供监测题集接口" description="请部署与前端配套的最新后端。" />}
    {payload.notice && <div className="monitoring-set-notice"><Warning size={17} /><span>{payload.notice}</span></div>}
    <div className="monitoring-set-grid">{sets.length ? sets.map((item: Json) => {
      const complete = Boolean(item.baseline_state?.complete);
      return <article className="monitoring-set-card" key={item.root_run_id}>
        <header><div><span>{item.set_type_label} · V{item.version}</span><h3>{item.name}</h3></div><div className="row-meta"><Badge tone={complete ? "success" : "warning"}>{complete ? "基线完整" : "待完成基线"}</Badge><Badge>不可变</Badge></div></header>
        <div className="monitoring-set-stats"><span><small>题目</small><strong>{item.question_count}</strong></span><span><small>周期</small><strong>{item.period_count}</strong></span><span><small>核心/长尾</small><strong>{item.core_count}/{item.long_tail_count}</strong></span><span><small>调度</small><strong>{item.schedule_count || 0}</strong></span></div>
        <div className="monitoring-set-scenes">{MONITORING_SET_SCENES.map(scene => <span key={scene.code}><small>{scene.label}</small><strong>{item.scene_counts?.[scene.code] || 0}</strong></span>)}</div>
        <div className="monitoring-set-config"><Badge>{item.platform || item.sampler}</Badge><span>{item.model_name || "模型未记录"}</span><small>{formatDate(item.frozen_at)} 冻结</small></div>
        {item.next_period_blocker && <p className="monitoring-set-blocker">{item.next_period_blocker}</p>}
        <div className="monitoring-set-actions"><Button onClick={() => collectNext(item)} disabled={busy || !item.can_collect_next}>采集下一期</Button><Button variant="secondary" onClick={() => openOptimization(item)}>发起优化复测</Button><Button variant="secondary" onClick={() => setDetailSet(item)}>题目与周期</Button><Button variant="ghost" onClick={() => resetWizard(item)}>创建新版本</Button>{item.automation_eligible && <Button variant="ghost" onClick={() => openAutomation(item)}>启动自动闭环</Button>}</div>
      </article>;
    }) : <StatePanel kind="empty" title="尚未建立固定监测题集" description="可以套用模板、完全自定义、复制已有题集或手工逐题选择。" />}</div>
    {(payload.historical_independent_runs || []).length > 0 && <details className="monitoring-set-history"><summary>历史独立批次（{payload.historical_independent_runs.length}）</summary><p>这些批次保留原始数据，但没有不可变题集根节点，不会被连接成连续趋势。</p><div>{payload.historical_independent_runs.map((run: Json) => <span key={run.run_id}><strong>{run.name || run.run_id}</strong><small>{run.total_tasks || 0} 题 · {run.comparison_to_previous?.label || "历史独立批次"}</small></span>)}</div></details>}

    <Modal open={wizardOpen} onOpenChange={setWizardOpen} title="创建监测题集" description="逐题预览确认后冻结；创建本身不会调用真实采样接口。">
      <div className="monitoring-set-wizard">
        <div className="monitoring-wizard-steps">{[[1, "结构"], [2, "选题"], [3, "冻结预览"]].map(([index, label]) => <span className={Number(index) <= wizardStep ? "active" : ""} key={index}><b>{index}</b>{label}</span>)}</div>
        {wizardStep === 1 ? <div className="monitoring-wizard-structure">
          <div className="monitoring-set-type-switch"><button className={form.set_type === "standard" ? "active" : ""} onClick={() => updateStructure({ set_type: "standard" })}><strong>正式标准题集</strong><span>精确 40 题、四场景均有题，可进入自动闭环</span></button><button className={form.set_type === "special" ? "active" : ""} onClick={() => updateStructure({ set_type: "special", mode: form.mode === "template" ? "custom" : form.mode })}><strong>专项题集</strong><span>1-50 题，独立基线，首版不进入严格自动闭环</span></button></div>
          <div className="monitoring-set-mode-grid">{MONITORING_SET_CREATION_MODES.map(mode => <button key={mode.code} className={form.mode === mode.code ? "active" : ""} onClick={() => updateStructure({ mode: mode.code })}><strong>{mode.label}</strong><span>{mode.description}</span></button>)}</div>
          <div className="monitoring-set-form-grid"><label>题集名称<input value={form.name || ""} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="例如：星舟标准可见度基线" /></label><label>联网采样平台<select value={form.sampler || ""} onChange={event => updateStructure({ sampler: event.target.value })}>{samplerConfigs.map((item: Json) => <option key={item.sampler} value={item.sampler}>{item.label} · {item.api_key_set ? "Key 已配置" : "Key 未配置"}</option>)}</select></label>{form.mode === "copy" && <label>复制来源<select value={form.copy_from_baseline_run_id || ""} onChange={event => { const item = sets.find((set: Json) => set.root_run_id === event.target.value); updateStructure({ copy_from_baseline_run_id: event.target.value, set_type: item?.set_type || form.set_type, sampler: item?.sampler || form.sampler, template_code: item?.template_code || form.template_code, scene_targets: monitoringSceneTargets(item?.scene_counts || form.scene_targets) }); }}><option value="">请选择</option>{sets.map((item: Json) => <option value={item.root_run_id} key={item.root_run_id}>{item.name} · V{item.version}</option>)}</select></label>}</div>
          {form.mode === "template" && <div className="monitoring-template-grid">{templates.map((template: Json) => <button className={form.template_code === template.code ? "active" : ""} key={template.code} onClick={() => applyTemplate(template)}><strong>{template.label}</strong><span>{MONITORING_SET_SCENES.map(scene => `${scene.label.replace("可见", "")}${template.scene_targets?.[scene.code] || 0}`).join(" · ")}</span></button>)}</div>}
          <div className="monitoring-target-grid">{MONITORING_SET_SCENES.map(scene => <label key={scene.code}><span>{scene.label}</span><input type="number" min={0} max={50} value={form.scene_targets?.[scene.code] || 0} disabled={form.mode === "template" || form.mode === "copy"} onChange={event => updateStructure({ scene_targets: { ...form.scene_targets, [scene.code]: Number(event.target.value) } })} /><small>当前结构目标</small></label>)}</div>
          <div className={cn("monitoring-target-validation", targetValidation.valid ? "is-valid" : "is-invalid")}><strong>合计 {monitoringTargetTotal(form.scene_targets)} 题</strong><span>{targetValidation.message}</span></div>
          <details className="monitoring-angle-editor"><summary>设置生成角度（建议项，不作为冻结硬门槛）</summary><div>{MONITORING_SET_SCENES.map(scene => <section key={scene.code}><h3>{scene.label}</h3><div>{angleOptions.map((option: Json) => <label key={option.code}><span>{option.label}</span><input type="number" min={0} max={form.scene_targets?.[scene.code] || 0} value={form.angle_targets?.[scene.code]?.[option.code] || 0} onChange={event => setForm({ ...form, angle_targets: { ...form.angle_targets, [scene.code]: { ...(form.angle_targets?.[scene.code] || {}), [option.code]: Number(event.target.value) } } })} /></label>)}</div></section>)}</div></details>
        </div> : <div className="monitoring-wizard-selection">
          <div className="monitoring-selection-summary"><span><small>已选</small><strong>{selectedIds.size}</strong></span><span><small>核心/长尾</small><strong>{selectedQuestions.filter(item => item.question_tier === "core").length}/{selectedQuestions.filter(item => item.question_tier !== "core").length}</strong></span><span><small>固定题</small><strong>{selectedQuestions.filter(item => item.fixed_monitoring).length}</strong></span><span><small>状态</small><strong>{previewDirty ? "待重新校验" : preview?.can_freeze ? "可冻结" : "有阻塞"}</strong></span></div>
          <div className="monitoring-selection-scenes">{MONITORING_SET_SCENES.map(scene => { const target = Number(form.scene_targets?.[scene.code] || 0); const actual = Number(selectedSceneCounts[scene.code] || 0); const pool = (preview?.candidate_questions || []).filter((item: Json) => item.scene_code === scene.code && item.active).length; const bankGap = Math.max(0, target - pool); return <article key={scene.code}><div><strong>{scene.label}</strong><span>{actual}/{target} 已选 · 题库 {pool} 题</span></div><div className="progress"><i style={{ width: `${Math.min(100, Math.round(actual / Math.max(1, target) * 100))}%` }} /></div><Button variant="ghost" onClick={() => generateSceneGap(scene.code)} disabled={busy || !bankGap}>{bankGap ? `AI 补 ${bankGap} 题` : "题库候选已足够"}</Button></article>; })}</div>
          <div className="monitoring-selection-toolbar"><div><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索题号或题目" /><select value={sceneFilter} onChange={event => setSceneFilter(event.target.value)}><option value="all">全部场景</option>{MONITORING_SET_SCENES.map(scene => <option value={scene.code} key={scene.code}>{scene.label}</option>)}</select></div><div className="row-actions"><Button variant="secondary" onClick={() => setManualOpen(true)}>手工添加</Button><Button variant="secondary" onClick={() => onNavigate("questions")}>前往题库审核</Button></div></div>
          <div className="monitoring-candidate-list">{filteredCandidates.map((question: Json) => { const checked = selectedIds.has(String(question.question_id)); return <article className={cn(checked && "selected", !question.sampleable && "not-sampleable")} key={question.question_id}><input type="checkbox" aria-label={`选择 ${question.question_id}`} checked={checked} onChange={event => toggleCandidate(String(question.question_id), event.target.checked)} /><div><strong>{question.question_id} · {question.question}</strong><span>{question.scene_label} · {question.question_tier === "core" ? "核心题" : "长尾题"} · {question.review_status === "approved" ? "已审核" : "待审核"}</span><small>{question.fixed_monitoring ? "固定监测题" : "普通题"}{question.quality_flags?.length ? ` · ${question.quality_flags.length} 个质量提示` : ""}</small></div>{checked && <Button variant="ghost" onClick={() => openQuestionEdit(question)}>编辑</Button>}</article>; })}</div>
          <div className="monitoring-preview-messages">{previewDirty && <div className="monitoring-message warning"><Warning size={16} /><span>选题已变化，冻结前必须重新校验。</span></div>}{(preview?.blockers || []).map((item: Json) => <div className="monitoring-message danger" key={item.code}><Warning size={16} /><span>{item.message}</span></div>)}{(preview?.warnings || []).map((item: Json) => <div className="monitoring-message warning" key={item.code}><Warning size={16} /><span>{item.message}</span></div>)}</div>
          {wizardStep === 3 && <div className="monitoring-freeze-note"><CheckCircle size={18} /><div><strong>最终逐题预览已校验</strong><span>冻结后不能原地修改；题目、平台、模型或核心联网配置变化时必须创建新基线。</span></div></div>}
        </div>}
      </div>
      <div className="dialog-actions monitoring-wizard-actions"><Button variant="ghost" onClick={() => setWizardOpen(false)}>取消</Button>{wizardStep > 1 && <Button variant="secondary" onClick={() => setWizardStep(wizardStep === 3 ? 2 : 1)}>上一步</Button>}{wizardStep === 1 ? <Button onClick={() => runPreview(false)} disabled={busy || !targetValidation.valid}>生成无写入预览</Button> : wizardStep === 2 ? <Button onClick={() => runPreview(true, Array.from(selectedIds))} disabled={busy}>校验并进入冻结预览</Button> : <Button icon={Check} onClick={freezeSet} disabled={busy || previewDirty || !preview?.can_freeze}>冻结题集并创建待执行基线</Button>}</div>
    </Modal>

    <Modal open={Boolean(detailSet)} onOpenChange={(open: boolean) => { if (!open) setDetailSet(null); }} title={detailSet?.name || "监测题集"} description="冻结题目范围与历史周期均为只读。"><div className="monitoring-set-detail"><div className="monitoring-set-detail-summary"><Badge>{detailSet?.set_type_label}</Badge><Badge>V{detailSet?.version}</Badge><Badge>{detailSet?.question_count || 0} 题</Badge><span>{detailSet?.platform} · {detailSet?.model_name || "模型未记录"}</span></div><div className="monitoring-set-detail-periods"><h3>历史周期</h3>{(detailSet?.periods || []).map((period: Json) => <span key={period.run_id}><strong>{period.is_baseline ? "基线期" : `第 ${period.period_number} 期`} · {period.name}</strong><small>{period.success_count || 0}/{period.total_tasks || 0} · {period.status}</small></span>)}</div><div className="monitoring-set-detail-questions"><h3>冻结题目</h3>{MONITORING_SET_SCENES.map(scene => <section key={scene.code}><h4>{scene.label}</h4>{(detailSet?.questions || []).filter((item: Json) => item.scene_code === scene.code).map((question: Json) => <span key={question.question_id}><strong>{question.question_id} · {question.question}</strong><small>{question.question_tier === "core" ? "核心题" : "长尾题"}{question.fixed_monitoring ? " · 固定监测" : ""}</small></span>)}</section>)}</div></div><div className="dialog-actions"><Button onClick={() => setDetailSet(null)}>关闭</Button></div></Modal>

    <Modal open={Boolean(editQuestion)} onOpenChange={(open: boolean) => { if (!open) setEditQuestion(null); }} title={`编辑 ${editQuestion?.question_id || "题目"}`} description="有历史引用时会自动创建新版本并保留旧题历史。"><div className="question-dialog-body"><div className="question-edit-grid"><label className="question-edit-text">题目<textarea value={editForm.question || ""} onChange={event => setEditForm({ ...editForm, question: event.target.value })} /></label><label>场景<select value={editForm.scene_code || "demand_solution"} onChange={event => setEditForm({ ...editForm, scene_code: event.target.value })}>{MONITORING_SET_SCENES.map(scene => <option value={scene.code} key={scene.code}>{scene.label}</option>)}</select></label><label>题型<select value={editForm.question_tier || "long_tail"} onChange={event => setEditForm({ ...editForm, question_tier: event.target.value })}><option value="core">核心题</option><option value="long_tail">长尾题</option></select></label><label>优先级<select value={editForm.priority || "中"} onChange={event => setEditForm({ ...editForm, priority: event.target.value })}><option>高</option><option>中</option><option>低</option></select></label><label className="question-manual-check"><input type="checkbox" checked={Boolean(editForm.fixed)} onChange={event => setEditForm({ ...editForm, fixed: event.target.checked })} />固定监测题</label></div></div><div className="dialog-actions"><Button variant="ghost" onClick={() => setEditQuestion(null)}>取消</Button><Button onClick={saveQuestionEdit} disabled={busy || !String(editForm.question || "").trim()}>保存安全版本</Button></div></Modal>

    <Modal open={manualOpen} onOpenChange={setManualOpen} title="手工添加题目" description="先做无写入预览；确认后新增题默认待审核，不会绕过质量门。"><div className="question-dialog-body"><div className="question-edit-grid"><label className="question-edit-text">题目<textarea value={manualForm.question || ""} onChange={event => { setManualForm({ ...manualForm, question: event.target.value }); setManualPreview(null); }} /></label><label>场景<select value={manualForm.scene_code} onChange={event => setManualForm({ ...manualForm, scene_code: event.target.value })}>{MONITORING_SET_SCENES.map(scene => <option value={scene.code} key={scene.code}>{scene.label}</option>)}</select></label><label>题型<select value={manualForm.question_tier} onChange={event => setManualForm({ ...manualForm, question_tier: event.target.value })}><option value="core">核心题</option><option value="long_tail">长尾题</option></select></label><label>优先级<select value={manualForm.priority} onChange={event => setManualForm({ ...manualForm, priority: event.target.value })}><option>高</option><option>中</option><option>低</option></select></label><label className="question-manual-check"><input type="checkbox" checked={Boolean(manualForm.fixed)} onChange={event => { setManualForm({ ...manualForm, fixed: event.target.checked }); setManualPreview(null); }} />固定监测题</label></div>{manualPreview && <div className={cn("monitoring-manual-preview", manualPreview.can_commit ? "valid" : "invalid")}><strong>{manualPreview.rows?.[0]?.question || manualForm.question}</strong><span>{manualPreview.rows?.[0]?.errors?.join("；") || manualPreview.rows?.[0]?.warnings?.join("；") || "预览通过；确认后仍需人工审核。"}</span></div>}</div><div className="dialog-actions"><Button variant="ghost" onClick={() => setManualOpen(false)}>取消</Button><Button variant="secondary" onClick={previewManualQuestion} disabled={busy}>无写入预览</Button><Button onClick={commitManualQuestion} disabled={busy || !manualPreview?.can_commit}>确认新增候选题</Button></div></Modal>

    <AutomationLaunchDialog open={automationOpen} onOpenChange={setAutomationOpen} projectId={projectId} notify={notify} reload={reload} initialQuestionIds={automationQuestionIds} />
  </section>;
}

function Sampling({ data, projectId, notify, reload, onNavigate }: any) {
  const [busy, setBusy] = useState(false); const [autoRunning, setAutoRunning] = useState(false); const autoRun = useRef(false);
  const [executionMessage, setExecutionMessage] = useState("");
  const [parallelism, setParallelism] = useState(4);
  const [windowState, setWindowState] = useState<Json>({ started: false, inFlight: 0, queued: 0, success: 0, failed: 0, tasks: [], rateLimited: false, degraded: false, paused: false });
  const continuousBusy = useRef(false); const activeRunIdRef = useRef("");
  const tabId = useRef(samplingTabId());
  const [settings, setSettings] = useState<Json>({ purpose: "baseline", scope: "next_unsampled", category: "", limit: 10 });
  const samplerConfigs = data.samplerConfigs?.items || (data.samplerConfig ? [data.samplerConfig] : []);
  const monitoringPlan = data.project?.monitoring_plan || {};
  const [selectedSamplers, setSelectedSamplers] = useState<Set<string>>(new Set(["doubao_api_websearch"]));
  const selectedSamplerConfigs = samplerConfigs.filter((item: Json) => selectedSamplers.has(item.sampler));
  const unconfiguredSamplerConfigs = selectedSamplerConfigs.filter((item: Json) => !item.api_key_set);
  const approved = data.questions.filter((q: Json) => q.review_status === "approved");
  const [selected, setSelected] = useState<Set<string>>(new Set()); const [questionSearch, setQuestionSearch] = useState("");
  const [activeRunId, setActiveRunId] = useState(""); const [activeRun, setActiveRun] = useState<Json | null>(null);
  const [assisted, setAssisted] = useState<Json | null>(null); const [answer, setAnswer] = useState("");
  const [manualQuestion, setManualQuestion] = useState(""); const [manualAnswer, setManualAnswer] = useState("");
  const [recordSearch, setRecordSearch] = useState(""); const [recordRisk, setRecordRisk] = useState("all"); const [recordBrand, setRecordBrand] = useState("all");
  const [recordOpen, setRecordOpen] = useState(false); const [selectedRecordId, setSelectedRecordId] = useState("");
  useEffect(() => {
    const fixed = approved.filter((q: Json) => Boolean(q.fixed_monitoring));
    const unsampled = approved.filter((q: Json) => !q.fixed_monitoring && Number(q.real_sample_count || 0) === 0);
    const sampled = approved.filter((q: Json) => !q.fixed_monitoring && Number(q.real_sample_count || 0) > 0);
    setSelected(new Set([...fixed, ...unsampled, ...sampled].slice(0, 50).map((q: Json) => String(q.question_id))));
    setManualQuestion(approved[0]?.question_id || "");
  }, [projectId, data.questions]);
  useEffect(() => { autoRun.current = false; activeRunIdRef.current = ""; setActiveRunId(""); setActiveRun(null); setExecutionMessage(""); setWindowState({ started: false, inFlight: 0, queued: 0, success: 0, failed: 0, tasks: [], rateLimited: false, degraded: false, paused: false }); }, [projectId]);
  useEffect(() => {
    const available = new Set(samplerConfigs.map((item: Json) => item.sampler));
    const preferred = (monitoringPlan.samplers || []).filter((sampler: string) => available.has(sampler));
    const fallback = samplerConfigs[0]?.sampler ? [samplerConfigs[0].sampler] : [];
    setSelectedSamplers(new Set(preferred.length ? preferred : fallback));
  }, [projectId, monitoringPlan.version, (monitoringPlan.samplers || []).join("|"), samplerConfigs.map((item: Json) => item.sampler).join("|")]);
  useEffect(() => { activeRunIdRef.current = activeRunId; }, [activeRunId]);
  useEffect(() => { const next = data.runs.find((run: Json) => isWebsearchSampler(run.sampler) && ["queued", "running", "partial_failed"].includes(run.status) && Number(run.queued_count || 0) > 0) || data.runs.find((run: Json) => isWebsearchSampler(run.sampler)); if (next && !activeRunId) { setActiveRunId(next.run_id); loadRun(next.run_id); } }, [projectId, data.runs]);
  useEffect(() => () => { autoRun.current = false; }, []);

  const autoKey = (runId: string) => `${SAMPLING_AUTO_PREFIX}${projectId}:${runId}`;
  const leaseKey = (runId: string) => `${SAMPLING_LEASE_PREFIX}${projectId}:${runId}`;
  const readIntent = (runId: string) => readLocalJson(autoKey(runId));
  const autoResumeEnabled = Boolean(activeRunId && readIntent(activeRunId).enabled);
  function saveIntent(runId: string, resumeAfter = 0) { localStorage.setItem(autoKey(runId), JSON.stringify({ enabled: true, projectId, runId, resume_after: resumeAfter, updated_at: Date.now() })); }
  function clearIntent(runId: string) { localStorage.removeItem(autoKey(runId)); }
  function acquireLease(runId: string) {
    const key = leaseKey(runId); const now = Date.now(); const current = readLocalJson(key);
    if (current.owner && current.owner !== tabId.current && Number(current.expires_at || 0) > now) return false;
    localStorage.setItem(key, JSON.stringify({ owner: tabId.current, expires_at: now + SAMPLING_LEASE_MS }));
    return readLocalJson(key).owner === tabId.current;
  }
  function refreshLease(runId: string) { if (readLocalJson(leaseKey(runId)).owner === tabId.current) localStorage.setItem(leaseKey(runId), JSON.stringify({ owner: tabId.current, expires_at: Date.now() + SAMPLING_LEASE_MS })); }
  function releaseLease(runId: string) { if (readLocalJson(leaseKey(runId)).owner === tabId.current) localStorage.removeItem(leaseKey(runId)); }
  async function waitWithCountdown(seconds: number, label: string) {
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      if (!autoRun.current) return false;
      setExecutionMessage(`${label}，${remaining} 秒后继续`);
      await sleep(1000);
    }
    setExecutionMessage("");
    return autoRun.current;
  }
  async function loadRun(runId: string, silent = false) { if (!runId) return null; try { const result = await get(`/api/projects/${projectId}/sampling-runs/${encodeURIComponent(runId)}`); if (activeRunIdRef.current && activeRunIdRef.current !== runId) setWindowState({ started: false, inFlight: 0, queued: 0, success: 0, failed: 0, tasks: [], rateLimited: false, degraded: false, paused: false }); setActiveRun(result.run || null); setActiveRunId(runId); return result.run || null; } catch (e: any) { if (!silent) notify(e.message, "error"); return null; } }
  async function createBatch(questionIds = Array.from(selected), purpose = settings.purpose) { if (!questionIds.length) return notify("请至少选择一个已审核问题", "error"); if (questionIds.length > 50) return notify("单个监测轮次最多选择 50 道题", "error"); if (!selectedSamplers.size) return notify("请至少选择一个采样平台", "error"); if (unconfiguredSamplerConfigs.length) return notify(`请先在系统设置中配置：${unconfiguredSamplerConfigs.map((item: Json) => item.label).join("、")}`, "error"); setBusy(true); try { const result = await samplingService.createMonitoringCycle(projectId, { ...settings, samplers: Array.from(selectedSamplers), purpose, question_ids: questionIds }); const firstRun = result.runs?.[0] || result.run || null; const runId = firstRun?.run_id || ""; setActiveRunId(runId); setActiveRun(firstRun); notify(`监测轮次已创建：${result.runs?.length || selectedSamplers.size} 个平台 × ${questionIds.length} 题`, "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  function toggleSampler(sampler: string) { const next = new Set(selectedSamplers); next.has(sampler) ? next.delete(sampler) : next.add(sampler); if (!next.size) return notify("至少保留一个采样平台", "error"); setSelectedSamplers(next); }
  async function deleteRun(runId: string) { if (!runId || !confirm("仅未执行、无结果且未被引用的批次可以删除。确定删除这个批次吗？")) return; setBusy(true); try { await samplingService.deleteRun(projectId, runId); clearIntent(runId); releaseLease(runId); if (activeRunId === runId) { activeRunIdRef.current = ""; setActiveRunId(""); setActiveRun(null); } notify("未执行的采样批次已删除", "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function executeNext(silent = false, runId = activeRunIdRef.current) { if (!runId) throw new Error("请先选择或创建可执行批次"); const result = await samplingService.runWebsearchWindow(projectId, runId, 1); const current = result.executed_tasks?.[0] || result.current_task; if (!silent) notify(current?.status === "failed" ? `采样失败：${current.error || "未知错误"}` : `已完成 ${current?.question_id || "当前问题"}${current?.retry_count ? `，自动重试 ${current.retry_count} 次` : ""}`, current?.status === "failed" ? "error" : "success"); await reload(); await loadRun(result.run?.run_id || runId, true); return result; }
  async function executeWindow(runId = activeRunIdRef.current) {
    if (!runId) throw new Error("请先选择或创建可执行批次");
    const localRun = activeRun?.run_id === runId ? activeRun : data.runs.find((run: Json) => run.run_id === runId) || {};
    const predictedTasks = (localRun.tasks || []).filter((task: Json) => task.status === "queued").slice(0, parallelism).map((task: Json) => ({ task_id: task.task_id, question_id: task.question_id, status: "running" }));
    const predictedInFlight = Math.min(parallelism, Number(localRun.queued_count || predictedTasks.length || parallelism));
    setWindowState({ started: true, inFlight: predictedInFlight, queued: Math.max(0, Number(localRun.queued_count || 0) - predictedInFlight), success: Number(localRun.success_count || 0), failed: Number(localRun.failed_count || 0), tasks: predictedTasks, rateLimited: false, degraded: false, paused: false });
    const result = await samplingService.runWebsearchWindow(projectId, runId, parallelism);
    const run = result.run || {};
    const rateLimited = Boolean(result.rate_limit_state?.window_rate_limited || (result.executed_tasks || []).some((task: Json) => task.rate_limited));
    const degraded = Boolean(result.rate_limit_state?.degraded);
    setWindowState({ started: true, inFlight: 0, queued: Number(run.queued_count ?? result.remaining_queued ?? 0), success: Number(run.success_count || 0), failed: Number(run.failed_count || 0), tasks: result.executed_tasks || [], rateLimited, degraded, paused: false, effectiveConcurrency: Number(result.effective_concurrency || parallelism) });
    setActiveRun(run || null); setActiveRunId(result.run?.run_id || runId);
    await reload(); await loadRun(result.run?.run_id || runId, true);
    return result;
  }
  async function runNext() { setBusy(true); try { await executeNext(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function runAll(confirmRequired = true, requestedRunId = activeRunIdRef.current) {
    const runId = requestedRunId;
    if (!runId || continuousBusy.current) return;
    if (confirmRequired && !confirm("将连续调用真实联网采样接口，可能产生费用。中断后将在本浏览器重新打开采样页时自动继续，是否继续？")) return;
    if (!acquireLease(runId)) { setExecutionMessage("该批次正在另一个标签页执行"); return; }
    continuousBusy.current = true; autoRun.current = true; setAutoRunning(true); setBusy(true); saveIntent(runId);
    let executed = 0; let connectionRetries = 0; let finalFailed = 0; let outcome: "complete" | "stopped" | "fatal" | "network" = "stopped";
    const leaseHeartbeat = window.setInterval(() => refreshLease(runId), 10_000);
    try {
      while (autoRun.current && executed < 500) {
        refreshLease(runId);
        try {
          const result = await executeWindow(runId); const windowTasks = result.executed_tasks || []; executed += windowTasks.length; connectionRetries = 0;
          const retried = windowTasks.filter((task: Json) => Number(task.retry_count || 0) > 0);
          if (retried.length) setExecutionMessage(`本窗口有 ${retried.length} 道题完成自动重试`);
          if (result.rate_limit_state?.degraded) setExecutionMessage("接口出现限流，系统已临时降低并行数量");
          const fatalTask = windowTasks.find((task: Json) => task.status === "failed" && samplingFatalError(task.error));
          if ((result.ok === false && samplingFatalError(result.error)) || fatalTask) { const message = result.error || fatalTask?.error || "采样配置不可用"; clearIntent(runId); outcome = "fatal"; notify(`采样已停止：${message}`, "error"); break; }
          const run = result.refreshed_run || result.run || {};
          const remainingQueued = Number(run.queued_count ?? result.remaining_queued ?? 0);
          if (!result.next_task?.task_id && remainingQueued <= 0) { finalFailed = Number(run.failed_count || 0); clearIntent(runId); outcome = "complete"; break; }
          if (!windowTasks.length && remainingQueued > 0) { if (!await waitWithCountdown(3, "采样队列正在同步")) break; }
        } catch (e: any) {
          if (samplingFatalError(e)) { clearIntent(runId); outcome = "fatal"; notify(`采样已停止：${e.message}`, "error"); break; }
          if (String(e.message || "").includes("已有任务正在执行") || String(e.message || "").includes("采样窗口")) { if (!await waitWithCountdown(5, "上一组采样仍在执行")) break; continue; }
          if (connectionRetries >= SAMPLING_NETWORK_RETRY_DELAYS.length) {
            const resumeAfter = Date.now() + 120_000; saveIntent(runId, resumeAfter); outcome = "network";
            setExecutionMessage("网络仍不可用，已保留自动续跑状态");
            notify("连接多次失败，已暂停；网络恢复或重新进入采样页后会自动继续", "error"); break;
          }
          const delay = SAMPLING_NETWORK_RETRY_DELAYS[connectionRetries]; connectionRetries += 1; saveIntent(runId, Date.now() + delay * 1000);
          if (!await waitWithCountdown(delay, "连接中断，正在等待重连")) break;
        }
      }
      if (!autoRun.current) outcome = "stopped";
      if (outcome === "complete") notify(finalFailed ? `连续采样结束，本轮执行 ${executed} 条，仍有 ${finalFailed} 条失败可补采` : `连续采样完成，本轮执行 ${executed} 条`, finalFailed ? "error" : "success");
      else if (outcome === "stopped") notify(`连续采样已暂停，本轮执行 ${executed} 条，可继续执行`, "info");
    } finally {
      window.clearInterval(leaseHeartbeat); releaseLease(runId); autoRun.current = false; continuousBusy.current = false;
      setWindowState((current: Json) => ({ ...current, inFlight: 0, paused: outcome === "stopped" || outcome === "network" }));
      setAutoRunning(false); setBusy(false); if (outcome !== "network") setExecutionMessage(""); await reload(); await loadRun(runId, true);
    }
  }
  function stopAutoRun() { autoRun.current = false; if (activeRunIdRef.current) clearIntent(activeRunIdRef.current); setExecutionMessage("将在当前并发窗口完成后暂停"); setWindowState((current: Json) => ({ ...current, paused: true })); notify("当前窗口完成后暂停，剩余任务不会丢失", "info"); }

  useEffect(() => {
    if (!activeRunId) return;
    const intent = readIntent(activeRunId);
    if (!intent.enabled) return;
    const timer = window.setInterval(() => loadRun(activeRunId, true), 1500);
    return () => window.clearInterval(timer);
  }, [activeRunId, projectId, autoRunning]);
  useEffect(() => {
    if (!activeRunId || !activeRun || autoRunning || continuousBusy.current) return;
    const intent = readIntent(activeRunId);
    if (!intent.enabled) return;
    const queued = Number(activeRun.queued_count || 0); const running = Number(activeRun.running_count || 0);
    if (!queued && !running) { clearIntent(activeRunId); return; }
    if (running) { setExecutionMessage("检测到当前请求仍在后端执行，完成后自动继续"); return; }
    const delay = Math.max(0, Number(intent.resume_after || 0) - Date.now());
    const timer = window.setTimeout(() => runAll(false, activeRunId), delay);
    return () => window.clearTimeout(timer);
  }, [activeRunId, activeRun?.queued_count, activeRun?.running_count, autoRunning, projectId]);
  async function handoffRun(runId: string) {
    if (!runId || !confirm("转交后将由服务端常驻执行器继续领取该批次，可能产生真实采样费用。是否继续？")) return;
    autoRun.current = false; clearIntent(runId); setBusy(true);
    try {
      const result = await executorService.handoff(projectId, runId);
      notify(result.already_handed_off ? "该批次已由服务端接管" : "已转交服务端执行，浏览器可安全关闭", "success");
      await reload(); await loadRun(runId, true);
    } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); }
  }
  async function retryFailed() {
    const failedIds = (activeRun?.tasks || []).filter((task: Json) => task.status === "failed").map((task: Json) => task.question_id);
    const runId = activeRun?.run_id || activeRunId;
    if (!failedIds.length || !runId) return notify("当前批次没有失败任务", "error");
    if (!confirm(`将在原批次中重新执行 ${failedIds.length} 道失败题，不会创建新批次。继续采样可能产生费用，是否继续？`)) return;
    setBusy(true);
    try {
      const result = await samplingService.retryFailedWebsearch(projectId, runId);
      setActiveRun(result.run || null); setActiveRunId(runId); await reload(); await loadRun(runId, true);
      notify(result.message || `已在原批次恢复 ${result.requeued_count || failedIds.length} 道失败题`, "success");
    } catch (e: any) {
      notify(e.message, "error"); return;
    } finally { setBusy(false); }
    await runAll(false, runId);
  }
  async function startAssisted() { setBusy(true); try { const result = await samplingService.startAssisted(projectId, settings); setAssisted(result); const task = result.current_task; if (task?.question) await copyText(task.question, "采样问题"); notify("半自动批次已创建，第一题已复制", "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function submitAssisted() { const task = assisted?.current_task || assisted?.run?.tasks?.find((item: Json) => item.status === "waiting_answer"); if (!task || !answer.trim()) return notify("请粘贴当前问题的模型回答", "error"); setBusy(true); try { const result = await samplingService.submitAssisted(projectId, { run_id: assisted?.run?.run_id, task_id: task.task_id, answer: answer.trim() }); setAssisted(result.current_task ? result : null); setAnswer(""); if (result.current_task?.question) await copyText(result.current_task.question, "下一道采样问题"); notify(result.current_task ? "回答已保存，下一题已复制" : "半自动批次已完成", "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function saveManual() { if (!manualQuestion || !manualAnswer.trim()) return notify("请选择问题并粘贴回答", "error"); setBusy(true); try { await samplingService.saveManualSample(projectId, { question_id: manualQuestion, answer: manualAnswer.trim(), sample_type: "real", platform: data.project?.project?.platform || "豆包" }); await post(`/api/projects/${projectId}/analyze`, {}); setManualAnswer(""); notify("样本已保存并完成自动分析", "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function runMock() { if (!confirm("Mock 样本与真实指标隔离，仅用于旧版兼容测试。是否继续？")) return; setBusy(true); try { await post("/api/sampling-runs", { name: "Mock 自动采样批次", platform: "豆包", sampler: "mock_doubao", purpose: "exploration", scope: settings.scope, category: settings.category, limit: Number(settings.limit), auto_execute: true }); notify("Mock 批次已完成，结果与真实指标隔离", "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  async function runWeb() { if (!manualQuestion || !confirm("将启动旧版豆包网页采样，可能需要登录或人工处理验证码。是否继续？")) return; setBusy(true); try { await post("/api/doubao-web/run", { question_id: manualQuestion, timeout_ms: 90000 }); notify("网页采样已完成", "success"); await reload(); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  const available = approved.filter((q: Json) => !questionSearch || `${q.question_id} ${q.question}`.toLowerCase().includes(questionSearch.toLowerCase()));
  const fixedApprovedCount = approved.filter((q: Json) => Boolean(q.fixed_monitoring)).length;
  const records = data.samples.filter((item: Json) => (!recordSearch || `${item.question_id} ${item.question} ${item.answer_text || item.answer || ""}`.toLowerCase().includes(recordSearch.toLowerCase())) && (recordRisk === "all" || (recordRisk === "high" ? String(item.risk_level).includes("高") : !String(item.risk_level).includes("高"))) && (recordBrand === "all" || (recordBrand === "mentioned" ? item.brand_mentioned : !item.brand_mentioned)));
  const retryState = activeRun?.retry_state || null;
  const retryStates = activeRun?.retry_states || (retryState ? [retryState] : []);
  const retryRemaining = retryState ? Math.max(0, Number(retryState.retry_until_epoch || 0) - Math.floor(Date.now() / 1000)) : 0;
  const activeRunTasks = (activeRun?.tasks || []).filter((task: Json) => task.status === "running");
  const hasObservedWindowProgress = Number(windowState.inFlight || 0) > 0 && (
    Number(activeRun?.running_count || 0) > 0
    || Number(activeRun?.success_count || 0) > Number(windowState.success || 0)
    || Number(activeRun?.failed_count || 0) > Number(windowState.failed || 0)
  );
  const runningTasks = Number(windowState.inFlight || 0) > 0 && !hasObservedWindowProgress ? (windowState.tasks || []) : activeRunTasks;
  const samplingStats = hasObservedWindowProgress
    ? { running: Number(activeRun?.running_count || 0), queued: Number(activeRun?.queued_count || 0), success: Number(activeRun?.success_count || 0), failed: Number(activeRun?.failed_count || 0) }
    : windowState.started
      ? { running: Number(windowState.inFlight || 0), queued: Number(windowState.queued || 0), success: Number(windowState.success || 0), failed: Number(windowState.failed || 0) }
      : { running: Number(activeRun?.running_count || 0), queued: Number(activeRun?.queued_count || 0), success: Number(activeRun?.success_count || 0), failed: Number(activeRun?.failed_count || 0) };
  const samplingRateLimited = Boolean(retryStates.length || windowState.rateLimited);
  const samplingDegraded = Boolean(windowState.degraded);
  const runSources = data.executorStatus?.run_sources || {};
  const activeExecutionSource = activeRunId ? (runSources[activeRunId] || "browser") : "browser";
  const activeServerOwned = activeExecutionSource === "server";
  const activeExecutorBlocked = activeExecutionSource === "executor_blocked" || activeRun?.status === "executor_blocked";
  const browserExecutionLocked = activeServerOwned || activeExecutorBlocked;
  const exportRecords = (format: "csv" | "md") => { const quote = (value: any) => `"${String(value ?? "").replaceAll('"', '""')}"`; const content = format === "csv" ? [`question_id,question,answer,risk,brand_mentioned`, ...records.map((item: Json) => [item.question_id, item.question, item.answer_text || item.answer, item.risk_level, item.brand_mentioned].map(quote).join(","))].join("\n") : records.map((item: Json) => `## ${item.question_id} ${item.question}\n\n${item.answer_text || item.answer || ""}\n\n- 风险：${item.risk_level || "-"}\n- 品牌出现：${item.brand_mentioned ? "是" : "否"}`).join("\n\n---\n\n"); downloadTextFile(`GEO-答案记录.${format}`, content, format === "csv" ? "text/csv" : "text/markdown"); };
  return <><MonitoringSetManager data={data} projectId={projectId} notify={notify} reload={reload} onNavigate={onNavigate} onRunCreated={loadRun} /><Tabs.Root defaultValue="api"><Tabs.List className="tabs"><Tabs.Trigger value="api">联网 API 采样</Tabs.Trigger><Tabs.Trigger value="assisted">辅助粘贴</Tabs.Trigger><Tabs.Trigger value="records">答案记录</Tabs.Trigger><Tabs.Trigger value="advanced">兼容工具</Tabs.Trigger></Tabs.List>
    <Tabs.Content value="api">
      <div className="sampling-parallel-panel">
        <div><strong>并行通道</strong><span>最多同时处理 4 道题，请求会按安全间隔依次发出。</span></div>
        <div className="sampling-parallel-options" aria-label="并行通道">{[1, 2, 4].map(option => <button key={option} type="button" className={parallelism === option ? "active" : ""} aria-pressed={parallelism === option} disabled={autoRunning || busy || browserExecutionLocked} onClick={() => setParallelism(option)}>{option} 路</button>)}</div>
      </div>
      <div className="sampling-platform-strip"><div><strong>本轮平台</strong><span>一次轮次可创建多个平台子批次；所有平台使用同一组问题，便于横向比较。</span></div><div className="sampling-platform-options">{samplerConfigs.map((item: Json) => <button key={item.sampler} type="button" className={selectedSamplers.has(item.sampler) ? "active" : ""} aria-pressed={selectedSamplers.has(item.sampler)} onClick={() => toggleSampler(item.sampler)} disabled={busy || autoRunning}><span>{item.label}</span><small>{item.api_key_set ? "Key 已配置" : "Key 未配置"}</small></button>)}</div></div>
      <div className="sampling-provider-notice"><Badge tone={unconfiguredSamplerConfigs.length ? "danger" : "success"}>{unconfiguredSamplerConfigs.length ? `${unconfiguredSamplerConfigs.length} 个平台待配置` : `${selectedSamplers.size} 个平台可执行`}</Badge><span>默认来自项目监测方案，本轮可临时增减；答案、模型和配置快照会记录到各平台子批次。</span></div>
      <div className="sampling-settings"><label>轮次用途<select value={settings.purpose} onChange={e => setSettings({ ...settings, purpose: e.target.value })}><option value="baseline">优化前基线</option><option value="monitoring">持续监测</option><option value="supplement">补采</option><option value="exploration">探索采样</option></select></label><label>范围<select value={settings.scope} onChange={e => setSettings({ ...settings, scope: e.target.value })}><option value="next_unsampled">优先未采样</option><option value="all">全部已审核题</option></select></label><label>上限<input type="number" min="1" max="50" value={settings.limit} onChange={e => setSettings({ ...settings, limit: Number(e.target.value) })} /></label></div>
      <div className="sampling-question-picker"><div className="section-heading compact-heading"><div><h2>选择采样问题</h2><p>已选 {selected.size} / {approved.length} 道已审核题 · {fixedApprovedCount} 道固定题已优先勾选</p></div><input value={questionSearch} onChange={e => setQuestionSearch(e.target.value)} placeholder="搜索问题" /></div>{fixedApprovedCount > 50 && <div className="sampling-picker-warning">固定题超过单轮 50 题上限，本轮按题号顺序预选前 50 题，请分轮创建。</div>}<div className="picker-list">{available.map((q: Json) => <label key={q.question_id}><input type="checkbox" checked={selected.has(q.question_id)} onChange={e => { const next = new Set(selected); if (e.target.checked && next.size >= 50) return notify("单个监测轮次最多选择 50 道题", "error"); e.target.checked ? next.add(q.question_id) : next.delete(q.question_id); setSelected(next); }} /><span><strong>{q.question_id} · {q.question}{q.fixed_monitoring ? " · 固定" : ""}</strong><small>{q.scene_label || q.generation_focus_label_current || q.category} · 已有 {q.real_sample_count || 0} 条模拟样本</small></span></label>)}</div><div className="dialog-actions"><Button variant="ghost" onClick={() => setSelected(new Set())}>清空</Button><Button variant="secondary" onClick={() => setSelected(new Set(approved.slice(0, 50).map((q: Json) => q.question_id)))}>全选前 50 道</Button><Button onClick={() => createBatch()} disabled={busy || !selected.size || selected.size > 50 || !selectedSamplers.size || Boolean(unconfiguredSamplerConfigs.length)}>创建 {selectedSamplers.size} 平台监测轮次</Button></div></div>
      <div className="section-heading"><div><h2>平台子批次</h2><p>同一轮次下每个平台独立执行；失败题可在原子批次重新排队，不会新增轮次。</p></div><div className="row-actions"><Button variant="secondary" onClick={runNext} disabled={busy || !activeRunId || browserExecutionLocked}>执行下一条</Button>{autoRunning ? <Button variant="secondary" onClick={stopAutoRun}>暂停</Button> : <Button onClick={() => runAll(true)} disabled={busy || !activeRunId || browserExecutionLocked}>连续执行</Button>}<Button variant="ghost" onClick={retryFailed} disabled={busy || autoRunning || browserExecutionLocked || !activeRun || !Number(activeRun.failed_count || 0)}>重试失败题</Button></div></div>
      {activeServerOwned && <div className="sampling-executor-notice"><MonitorPlay size={18} /><div><strong>{activeRun?.schedule_name ? `周期调度：${activeRun.schedule_name}` : "该批次已由服务端执行"}</strong><span>服务端会按窗口持续领取任务，浏览器执行按钮已停用。</span></div></div>}
      {activeExecutorBlocked && <div className="sampling-executor-notice is-blocked"><Warning size={18} /><div><strong>执行器已熔断</strong><span>连续失败达到阈值，已停止自动续跑，等待人工核查。</span></div></div>}
      {activeRun && <div className="sampling-window-overview" role="status">
        <div className="sampling-window-stats"><span><small>正在处理</small><strong>{samplingStats.running}/{windowState.effectiveConcurrency || parallelism}</strong></span><span><small>排队</small><strong>{samplingStats.queued}</strong></span><span><small>成功</small><strong>{samplingStats.success}</strong></span><span><small>失败</small><strong>{samplingStats.failed}</strong></span></div>
        {runningTasks.length > 0 && <div className="sampling-running-tasks">{runningTasks.map((task: Json) => <span key={task.task_id || task.question_id}><Pulse size={14} />{task.question_id || "当前问题"} · 执行中</span>)}</div>}
        {windowState.paused && <div className="sampling-window-note">已暂停，不再领取下一组任务。</div>}
      </div>}
      {(executionMessage || retryStates.length > 0 || samplingDegraded) && <div className="sampling-execution-status" role="status"><Pulse size={18} /><div><strong>{samplingRateLimited && retryStates.length ? `限流等待，预计 ${retryRemaining} 秒后继续` : samplingDegraded ? "接口出现限流，系统已临时降低并行数量" : executionMessage}</strong>{samplingDegraded && samplingRateLimited && retryStates.length > 0 && <span>接口出现限流，系统已临时降低并行数量</span>}{retryStates.length > 0 && <span>{retryStates.slice(0, 4).map((state: Json) => `${state.question_id} · 第 ${state.retry_count}/3 次重试`).join("；")}</span>}{autoResumeEnabled && <span>自动续跑已启用，刷新或重新进入采样页后仍会继续。</span>}</div></div>}
      <RunList runs={data.runs} runSources={runSources} activeRunId={activeRunId} onSelect={loadRun} onHandoff={handoffRun} onDelete={deleteRun} autoRunning={autoRunning} autoResumeEnabled={autoResumeEnabled} retryState={retryState} busy={busy} />
      {activeRun && <RunTaskDetail run={activeRun} />}
    </Tabs.Content>
    <Tabs.Content value="assisted"><div className="feature-banner"><div><MonitorPlay size={25} /><h2>半自动粘贴采样</h2><p>创建批次后复制当前问题，在豆包中提问并把回答粘贴回来。</p></div><Button onClick={startAssisted} disabled={busy}>创建辅助批次</Button></div>{assisted?.current_task || assisted?.run ? <div className="paste-workbench"><div><Badge>当前问题</Badge><h2>{(assisted?.current_task || assisted?.run?.tasks?.find((item: Json) => item.status === "waiting_answer"))?.question}</h2><Button variant="secondary" onClick={() => copyText((assisted?.current_task || assisted?.run?.tasks?.find((item: Json) => item.status === "waiting_answer"))?.question || "", "采样问题")}>复制问题</Button></div><textarea value={answer} onChange={e => setAnswer(e.target.value)} placeholder="粘贴模型完整回答" /><Button icon={Check} onClick={submitAssisted} disabled={busy || !answer.trim()}>保存并进入下一题</Button></div> : <StatePanel kind="empty" title="尚未创建辅助批次" />}</Tabs.Content>
    <Tabs.Content value="records"><div className="section-heading"><div><h2>答案记录</h2><p>{records.length} 条模拟样本</p></div><div className="row-actions"><Button variant="secondary" onClick={() => { setSelectedRecordId(records[0]?.sample_id || ""); setRecordOpen(true); }}>打开答案记录抽屉</Button><Button variant="secondary" onClick={() => exportRecords("csv")}>导出 CSV</Button><Button variant="secondary" onClick={() => exportRecords("md")}>导出 Markdown</Button></div></div><div className="record-filters"><input value={recordSearch} onChange={e => setRecordSearch(e.target.value)} placeholder="搜索问题或回答" /><select value={recordRisk} onChange={e => setRecordRisk(e.target.value)}><option value="all">全部风险</option><option value="high">高风险</option><option value="normal">非高风险</option></select><select value={recordBrand} onChange={e => setRecordBrand(e.target.value)}><option value="all">全部品牌状态</option><option value="mentioned">提到品牌</option><option value="missing">未提到</option></select></div><div className="record-list">{records.map((item: Json) => <details key={item.sample_id}><summary><strong>{item.question_id} · {item.question}</strong><span><Badge>{item.platform || "未标注平台"}</Badge><Badge tone={item.brand_mentioned ? "success" : "neutral"}>{item.brand_mentioned ? "品牌已出现" : "未出现"}</Badge><Badge tone={String(item.risk_level).includes("高") ? "danger" : "neutral"}>{item.risk_level || "低"}</Badge></span></summary><p>{item.answer_text || item.answer || "未保存回答正文"}</p><small>{formatDate(item.sampled_at || item.created_at)} · {(item.citations || []).length} 个引用</small></details>)}{!records.length && <StatePanel kind="empty" title="当前筛选下暂无答案记录" />}</div></Tabs.Content>
    <Tabs.Content value="advanced"><div className="settings-grid"><section className="settings-card"><h2>手动单题采样</h2><p>选择问题并粘贴真实回答，保存后立即运行规则分析。</p><select value={manualQuestion} onChange={e => setManualQuestion(e.target.value)}>{approved.map((q: Json) => <option key={q.question_id} value={q.question_id}>{q.question_id} · {q.question}</option>)}</select><textarea value={manualAnswer} onChange={e => setManualAnswer(e.target.value)} placeholder="粘贴完整回答" /><Button onClick={saveManual} disabled={busy}>保存真实样本</Button></section><section className="settings-card"><h2>旧版兼容采样</h2><p>Mock 仅用于演示且与真实指标隔离；网页采样可能需要登录和验证码。</p><Button variant="secondary" onClick={runMock} disabled={busy}>运行 Mock 批次</Button><Button variant="secondary" onClick={runWeb} disabled={busy || !manualQuestion}>运行豆包网页采样</Button></section></div></Tabs.Content>
  </Tabs.Root><AnswerRecordsDialog open={recordOpen} onOpenChange={setRecordOpen} records={records} selectedId={selectedRecordId} onSelected={setSelectedRecordId} /></>;
}

function RunList({ runs, runSources, activeRunId, onSelect, onHandoff, onDelete, autoRunning, autoResumeEnabled, retryState, busy }: any) {
  return <div className="run-table">{runs.length ? runs.map((run: Json) => {
    const active = activeRunId === run.run_id;
    const queued = Number(run.queued_count || 0);
    const failed = Number(run.failed_count || 0);
    const finished = !queued && !Number(run.running_count || 0);
    const isWebsearch = isWebsearchSampler(run.sampler);
    const source = runSources?.[run.run_id] || (isWebsearch ? "browser" : "manual");
    const blocked = source === "executor_blocked" || run.status === "executor_blocked";
    const label = blocked ? "执行器已熔断" : active && retryState ? "限流等待" : active && autoRunning ? (failed ? `采样中，已有 ${failed} 条失败` : "采样中") : finished && failed ? "已完成，部分失败" : finished && ["completed", "success"].includes(run.status) ? "已完成" : source === "server" && queued ? "服务端执行中" : queued && run.started_at ? (active && autoResumeEnabled ? "等待自动继续" : "已暂停，可继续") : "待执行";
    const tone = blocked || (finished && failed) ? "danger" : finished && ["completed", "success"].includes(run.status) ? "success" : "warning";
    const sourceLabel = blocked ? "executor_blocked" : run.schedule_name ? "周期调度" : source === "server" ? "服务端" : source === "browser" ? "浏览器" : "人工";
    const canHandoff = isWebsearch && source === "browser" && queued > 0;
    const select = () => onSelect(run.run_id);
    return <article className={cn("run-row", active && "active", blocked && "executor-blocked")} key={run.run_id} role="button" tabIndex={0} onClick={select} onKeyDown={event => { if (event.currentTarget === event.target && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(); } }}>
      <div><strong>{run.name}</strong><span>{formatDate(run.created_at)} · {run.cycle_name ? `轮次：${run.cycle_name} · ` : ""}{run.schedule_name ? `调度：${run.schedule_name} · ${run.platform || run.sampler}` : (run.platform || run.sampler)} · {run.model_name || "模型未记录"} · {run.purpose_label || run.purpose}</span></div>
      <div className="run-progress"><span>{run.success_count || 0}/{run.total_tasks || 0} · 失败 {failed} · 待执行 {queued}</span><div className="progress"><i style={{ width: `${Math.round(Number(run.success_count || 0) / Math.max(1, Number(run.total_tasks || 1)) * 100)}%` }} /></div></div>
      <div className="run-state-actions"><Badge>{run.platform || run.sampler || "采样"}</Badge>{run.is_monitoring_set && <Badge tone="success">{run.is_monitoring_set_baseline ? "题集基线" : `固定题集 V${run.monitoring_set_version || 1}`}</Badge>}<Badge tone={blocked ? "danger" : source === "server" ? "success" : "neutral"}>{sourceLabel}</Badge><Badge tone={tone}>{label}</Badge>{canHandoff && <Button variant="ghost" onClick={(event: any) => { event.stopPropagation(); onHandoff(run.run_id); }} disabled={busy || autoRunning}>转交服务端执行</Button>}{run.can_delete && <Button variant="ghost" icon={Trash} onClick={(event: any) => { event.stopPropagation(); onDelete(run.run_id); }} disabled={busy || autoRunning}>删除</Button>}</div>
    </article>;
  }) : <StatePanel kind="empty" title="尚无采样批次" />}</div>;
}
function RunTaskDetail({ run }: any) { const tasks = run.tasks || []; const current = tasks.find((task: Json) => task.status === "running"); return <details className="run-task-detail"><summary>查看批次任务（{tasks.length}）{current ? ` · 当前 ${current.question_id}` : ""}</summary><div className="table-wrap"><table><thead><tr><th>问题</th><th>状态</th><th>回答字数</th><th>错误</th></tr></thead><tbody>{tasks.map((task: Json) => <tr key={task.task_id}><td><strong>{task.question_id}</strong><span>{task.question}</span></td><td><Badge tone={task.status === "success" ? "success" : task.status === "failed" ? "danger" : "warning"}>{task.status === "success" ? "成功" : task.status === "failed" ? "失败" : task.status === "running" ? "执行中" : task.status === "queued" ? "待执行" : task.status}</Badge></td><td>{task.answer_chars || 0}</td><td>{task.error || "-"}</td></tr>)}</tbody></table></div></details>; }
function AnswerRecordsDialog({ open, onOpenChange, records, selectedId, onSelected }: any) { const selected = records.find((item: Json) => item.sample_id === selectedId) || records[0]; function openSources() { if (!selected?.question_id) return; const url = new URL(location.href); url.searchParams.set("mode", "internal"); url.searchParams.set("view", "sources"); url.searchParams.set("source_question", selected.question_id); location.href = url.toString(); } return <Modal open={open} onOpenChange={onOpenChange} title="答案记录" description="按 Escape 可关闭并返回采样工作台。"><div className="answer-drawer-grid"><div className="answer-drawer-list">{records.map((item: Json) => <button className={selected?.sample_id === item.sample_id ? "active" : ""} key={item.sample_id} onClick={() => onSelected(item.sample_id)}><strong>{item.question_id} · {item.question}</strong><span>{item.platform || "未标注平台"} · {formatDate(item.sampled_at || item.created_at)}</span></button>)}</div><div className="answer-drawer-detail">{selected ? <><div className="row-meta"><Badge>{selected.platform || "未标注平台"}</Badge><Badge tone={selected.brand_mentioned ? "success" : "neutral"}>{selected.brand_mentioned ? "品牌已出现" : "未出现"}</Badge><Badge tone={String(selected.risk_level).includes("高") ? "danger" : "neutral"}>{selected.risk_level || "低"}</Badge></div><h2>{selected.question_id} · {selected.question}</h2><p>{selected.answer_text || selected.answer || "未保存回答正文"}</p><div className="section-heading compact-heading"><div><h3>引用来源</h3><p>{(selected.citations || []).length} 条模型原始引用</p></div><Button variant="secondary" icon={LinkSimple} onClick={openSources}>信源与核验</Button></div><ul>{(selected.citations || []).map((citation: Json, index: number) => <li key={index}>{citation.title || citation.url || String(citation)}</li>)}</ul></> : <StatePanel kind="empty" title="暂无答案记录" />}</div></div></Modal>; }

const ANALYSIS_SCENE_ORDER = [
  "demand_solution",
  "vendor_selection",
  "budget_case_process",
  "competitor_compare",
];

function analysisReviewValue(value: any) {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    if (!value.length) return "无";
    return value.map(item => {
      if (item && typeof item === "object") {
        return item.label || item.reason || JSON.stringify(item);
      }
      return String(item);
    }).join("；");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function Analysis({ data, projectId, notify, reload }: any) {
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<Json | null>(null);
  const [resultText, setResultText] = useState("");
  const [validation, setValidation] = useState<Json | null>(null);
  const [llmMeta, setLlmMeta] = useState<Json | null>(null);
  const [executionMeta, setExecutionMeta] = useState<Json | null>(null);
  const [choices, setChoices] = useState<AnalysisReviewChoices>({});
  const [globalDecisions, setGlobalDecisions] = useState<Record<string, "keep_rules" | "adopt_llm">>({});
  const [saved, setSaved] = useState(true);
  const [activeTab, setActiveTab] = useState("review");
  const [reviewFilter, setReviewFilter] = useState<"all" | "differences" | "unresolved">("all");
  const [sceneFilter, setSceneFilter] = useState("all");
  const [confirmedVersion, setConfirmedVersion] = useState<Json | null>(null);

  useEffect(() => {
    setBrief(null);
    setResultText("");
    setValidation(null);
    setLlmMeta(null);
    setExecutionMeta(null);
    setChoices({});
    setGlobalDecisions({});
    setSaved(true);
    setActiveTab("review");
    setReviewFilter("all");
    setSceneFilter("all");
    setConfirmedVersion(null);
  }, [projectId]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (resultText.trim() && !saved) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    addEventListener("beforeunload", handler);
    return () => removeEventListener("beforeunload", handler);
  }, [resultText, saved]);

  const reviewRows = useMemo(
    () => buildAnalysisReviewRows(
      brief?.input_package?.samples || [],
      resultText,
      data.questions || [],
    ),
    [brief, resultText, data.questions],
  );
  const executionEstimate = useMemo(
    () => getAnalysisExecutionEstimate(brief, data.samples || []),
    [brief, data.samples],
  );
  const conflicts = validation?.checks?.conflicts || [];
  const globalConflicts = conflicts.filter((item: Json) => !String(item.question_id || "").trim());
  const validationStatus = validation?.summary?.status || validation?.validation?.summary?.status || "";
  const validationFailed = ["fail", "invalid"].includes(validationStatus);

  useEffect(() => {
    if (!validation) return;
    setChoices(previous => withDefaultConsistentChoices(reviewRows, previous));
  }, [validation, reviewRows]);

  const sceneOptions = useMemo(() => {
    const map = new Map<string, string>();
    reviewRows.forEach(row => map.set(row.scene_code, row.scene_label));
    return Array.from(map, ([code, label]) => ({ code, label })).sort((left, right) => {
      const leftIndex = ANALYSIS_SCENE_ORDER.indexOf(left.code);
      const rightIndex = ANALYSIS_SCENE_ORDER.indexOf(right.code);
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex)
        || left.label.localeCompare(right.label, "zh-CN");
    });
  }, [reviewRows]);
  const visibleRows = reviewRows.filter(row => {
    if (sceneFilter !== "all" && row.scene_code !== sceneFilter) return false;
    if (reviewFilter === "differences" && !row.has_differences) return false;
    if (reviewFilter === "unresolved" && choices[row.question_id]) return false;
    return true;
  });
  const groupedRows = sceneOptions
    .map(scene => ({
      ...scene,
      rows: visibleRows.filter(row => row.scene_code === scene.code),
    }))
    .filter(scene => scene.rows.length);
  const decidedCount = reviewRows.filter(row => Boolean(choices[row.question_id])).length;
  const rejectedCount = reviewRows.filter(row => choices[row.question_id] === "rejected").length;
  const differenceCount = reviewRows.filter(row => row.has_differences).length;
  const unresolvedQuestionCount = reviewRows.filter(row => !choices[row.question_id]).length;
  const unresolvedGlobalCount = globalConflicts.filter(
    (item: Json, index: number) => !globalDecisions[reviewConflictKey(item, index)],
  ).length;
  const canConfirm = Boolean(
    validation
    && !validationFailed
    && reviewRows.length
    && unresolvedQuestionCount === 0
    && unresolvedGlobalCount === 0
    && rejectedCount < reviewRows.length,
  );

  async function refreshRules() {
    setBusy(true);
    try {
      await post(`/api/projects/${projectId}/analyze`, {});
      notify("规则分析已刷新", "success");
      await reload();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function loadBrief() {
    setBusy(true);
    try {
      const result = await analysisService.brief(projectId, ANALYSIS_FULL_SAMPLE_LIMIT);
      setBrief(result);
      const estimate = getAnalysisExecutionEstimate(result);
      notify(
        result.readiness?.can_generate_prompt
          ? `全量复核包已生成，共 ${estimate.question_count} 题；调用模型预计 ${estimate.estimated_paid_calls} 次请求`
          : `复核包尚未就绪：${(result.readiness?.missing || []).join("、")}`,
        result.readiness?.can_generate_prompt ? "success" : "error",
      );
      return result;
    } catch (error: any) {
      notify(error.message, "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runLlm(resume = false) {
    const plannedCalls = resume
      ? Number(executionMeta?.remaining_batch_count || 0)
      : executionEstimate.estimated_paid_calls;
    if (!plannedCalls) {
      notify("当前没有需要调用模型的复核批次", "error");
      return;
    }
    const actionLabel = resume ? "继续未完成分批" : "开始全量分批复核";
    if (!confirm(
      `${actionLabel}预计发起 ${plannedCalls} 次真实 API 请求并产生费用。`
      + "系统不会自动重试失败批次，是否继续？",
    )) return;
    setBusy(true);
    try {
      const payload: Json = {
        limit: ANALYSIS_FULL_SAMPLE_LIMIT,
      };
      if (resume) {
        payload.resume_result_text = resultText.trim();
        payload.resume_llm_meta = llmMeta || {};
        payload.resume_execution = executionMeta || {};
      }
      const result = await analysisService.run(projectId, payload);
      setResultText(result.result_text || "");
      setValidation(result.validation || result);
      setLlmMeta(result.llm || null);
      setExecutionMeta(result.execution || null);
      setSaved(false);
      setChoices({});
      setGlobalDecisions({});
      setConfirmedVersion(null);
      if (result.execution?.status === "partial_failed") {
        notify(
          `第 ${result.execution.failed_batch || "-"} 批未完成；已保留 `
          + `${result.execution.completed_batches || 0}/${result.execution.batch_count || 0} 批，`
          + "可继续剩余批次",
          "error",
        );
      } else {
        notify(
          `大模型复核草稿已完成 ${result.execution?.completed_batches || 1}/`
          + `${result.execution?.batch_count || 1} 批，请逐题裁决后确认`,
          "success",
        );
      }
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!resultText.trim()) {
      notify("请先生成或粘贴大模型返回 JSON", "error");
      return;
    }
    setBusy(true);
    try {
      let activeBrief = brief;
      if (!activeBrief) {
        activeBrief = await analysisService.brief(projectId, ANALYSIS_FULL_SAMPLE_LIMIT);
        setBrief(activeBrief);
      }
      const result = await analysisService.validate(projectId, {
        result_text: resultText.trim(),
        limit: ANALYSIS_FULL_SAMPLE_LIMIT,
      });
      setValidation(result);
      setExecutionMeta(null);
      setSaved(false);
      setChoices({});
      setGlobalDecisions({});
      setConfirmedVersion(null);
      const failed = ["fail", "invalid"].includes(result.summary?.status);
      notify(
        failed ? "校验未通过，请在高级模式中修正 JSON" : "校验完成，请处理逐题差异",
        failed ? "error" : "success",
      );
    } catch (error: any) {
      setValidation(null);
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmResult() {
    if (!canConfirm) {
      notify(
        `仍有 ${unresolvedQuestionCount} 道题和 ${unresolvedGlobalCount} 项全局差异未裁决`,
        "error",
      );
      return;
    }
    const reviewDecisions = buildAnalysisReviewDecisions(
      conflicts,
      choices,
      globalDecisions,
    );
    setBusy(true);
    try {
      const result = await analysisService.confirm(projectId, {
        result_text: resultText.trim(),
        limit: ANALYSIS_FULL_SAMPLE_LIMIT,
        review_decisions: reviewDecisions,
        llm_meta: llmMeta || { source: "manual_paste" },
        note: "Dashboard V2 逐题复核确认写入大模型分析与优化建议",
      });
      setSaved(true);
      const versionNo = result.summary?.analysis_version_no || 0;
      setConfirmedVersion({
        version_no: versionNo,
        saved_count: result.summary?.saved_analysis_count || 0,
        rejected_count: rejectedCount,
      });
      notify(
        `已确认 ${result.summary?.saved_analysis_count || 0} 题并生成版本 V${versionNo || "-"}`,
        "success",
      );
      await reload();
      const nextBrief = await analysisService.brief(
        projectId,
        ANALYSIS_FULL_SAMPLE_LIMIT,
      );
      setBrief(nextBrief);
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    const prompt = brief?.prompt || "";
    if (!prompt) {
      notify("当前复核包没有可复制 Prompt", "error");
      return;
    }
    try {
      await copyText(prompt, "LLM 分析 Prompt");
      notify(`已复制 ${prompt.length} 字 Prompt`, "success");
    } catch (error: any) {
      notify(error.message, "error");
    }
  }

  function clearDraft() {
    if (resultText && !confirm("清空尚未保存的复核草稿？")) return;
    setResultText("");
    setValidation(null);
    setChoices({});
    setGlobalDecisions({});
    setLlmMeta(null);
    setExecutionMeta(null);
    setConfirmedVersion(null);
    setSaved(true);
  }

  function applyConsistentChoice(choice: "rules" | "llm") {
    setChoices(previous => {
      const next = { ...previous };
      reviewRows.filter(row => row.consistent).forEach(row => {
        next[row.question_id] = choice;
      });
      return next;
    });
  }

  function goToTaskCenter() {
    const url = new URL(location.href);
    url.searchParams.set("mode", "internal");
    url.searchParams.set("view", "optimization");
    if (confirmedVersion?.version_no) {
      url.searchParams.set(
        "source_analysis_version",
        String(confirmedVersion.version_no),
      );
    }
    location.href = url.toString();
  }

  return <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
    <Tabs.List className="tabs">
      <Tabs.Trigger value="review">逐题复核</Tabs.Trigger>
      <Tabs.Trigger value="results">当前结果</Tabs.Trigger>
      <Tabs.Trigger value="versions">分析版本</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Content value="review">
      <div className="review-command analysis-review-command">
        <div>
          <h2>准备全量逐题复核</h2>
          <p>草稿与校验不写库；只有完成逐题人工裁决并确认后才生成正式分析版本。</p>
        </div>
        <Badge>{executionEstimate.question_count} 题全量范围</Badge>
        <Button variant="secondary" onClick={loadBrief} disabled={busy}>
          生成复核包
        </Button>
        {executionMeta?.status === "partial_failed" && executionMeta?.can_resume ? <>
          <Button
            onClick={() => runLlm(true)}
            disabled={busy || !brief?.readiness?.can_call_llm || !resultText.trim()}
          >
            继续未完成（预计 {executionMeta.remaining_batch_count || 0} 次）
          </Button>
          <Button
            variant="secondary"
            onClick={() => runLlm(false)}
            disabled={busy || !brief?.readiness?.can_call_llm}
          >
            从头重跑（预计 {executionEstimate.estimated_paid_calls} 次）
          </Button>
        </> : <Button
          onClick={() => runLlm(false)}
          disabled={busy || !brief?.readiness?.can_call_llm}
        >
          调用大模型（预计 {executionEstimate.estimated_paid_calls} 次）
        </Button>}
      </div>

      <div className="analysis-quality-gate">
        <Warning size={18} />
        <div>
          <strong>
            {executionEstimate.question_count} 题将按每批最多 {executionEstimate.batch_size} 题拆为
            {" "}{executionEstimate.batch_count} 批，预计 {executionEstimate.estimated_paid_calls} 次真实 API 请求
          </strong>
          <span>每批独立计费且不自动重试；成功批次会保留，可从失败批次继续。也可在高级模式粘贴 JSON 离线校验，确认前不会写入正式分析。</span>
        </div>
      </div>

      {executionMeta && <div className={cn(
        "analysis-batch-status",
        executionMeta.status === "partial_failed" && "is-failed",
      )}>
        <div>
          {executionMeta.status === "partial_failed"
            ? <Warning size={20} />
            : <CheckCircle size={20} />}
          <span>
            <strong>
              {executionMeta.status === "partial_failed" ? "分批调用尚未完成" : "分批调用已完成"}
            </strong>
            已完成 {executionMeta.completed_batches || 0}/{executionMeta.batch_count || 0} 批，
            本次发起 {executionMeta.calls_this_request || 0} 次请求；系统未自动重试。
          </span>
        </div>
        {executionMeta.last_error && <p>{executionMeta.last_error}</p>}
      </div>}

      {confirmedVersion && <div className="analysis-confirmed-banner">
        <div>
          <CheckCircle size={22} />
          <span>
            <strong>分析版本 V{confirmedVersion.version_no} 已生成</strong>
            已确认 {confirmedVersion.saved_count} 题，打回 {confirmedVersion.rejected_count} 题。
          </span>
        </div>
        <div className="row-actions">
          <Button onClick={goToTaskCenter}>前往任务中心生成建议草稿</Button>
          <Button variant="secondary" onClick={() => setActiveTab("results")}>
            查看当前正式分析
          </Button>
        </div>
      </div>}

      {brief ? <div className="review-brief analysis-review-summary">
        <div className="metric-grid compact">
          <Metric label="复核题目" value={executionEstimate.question_count} />
          <Metric label="真实样本" value={executionEstimate.sample_count} />
          <Metric label="规则基线" value={brief.input_package?.counts?.rules_baseline || 0} />
          <Metric label="预计 API 请求" value={executionEstimate.estimated_paid_calls} />
          <Metric label="有差异" value={validation ? differenceCount : "待校验"} />
          <Metric label="模型状态" value={brief.readiness?.can_call_llm ? "可调用" : "仅手工"} />
        </div>
      </div> : <StatePanel
        kind="empty"
        title="尚未生成复核包"
        description="生成后会按项目全量真实样本建立逐题复核范围。"
      />}

      {validation && <div className="analysis-review-toolbar">
        <div className="analysis-review-progress">
          <span>已裁决</span>
          <strong>{decidedCount}/{reviewRows.length} 题</strong>
          <Badge tone={rejectedCount ? "warning" : "neutral"}>{rejectedCount} 题打回</Badge>
        </div>
        <div className="analysis-review-filters">
          <label>
            场景
            <select value={sceneFilter} onChange={event => setSceneFilter(event.target.value)}>
              <option value="all">全部场景</option>
              {sceneOptions.map(scene => <option key={scene.code} value={scene.code}>{scene.label}</option>)}
            </select>
          </label>
          <div className="segmented" aria-label="复核队列筛选">
            <button className={reviewFilter === "all" ? "active" : ""} onClick={() => setReviewFilter("all")}>全部</button>
            <button className={reviewFilter === "differences" ? "active" : ""} onClick={() => setReviewFilter("differences")}>仅看有差异</button>
            <button className={reviewFilter === "unresolved" ? "active" : ""} onClick={() => setReviewFilter("unresolved")}>仅看未裁决</button>
          </div>
        </div>
        <div className="row-actions">
          <Button variant="secondary" onClick={() => applyConsistentChoice("rules")}>
            一致题全部采纳规则
          </Button>
          <Button variant="secondary" onClick={() => applyConsistentChoice("llm")}>
            一致题全部采纳 LLM
          </Button>
        </div>
      </div>}

      {validation && !validationFailed && <div className="analysis-question-list">
        {groupedRows.map(group => <section className="analysis-scene-group" key={group.code}>
          <div className="analysis-scene-heading">
            <div>
              <h2>{group.label}</h2>
              <p>{group.rows.length} 道题</p>
            </div>
            <Badge>{group.rows.filter(row => row.has_differences).length} 题有差异</Badge>
          </div>
          {group.rows.map(row => {
            const choice = choices[row.question_id];
            const conflictCount = conflicts.filter(
              (item: Json) => String(item.question_id || "") === row.question_id,
            ).length;
            return <article
              className={cn(
                "analysis-question-card",
                row.has_differences && "has-differences",
                choice === "rejected" && "is-rejected",
              )}
              key={row.question_id}
            >
              <div className="analysis-question-head">
                <div>
                  <span>{row.question_id}</span>
                  <h3>{row.question}</h3>
                </div>
                <div className="row-meta">
                  <Badge>{row.scene_label}</Badge>
                  <Badge tone={row.consistent ? "success" : row.missing_llm ? "danger" : "warning"}>
                    {row.consistent ? "一致" : row.missing_llm ? "模型缺失" : `${row.fields.filter(field => field.different).length} 项差异`}
                  </Badge>
                  {conflictCount > 0 && <Badge tone="danger">{conflictCount} 项强冲突</Badge>}
                </div>
              </div>
              <div className="analysis-compare-grid">
                <div className="analysis-compare-head">
                  <span>判断项</span>
                  <strong>当前规则结论</strong>
                  <strong>LLM 结论</strong>
                </div>
                {row.fields.map(field => <div
                  className={cn("analysis-compare-row", field.different && "is-different")}
                  key={field.field}
                >
                  <span>{field.label}</span>
                  <p>{analysisReviewValue(field.rules_value)}</p>
                  <p>{analysisReviewValue(field.llm_value)}</p>
                </div>)}
              </div>
              <div className="analysis-question-decision">
                <span>{choice ? `当前裁决：${choice === "rules" ? "采纳规则" : choice === "llm" ? "采纳 LLM" : "打回"}` : "该题尚未裁决"}</span>
                <div className="segmented">
                  <button
                    className={choice === "rules" ? "active" : ""}
                    disabled={row.missing_llm}
                    onClick={() => setChoices({ ...choices, [row.question_id]: "rules" })}
                  >
                    采纳规则
                  </button>
                  <button
                    className={choice === "llm" ? "active" : ""}
                    disabled={row.missing_llm}
                    onClick={() => setChoices({ ...choices, [row.question_id]: "llm" })}
                  >
                    采纳 LLM
                  </button>
                  <button
                    className={choice === "rejected" ? "active danger" : ""}
                    onClick={() => setChoices({ ...choices, [row.question_id]: "rejected" })}
                  >
                    打回
                  </button>
                </div>
              </div>
            </article>;
          })}
        </section>)}
        {!groupedRows.length && <StatePanel
          kind="empty"
          title="当前筛选下暂无题目"
          description="切换场景或复核状态筛选后继续查看。"
        />}
      </div>}

      {validationFailed && <div className="validation-panel analysis-validation-blocked">
        <div className="section-heading compact-heading">
          <div>
            <h2>JSON 校验未通过</h2>
            <p>修正格式错误后，系统才会生成逐题复核队列。</p>
          </div>
          <Badge tone="danger">{validationStatus}</Badge>
        </div>
        {(validation?.errors || validation?.checks?.errors || []).map((item: any, index: number) => <p className="error-line" key={index}>{typeof item === "string" ? item : item.message}</p>)}
      </div>}

      {globalConflicts.length > 0 && !validationFailed && <div className="analysis-global-conflicts">
        <div className="section-heading compact-heading">
          <div>
            <h2>全局复核提醒</h2>
            <p>这些差异未绑定具体题目，也需要人工裁决。</p>
          </div>
          <Badge tone="warning">{unresolvedGlobalCount} 项未裁决</Badge>
        </div>
        {globalConflicts.map((item: Json, index: number) => {
          const key = reviewConflictKey(item, index);
          return <div className="conflict-row" key={key}>
            <div>
              <strong>{item.field || "规则冲突提醒"}</strong>
              <span>{item.message || analysisReviewValue(item.llm_value)}</span>
            </div>
            <div className="segmented">
              <button className={globalDecisions[key] === "keep_rules" ? "active" : ""} onClick={() => setGlobalDecisions({ ...globalDecisions, [key]: "keep_rules" })}>采纳规则</button>
              <button className={globalDecisions[key] === "adopt_llm" ? "active" : ""} onClick={() => setGlobalDecisions({ ...globalDecisions, [key]: "adopt_llm" })}>采纳 LLM</button>
            </div>
          </div>;
        })}
      </div>}

      {validation && !validationFailed && <div className="analysis-confirm-bar">
        <div>
          <strong>已裁决 {decidedCount}/{reviewRows.length} 题，{rejectedCount} 题打回</strong>
          <span>{unresolvedQuestionCount + unresolvedGlobalCount > 0 ? `仍有 ${unresolvedQuestionCount} 道题、${unresolvedGlobalCount} 项全局差异待处理` : "人工质量门已满足，可以生成正式分析版本"}</span>
        </div>
        <Button icon={Check} onClick={confirmResult} disabled={busy || !canConfirm}>
          确认写入正式结果
        </Button>
      </div>}

      <details className="analysis-advanced-mode">
        <summary>高级模式：JSON 编辑、校验与 Prompt</summary>
        <div className="review-editor">
          <div className="section-heading">
            <div>
              <h2>大模型返回 JSON</h2>
              <p>用于自动生成失败时的手工粘贴、修正和离线校验。</p>
            </div>
            <div className="row-actions">
              <Button variant="secondary" onClick={validate} disabled={busy || !resultText.trim()}>校验并生成逐题队列</Button>
              <Button variant="ghost" onClick={clearDraft}>清空</Button>
            </div>
          </div>
          <textarea
            className="json-editor"
            value={resultText}
            onChange={event => {
              setResultText(event.target.value);
              setSaved(false);
              setValidation(null);
              setExecutionMeta(null);
              setChoices({});
              setGlobalDecisions({});
              setConfirmedVersion(null);
            }}
            placeholder="粘贴大模型返回 JSON"
          />
          {validation && <div className="validation-panel">
            <div className="section-heading compact-heading">
              <div>
                <h2>校验摘要</h2>
                <p>{validation.summary?.format_error_count || 0} 个错误 · {validation.summary?.warning_count || 0} 个提醒 · {conflicts.length} 项强冲突</p>
              </div>
              <Badge tone={validationStatus === "pass" ? "success" : validationFailed ? "danger" : "warning"}>{validationStatus || "review"}</Badge>
            </div>
          </div>}
        </div>
        {brief && <div className="review-brief">
          <details>
            <summary>查看复核 Prompt 与输入边界</summary>
            <pre>{brief.prompt || "当前项目还不能生成 Prompt"}</pre>
            <Button variant="secondary" onClick={copyPrompt} disabled={!brief.prompt}>复制 Prompt</Button>
          </details>
        </div>}
      </details>
    </Tabs.Content>

    <Tabs.Content value="results">
      <div className="section-heading">
        <div>
          <h2>当前正式分析</h2>
          <p>采样批次结束后会自动刷新，此按钮仅作为手动兜底。</p>
        </div>
        <Button onClick={refreshRules} disabled={busy}>{busy ? "分析中…" : "刷新规则分析（手动兜底）"}</Button>
      </div>
      <div className="metric-grid compact">
        <Metric label="已分析" value={data.results.length} detail="真实样本" />
        <Metric label="提到品牌" value={data.results.filter((item: Json) => item.brand_mentioned).length} />
        <Metric label="进入推荐" value={data.results.filter((item: Json) => item.brand_recommended).length} />
        <Metric label="高风险" value={data.results.filter((item: Json) => String(item.risk_level).includes("高")).length} />
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>问题</th><th>品牌</th><th>推荐</th><th>风险</th><th>建议</th></tr></thead>
          <tbody>{data.results.map((item: Json) => <tr key={item.analysis_id}>
            <td><strong>{item.question_id}</strong><span>{item.question}</span></td>
            <td>{item.brand_mentioned ? "是" : "否"}</td>
            <td>{item.brand_recommended ? "是" : "否"}</td>
            <td><Badge tone={String(item.risk_level).includes("高") ? "danger" : "neutral"}>{item.risk_level}</Badge></td>
            <td className="cell-long">{item.recommended_fix}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </Tabs.Content>

    <Tabs.Content value="versions">
      <div className="run-table">{data.analysisVersions.length
        ? data.analysisVersions.map((version: Json) => <div className="run-row" key={version.analysis_version_id}>
          <div>
            <strong>分析版本 V{version.version_no}</strong>
            <span>{formatDate(version.created_at)} · {version.note || version.source || "人工确认"}</span>
          </div>
          <div className="row-actions">
            {version.source === "automation_llm_first" && <Badge tone="warning">自动确认·LLM优先</Badge>}
            <Badge>{version.status || "saved"}</Badge>
          </div>
        </div>)
        : <StatePanel kind="empty" title="暂无分析版本" description="确认写入大模型复核结果后生成。" />}
      </div>
    </Tabs.Content>
  </Tabs.Root>;
}

function ReportInline({ text }: { text: string }) {
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return <>{parts.map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>)}</>;
}

function reportLead(markdown: string, fallback: string) {
  return String(markdown || "").split(/\n{2,}/).map(block => block.trim()).find(block => block && !block.startsWith("#") && !block.startsWith("-") && !/^\d+\.\s/.test(block)) || fallback;
}

function ReportMarkdown({ markdown }: { markdown: string }) {
  return <div className="report-markdown">{String(markdown || "").split("\n").map((raw, index) => {
    const line = raw.trim();
    if (!line) return <div className="report-markdown-space" key={index} />;
    if (line.startsWith("### ")) return <h3 key={index}>{line.slice(4)}</h3>;
    if (line.startsWith("## ")) return <h2 key={index}>{line.replace(/^##\s+\d+\.\s*/, "").replace(/^##\s+/, "")}</h2>;
    if (/^\d+\.\s/.test(line)) return <div className="report-numbered" key={index}><span>{line.match(/^\d+/)?.[0]}</span><p><ReportInline text={line.replace(/^\d+\.\s*/, "")} /></p></div>;
    if (line.startsWith("- ")) return <div className="report-bullet" key={index}><span>•</span><p><ReportInline text={line.slice(2)} /></p></div>;
    return <p key={index}><ReportInline text={line} /></p>;
  })}</div>;
}

function ReportEvidenceCards({ items }: { items: any[] }) {
  return <div className="report-evidence-list">{items.length ? items.map(item => <article className="report-evidence-card" key={item.id}>
    <div className="report-evidence-head"><div><span>{item.sceneLabel}</span><strong>{item.questionId} · {item.question}</strong></div><div className="row-meta"><Badge tone={item.brandMentioned ? "success" : "danger"}>{item.brandMentioned ? "品牌已出现" : "品牌未出现"}</Badge><Badge tone={item.brandRecommended ? "success" : "warning"}>{item.brandRecommended ? "已推荐" : "未推荐"}</Badge></div></div>
    <p>{item.answerExcerpt || "当前回答没有可展示的正文片段。"}</p>
    {item.competitors?.length > 0 && <small>竞品/替代对象：{item.competitors.join("、")}</small>}
    {item.citations?.length > 0 && <div className="report-citations">{item.citations.map((citation: any, index: number) => citation.url ? <a key={`${citation.url}-${index}`} href={citation.url} target="_blank" rel="noreferrer">{citation.title || "查看公开来源"}</a> : <span key={`${citation.title}-${index}`}>{citation.title}</span>)}</div>}
  </article>) : <StatePanel kind="empty" title="当前没有可展示的证据" />}</div>;
}

function ReportDocument({ model, activeSection, onSection }: { model: ReportModel; activeSection?: ReportSectionId; onSection?: (id: ReportSectionId) => void }) {
  const metric = model.metrics || {};
  const hasSamples = Number(metric.total_samples || 0) > 0;
  return <article className="report-sheet report-document"><header><Badge>{model.typeLabel}</Badge><h1>{model.title}</h1><p>{model.executiveSummary}</p></header>{model.sections.map(section => {
    const interactive = Boolean(onSection);
    return <section key={section.id} className={cn("report-document-section", activeSection === section.id && "active")} data-report-section={section.id} tabIndex={interactive ? 0 : undefined} role={interactive ? "button" : undefined} onClick={() => onSection?.(section.id)} onKeyDown={event => { if (interactive && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSection?.(section.id); } }}>
      {section.id === "metrics" ? <><h2>{section.title}</h2><div className="metric-grid compact"><Metric label="真实样本" value={hasSamples ? metric.total_samples : "待采样"} /><Metric label="基础可见率" value={hasSamples ? pct(metric.brand_mention_rate) : "暂不可诊断"} /><Metric label="强可见率" value={hasSamples ? pct(metric.brand_recommendation_rate) : "暂不可诊断"} /><Metric label="未出现问题" value={hasSamples ? metric.missing_count : "待采样"} /><Metric label="竞品压制" value={hasSamples ? metric.competitor_pressure_count : "待采样"} /><Metric label="高风险样本" value={hasSamples ? metric.high_risk_count : "待采样"} /></div></> : section.id === "scenes" ? <><h2>{section.title}</h2><div className="scene-grid">{model.scenes.map(scene => <div className="scene-card" key={scene.id}><h3>{scene.label}</h3><strong>{hasSamples ? `${scene.sampleCount} 条样本` : "待采样"}</strong><p>{hasSamples ? `品牌出现率 ${pct(scene.mentionRate)} · 推荐进入率 ${pct(scene.recommendationRate)}` : "暂不可诊断"}</p><small>{hasSamples ? `${scene.evidenceCount} 条代表证据` : "尚未建立场景基线"}</small></div>)}</div></> : section.id === "evidence" ? <><h2>{section.title}</h2><ReportEvidenceCards items={model.evidence} /></> : section.id === "appendix" ? <><h2>{section.title}</h2><ReportEvidenceCards items={model.allAnomalies} /><div className="report-method-note"><strong>方法与边界</strong><p>结论仅基于当前项目真实采样、已确认事实库和公开引用，不代表平台私有排序算法。</p></div></> : <ReportMarkdown markdown={section.markdown} />}
    </section>;
  })}</article>;
}

function Report({ data, project, projectId, mode, notify }: any) {
  const initialType: ReportType = mode === "client" ? "client" : "internal";
  const [reportType, setReportType] = useState<ReportType>(initialType);
  const [mobilePane, setMobilePane] = useState<"document" | "review">("document");
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<Json[]>(data.reportVersions || []);
  const [loadedModel, setLoadedModel] = useState<ReportModel | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [activeSection, setActiveSection] = useState<ReportSectionId>("conclusion");
  const [overrides, setOverrides] = useState<Partial<Record<ReportSectionId, string>>>({});
  const [sectionStatuses, setSectionStatuses] = useState<Partial<Record<ReportSectionId, string>>>({});
  const [pendingSection, setPendingSection] = useState<Json | null>(null);
  const [pendingWhole, setPendingWhole] = useState<Json | null>(null);
  const generatedModel = useMemo(() => buildReportModel(data, project, reportType), [data, project, reportType]);

  useEffect(() => { setVersions(data.reportVersions || []); }, [data.reportVersions, projectId]);
  useEffect(() => { setReportType(mode === "client" ? "client" : "internal"); setMobilePane("document"); setLoadedModel(null); setSelectedVersionId(""); setActiveSection("conclusion"); setOverrides({}); setSectionStatuses({}); setPendingSection(null); setPendingWhole(null); }, [mode, projectId]);

  const baseModel = loadedModel || generatedModel;
  const workingSections = baseModel.sections.map(section => ({ ...section, markdown: overrides[section.id] || section.markdown }));
  const conclusionSection = workingSections.find(section => section.id === "conclusion");
  const workingModel: ReportModel = { ...baseModel, executiveSummary: reportLead(conclusionSection?.markdown || "", baseModel.executiveSummary), sections: workingSections };
  const activeMarkdown = reportMarkdown(workingModel);
  const typeVersions = versions.filter(item => item.report_type === reportType).sort((a, b) => Number(b.version_no || 0) - Number(a.version_no || 0));
  const currentSection = workingSections.find(section => section.id === activeSection) || workingSections[0];

  function changeType(next: ReportType) { setReportType(next); setMobilePane("document"); setLoadedModel(null); setSelectedVersionId(""); setActiveSection("conclusion"); setOverrides({}); setSectionStatuses({}); setPendingSection(null); setPendingWhole(null); }
  function sectionContext(id: ReportSectionId) { return { metrics: workingModel.metrics, scenes: workingModel.scenes, evidence: id === "appendix" ? workingModel.allAnomalies : workingModel.evidence, actions: workingModel.actions, source_snapshot: workingModel.sourceSnapshot }; }

  async function requestSectionPolish() {
    if (!currentSection?.editable) return notify("该章节包含锁定指标或证据，只能审核，不能由大模型改写", "error");
    setBusy(true);
    try {
      const response = await reportService.polish(projectId, { report_type: "client", section_id: currentSection.id, section_markdown: currentSection.markdown, evidence_context: sectionContext(currentSection.id) });
      setPendingSection({ ...response.result, llm: response.llm || {} });
      notify("章节润色草稿已生成，请确认后应用", "success");
      return response.result;
    } catch (error: any) { notify(error.message, "error"); return null; } finally { setBusy(false); }
  }

  function applySectionPolish(result = pendingSection) {
    if (!result?.section_id || !result?.section_markdown) return;
    setOverrides(value => ({ ...value, [result.section_id]: result.section_markdown }));
    setSectionStatuses(value => ({ ...value, [result.section_id]: "ai_applied" }));
    setPendingSection(null);
    notify("章节润色已应用", "success");
  }

  function restoreSection() {
    setOverrides(value => { const next = { ...value }; delete next[activeSection]; return next; });
    setSectionStatuses(value => ({ ...value, [activeSection]: "pending" }));
    setPendingSection(null);
    notify("已恢复章节原文", "success");
  }

  async function runWholePolish() {
    setBusy(true);
    try {
      const response = await reportService.polish(projectId, { report_type: reportType, report_markdown: activeMarkdown });
      const bundle = { result: response.result, llm: response.llm || {} };
      setPendingWhole(bundle);
      notify("整篇润色建议已生成，不会删除原报告章节", "success");
      return bundle;
    } catch (error: any) { notify(error.message, "error"); return null; } finally { setBusy(false); }
  }

  function wholePolishPatches(bundle: Json) {
    const result = bundle?.result || {};
    const original = Object.fromEntries(workingSections.map(section => [section.id, section.markdown])) as Record<ReportSectionId, string>;
    const findings = (result.key_findings || []).map((item: string) => `- ${item}`).join("\n");
    const nextActions = (result.next_actions || []).map((item: string, index: number) => `${index + 1}. ${item}`).join("\n");
    const caveats = (result.caveats || []).map((item: string) => `- ${item}`).join("\n");
    return {
      conclusion: `## 1. 本期诊断结论\n\n${result.executive_summary || workingModel.executiveSummary}${findings ? `\n\n### 关键发现\n\n${findings}` : ""}`,
      causes: `${original.causes}${result.recommendation_summary ? `\n\n### 顾问解释\n\n${result.recommendation_summary}` : ""}`,
      actions: `${original.actions}${nextActions ? `\n\n### 优先执行顺序\n\n${nextActions}` : ""}`,
      retest: `${original.retest}${caveats ? `\n\n### 数据边界与注意事项\n\n${caveats}` : ""}`,
    } as Partial<Record<ReportSectionId, string>>;
  }

  function applyWholePolish(bundle = pendingWhole) {
    if (!bundle?.result) return;
    const patches = wholePolishPatches(bundle);
    setOverrides(value => ({ ...value, ...patches }));
    setSectionStatuses(value => ({ ...value, conclusion: "ai_applied", causes: "ai_applied", actions: "ai_applied", retest: "ai_applied" }));
    setPendingWhole(null);
    notify("润色建议已按章节应用，事实章节保持不变", "success");
  }

  function pdfPayload(model: ReportModel, markdown: string, polish: Json = {}) { return { report_type: model.reportType, title: model.title, executive_summary: model.executiveSummary, markdown_text: markdown, metrics: model.metrics, polish, llm: polish.llm || {} }; }
  async function downloadPdf(model = workingModel, markdown = activeMarkdown, polish: Json = {}) { try { await download(`/api/projects/${projectId}/report-export/pdf`, pdfPayload(model, markdown, polish), `${model.title}.pdf`); notify("PDF 已生成", "success"); } catch (error: any) { notify(error.message, "error"); } }

  async function saveDraft(silent = false) {
    setBusy(true);
    try {
      const bundle = reportBundle(workingModel, workingSections, sectionStatuses);
      const response = await reportService.saveVersion(projectId, { report_type: reportType, title: workingModel.title, executive_summary: workingModel.executiveSummary, markdown_text: activeMarkdown, applied_polish: Object.keys(overrides).length > 0, polish: bundle, llm: pendingWhole?.llm || pendingSection?.llm || {}, metrics: workingModel.metrics, source: "dashboard-v2-report-workbench", status: "draft" });
      const saved = response.version;
      setVersions(rows => [saved, ...rows.filter(row => row.report_version_id !== saved.report_version_id)]);
      setSelectedVersionId(saved.report_version_id);
      if (!silent) notify(`${workingModel.typeLabel}草稿 V${saved.version_no} 已保存`, "success");
      return saved;
    } catch (error: any) { notify(error.message, "error"); return null; } finally { setBusy(false); }
  }

  async function publishVersion(version: Json) {
    if (!version?.report_version_id) return;
    setBusy(true);
    try {
      const response = await reportService.publishVersion(projectId, version.report_version_id);
      setVersions(rows => rows.map(row => row.report_type === "client" ? { ...row, status: row.report_version_id === response.version.report_version_id ? "published" : row.status === "published" ? "superseded" : row.status } : row));
      notify(`客户诊断报告 V${response.version.version_no} 已发布`, "success");
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function saveAndPublish() { const saved = await saveDraft(true); if (saved) await publishVersion(saved); }
  function openVersion(version: Json, asCopy = false) { setLoadedModel(modelFromVersion(version, generatedModel)); setOverrides({}); setSectionStatuses(version.polish?.section_statuses || {}); setPendingSection(null); setPendingWhole(null); setSelectedVersionId(asCopy ? "" : version.report_version_id); setActiveSection("conclusion"); notify(asCopy ? "已复制为新的工作草稿" : `已打开 V${version.version_no}`, "success"); }

  async function polishAndDownload() {
    if (reportType === "client") {
      const result = pendingSection || await requestSectionPolish();
      if (!result?.section_id) return;
      const nextSections = workingSections.map(section => section.id === result.section_id ? { ...section, markdown: result.section_markdown } : section);
      const nextModel = { ...workingModel, sections: nextSections };
      await downloadPdf(nextModel, reportMarkdown(nextModel), result);
      return;
    }
    const bundle = pendingWhole || await runWholePolish();
    if (!bundle) return;
    const patches = wholePolishPatches(bundle);
    const nextSections = workingSections.map(section => patches[section.id] ? { ...section, markdown: patches[section.id]! } : section);
    const nextModel = { ...workingModel, sections: nextSections };
    await downloadPdf(nextModel, reportMarkdown(nextModel), bundle);
  }

  if (mode === "client") {
    const published = versions.filter(item => item.report_type === "client" && item.status === "published").sort((a, b) => Number(b.version_no || 0) - Number(a.version_no || 0))[0];
    if (!published) return <StatePanel kind="empty" title="诊断报告准备中" description="正式报告正在由项目团队审核，发布后将在这里展示。" />;
    const publishedModel = modelFromVersion(published, generatedModel);
    const publishedMarkdown = published.markdown_text || reportMarkdown(publishedModel);
    return <><div className="published-report-bar"><div><Badge tone="success">正式发布版</Badge><strong>V{published.version_no} · {formatDate(published.updated_at || published.created_at)}</strong></div><Button icon={FilePdf} onClick={() => downloadPdf(publishedModel, publishedMarkdown, published.polish || {})}>下载 PDF</Button></div>{published.polish?.report_bundle ? <ReportDocument model={publishedModel} /> : <article className="report-sheet report-document"><header><Badge>客户诊断报告</Badge><h1>{published.title}</h1><p>{published.executive_summary}</p></header><section><ReportMarkdown markdown={publishedMarkdown} /></section></article>}</>;
  }

  return <>{<div className="segmented report-type-tabs">{([['internal', '内部版'], ['client', '客户版'], ['weekly', '周期报告']] as Array<[ReportType, string]>).map(([id, label]) => <button key={id} className={reportType === id ? "active" : ""} onClick={() => changeType(id)}>{label}</button>)}</div>}<div className="report-toolbar"><Button variant="secondary" icon={ClipboardText} onClick={() => copyText(activeMarkdown, "报告").then(() => notify("报告已复制", "success")).catch((error: any) => notify(error.message, "error"))}>复制</Button><Button variant="secondary" onClick={() => downloadTextFile(`${workingModel.title}.md`, activeMarkdown, "text/markdown")}>下载 Markdown</Button><Button variant="secondary" onClick={() => window.print()}>打印 / PDF</Button><Button variant="secondary" onClick={reportType === "client" ? requestSectionPolish : runWholePolish} disabled={busy}>大模型润色</Button><Button variant="secondary" onClick={() => saveDraft()} disabled={busy}>保存版本</Button><Button variant="secondary" onClick={() => downloadPdf()} disabled={busy}>直接 PDF</Button><Button icon={FilePdf} onClick={polishAndDownload} disabled={busy}>润色并下载 PDF</Button>{reportType === "client" && <Button icon={Check} onClick={saveAndPublish} disabled={busy}>保存并发布</Button>}</div>
    {pendingWhole && <div className="polish-preview"><div className="section-heading compact-heading"><div><h2>整篇润色预览</h2><p>应用后只更新叙事章节，指标与证据章节保持锁定。</p></div><div className="row-actions"><Button variant="ghost" onClick={() => setPendingWhole(null)}>清除</Button><Button onClick={() => applyWholePolish()}>按章节应用</Button></div></div><strong>{pendingWhole.result?.executive_summary}</strong><ul>{(pendingWhole.result?.key_findings || []).map((item: string) => <li key={item}>{item}</li>)}</ul></div>}
    {reportType === "client" && <div className="segmented report-mobile-tabs" aria-label="移动端报告工作区"><button className={mobilePane === "document" ? "active" : ""} onClick={() => setMobilePane("document")}>报告正文</button><button className={mobilePane === "review" ? "active" : ""} onClick={() => setMobilePane("review")}>章节审核</button></div>}
    <div className={cn("report-workbench", reportType !== "client" && "report-workbench-single")}><div className={cn("report-document-pane", mobilePane !== "document" && "mobile-inactive")}><ReportDocument model={workingModel} activeSection={reportType === "client" ? activeSection : undefined} onSection={reportType === "client" ? setActiveSection : undefined} /></div>{reportType === "client" && <aside className={cn("report-review-panel", mobilePane !== "review" && "mobile-inactive")}><div className="report-review-heading"><span>章节审核</span><Badge tone={currentSection?.editable ? (sectionStatuses[activeSection] === "ai_applied" ? "success" : "warning") : "neutral"}>{currentSection?.editable ? sectionStatuses[activeSection] === "ai_applied" ? "已应用润色" : sectionStatuses[activeSection] === "reviewed" ? "已审核" : "待审核" : "事实锁定"}</Badge></div><div className="report-section-nav" aria-label="报告章节">{workingSections.map((section, index) => <button key={section.id} className={activeSection === section.id ? "active" : ""} onClick={() => { setActiveSection(section.id); setPendingSection(null); }}><span>{index + 1}</span><strong>{section.title}</strong></button>)}</div><div className="report-review-body"><h2>{currentSection?.title}</h2>{currentSection?.editable ? <><p>大模型只优化本章节表达，不会修改指标、问题 ID、竞品和引用事实。</p><div className="row-actions"><Button variant="secondary" onClick={requestSectionPolish} disabled={busy}>AI 润色本章</Button><Button variant="ghost" onClick={restoreSection} disabled={!overrides[activeSection]}>恢复原文</Button></div>{pendingSection && <div className="section-polish-preview"><strong>{pendingSection.change_summary || "章节表达已优化"}</strong><ReportMarkdown markdown={pendingSection.section_markdown || ""} /><div className="row-actions"><Button variant="ghost" onClick={() => setPendingSection(null)}>放弃</Button><Button onClick={() => applySectionPolish()}>应用本章</Button></div></div>}<Button variant="secondary" onClick={() => setSectionStatuses(value => ({ ...value, [activeSection]: "reviewed" }))}>标记已审核</Button></> : <div className="locked-section-note"><Database size={20} /><div><strong>事实章节已锁定</strong><p>本章由当前指标、样本和引用直接生成，不允许 AI 改写。</p></div></div>}</div></aside>}</div>
    <div className="section-heading"><div><h2>报告版本</h2><p>{typeVersions.length} 个已保存版本</p></div>{loadedModel && <Button variant="ghost" onClick={() => { setLoadedModel(null); setSelectedVersionId(""); setOverrides({}); setSectionStatuses({}); setPendingSection(null); setPendingWhole(null); }}>返回实时草稿</Button>}</div><div className="report-version-list">{typeVersions.length ? typeVersions.map(version => <article className={cn("report-version-row", selectedVersionId === version.report_version_id && "active")} key={version.report_version_id}><div><strong>V{version.version_no} · {version.title}</strong><span>{formatDate(version.created_at)} · {version.status === "published" ? "已发布" : version.status === "superseded" ? "已替代" : "草稿"} · {version.markdown_chars || 0} 字</span></div><div className="report-version-actions"><Button variant="ghost" onClick={() => openVersion(version)}>打开</Button><Button variant="ghost" onClick={() => openVersion(version, true)}>复制为草稿</Button><Button variant="ghost" onClick={() => downloadTextFile(`${version.title}-V${version.version_no}.md`, version.markdown_text || "", "text/markdown")}>下载</Button><Button variant="ghost" onClick={() => downloadPdf(modelFromVersion(version, generatedModel), version.markdown_text || "", version.polish || {})}>PDF</Button>{reportType === "client" && version.status !== "published" && <Button variant="secondary" onClick={() => publishVersion(version)} disabled={busy}>发布</Button>}</div></article>) : <StatePanel kind="empty" title={`${workingModel.typeLabel}暂无保存版本`} />}</div></>;
}

function LegacyReport({ data, project, projectId, mode, notify }: any) {
  const [reportType, setReportType] = useState(mode === "client" ? "client" : "internal"); const [busy, setBusy] = useState(false); const [pendingPolish, setPendingPolish] = useState<Json | null>(null); const [appliedPolish, setAppliedPolish] = useState<Json | null>(null);
  useEffect(() => { if (mode === "client") setReportType("client"); setPendingPolish(null); setAppliedPolish(null); }, [mode, projectId]);
  const summary = data.status?.analysis_summary || {}; const missingResults = data.results.filter((item: Json) => !item.brand_mentioned); const pressureResults = data.results.filter((item: Json) => (item.competitors || []).length); const missing = missingResults.length || data.samples.filter((s: Json) => !s.brand_mentioned).length;
  const customerName = project?.customer_name || data.project?.project?.customer_name || "客户"; const periods = data.trends?.periods || []; const current = data.trends?.current || periods.at(-1); const previous = data.trends?.previous || periods.at(-2);
  const typeLabel: Json = { internal: "内部版", client: "客户交付版", weekly: periods.length > 1 ? "周期报告" : "基线报告" };
  const title = reportType === "client" ? `${customerName} GEO 可见度诊断报告` : reportType === "weekly" ? `${customerName} GEO 可见度${periods.length > 1 ? "周期" : "基线"}报告` : `${customerName} GEO 监测简报`;
  const executiveSummary = !data.samples.length ? "当前尚未完成真实采样，暂不形成诊断结论。" : reportType === "weekly" && previous ? `${current?.label || "本期"}对比${previous?.label || "上期"}：${data.trends?.verdict?.summary || data.trends?.conclusion || "本期可见度稳定"}` : `当前共 ${data.samples.length} 条模拟样本，基础可见率 ${pct(summary.brand_mention_rate)}，强可见率 ${pct(summary.brand_recommendation_rate)}，仍有 ${missing} 条问题未出现品牌。`;
  const sceneLines = (data.status?.scene_score_breakdown || []).filter((scene: Json) => ["demand_solution", "vendor_selection", "budget_case_process", "competitor_compare"].includes(scene.code)).map((scene: Json) => `- ${scene.label || scene.code}：${scene.sample_count || 0} 条样本，品牌出现率 ${pct(scene.brand_mention_rate ?? scene.surface_score)}，推荐进入率 ${pct(scene.brand_recommendation_rate ?? scene.trusted_score)}`).join("\n");
  const evidenceLines = [...missingResults.slice(0, 4), ...pressureResults.slice(0, 4)].filter((item: Json, index: number, all: Json[]) => all.findIndex(other => other.question_id === item.question_id) === index).map((item: Json) => `- ${item.question_id} ${item.question}：${item.brand_mentioned ? "品牌已出现" : "未出现品牌"}${(item.competitors || []).length ? `；竞品/替代对象 ${(item.competitors || []).join("、")}` : ""}`).join("\n");
  const actionLines = data.recommendations.slice(0, 6).map((item: Json, index: number) => `${index + 1}. ${item.title}：${item.action}\n   - 完成标准：${item.implementation_plan?.acceptance_criteria?.join("；") || item.expected_impact || "内容上线并完成同题复测"}`).join("\n");
  const baseMarkdown = reportType === "client" ? `# ${title}\n\n## 1. 本期结论\n${executiveSummary}\n\n## 2. 四场景问题\n${sceneLines || "- 当前场景样本不足，建议先完成首批采样。"}\n\n## 3. 原因与证据\n${evidenceLines || "- 当前暂无可展开的异常样本。"}\n\n## 4. 内容资产清单\n${actionLines || "1. 先补齐事实库、官网信息和首批真实样本。"}\n\n## 5. 复测验收标准\n- 内容发布后使用本期未出现问题和重点采购问题进行同题复测。\n- 比较品牌出现率、推荐率、未出现问题和竞品压制变化。\n\n## 附录：方法与样本边界\n- 结论仅基于当前项目真实采样、已确认事实库和公开引用。\n- 不代表平台私有排序算法。` : reportType === "weekly" ? `# ${title}\n\n## 本期结论\n${executiveSummary}\n\n## 环比变化\n- 基础可见率：${current ? pct(current.basic_visibility_rate) : "待建立"}${previous ? `，上期 ${pct(previous.basic_visibility_rate)}` : "，等待下一期对比"}\n- 强可见率：${current ? pct(current.strong_visibility_rate) : "待建立"}${previous ? `，上期 ${pct(previous.strong_visibility_rate)}` : "，等待下一期对比"}\n- 未出现问题：${current?.missing_count || missing} 条\n- 竞品压制：${current?.competitor_pressure_count || pressureResults.length} 条\n\n## 异常提醒\n${(data.trends?.anomalies || []).map((item: Json) => `- ${item.label || item.type}：${item.message || item.summary}`).join("\n") || "- 本期未触发明显异常。"}\n\n## 下期优先动作\n${actionLines || "1. 建立下一期采样并保持同题对比。"}` : `# ${title}\n\n## 项目摘要\n${executiveSummary}\n\n## 核心指标\n- 真实样本：${data.samples.length}\n- 基础可见率：${pct(summary.brand_mention_rate)}\n- 强可见率：${pct(summary.brand_recommendation_rate)}\n- 高风险样本：${data.results.filter((item: Json) => String(item.risk_level).includes("高")).length}\n\n## 内部风险与证据\n${evidenceLines || "- 暂无异常证据。"}\n\n## 优化任务\n${actionLines || "1. 完成采样和复核后生成。"}`;
  const polishedMarkdown = (bundle: Json | null) => { const result = bundle?.result; if (!result) return baseMarkdown; return `# ${title}\n\n## 执行摘要\n${result.executive_summary || executiveSummary}\n\n## 关键发现\n${(result.key_findings || []).map((value: string) => `- ${value}`).join("\n")}\n\n## 建议说明\n${result.recommendation_summary || ""}\n\n## 下一步动作\n${(result.next_actions || []).map((value: string, index: number) => `${index + 1}. ${value}`).join("\n")}\n\n## 注意事项\n${(result.caveats || []).map((value: string) => `- ${value}`).join("\n")}`; };
  const activeMarkdown = polishedMarkdown(appliedPolish);
  const pdfPayload = (markdownText = activeMarkdown, polishBundle = appliedPolish) => ({ report_type: reportType, title, executive_summary: polishBundle?.result?.executive_summary || executiveSummary, markdown_text: markdownText, metrics: { total_samples: data.samples.length, brand_mention_rate: summary.brand_mention_rate, brand_recommendation_rate: summary.brand_recommendation_rate, missing_count: missing, competitor_pressure_count: pressureResults.length }, polish: polishBundle?.result || {}, llm: polishBundle?.llm || {} });
  async function runPolish() { setBusy(true); try { const result = await reportService.polish(projectId, { report_type: reportType, report_markdown: baseMarkdown }); const bundle = { result: result.result, llm: result.llm || {}, created_at: new Date().toISOString() }; setPendingPolish(bundle); notify("润色草稿已生成，请预览后应用", "success"); return bundle; } catch (e: any) { notify(e.message, "error"); return null; } finally { setBusy(false); } }
  async function pdf(markdownText = activeMarkdown, bundle = appliedPolish) { try { await download(`/api/projects/${projectId}/report-export/pdf`, pdfPayload(markdownText, bundle), `${title}.pdf`); notify("PDF 已生成", "success"); } catch (e: any) { notify(e.message, "error"); } }
  async function polishPdf() { setBusy(true); try { const bundle = appliedPolish || await runPolish(); if (!bundle) return; const markdown = polishedMarkdown(bundle); setAppliedPolish(bundle); setPendingPolish(null); await pdf(markdown, bundle); } finally { setBusy(false); } }
  async function saveVersion() { setBusy(true); try { const result = await reportService.saveVersion(projectId, { report_type: reportType, title, executive_summary: appliedPolish?.result?.executive_summary || executiveSummary, markdown_text: activeMarkdown, applied_polish: Boolean(appliedPolish?.result), polish: appliedPolish?.result || {}, llm: appliedPolish?.llm || {}, metrics: pdfPayload().metrics, source: "dashboard-v2", status: "saved" }); notify(`已保存 ${typeLabel[reportType]} V${result.version?.version_no || ""}`, "success"); } catch (e: any) { notify(e.message, "error"); } finally { setBusy(false); } }
  const versions = data.reportVersions.filter((item: Json) => item.report_type === reportType);
  return <>{mode === "internal" && <div className="segmented report-type-tabs">{[["internal", "内部版"], ["client", "客户版"], ["weekly", "周期报告"]].map(([id, label]) => <button key={id} className={reportType === id ? "active" : ""} onClick={() => { setReportType(id); setPendingPolish(null); setAppliedPolish(null); }}>{label}</button>)}</div>}<div className="report-toolbar"><Button variant="secondary" icon={ClipboardText} onClick={() => copyText(activeMarkdown, "报告").then(() => notify("报告已复制", "success")).catch((e: any) => notify(e.message, "error"))}>复制</Button>{mode === "internal" && <><Button variant="secondary" onClick={() => downloadTextFile(`${title}.md`, activeMarkdown, "text/markdown")}>下载 Markdown</Button><Button variant="secondary" onClick={() => window.print()}>打印 / PDF</Button><Button variant="secondary" onClick={runPolish} disabled={busy}>大模型润色</Button><Button variant="secondary" onClick={saveVersion} disabled={busy}>保存版本</Button><Button variant="secondary" onClick={() => pdf()} disabled={busy}>直接 PDF</Button><Button icon={FilePdf} onClick={polishPdf} disabled={busy}>润色并下载 PDF</Button></>}{mode === "client" && <Button icon={FilePdf} onClick={() => pdf()} disabled={busy}>下载 PDF</Button>}</div>{pendingPolish && <div className="polish-preview"><div className="section-heading compact-heading"><div><h2>润色预览</h2><p>应用前不会改变当前报告和版本记录。</p></div><div className="row-actions"><Button variant="ghost" onClick={() => setPendingPolish(null)}>清除</Button><Button onClick={() => { setAppliedPolish(pendingPolish); setPendingPolish(null); notify("已应用润色稿", "success"); }}>应用润色</Button></div></div><strong>{pendingPolish.result?.executive_summary}</strong><ul>{(pendingPolish.result?.key_findings || []).map((item: string) => <li key={item}>{item}</li>)}</ul></div>}<article className="report-sheet"><header><Badge>{typeLabel[reportType]}</Badge><h1>{title}</h1><p>{appliedPolish?.result?.executive_summary || executiveSummary}</p></header><section><h2>{reportType === "client" ? "本期结论" : "项目摘要"}</h2><div className="report-callout">{executiveSummary}</div><div className="metric-grid compact"><Metric label="真实样本" value={data.samples.length} /><Metric label="基础可见率" value={pct(summary.brand_mention_rate)} /><Metric label="强可见率" value={pct(summary.brand_recommendation_rate)} /><Metric label="未出现问题" value={missing} /></div></section>{reportType === "client" && <><section><h2>四场景问题</h2><div className="scene-grid">{(data.status?.scene_score_breakdown || []).filter((scene: Json) => ["demand_solution", "vendor_selection", "budget_case_process", "competitor_compare"].includes(scene.code)).map((scene: Json) => <div className="scene-card" key={scene.code}><h3>{scene.label || scene.code}</h3><strong>{scene.sample_count || 0} 条</strong><p>品牌出现率 {pct(scene.brand_mention_rate ?? scene.surface_score)} · 推荐进入率 {pct(scene.brand_recommendation_rate ?? scene.trusted_score)}</p></div>)}</div></section><section><h2>原因与证据</h2>{[...missingResults.slice(0, 4), ...pressureResults.slice(0, 4)].map((item: Json) => <div className="report-action" key={`${item.analysis_id}-evidence`}><span>{item.question_id}</span><div><h3>{item.question}</h3><p>{item.recommended_fix || "补充可引用事实与服务内容"}</p><small>{(item.competitors || []).length ? `竞品/替代对象：${item.competitors.join("、")}` : "品牌未出现"}</small></div></div>)}</section></>}<section><h2>{reportType === "weekly" ? "下期优先动作" : "内容资产清单"}</h2>{data.recommendations.map((item: Json, index: number) => <div className="report-action" key={item.recommendation_id}><span>0{index + 1}</span><div><h3>{item.title}</h3><p>{item.action}</p><small>验收：{item.implementation_plan?.acceptance_criteria?.join("；") || item.expected_impact}</small></div></div>)}</section><section><h2>复测验收标准</h2><p>完成内容发布后，使用本期未出现问题与重点采购问题进行同题复测，比较品牌出现率、推荐率和竞品压制变化。</p></section>{reportType === "client" && <details className="report-appendix"><summary>附录：方法、样本与引用边界</summary><pre>{activeMarkdown}</pre></details>}</article>{mode === "internal" && <><div className="section-heading"><div><h2>报告版本</h2><p>{versions.length} 个已保存版本</p></div></div><div className="run-table">{versions.length ? versions.map((version: Json) => <div className="run-row" key={version.report_version_id}><div><strong>V{version.version_no} · {version.title}</strong><span>{formatDate(version.created_at)} · {version.applied_polish ? "已应用润色" : "未应用润色"} · {version.markdown_chars || 0} 字</span></div><Badge>{version.status || "saved"}</Badge></div>) : <StatePanel kind="empty" title={`${typeLabel[reportType]}暂无保存版本`} />}</div></>}</>;
}

function SamplingScheduleManager({ data, projectId, notify, reload }: any) {
  const schedules = data.samplingSchedules?.schedules || [];
  const templates = data.samplingSchedules?.templates || [];
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Json>({
    name: "每周持续监测",
    source_run_id: "",
    cadence: "weekly",
    day_of_week: 2,
    day_of_month: 1,
    run_at_local: "06:47",
    daily_task_budget: 200,
    max_concurrency: 4,
  });
  const templateKey = templates.map((item: Json) => item.run_id).join("|");
  useEffect(() => {
    setForm((current: Json) => ({
      ...current,
      source_run_id: templates.some((item: Json) => item.run_id === current.source_run_id)
        ? current.source_run_id
        : templates[0]?.run_id || "",
    }));
  }, [projectId, templateKey]);

  function changeCadence(cadence: "weekly" | "monthly") {
    setForm((current: Json) => {
      const currentName = String(current.name || "").trim();
      const usesDefaultName = !currentName || ["每周持续监测", "每月持续监测"].includes(currentName);
      return {
        ...current,
        cadence,
        name: usesDefaultName ? (cadence === "weekly" ? "每周持续监测" : "每月持续监测") : current.name,
      };
    });
  }

  async function createSchedule() {
    if (!form.source_run_id) return notify("请先选择一个联网采样模板批次", "error");
    const name = String(form.name || "").trim();
    const runAtLocal = String(form.run_at_local || "").trim();
    const dailyTaskBudget = Number(form.daily_task_budget);
    const maxConcurrency = Number(form.max_concurrency);
    const dayOfWeek = Number(form.day_of_week);
    const dayOfMonth = Number(form.day_of_month);
    if (!name) return notify("请填写调度名称", "error");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(runAtLocal)) return notify("请选择有效的低峰执行时刻", "error");
    if (!Number.isInteger(dailyTaskBudget) || dailyTaskBudget < 1 || dailyTaskBudget > 500) return notify("单日任务预算必须是 1～500 的整数", "error");
    if (![1, 2, 4].includes(maxConcurrency)) return notify("最大并发只支持 1、2 或 4 路", "error");
    if (form.cadence === "weekly" && (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7)) return notify("请选择有效的每周执行日", "error");
    if (form.cadence === "monthly" && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) return notify("每月日期必须是 1～28 的整数", "error");
    setBusy(true);
    try {
      const payload = {
        ...form,
        name,
        run_at_local: runAtLocal,
        enabled: false,
        day_of_week: form.cadence === "weekly" ? dayOfWeek : null,
        day_of_month: form.cadence === "monthly" ? dayOfMonth : null,
        daily_task_budget: dailyTaskBudget,
        max_concurrency: maxConcurrency,
      };
      await samplingScheduleService.create(projectId, payload);
      notify("周期调度已创建，当前保持停用", "success");
      await reload();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSchedule(schedule: Json) {
    const enabling = !schedule.enabled;
    if (enabling && !confirm("开启后到点会自动克隆模板并执行。调度执行会产生真实 API 费用，是否继续？")) return;
    setBusy(true);
    try {
      await samplingScheduleService.update(projectId, schedule.schedule_id, { enabled: enabling });
      notify(enabling ? "周期调度已开启" : "周期调度已停用", "success");
      await reload();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule(schedule: Json) {
    if (!confirm(`删除调度“${schedule.name}”？已生成的采样批次和历史数据会保留。`)) return;
    setBusy(true);
    try {
      await samplingScheduleService.remove(projectId, schedule.schedule_id);
      notify("调度已删除，历史采样批次保持不变", "success");
      await reload();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  const weekdayLabels = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const ruleLabel = (schedule: Json) => schedule.cadence === "weekly"
    ? `每周${weekdayLabels[Number(schedule.day_of_week)] || ""} ${schedule.run_at_local}`
    : `每月 ${schedule.day_of_month} 日 ${schedule.run_at_local}`;

  return <section className="schedule-management">
    <div className="section-heading">
      <div><h2>周期监测调度</h2><p>从一个真实联网 API 批次精确克隆同题范围，沿用模板平台并形成可比较的后续监测批次。</p></div>
      <Badge tone={schedules.some((item: Json) => item.enabled) ? "success" : "neutral"}>{schedules.filter((item: Json) => item.enabled).length} 个已开启</Badge>
    </div>
    <div className="schedule-cost-warning"><Warning size={17} /><span>调度执行会产生真实 API 费用。新调度默认停用，必须人工开启后才会到点执行。</span></div>
    {templates.length ? <div className="schedule-create-grid">
      <label className="schedule-field schedule-name-field"><span>调度名称</span><input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label className="schedule-field schedule-template-field"><span>模板批次</span><select value={form.source_run_id} onChange={event => setForm({ ...form, source_run_id: event.target.value })}>{templates.map((item: Json) => <option value={item.run_id} key={item.run_id}>{item.platform || item.sampler} · {item.name} · {item.task_count} 题</option>)}</select></label>
      <label className="schedule-field schedule-cadence-field"><span>周期</span><select value={form.cadence} onChange={event => changeCadence(event.target.value as "weekly" | "monthly")}><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
      {form.cadence === "weekly"
        ? <label className="schedule-field schedule-day-field"><span>执行日</span><select value={form.day_of_week} onChange={event => setForm({ ...form, day_of_week: Number(event.target.value) })}>{weekdayLabels.slice(1).map((label, index) => <option value={index + 1} key={label}>{label}</option>)}</select></label>
        : <label className="schedule-field schedule-day-field"><span>每月日期</span><input type="number" min="1" max="28" step="1" value={form.day_of_month} onChange={event => setForm({ ...form, day_of_month: Number(event.target.value) })} /></label>}
      <label className="schedule-field schedule-time-field"><span>低峰时刻</span><input type="time" value={form.run_at_local} onChange={event => setForm({ ...form, run_at_local: event.target.value })} /></label>
      <label className="schedule-field schedule-budget-field"><span>单日任务预算</span><input type="number" min="1" max="500" step="1" aria-label="单日任务预算" aria-describedby="schedule-budget-help" value={form.daily_task_budget} onChange={event => setForm({ ...form, daily_task_budget: Number(event.target.value) })} /><small id="schedule-budget-help">硬上限 500；调度执行会产生真实 API 费用。</small></label>
      <label className="schedule-field schedule-concurrency-field"><span>最大并发</span><select value={form.max_concurrency} onChange={event => setForm({ ...form, max_concurrency: Number(event.target.value) })}>{[1, 2, 4].map(value => <option value={value} key={value}>{value} 路</option>)}</select></label>
      <div className="schedule-create-actions"><Button icon={Plus} onClick={createSchedule} disabled={busy || !projectId || !form.source_run_id}>创建停用调度</Button></div>
    </div> : <StatePanel kind="empty" title="暂无可用模板批次" description="请先完成至少一个受支持平台的联网采样批次，再创建周期调度。" />}
    <div className="schedule-list">
      {schedules.length ? schedules.map((schedule: Json) => <article className="schedule-row" key={schedule.schedule_id}>
        <div className="schedule-main"><div><strong>{schedule.name}</strong><span>{ruleLabel(schedule)} · {schedule.source_platform || schedule.source_sampler} · 模板：{schedule.source_run_name || schedule.source_run_id} · {schedule.source_task_count || 0} 题</span></div><div className="schedule-badges"><Badge>{schedule.source_platform || schedule.source_sampler}</Badge><Badge tone={schedule.enabled ? "success" : "neutral"}>{schedule.enabled ? "已开启" : "已停用"}</Badge>{schedule.last_status && <Badge tone={schedule.last_status === "executor_blocked" ? "danger" : "neutral"}>{schedule.last_status}</Badge>}</div></div>
        <div className="schedule-meta"><span><small>下次运行</small><strong>{formatDate(schedule.next_run_at)}</strong></span><span><small>单日预算</small><strong>{schedule.daily_task_budget} 题</strong></span><span><small>已生成</small><strong>{schedule.generated_run_count || 0} 批</strong></span></div>
        {schedule.last_error && <div className="schedule-error"><Warning size={15} />{schedule.last_error}</div>}
        <div className="schedule-actions"><Button variant={schedule.enabled ? "secondary" : "primary"} onClick={() => toggleSchedule(schedule)} disabled={busy}>{schedule.enabled ? "停用" : "开启"}</Button><Button variant="ghost" icon={Trash} onClick={() => deleteSchedule(schedule)} disabled={busy}>删除</Button></div>
      </article>) : <StatePanel kind="empty" title="尚未创建周期调度" description="选择一个已完成的联网采样批次作为模板，新调度会默认保持停用。" />}
    </div>
  </section>;
}

function Settings({ data, projectId, project, notify, reload, reloadGlobal }: any) {
  const [llm, setLlm] = useState<Json>({});
  const [samplers, setSamplers] = useState<Json>({});
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Json | null>(null);
  const [confirmText, setConfirmText] = useState("");
  useEffect(() => {
    setLlm(data.llmConfig || {});
    const items = data.samplerConfigs?.items || (data.samplerConfig ? [data.samplerConfig] : []);
    setSamplers(Object.fromEntries(items.map((item: Json) => [item.sampler, { ...item, api_key: "" }])));
  }, [data.llmConfig, data.samplerConfig, data.samplerConfigs]);
  const executor = data.executorStatus || {};
  async function save(path: string, value: Json) {
    try {
      const payload = { ...value };
      if (!payload.api_key) delete payload.api_key;
      await post(path, payload);
      notify("配置已保存，密钥仍保持掩码", "success");
      await reload();
    } catch (e: any) {
      notify(e.message, "error");
    }
  }
  const matches = Boolean(projectId && (confirmText.trim() === projectId || confirmText.trim() === project?.name));
  async function loadPreview(kind: "reset" | "delete") {
    if (!projectId) return;
    setBusy(true);
    try {
      const result = kind === "reset" ? await settingsService.resetPreview(projectId) : await settingsService.deletePreview(projectId);
      setPreview({ ...result, kind });
      notify(`${kind === "reset" ? "重置" : "删除"}影响已读取`, "success");
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function resetProject() {
    if (!matches || !confirm(`确认重置项目“${project?.name || projectId}”的测试数据？项目和事实库会保留。`)) return;
    setBusy(true);
    try {
      const result = await settingsService.resetProject(projectId, { confirm_text: confirmText.trim() });
      setConfirmText(""); setPreview(null);
      notify(`测试数据已重置，数据库备份：${result.backup_file || "已生成"}`, "success");
      await reload();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function deleteProject() {
    if (!matches || !confirm(`确认删除项目“${project?.name || projectId}”？删除前会自动备份数据库。`)) return;
    setBusy(true);
    try {
      const result = await settingsService.deleteProject(projectId, { confirm_text: confirmText.trim() });
      setConfirmText(""); setPreview(null);
      notify(`项目已删除并备份：${result.backup_file || "data 目录"}`, "success");
      await reloadGlobal();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function resetFictional() {
    if (!confirm("确认重置星舟 Demo 到事实库已配置、题库和回答清空的状态？")) return;
    setBusy(true);
    try {
      const result = await settingsService.resetFictional({});
      notify(`星舟 Demo 已重置，数据库备份：${result.backup_file || "已生成"}`, "success");
      await reloadGlobal();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function toggleExecutor() {
    setBusy(true);
    try {
      const result = executor.paused ? await executorService.resume() : await executorService.pause();
      notify(result.paused ? "服务端采样执行器已暂停" : "服务端采样执行器已恢复", "success");
      await reload();
    } catch (e: any) {
      notify(e.message, "error");
    } finally {
      setBusy(false);
    }
  }
  return <Tabs.Root defaultValue="config">
    <Tabs.List className="tabs"><Tabs.Trigger value="config">模型、采样与调度</Tabs.Trigger><Tabs.Trigger value="danger">重置与删除</Tabs.Trigger></Tabs.List>
    <Tabs.Content value="config">
      <div className="settings-grid">
        <section className="settings-card"><div className="settings-icon"><Sparkle /></div><div><h2>共享大模型</h2><p>用于知识库草稿、题库生成、复核和报告润色。</p></div><label>服务商<input value={llm.provider || ""} onChange={e => setLlm({ ...llm, provider: e.target.value })} /></label><label>模型<input value={llm.model || ""} onChange={e => setLlm({ ...llm, model: e.target.value })} /></label><label>接口地址<input value={llm.endpoint || ""} onChange={e => setLlm({ ...llm, endpoint: e.target.value })} /></label><label>API Key<input type="password" value={llm.api_key || ""} placeholder={llm.api_key_set ? "已配置，留空保持不变" : "请输入密钥"} onChange={e => setLlm({ ...llm, api_key: e.target.value })} /></label><Button onClick={() => save("/api/llm-config", llm)}>保存大模型配置</Button></section>
        {(data.samplerConfigs?.items || (data.samplerConfig ? [data.samplerConfig] : [])).map((item: Json) => { const sampler = samplers[item.sampler] || item; return <section className="settings-card sampler-settings-card" key={item.sampler}><div className="settings-icon"><MonitorPlay /></div><div><h2>{item.label}联网采样</h2><p>{item.approximation_notice || "用于真实提问的 API 联网近似采样。"}</p></div><div className="executor-status-line"><Badge tone={item.api_key_set ? "success" : "danger"}>{item.api_key_set ? "API Key 已配置" : "API Key 未配置"}</Badge><Badge>{item.provider}</Badge></div><label>模型<select value={sampler.model || ""} onChange={e => setSamplers({ ...samplers, [item.sampler]: { ...sampler, model: e.target.value } })}>{(item.model_options || []).map((model: Json) => <option value={model.value} key={model.value}>{model.label}</option>)}</select></label><label>接口地址<input value={sampler.endpoint || ""} onChange={e => setSamplers({ ...samplers, [item.sampler]: { ...sampler, endpoint: e.target.value } })} /></label><label>API Key<input type="password" value={sampler.api_key || ""} placeholder={item.api_key_set ? "已配置，留空保持不变" : "请输入密钥"} onChange={e => setSamplers({ ...samplers, [item.sampler]: { ...sampler, api_key: e.target.value } })} /></label><Button onClick={() => save(`/api/sampler-config/${item.slug}`, sampler)}>保存 {item.label} 配置</Button></section>; })}
        <section className="settings-card executor-settings-card"><div className="settings-icon"><Database /></div><div><h2>服务端采样执行器</h2><p>每 {executor.tick_seconds || 30} 秒检查一次，只接管已转交或周期调度批次。</p></div><div className="executor-status-grid"><span><small>总开关</small><strong>{executor.paused ? "已暂停" : "运行中"}</strong></span><span><small>在跑批次</small><strong>{executor.running_run_count || 0}</strong></span><span><small>今日任务</small><strong>{executor.today?.task_count || 0}/{executor.today?.hard_limit || 500}</strong></span><span><small>已配置平台</small><strong>{executor.configured_provider_count || 0}/4</strong></span></div><div className="executor-provider-list">{(executor.providers || []).map((provider: Json) => <span key={provider.sampler}><Badge tone={provider.api_key_set ? "success" : "neutral"}>{provider.label}</Badge><small>{provider.api_key_set ? `${provider.effective_limit || 4} 路 · 可执行` : "Key 未配置"}</small></span>)}</div><div className="executor-status-line"><Badge tone={executor.blocked_runs?.length ? "danger" : "neutral"}>{executor.blocked_runs?.length || 0} 个熔断批次</Badge></div>{executor.last_error && <div className="executor-last-error"><Warning size={16} /><span>{executor.last_error}</span></div>}<Button variant={executor.paused ? "primary" : "secondary"} onClick={toggleExecutor} disabled={busy}>{executor.paused ? "恢复服务端执行器" : "暂停服务端执行器"}</Button></section>
      </div>
      <SamplingScheduleManager data={data} projectId={projectId} notify={notify} reload={reload} />
    </Tabs.Content>
    <Tabs.Content value="danger"><section className="danger-zone"><div><Warning size={25} /><h2>项目数据操作</h2><p>所有操作都先预览影响，并由后端自动备份数据库。当前项目：{project?.name || "未选择"}（{projectId || "-"}）</p></div><div className="row-actions"><Button variant="secondary" onClick={() => loadPreview("reset")} disabled={busy || !projectId}>预览重置影响</Button><Button variant="secondary" onClick={() => loadPreview("delete")} disabled={busy || !projectId}>预览删除影响</Button><Button variant="ghost" onClick={resetFictional} disabled={busy}>重置星舟 Demo</Button></div>{preview && <div className="preview-counts"><strong>{preview.kind === "reset" ? "重置" : "删除"}影响</strong><pre>{JSON.stringify(preview.counts || preview.impact || preview.summary || {}, null, 2)}</pre></div>}<label>输入项目名称或项目 ID 以确认<input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder={project?.name || projectId || "当前无项目"} /></label><div className="row-actions"><Button variant="secondary" onClick={resetProject} disabled={busy || !matches}>确认重置测试数据</Button><Button variant="secondary" onClick={deleteProject} disabled={busy || !matches}>确认删除项目</Button></div></section></Tabs.Content>
  </Tabs.Root>;
}

export function App() {
  const initial = queryState(); const [mode, setMode] = useState<ViewMode>(initial.mode); const [view, setView] = useState<ViewId>(initial.view);
  const [customers, setCustomers] = useState<Customer[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [customerId, setCustomerId] = useState(localStorage.getItem("geo-v2-customer") || ""); const [projectId, setProjectId] = useState(localStorage.getItem("geo-v2-project") || "");
  const [data, setData] = useState<AppData>(EMPTY_DATA); const [loading, setLoading] = useState(true); const [viewLoading, setViewLoading] = useState(false); const [error, setError] = useState(""); const [viewError, setViewError] = useState(""); const [toast, setToast] = useState<{ message: string; tone: string } | null>(null);
  const activeProjectLoad = useRef(""); const projectLoadVersion = useRef(0); const viewLoadCount = useRef(0); const loadedViews = useRef(new Set<string>()); const inFlightViews = useRef(new Map<string, Promise<void>>());
  const notify = useCallback((message: string, tone = "info") => { setToast({ message, tone }); setTimeout(() => setToast(null), 3600); }, []);

  const activateNoProject = useCallback((cid: string) => {
    projectLoadVersion.current += 1;
    activeProjectLoad.current = `${cid}:no-project`;
    loadedViews.current.clear(); inFlightViews.current.clear(); viewLoadCount.current = 0;
    localStorage.removeItem("geo-v2-project");
    if (cid) localStorage.setItem("geo-v2-customer", cid);
    setProjectId(""); setData(EMPTY_DATA); setError(""); setViewError(""); setViewLoading(false); setLoading(false);
  }, []);

  const loadGlobal = useCallback(async () => { const [c, p] = await Promise.all([get("/api/customers"), get("/api/projects")]); const cs = c.customers || []; const ps = p.projects || []; setCustomers(cs); setProjects(ps); const nextCustomer = customerId && cs.some((x: Customer) => x.customer_id === customerId) ? customerId : cs[0]?.customer_id || ""; const customerProjects = ps.filter((x: Project) => x.customer_id === nextCustomer); const nextProject = projectId && customerProjects.some((x: Project) => x.project_id === projectId) ? projectId : customerProjects[0]?.project_id || ""; setCustomerId(nextCustomer); setProjectId(nextProject); if (nextCustomer) localStorage.setItem("geo-v2-customer", nextCustomer); if (nextProject) localStorage.setItem("geo-v2-project", nextProject); else localStorage.removeItem("geo-v2-project"); return { customerId: nextCustomer, projectId: nextProject }; }, [customerId, projectId]);

  const loadDatasets = useCallback(async (datasets: readonly ProjectDataset[], pid: string, cid: string): Promise<Partial<AppData>> => {
    const parts = await Promise.all(datasets.map(async dataset => {
      if (dataset === "status") return { status: await get(`/api/projects/${pid}/status`) };
      if (dataset === "project") return { project: await get(`/api/projects/${pid}`) };
      if (dataset === "samples") { const payload = await get(`/api/projects/${pid}/samples?sample_type=mock&limit=500`); return { samples: payload.samples || [] }; }
      if (dataset === "results") { const payload = await get(`/api/projects/${pid}/analysis-results`); return { results: payload.results || [] }; }
      if (dataset === "trends") return { trends: await get(`/api/projects/${pid}/monitoring-trends?limit=6`) };
      if (dataset === "questions") { const payload = await get(`/api/projects/${pid}/questions`); return { questions: payload.questions || [], questionSummary: payload.summary || {}, questionSceneSummary: payload.scene_summary || [], questionProfile: payload.question_profile || {}, questionProfileSaved: Boolean(payload.question_profile_saved) }; }
      if (dataset === "recommendations") { const payload = await get(`/api/projects/${pid}/recommendations`); return { recommendations: payload.items || [], actionTasks: payload.action_tasks || [], taskDrafts: payload.task_drafts || [], recommendationSummary: payload.summary || {} }; }
      if (dataset === "monitoringSets") return { monitoringSets: await loadMonitoringSetsCompat(pid) };
      if (dataset === "runs") { const payload = await get(`/api/projects/${pid}/sampling-runs`); return { runs: payload.runs || [] }; }
      if (dataset === "samplingSchedules") return { samplingSchedules: await loadSamplingSchedulesCompat(pid) };
      if (dataset === "automationRuns") return { automationRuns: await get(`/api/projects/${pid}/automation-runs?limit=20`) };
      if (dataset === "analysisVersions") { const payload = await get(`/api/projects/${pid}/analysis-versions`); return { analysisVersions: payload.versions || [] }; }
      if (dataset === "retests") { const payload = await get(`/api/projects/${pid}/retests`); return { retests: payload.items || [] }; }
      if (dataset === "sourceEvidence") return { sourceEvidence: await get(`/api/projects/${pid}/source-evidence`) };
      if (dataset === "sourceVerificationRuns") { const payload = await get(`/api/projects/${pid}/source-verification-runs?limit=50`); return { sourceVerificationRuns: payload.runs || [] }; }
      if (dataset === "sources") { const payload = await get(`/api/customers/${cid}/source-documents`); return { sources: payload.items || [] }; }
      if (dataset === "knowledgeRuns") { const payload = await get(`/api/customers/${cid}/knowledge-import-runs`); return { knowledgeRuns: payload.items || [] }; }
      if (dataset === "customerFactBase") return { project: await workspaceService.factBase(cid) };
      if (dataset === "factVersions") { const payload = await workspaceService.factVersions(cid); return { factVersions: payload.versions || [] }; }
      if (dataset === "llmConfig") return { llmConfig: await get("/api/llm-config") };
      if (dataset === "samplerConfigs") { const samplerConfigs = await get("/api/sampler-configs/websearch"); return { samplerConfigs, samplerConfig: samplerConfigs.by_sampler?.doubao_api_websearch || samplerConfigs.items?.[0] || {} }; }
      if (dataset === "executorStatus") return { executorStatus: await executorService.status() };
      if (dataset === "reportVersions") { const [internalReports, clientReports, weeklyReports] = await Promise.all([reportService.listVersions(pid, "internal", "", 20), reportService.listVersions(pid, "client", "", 20), reportService.listVersions(pid, "weekly", "", 20)]); return { reportVersions: [...(internalReports.versions || []), ...(clientReports.versions || []), ...(weeklyReports.versions || [])] }; }
      return {};
    }));
    return Object.assign({}, ...parts);
  }, []);

  const loadViewProjectData = useCallback(async (targetView: ViewId, pid: string, cid: string, force = false) => {
    const customerScoped = new Set<ProjectDataset>(["sources", "knowledgeRuns", "customerFactBase", "factVersions", "llmConfig", "samplerConfigs", "executorStatus"]);
    const datasets = projectDatasetsForView(targetView).filter(dataset => pid ? dataset !== "customerFactBase" : customerScoped.has(dataset));
    if (!datasets.length || !cid) return;
    const projectKey = `${cid}:${pid || "no-project"}`; const viewKey = `${projectKey}:${targetView}`;
    if (!force && loadedViews.current.has(viewKey)) return;
    const existing = inFlightViews.current.get(viewKey);
    if (existing) return existing;
    const task = (async () => {
      viewLoadCount.current += 1; setViewLoading(true); setViewError("");
      try {
        const partial = await loadDatasets(datasets, pid, cid);
        if (activeProjectLoad.current !== projectKey) return;
        setData(previous => ({ ...previous, ...partial }));
        loadedViews.current.add(viewKey);
      } catch (e: any) {
        if (activeProjectLoad.current === projectKey) setViewError(e.message || "当前工作区数据加载失败");
      } finally {
        viewLoadCount.current = Math.max(0, viewLoadCount.current - 1);
        if (!viewLoadCount.current) setViewLoading(false);
      }
    })();
    inFlightViews.current.set(viewKey, task);
    try {
      await task;
    } finally {
      if (inFlightViews.current.get(viewKey) === task) inFlightViews.current.delete(viewKey);
    }
  }, [loadDatasets]);

  const loadProject = useCallback(async (pid = projectId, cid = customerId, showLoading = true, targetView = view): Promise<void> => {
    if (!pid || !cid) {
      activateNoProject(cid);
      if (cid) await loadViewProjectData(targetView, "", cid, true);
      return;
    }
    const projectKey = `${cid}:${pid}`; const loadVersion = ++projectLoadVersion.current; activeProjectLoad.current = projectKey;
    if (showLoading) { setLoading(true); setData(EMPTY_DATA); loadedViews.current.clear(); }
    setError(""); setViewError("");
    try {
      const core = await loadDatasets(CORE_PROJECT_DATASETS, pid, cid);
      if (activeProjectLoad.current !== projectKey || projectLoadVersion.current !== loadVersion) return;
      setData(previous => ({ ...(showLoading ? EMPTY_DATA : previous), ...core }));
      localStorage.setItem("geo-v2-customer", cid); localStorage.setItem("geo-v2-project", pid);
      if (showLoading) setLoading(false);
      await loadViewProjectData(targetView, pid, cid, true);
    } catch (e: any) {
      if (activeProjectLoad.current === projectKey && projectLoadVersion.current === loadVersion) {
        if (e instanceof ApiError && e.status === 404) {
          const next = await loadGlobal();
          if (next.projectId !== pid || next.customerId !== cid) {
            await loadProject(next.projectId, next.customerId, true, targetView);
            return;
          }
        }
        setError(e.message || "核心数据加载失败");
      }
    } finally {
      if (showLoading && activeProjectLoad.current === projectKey && projectLoadVersion.current === loadVersion) setLoading(false);
    }
  }, [projectId, customerId, view, activateNoProject, loadGlobal, loadDatasets, loadViewProjectData]);

  async function reloadGlobal(preferredProjectId = "", preferredCustomerId = "") {
    const [customerPayload, projectPayload] = await Promise.all([get("/api/customers"), get("/api/projects")]);
    const nextCustomers = customerPayload.customers || []; const nextProjects = projectPayload.projects || [];
    const nextCustomerId = preferredCustomerId && nextCustomers.some((item: Customer) => item.customer_id === preferredCustomerId) ? preferredCustomerId : customerId && nextCustomers.some((item: Customer) => item.customer_id === customerId) ? customerId : nextCustomers[0]?.customer_id || "";
    const candidates = nextProjects.filter((item: Project) => item.customer_id === nextCustomerId);
    const nextProjectId = preferredProjectId && candidates.some((item: Project) => item.project_id === preferredProjectId) ? preferredProjectId : candidates[0]?.project_id || "";
    setCustomers(nextCustomers); setProjects(nextProjects); setCustomerId(nextCustomerId); setProjectId(nextProjectId);
    if (nextProjectId && nextCustomerId) await loadProject(nextProjectId, nextCustomerId); else await loadProject("", nextCustomerId);
  }

  useEffect(() => { loadGlobal().then(({ projectId: pid, customerId: cid }) => loadProject(pid, cid)).catch(e => { setError(e.message); setLoading(false); }); }, []);
  useEffect(() => { const pop = () => { const next = queryState(); setMode(next.mode); setView(next.view); }; addEventListener("popstate", pop); return () => removeEventListener("popstate", pop); }, []);
  useEffect(() => { if (!loading && !error && customerId) void loadViewProjectData(view, projectId, customerId); }, [view, projectId, customerId, loading, error, loadViewProjectData]);
  const visibleProjects = useMemo(() => projects.filter(p => p.customer_id === customerId), [projects, customerId]);
  const currentProject = projects.find(p => p.project_id === projectId);
  function changeView(next: ViewId) { setView(next); setQuery(mode, next); }
  function changeMode() { const next: ViewMode = mode === "internal" ? "client" : "internal"; const nextView = next === "client" && !["overview", "optimization", "report"].includes(view) ? "overview" : view; setMode(next); setView(nextView); setQuery(next, nextView); }
  async function changeCustomer(id: string) { setCustomerId(id); const next = projects.find(p => p.customer_id === id)?.project_id || ""; setProjectId(next); await loadProject(next, id); }
  async function changeProject(id: string) { setProjectId(id); await loadProject(id, customerId); }
  const reloadCurrent = () => loadProject(projectId, customerId, false);
  const pageProps = { data, projectId, customerId, project: currentProject, customers, projects, mode, notify, onNavigate: changeView, reload: reloadCurrent, reloadGlobal };
  const latestPeriod = data.trends?.current || data.trends?.periods?.at(-1);
  const overviewMeta = { customerName: currentProject?.customer_name || "当前客户", sampleCount: data.samples.length || Number(data.status?.sample_row_count || data.status?.analysis_summary?.total_samples || 0), sampledAt: latestPeriod ? formatDate(latestPeriod.completed_at || latestPeriod.updated_at) : "" };
  const questionPrimaryCodes = ["demand_solution", "vendor_selection", "budget_case_process", "competitor_compare"];
  const questionAdvancedCodes = ["brand_named_check", "risk_fact_check"];
  const primaryQuestions = data.questions.filter((q: Json) => questionPrimaryCodes.includes(q.scene_code || q.generation_focus));
  const questionMeta = { primaryCount: Number(data.questionSummary?.primary_effective ?? primaryQuestions.filter((q: Json) => !["disabled", "discarded"].includes(q.review_status)).length), pendingCount: primaryQuestions.filter((q: Json) => q.review_status === "pending").length, advancedCount: Number(data.questionSummary?.advanced_count ?? data.questions.filter((q: Json) => questionAdvancedCodes.includes(q.scene_code || q.generation_focus)).length) };
  let content: any = null;
  if (!loading && !error) content = !projectId && view !== "assets" ? <StatePanel kind="empty" title="当前客户尚无监测项目" description="客户事实库仍然保留，可前往内容资产查看；需要开始新的监测时再创建项目。" action={<Button icon={BookOpenText} onClick={() => changeView("assets")}>查看客户事实库</Button>} /> : view === "overview" ? <Overview data={data} project={currentProject} reload={() => loadProject(projectId, customerId)} onNavigate={changeView} /> : view === "assets" ? <Assets {...pageProps} /> : view === "questions" ? <Questions {...pageProps} /> : view === "sampling" ? <Sampling {...pageProps} /> : view === "analysis" ? <Analysis {...pageProps} /> : view === "sources" ? <SourceCenter data={data} projectId={projectId} notify={notify} /> : view === "optimization" ? <TaskCenter data={data} mode={mode} projectId={projectId} notify={notify} reload={reloadCurrent} /> : view === "report" ? <ReportCenter {...pageProps} /> : <Settings {...pageProps} />;

  return <Tooltip.Provider delayDuration={300}><AppShell mode={mode} view={view} customers={customers} projects={visibleProjects} customerId={customerId} projectId={projectId} onCustomer={changeCustomer} onProject={changeProject} onView={changeView} onMode={changeMode} overviewMeta={overviewMeta} questionMeta={questionMeta} onRefresh={reloadCurrent}>
    <div className="page"><section className="public-demo-guide"><div><strong>GEO Agent · 离线模拟体验</strong><p>所有品牌、回答和指标均为虚构。浏览事实库、题库、样本、分析与任务；网络采样和模型功能已禁用。</p></div><Button onClick={async () => { try { const result = await post("/api/demo/simulate", { project_id: projectId }); notify(result.message, "success"); await reloadCurrent(); } catch (e: any) { notify(e.message, "error"); } }}>生成一轮模拟样本</Button></section>{!["overview", "questions", "report"].includes(view) && <PageHeader view={view} onRefresh={reloadCurrent} busy={loading || viewLoading} />}{!loading && !error && mode === "internal" && ["questions", "sampling", "analysis", "report"].includes(view) && data.automationRuns?.latest && <AutomationFlowBanner data={data} projectId={projectId} onNavigate={changeView} notify={notify} reload={reloadCurrent} />}{!loading && !error && viewLoading && <div className="workspace-loading-note" role="status"><Pulse size={16} />正在加载当前工作区数据，已完成的核心数据可先查看。</div>}{!loading && !error && viewError && <div className="workspace-loading-note workspace-loading-error" role="alert"><Warning size={16} />{viewError}<Button variant="ghost" onClick={() => loadViewProjectData(view, projectId, customerId, true)}>重试当前工作区</Button></div>}{loading ? <StatePanel kind="loading" title="正在加载核心数据" description="先同步项目、状态汇总与趋势，其余工作区将在进入时加载。" /> : error ? <StatePanel kind="error" title="页面加载失败" description={error} action={<Button variant="secondary" onClick={reloadCurrent}>重试</Button>} /> : content}</div>
    {toast && <div className={cn("toast", `toast-${toast.tone}`)} role="status">{toast.tone === "success" ? <CheckCircle /> : toast.tone === "error" ? <Warning /> : <Pulse />}{toast.message}</div>}
  </AppShell></Tooltip.Provider>;
}
