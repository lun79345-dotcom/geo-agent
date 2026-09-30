import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowClockwise, Check, CheckCircle, Globe, LinkSimple, MagnifyingGlass,
  Pause, Play, Plus, ShieldCheck, Warning, X,
} from "@phosphor-icons/react";
import { sourceService } from "./services";
import type { AppData, Json } from "./types";

const SOURCE_TYPE_OPTIONS = [
  ["", "全部来源类型"],
  ["official", "官方来源"],
  ["government_standard", "政府/标准"],
  ["industry_media", "行业媒体"],
  ["commercial_platform", "商业平台"],
  ["community_other", "社区/其他"],
  ["customer_supplied", "客户资料"],
];

const RELATION_OPTIONS = [
  ["supports", "支持结论"],
  ["context", "背景信息"],
  ["contradicts", "与结论矛盾"],
  ["unverified", "尚未判断"],
];
const SOURCE_PAGE_SIZE = 30;

function cx(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
function formatDate(value: unknown) { if (!value) return "-"; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }

function Button({ children, variant = "primary", icon: Icon, ...props }: any) {
  return <button className={cx("button", `button-${variant}`)} {...props}>{Icon && <Icon size={17} weight="bold" />}{children}</button>;
}

function Badge({ children, tone = "neutral" }: { children: any; tone?: string }) {
  return <span className={cx("badge", `badge-${tone}`)}>{children}</span>;
}

function statusTone(status: string) {
  if (status === "confirmed") return "success";
  if (["conflict", "unavailable", "rejected"].includes(status)) return "danger";
  if (["matched", "running", "partial_failed", "blocked", "restricted", "fetch_failed", "unsupported"].includes(status)) return "warning";
  return "neutral";
}

function runStatusLabel(status: string) {
  return ({ queued: "等待开始", running: "核验中", stopped: "已暂停", completed: "流程已结束", partial_failed: "部分流程失败" } as Record<string, string>)[status] || status || "未知";
}

function SourceDrawer({ item, open, onOpenChange, onDecision, onVerifyRaw, onRetry, busy }: any) {
  const [relation, setRelation] = useState("context");
  const [sourceType, setSourceType] = useState("community_other");
  const [reason, setReason] = useState("");
  useEffect(() => {
    setRelation(item?.relation === "unverified" ? "context" : item?.relation || "context");
    setSourceType(item?.source_type || "community_other");
    setReason("");
  }, [item?.source_evidence_id]);
  const canConfirm = Boolean(item && ["accessible", "local"].includes(item.fetch_status) && String(item.excerpt || "").trim());
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="source-drawer">
      <div className="dialog-head"><div><Dialog.Title>信源详情</Dialog.Title><Dialog.Description>核对原文摘录和对应结论后再确认。</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="关闭信源详情"><X size={18} /></button></Dialog.Close></div>
      {item && <div className="source-drawer-body">
        <div className="source-drawer-heading"><div><Badge tone={statusTone(item.verification_status)}>{item.verification_status_label}</Badge><Badge>{item.origin_label}</Badge></div><h2>{item.title || item.domain || "未命名来源"}</h2><p>{item.question_id} · {item.question}</p></div>
        <dl className="source-meta-list">
          <div><dt>来源域名</dt><dd>{item.domain || "客户资料"}</dd></div>
          <div><dt>获取时间</dt><dd>{formatDate(item.retrieved_at || item.created_at)}</dd></div>
          <div><dt>来源类型</dt><dd>{item.source_type_label}</dd></div>
          <div><dt>当前关系</dt><dd>{item.relation_label}</dd></div>
        </dl>
        {item.url?.startsWith("http") && <a className="source-open-link" href={item.url} target="_blank" rel="noreferrer"><Globe size={16} />打开公开页面</a>}
        {item.status_detail && <div className="source-status-detail"><Warning size={17} /><span><strong>本次核验说明</strong>{item.status_detail}</span></div>}
        {item.source_location && <div className="source-location"><strong>客户资料定位</strong><span>{item.title} · {item.source_location}</span></div>}
        <section><h3>原文摘录</h3><blockquote>{item.excerpt || "当前来源还没有可确认的原文摘录。"}</blockquote></section>
        {item.claim_text && <section><h3>对应结论或回答</h3><p>{item.claim_text}</p></section>}
        {item.synthetic ? <div className="source-decision-panel"><p>这是 AI 回答中的原始引用，尚未完成独立读取。请先核验该链接，再进行人工确认。</p><Button icon={ShieldCheck} onClick={() => onVerifyRaw(item)} disabled={busy || !item.url}>核验这个链接</Button></div> : !canConfirm && item.url?.startsWith("http") ? <div className="source-decision-panel"><p>该页面尚未获得可确认原文。重新核验只读取当前链接，不会重新调用大模型搜索。</p><Button icon={ArrowClockwise} onClick={() => onRetry(item)} disabled={busy}>重新核验这个链接</Button></div> : <div className="source-decision-panel">
          <label>来源类型<select value={sourceType} onChange={event => setSourceType(event.target.value)}>{SOURCE_TYPE_OPTIONS.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>与当前结论的关系<select value={relation} onChange={event => setRelation(event.target.value)}>{RELATION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="source-reject-reason">驳回说明<input value={reason} onChange={event => setReason(event.target.value)} placeholder="仅驳回时填写" /></label>
          <div className="row-actions"><Button variant="secondary" onClick={() => onDecision(item, "reject", relation, sourceType, reason)} disabled={busy}>驳回</Button><Button icon={Check} onClick={() => onDecision(item, "confirm", relation, sourceType, "")} disabled={busy || !canConfirm}>人工确认</Button></div>
        </div>}
      </div>}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function SourceCenter({ data, projectId, notify }: { data: AppData; projectId: string; notify: (message: string, tone?: string) => void }) {
  const initialQuestion = new URLSearchParams(location.search).get("source_question") || "";
  const [payload, setPayload] = useState<Json>(data.sourceEvidence || {});
  const [runs, setRuns] = useState<Json[]>(data.sourceVerificationRuns || []);
  const [selectedQuestions, setSelectedQuestions] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState({ status: "", origin: "", sourceType: "", scene: "", domain: "", question: initialQuestion });
  const [busy, setBusy] = useState(false);
  const [activeItem, setActiveItem] = useState<Json | null>(null);
  const [manual, setManual] = useState({ question_id: "", url: "", title: "" });
  const [manualOpen, setManualOpen] = useState(false);
  const [sourcePage, setSourcePage] = useState(1);
  const stopAfterCurrent = useRef(false);

  useEffect(() => {
    setPayload(data.sourceEvidence || {});
    setRuns(data.sourceVerificationRuns || []);
    setSelectedQuestions(new Set());
    setActiveItem(null);
    setSourcePage(1);
  }, [projectId, data.sourceEvidence, data.sourceVerificationRuns]);

  useEffect(() => { setSourcePage(1); }, [filters.status, filters.origin, filters.sourceType, filters.scene, filters.domain, filters.question]);

  async function refresh() {
    if (!projectId) return;
    const [evidence, runRows] = await Promise.all([sourceService.list(projectId), sourceService.listRuns(projectId)]);
    setPayload(evidence);
    setRuns(runRows.runs || []);
  }

  const recommended = payload.recommended_questions || [];
  const scenes = useMemo(() => Array.from(new Map(recommended.filter((item: Json) => item.scene_id).map((item: Json) => [item.scene_id, item.scene_label || item.scene_id])).entries()), [recommended]);
  const filteredItems = useMemo(() => (payload.items || []).filter((item: Json) => {
    if (filters.status === "pending" && !["raw", "matched"].includes(item.verification_status)) return false;
    if (filters.status === "invalid" && !["unavailable", "conflict", "blocked", "restricted", "fetch_failed", "unsupported"].includes(item.verification_status)) return false;
    if (filters.status && !["pending", "invalid"].includes(filters.status) && item.verification_status !== filters.status) return false;
    if (filters.origin && item.origin !== filters.origin) return false;
    if (filters.sourceType && item.source_type !== filters.sourceType) return false;
    if (filters.scene && item.scene_id !== filters.scene) return false;
    if (filters.domain && !String(item.domain || "").toLowerCase().includes(filters.domain.toLowerCase())) return false;
    if (filters.question && !`${item.question_id} ${item.question}`.toLowerCase().includes(filters.question.toLowerCase())) return false;
    return true;
  }), [payload.items, filters]);
  const activeRun = runs.find(item => ["running", "queued", "stopped", "partial_failed"].includes(item.status)) || runs[0];
  const sourcePageCount = Math.max(1, Math.ceil(filteredItems.length / SOURCE_PAGE_SIZE));
  const safeSourcePage = Math.min(sourcePage, sourcePageCount);
  const sourcePageItems = filteredItems.slice((safeSourcePage - 1) * SOURCE_PAGE_SIZE, safeSourcePage * SOURCE_PAGE_SIZE);
  const sourcePageStart = filteredItems.length ? (safeSourcePage - 1) * SOURCE_PAGE_SIZE + 1 : 0;
  const sourcePageEnd = Math.min(safeSourcePage * SOURCE_PAGE_SIZE, filteredItems.length);

  function toggleQuestion(questionId: string) {
    const next = new Set(selectedQuestions);
    if (next.has(questionId)) next.delete(questionId);
    else if (next.size < 20) next.add(questionId);
    else notify("单批最多选择 20 道题", "error");
    setSelectedQuestions(next);
  }

  async function executeRun(runId: string) {
    stopAfterCurrent.current = false;
    setBusy(true);
    try {
      let finished = false;
      while (!finished) {
        const result = await sourceService.runNext(projectId, runId);
        finished = Boolean(result.done);
        await refresh();
        if (stopAfterCurrent.current && !finished) {
          await sourceService.stop(projectId, runId);
          await refresh();
          notify("信源核验已在当前问题结束后暂停", "success");
          break;
        }
        if (result.error) notify(`${result.question_id || "当前问题"}核验失败，已继续下一题`, "error");
      }
      if (finished) notify("本批信源读取流程已结束；只有带原文摘录的候选来源可以人工确认", "success");
    } catch (error: any) {
      notify(error.message, "error");
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
      stopAfterCurrent.current = false;
    }
  }

  async function startRun() {
    if (!selectedQuestions.size) return;
    setBusy(true);
    try {
      const result = await sourceService.createRun(projectId, Array.from(selectedQuestions));
      setSelectedQuestions(new Set());
      await refresh();
      await executeRun(result.run.verification_run_id);
    } catch (error: any) { notify(error.message, "error"); setBusy(false); }
  }

  async function continueRun() {
    if (!activeRun?.verification_run_id) return;
    try {
      if (activeRun.status === "stopped") await sourceService.resume(projectId, activeRun.verification_run_id);
      await executeRun(activeRun.verification_run_id);
    } catch (error: any) { notify(error.message, "error"); }
  }

  async function retryFailed() {
    if (!activeRun?.verification_run_id) return;
    try {
      await sourceService.retryFailed(projectId, activeRun.verification_run_id);
      await executeRun(activeRun.verification_run_id);
    } catch (error: any) { notify(error.message, "error"); }
  }

  async function addManual() {
    if (!manual.question_id || !manual.url) return;
    setBusy(true);
    try {
      const result = await sourceService.addManual(projectId, manual);
      setManualOpen(false);
      setManual({ question_id: "", url: "", title: "" });
      await refresh();
      setActiveItem(result.item);
      notify("指定网址已完成读取，等待人工确认", "success");
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function decide(item: Json, decision: string, relation: string, sourceType: string, reason: string) {
    setBusy(true);
    try {
      const result = await sourceService.decide(projectId, item.source_evidence_id, { decision, relation, source_type: sourceType, reason });
      setActiveItem(result.item);
      await refresh();
      notify(decision === "confirm" ? (relation === "contradicts" ? "矛盾来源已确认并标记" : "信源已人工确认") : "信源已驳回", "success");
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function retryEvidence(item: Json) {
    setBusy(true);
    try {
      const result = await sourceService.retryEvidence(projectId, item.source_evidence_id);
      setActiveItem(result.item);
      await refresh();
      const usable = result.item?.fetch_status === "accessible" && String(result.item?.excerpt || "").trim();
      notify(usable ? "链接已重新读取并匹配到原文，等待人工确认" : result.item?.status_detail || result.item?.verification_status_label || "重新核验完成", usable ? "success" : "error");
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  function verifyRaw(item: Json) {
    setManual({ question_id: item.question_id, url: item.url, title: item.title || "" });
    setActiveItem(null);
    setManualOpen(true);
  }

  const stats = payload.stats || {};
  const workItems = activeRun?.work_items || [];
  const currentWork = workItems.find((item: Json) => item.status === "running") || workItems.find((item: Json) => item.status === "queued");
  const sourceOutcome = activeRun?.result_counts_available
    ? `可用原文 ${activeRun.usable_sources || 0} 条 · ${activeRun.questions_without_usable_sources || 0} 道未找到可用来源`
    : `${activeRun?.failed_questions || 0} 道流程失败${currentWork ? ` · 下一题 ${currentWork.question_id}` : ""}`;
  return <div className="source-center">
    <section className="source-stats" aria-label="信源状态统计">
      <div><span>待核验</span><strong>{stats.pending || 0}</strong><small>候选与原始引用</small></div>
      <div><span>已确认</span><strong>{stats.confirmed || 0}</strong><small>经人工确认</small></div>
      <div><span>原始引用</span><strong>{stats.raw || 0}</strong><small>尚未独立核验</small></div>
      <div><span>需处理来源</span><strong>{stats.invalid_or_conflict || 0}</strong><small>失效、受限或矛盾</small></div>
    </section>

    <section className="source-priority-panel">
      <div className="section-heading compact-heading"><div><h2>重点问题推荐</h2><p>系统按品牌未出现、竞品压制、事实风险和报告证据推荐；每批最多 20 题。</p></div><div className="row-actions"><Button variant="secondary" icon={Plus} onClick={() => setManualOpen(true)}>指定网址</Button><Button icon={ShieldCheck} onClick={startRun} disabled={busy || !selectedQuestions.size}>开始核验 {selectedQuestions.size ? `(${selectedQuestions.size})` : ""}</Button></div></div>
      <div className="source-question-picker">{recommended.slice(0, 40).map((item: Json) => <label key={item.question_id}>
        <input type="checkbox" checked={selectedQuestions.has(item.question_id)} onChange={() => toggleQuestion(item.question_id)} />
        <span><strong>{item.question_id} · {item.question}</strong><small>{(item.priority_reasons || []).join(" · ")} · 已确认 {item.confirmed_source_count || 0} 条</small></span>
      </label>)}{!recommended.length && <div className="source-empty">完成真实采样后，系统会在这里推荐需要补查信源的问题。</div>}</div>
    </section>

    {activeRun && <section className="source-run-panel" aria-live="polite">
      <div><Badge tone={statusTone(activeRun.status)}>{runStatusLabel(activeRun.status)}</Badge><strong>{activeRun.completed_questions || 0}/{activeRun.total_questions || 0} 道流程已处理</strong><span>{sourceOutcome}</span></div>
      <div className="source-run-progress"><i style={{ width: `${activeRun.total_questions ? ((activeRun.completed_questions + activeRun.failed_questions) / activeRun.total_questions) * 100 : 0}%` }} /></div>
      <div className="row-actions">{busy ? <Button variant="secondary" icon={Pause} onClick={() => { stopAfterCurrent.current = true; }}>本题结束后停止</Button> : ["queued", "running", "stopped"].includes(activeRun.status) ? <Button icon={Play} onClick={continueRun}>继续核验</Button> : null}{activeRun.failed_questions > 0 && !busy && <Button variant="secondary" icon={ArrowClockwise} onClick={retryFailed}>重试失败题</Button>}</div>
    </section>}

    <section className="source-library">
      <div className="section-heading"><div><h2>信源记录</h2><p>{filteredItems.length} 条符合当前筛选</p></div><Button variant="secondary" icon={ArrowClockwise} onClick={() => refresh().catch((error: any) => notify(error.message, "error"))}>刷新</Button></div>
      <div className="source-filters">
        <label><MagnifyingGlass /><input value={filters.question} onChange={event => setFilters({ ...filters, question: event.target.value })} placeholder="搜索问题" /></label>
        <select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option><option value="pending">待核验</option><option value="confirmed">已确认</option><option value="raw">原始引用</option><option value="invalid">需处理</option><option value="rejected">已驳回</option></select>
        <select value={filters.origin} onChange={event => setFilters({ ...filters, origin: event.target.value })}><option value="">全部来源渠道</option><option value="model_citation">模型原始引用</option><option value="independent_web">独立公开信源</option><option value="manual_url">指定公开网址</option><option value="customer_document">客户资料依据</option></select>
        <select value={filters.sourceType} onChange={event => setFilters({ ...filters, sourceType: event.target.value })}>{SOURCE_TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={filters.scene} onChange={event => setFilters({ ...filters, scene: event.target.value })}><option value="">全部场景</option>{scenes.map(([value, label]) => <option key={String(value)} value={String(value)}>{String(label)}</option>)}</select>
        <input value={filters.domain} onChange={event => setFilters({ ...filters, domain: event.target.value })} placeholder="筛选域名" />
      </div>
      <div className="source-table"><div className="source-table-head"><span>问题与来源</span><span>来源类型</span><span>与结论关系</span><span>状态</span><span>操作</span></div>{sourcePageItems.map((item: Json) => <article key={item.source_evidence_id}>
        <div className="source-main-cell"><strong>{item.question_id} · {item.question}</strong><span>{item.title || item.domain || "未命名来源"}</span><small>{item.domain || "客户资料"} · {formatDate(item.retrieved_at || item.created_at)}</small></div>
        <Badge>{item.source_type_label}</Badge><span>{item.relation_label}</span><Badge tone={statusTone(item.verification_status)}>{item.verification_status_label}</Badge><Button variant="ghost" onClick={() => setActiveItem(item)}>查看</Button>
      </article>)}{!filteredItems.length && <div className="source-empty">当前筛选下暂无信源记录。</div>}</div>
      {filteredItems.length > SOURCE_PAGE_SIZE && <div className="source-pagination" aria-label="信源记录分页"><span>{sourcePageStart}-{sourcePageEnd} / {filteredItems.length} 条，第 {safeSourcePage} / {sourcePageCount} 页</span><div className="row-actions"><Button variant="secondary" onClick={() => setSourcePage(Math.max(1, safeSourcePage - 1))} disabled={safeSourcePage <= 1}>上一页</Button><Button variant="secondary" onClick={() => setSourcePage(Math.min(sourcePageCount, safeSourcePage + 1))} disabled={safeSourcePage >= sourcePageCount}>下一页</Button></div></div>}
    </section>

    <Dialog.Root open={manualOpen} onOpenChange={setManualOpen}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content source-manual-dialog"><div className="dialog-head"><div><Dialog.Title>补充指定公开网址</Dialog.Title><Dialog.Description>系统会先做公网安全检查、读取页面并匹配原文，再进入人工确认。</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="关闭"><X size={18} /></button></Dialog.Close></div><div className="form-grid single-column"><label>对应问题<select value={manual.question_id} onChange={event => setManual({ ...manual, question_id: event.target.value })}><option value="">请选择问题</option>{recommended.map((item: Json) => <option key={item.question_id} value={item.question_id}>{item.question_id} · {item.question}</option>)}</select></label><label>公开网址<input value={manual.url} onChange={event => setManual({ ...manual, url: event.target.value })} placeholder="https://..." /></label><label>来源标题（可选）<input value={manual.title} onChange={event => setManual({ ...manual, title: event.target.value })} /></label></div><div className="dialog-actions"><Button variant="secondary" onClick={() => setManualOpen(false)}>取消</Button><Button icon={LinkSimple} onClick={addManual} disabled={busy || !manual.question_id || !manual.url}>读取并匹配原文</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>
    <SourceDrawer item={activeItem} open={Boolean(activeItem)} onOpenChange={(open: boolean) => !open && setActiveItem(null)} onDecision={decide} onVerifyRaw={verifyRaw} onRetry={retryEvidence} busy={busy} />
  </div>;
}
