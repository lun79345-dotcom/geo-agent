import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowClockwise,
  Check,
  CheckCircle,
  Clock,
  FileText,
  Lock,
  Plus,
  Target,
  Warning,
  X,
} from "@phosphor-icons/react";
import { optimizationService } from "./services";
import type { AppData, Json, ViewMode } from "./types";

type TaskFilter = "all" | "pending_approval" | "todo" | "doing" | "blocked" | "delivered" | "awaiting_retest" | "awaiting_confirmation" | "verified";
type TaskRow = { key: string; kind: "draft" | "task"; item: Json; recommendation: Json };

const SCENES = [
  ["品类需求可见", "demand_solution"],
  ["推荐名单可见", "vendor_selection"],
  ["采购决策可见", "budget_case_process"],
  ["竞品对比可见", "competitor_compare"],
] as const;

const FILTERS: Array<[TaskFilter, string]> = [
  ["all", "全部"],
  ["pending_approval", "待审批"],
  ["todo", "待执行"],
  ["doing", "执行中"],
  ["blocked", "已受阻"],
  ["delivered", "已交付"],
  ["awaiting_retest", "待复测"],
  ["awaiting_confirmation", "待人工确认"],
  ["verified", "已验证"],
];

const STATUS_LABELS: Record<string, string> = {
  todo: "待执行",
  doing: "执行中",
  blocked: "已受阻",
  done: "已交付",
};

const EFFECT_LABELS: Record<string, string> = {
  not_ready: "尚未进入复测",
  awaiting_retest: "待复测",
  awaiting_confirmation: "待人工确认",
  verified: "已验证",
};

function cn(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
function array(value: unknown): string[] { return Array.isArray(value) ? value.map(item => String(item || "").trim()).filter(Boolean) : []; }
function objects(value: unknown): Json[] { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") as Json[] : []; }
function lines(value: string) { return String(value || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean); }
function formatDate(value: unknown, withTime = false) {
  if (!value) return "-";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", withTime ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } : { year: "numeric", month: "2-digit", day: "2-digit" });
}
function sceneLabel(value: string) { return SCENES.find(([, code]) => code === value)?.[0] || value; }

function Button({ children, variant = "primary", icon: Icon, ...props }: any) {
  return <button className={cn("button", `button-${variant}`)} {...props}>{Icon && <Icon size={17} weight="bold" />}{children}</button>;
}

function Badge({ children, tone = "neutral" }: { children: any; tone?: string }) {
  return <span className={cn("badge", `badge-${tone}`)}>{children}</span>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="task-center-empty"><FileText size={26} /><strong>{title}</strong><p>{description}</p></div>;
}

function statusTone(status: string) {
  if (status === "done" || status === "verified") return "success";
  if (status === "blocked") return "danger";
  return "warning";
}

function draftFromRecommendation(recommendation: Json): Json {
  const plan = recommendation.implementation_plan || {};
  const evidenceQuestionIds = objects(recommendation.evidence).map(item => String(item.question_id || "")).filter(Boolean);
  const retestQuestionIds = objects(recommendation.retest_questions).map(item => String(item.question_id || "")).filter(Boolean);
  const impactedScenes = array(plan.impacted_scenes).map(sceneLabel);
  return {
    draft_id: "",
    recommendation_id: recommendation.recommendation_id,
    title: recommendation.title || "",
    priority: recommendation.priority || "P1",
    priority_reason: recommendation.reason || "",
    target_question_ids: Array.from(new Set(evidenceQuestionIds)),
    impacted_scenes: impactedScenes.length ? impactedScenes : recommendation.category ? [String(recommendation.category)] : [],
    deliverable: array(plan.deliverables)[0] || recommendation.action || "",
    execution_steps: array(plan.execution_steps).length ? array(plan.execution_steps) : array(plan.content_outline),
    required_materials_and_facts: array(plan.required_facts).length ? array(plan.required_facts) : array(recommendation.required_facts),
    content_requirements: array(plan.content_requirements).length ? array(plan.content_requirements) : array(plan.content_outline),
    acceptance_criteria: array(plan.acceptance_criteria),
    retest_plan: plan.retest_plan || "交付物完成人工验收后，使用所选基线批次中的同题进行复测。",
    retest_question_ids: Array.from(new Set(retestQuestionIds.length ? retestQuestionIds : evidenceQuestionIds)),
    requires_confirmed_sources: false,
    confirmed_source_ids: [],
    owner: "",
    due_date: "",
    status: "draft",
  };
}

function draftForTask(task: Json, recommendation: Json, draft?: Json): Json {
  if (draft) return { ...draft, draft_id: "", status: "draft", linked_action_task_id: "", approved_at: "", approved_by_human: false, title: `${draft.title || task.title}（修订）` };
  return {
    ...draftFromRecommendation(recommendation),
    title: `${task.title || recommendation.title || "任务"}（修订）`,
    priority: task.priority || recommendation.priority || "P1",
    priority_reason: task.priority_reason || recommendation.reason || "",
    target_question_ids: array(task.target_question_ids),
    impacted_scenes: array(task.impacted_scenes),
    deliverable: task.deliverable || task.done_definition || "",
    execution_steps: array(task.execution_steps),
    required_materials_and_facts: array(task.required_materials_and_facts),
    content_requirements: array(task.content_requirements),
    acceptance_criteria: array(task.acceptance_criteria),
    retest_question_ids: objects(task.retest_questions).filter(item => item.selected).map(item => String(item.question_id)),
  };
}

function matchesFilter(row: TaskRow, filter: TaskFilter) {
  if (filter === "all") return true;
  if (filter === "pending_approval") return row.kind === "draft" || Boolean(row.item.legacy_rule_task);
  if (row.kind !== "task") return false;
  if (["todo", "doing", "blocked"].includes(filter)) return row.item.status === filter;
  if (filter === "delivered") return row.item.status === "done" && row.item.delivery_accepted;
  return row.item.final_effect_status === filter;
}

function taskSource(row: TaskRow) {
  const ids = array(row.item.target_question_ids);
  if (ids.length) return ids.join("、");
  const retestIds = objects(row.item.retest_questions).filter(item => item.selected).map(item => item.question_id);
  return retestIds.length ? retestIds.join("、") : row.recommendation.title || "当前建议";
}

function deliveryLabel(task: Json) {
  if (task.status !== "done") return "未交付";
  return task.delivery_accepted ? "已人工验收" : "待人工验收";
}

function retestLabel(task: Json) {
  if (task.final_effect_status === "verified") return "复测已确认";
  if (task.final_effect_status === "awaiting_confirmation") return "结果待确认";
  if (task.final_effect_status === "awaiting_retest") return "范围已锁定";
  const selected = objects(task.retest_questions).filter(item => item.selected).length;
  return selected ? `已选 ${selected} 题` : "尚未准备";
}

function ClientActions({ data }: { data: AppData }) {
  const recommendationById = new Map(data.recommendations.map(item => [String(item.recommendation_id), item]));
  const tasks = data.actionTasks.filter(task => task.formal_approved && recommendationById.get(String(task.recommendation_id))?.approval_status === "approved");
  if (!tasks.length) return <EmptyState title="暂无已批准的正式行动方案" description="内部团队完成人工复核、质量检查和批准后，行动方案会显示在这里。" />;
  return <div className="client-action-groups">{tasks.map(task => {
    const recommendation = recommendationById.get(String(task.recommendation_id)) || {};
    return <article className="client-action-card" key={task.action_task_id}>
      <div className="section-heading compact-heading"><div><h2>{task.title}</h2><p>{array(task.impacted_scenes).map(sceneLabel).join(" · ") || recommendation.category || "内容资产"}</p></div><div className="row-meta"><Badge>{task.priority || "P1"}</Badge><Badge tone="success">已人工批准</Badge></div></div>
      <div className="client-action-answer-grid">
        <div><span>为什么要做</span><p>{task.priority_reason || recommendation.reason || "基于已确认分析形成。"}</p></div>
        <div><span>唯一交付物</span><p>{task.deliverable || task.done_definition || "按正式任务范围执行。"}</p></div>
        <div><span>执行步骤</span><ul>{array(task.execution_steps).map(value => <li key={value}>{value}</li>)}</ul></div>
        <div><span>需要客户提供</span><ul>{array(task.required_materials_and_facts).map(value => <li key={value}>{value}</li>)}</ul></div>
        <div><span>人工验收标准</span><ul>{array(task.acceptance_criteria).map(value => <li key={value}>{value}</li>)}</ul></div>
        <div><span>交付与效果</span><p>{deliveryLabel(task)} · {EFFECT_LABELS[task.final_effect_status] || "尚未验证"}</p></div>
      </div>
    </article>;
  })}</div>;
}

function MultiLineField({ label, value, onChange, placeholder, disabled = false }: { label: string; value: string[]; onChange: (value: string[]) => void; placeholder?: string; disabled?: boolean }) {
  return <label>{label}<textarea value={array(value).join("\n")} onChange={event => onChange(lines(event.target.value))} placeholder={placeholder} disabled={disabled} /></label>;
}

function DetailSection({ index, title, children }: { index: number; title: string; children: any }) {
  return <section className="task-detail-section"><div className="task-detail-section-title"><span>{String(index).padStart(2, "0")}</span><h3>{title}</h3></div>{children}</section>;
}

function DraftEditor({
  draft,
  recommendation,
  data,
  projectId,
  busy,
  setBusy,
  notify,
  reload,
  onSaved,
  onApproved,
}: {
  draft: Json;
  recommendation: Json;
  data: AppData;
  projectId: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  notify: (message: string, tone?: string) => void;
  reload: () => Promise<any>;
  onSaved: (draft: Json) => void;
  onApproved: (task: Json) => void;
}) {
  const [form, setForm] = useState<Json>(draft);
  const [approvalChecked, setApprovalChecked] = useState(false);
  useEffect(() => { setForm(draft); setApprovalChecked(false); }, [draft.draft_id, draft.updated_at, draft.title]);
  const linkedTask = data.actionTasks.find(task => task.action_task_id === draft.linked_action_task_id);
  const locked = Boolean(linkedTask && (linkedTask.status !== "todo" || linkedTask.started_at));
  const approvedQuestions = data.questions.filter(question => question.review_status === "approved" && (!question.status || question.status === "active"));
  const confirmedSources = (data.sourceEvidence?.items || []).filter((source: Json) => source.verification_status === "confirmed" && source.fetch_status === "accessible" && !/^(wappass|passport|captcha|accounts)\./i.test(String(source.domain || "")));
  const quality = draft.quality_check || {};

  function toggleList(name: string, value: string, checked: boolean) {
    const next = new Set(array(form[name]));
    checked ? next.add(value) : next.delete(value);
    setForm({ ...form, [name]: Array.from(next) });
  }

  async function save() {
    setBusy(true);
    try {
      const result = await optimizationService.saveTaskDraft(projectId, String(recommendation.recommendation_id), { ...form, draft_id: draft.draft_id || undefined });
      onSaved(result.task_draft || form);
      notify("任务草稿已保存，并完成质量门槛校验", "success");
      await reload();
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function approve() {
    if (!draft.draft_id) return notify("请先保存任务草稿", "error");
    if (!quality.passed) return notify("草稿尚未通过质量门槛", "error");
    if (!approvalChecked) return notify("请明确勾选人工批准", "error");
    setBusy(true);
    try {
      const result = await optimizationService.approveTaskDraft(projectId, String(recommendation.recommendation_id), String(draft.draft_id), { approved: true });
      onApproved(result.action_task || {});
      notify(result.reused ? "该草稿已批准，沿用原正式任务" : "草稿已批准并创建正式任务", "success");
      await reload();
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  return <>
    <div className="task-drawer-status"><Badge tone={draft.status === "approved" ? "success" : "warning"}>{draft.status === "approved" ? "已人工批准" : "任务草稿"}</Badge><Badge>{form.priority || "P1"}</Badge>{locked && <Badge tone="warning"><Lock size={12} />核心范围已锁定</Badge>}</div>
    {locked && <div className="task-drawer-notice"><Lock size={18} /><div><strong>任务已开始，当前草稿不可改写</strong><p>重大变更请从正式任务详情创建修订草稿，原任务和历史记录继续保留。</p></div></div>}
    <DetailSection index={1} title="为什么要做">
      <div className="task-detail-form two-columns"><label>任务标题<input value={form.title || ""} onChange={event => setForm({ ...form, title: event.target.value })} disabled={locked} /></label><label>优先级<select value={form.priority || "P1"} onChange={event => setForm({ ...form, priority: event.target.value })} disabled={locked}><option>P0</option><option>P1</option><option>P2</option></select></label><label className="span-all">优先级理由<textarea value={form.priority_reason || ""} onChange={event => setForm({ ...form, priority_reason: event.target.value })} disabled={locked} /></label></div>
    </DetailSection>
    <DetailSection index={2} title="目标问题和受影响场景">
      <div className="task-scene-options">{SCENES.map(([label]) => <label key={label}><input type="checkbox" checked={array(form.impacted_scenes).includes(label)} onChange={event => toggleList("impacted_scenes", label, event.target.checked)} disabled={locked} /><span>{label}</span></label>)}</div>
      <div className="task-question-picker"><div className="task-question-picker-head"><span>问题</span><span>目标</span><span>复测</span></div>{approvedQuestions.map(question => <div key={question.question_id}><span><strong>{question.question_id}</strong>{question.question}</span><input type="checkbox" aria-label={`${question.question_id} 设为目标问题`} checked={array(form.target_question_ids).includes(String(question.question_id))} onChange={event => toggleList("target_question_ids", String(question.question_id), event.target.checked)} disabled={locked} /><input type="checkbox" aria-label={`${question.question_id} 纳入复测`} checked={array(form.retest_question_ids).includes(String(question.question_id))} onChange={event => toggleList("retest_question_ids", String(question.question_id), event.target.checked)} disabled={locked} /></div>)}</div>
    </DetailSection>
    <DetailSection index={3} title="唯一交付物"><label className="task-detail-single-field">一个可独立验收的交付物<textarea value={form.deliverable || ""} onChange={event => setForm({ ...form, deliverable: event.target.value })} disabled={locked} /></label></DetailSection>
    <DetailSection index={4} title="执行前所需材料和事实"><MultiLineField label="每行一项" value={form.required_materials_and_facts || []} onChange={value => setForm({ ...form, required_materials_and_facts: value })} disabled={locked} /></DetailSection>
    <DetailSection index={5} title="分步骤执行方法"><MultiLineField label="按执行顺序逐行填写" value={form.execution_steps || []} onChange={value => setForm({ ...form, execution_steps: value })} disabled={locked} /></DetailSection>
    <DetailSection index={6} title="内容结构或交付模板"><MultiLineField label="每行一项内容要求" value={form.content_requirements || []} onChange={value => setForm({ ...form, content_requirements: value })} disabled={locked} /></DetailSection>
    <DetailSection index={7} title="信源要求">
      <label className="task-inline-check"><input type="checkbox" checked={Boolean(form.requires_confirmed_sources)} onChange={event => setForm({ ...form, requires_confirmed_sources: event.target.checked })} disabled={locked} /><span>本任务涉及外部事实，必须绑定已人工确认且当前可访问的信源</span></label>
      {confirmedSources.length ? <div className="task-source-options">{confirmedSources.map((source: Json) => <label key={source.source_evidence_id}><input type="checkbox" checked={array(form.confirmed_source_ids).includes(String(source.source_evidence_id))} onChange={event => toggleList("confirmed_source_ids", String(source.source_evidence_id), event.target.checked)} disabled={locked} /><span><strong>{source.title || source.domain || source.source_evidence_id}</strong><small>{source.domain || "已确认信源"}</small></span></label>)}</div> : <p className="task-muted">当前没有符合质量门槛的已确认信源。若任务涉及外部事实，批准会被阻止。</p>}
    </DetailSection>
    <DetailSection index={8} title="人工验收标准"><MultiLineField label="每行一项可人工判断的标准" value={form.acceptance_criteria || []} onChange={value => setForm({ ...form, acceptance_criteria: value })} disabled={locked} /></DetailSection>
    <DetailSection index={9} title="同题复测范围和计划"><label className="task-detail-single-field">复测计划<textarea value={form.retest_plan || ""} onChange={event => setForm({ ...form, retest_plan: event.target.value })} disabled={locked} /></label><p className="task-muted">当前选择 {array(form.retest_question_ids).length} 道题；批准时会固定为同一完整基线批次中的精确题目范围。</p></DetailSection>
    <DetailSection index={10} title="执行准备和历史记录">
      <div className="task-detail-form two-columns"><label>建议负责人<input value={form.owner || ""} onChange={event => setForm({ ...form, owner: event.target.value })} disabled={locked} /></label><label>建议截止日期<input type="date" value={form.due_date || ""} onChange={event => setForm({ ...form, due_date: event.target.value })} disabled={locked} /></label></div>
      <div className="task-history-line"><span>草稿创建：{formatDate(draft.created_at, true)}</span><span>最近更新：{formatDate(draft.updated_at, true)}</span>{draft.approved_at && <span>人工批准：{formatDate(draft.approved_at, true)}</span>}</div>
    </DetailSection>
    <section className={cn("task-quality-gate", quality.passed && "passed")}>
      <div>{quality.passed ? <CheckCircle size={22} weight="fill" /> : <Warning size={22} />}<div><strong>{quality.passed ? "质量门槛已通过" : draft.draft_id ? "质量门槛未通过" : "保存后执行质量检查"}</strong><p>{quality.passed ? `精确基线批次：${quality.baseline_run_id || "已确认"}` : "缺少任一必要项时均不能批准为正式任务。"}</p></div></div>
      {!quality.passed && array(quality.missing_fields).length > 0 && <ul>{array(quality.missing_fields).map(item => <li key={item}>{item}</li>)}</ul>}
    </section>
    <div className="task-drawer-footer">
      <label className="task-inline-check"><input type="checkbox" checked={approvalChecked} onChange={event => setApprovalChecked(event.target.checked)} disabled={!quality.passed || locked} /><span>我已人工复核任务范围、事实边界和复测计划，并批准生成正式任务</span></label>
      <div className="row-actions"><Button variant="secondary" onClick={save} disabled={busy || locked}>{busy ? "保存中" : "保存并检查"}</Button><Button icon={Check} onClick={approve} disabled={busy || locked || !draft.draft_id || !quality.passed || !approvalChecked}>{draft.status === "approved" ? "沿用正式任务" : "批准为正式任务"}</Button></div>
    </div>
  </>;
}

function TaskExecution({
  task,
  recommendation,
  linkedDraft,
  baselineRunId,
  data,
  projectId,
  busy,
  setBusy,
  notify,
  reload,
  onRevision,
}: {
  task: Json;
  recommendation: Json;
  linkedDraft?: Json;
  baselineRunId?: string;
  data: AppData;
  projectId: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  notify: (message: string, tone?: string) => void;
  reload: () => Promise<any>;
  onRevision: (draft: Json) => void;
}) {
  const [form, setForm] = useState<Json>({});
  const [selectedRetest, setSelectedRetest] = useState<Set<string>>(new Set());
  const [acceptanceChecked, setAcceptanceChecked] = useState(false);
  const [effectChecked, setEffectChecked] = useState(false);
  const [effectConclusion, setEffectConclusion] = useState("");
  useEffect(() => {
    setForm({ owner: task.owner || "", due_date: task.due_date || "", execution_note: task.execution_note || "", evidence_url: task.evidence_url || "", blocked_reason: task.blocked_reason || "" });
    setSelectedRetest(new Set(objects(task.retest_questions).filter(item => item.selected).map(item => String(item.question_id))));
    setAcceptanceChecked(Boolean(task.delivery_accepted));
    setEffectChecked(false);
    setEffectConclusion("");
  }, [task.action_task_id, task.updated_at, task.delivery_accepted]);
  const retest = data.retests.find(item => item.related_action_task_id === task.action_task_id);
  const canEditScope = Boolean(task.formal_approved && task.status === "todo" && !task.started_at);

  async function updateStatus(status: string) {
    if (!task.formal_approved) return notify("历史规则任务需重新形成合格草稿并人工批准，原任务只读保留", "error");
    setBusy(true);
    try {
      await optimizationService.updateTask(projectId, task.action_task_id, { ...form, status, acceptance_confirmed: status === "done" ? acceptanceChecked : undefined });
      notify(status === "done" ? "交付已记录；效果仍需独立复测和人工确认" : "任务执行状态已保存", "success");
      await reload();
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function saveRetest() {
    setBusy(true);
    try {
      await optimizationService.saveRetestQuestions(projectId, task.action_task_id, Array.from(selectedRetest));
      notify("同题复测范围已保存", "success");
      await reload();
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function prepareRetest() {
    setBusy(true);
    try {
      await optimizationService.prepareRetest(projectId, {
        action_task_id: task.action_task_id,
        question_ids: Array.from(selectedRetest),
        ...(baselineRunId ? { baseline_run_id: baselineRunId } : {}),
      });
      notify("完整复测范围已准备，可到样本采集工作区执行", "success");
      await reload();
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function confirmEffect() {
    if (!retest?.retest_run_id) return;
    if (!effectChecked || !effectConclusion.trim()) return notify("请填写结论并明确完成人工确认", "error");
    setBusy(true);
    try {
      const result = await optimizationService.confirmRetestEffect(projectId, retest.retest_run_id, { confirmed: true, conclusion: effectConclusion.trim() });
      notify(result.reused ? "该效果结论已确认，未重复写入" : "最终效果结论已人工确认", "success");
      await reload();
    } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  const targetIds = array(task.target_question_ids);
  const scenes = array(task.impacted_scenes);
  const materials = array(task.required_materials_and_facts);
  const steps = array(task.execution_steps);
  const requirements = array(task.content_requirements);
  const acceptance = array(task.acceptance_criteria);
  const questions = objects(task.retest_questions);
  const sources = array(linkedDraft?.confirmed_source_ids);

  return <>
    <div className="task-drawer-status"><Badge tone={task.formal_approved ? "success" : "warning"}>{task.approval_label || (task.formal_approved ? "已人工批准" : "历史规则任务·待复核")}</Badge><Badge>{task.priority || "P1"}</Badge><Badge tone={statusTone(task.status)}>{STATUS_LABELS[task.status] || task.status}</Badge></div>
    {!task.formal_approved && <div className="task-drawer-notice"><Warning size={18} /><div><strong>该任务按历史规则生成，只读保留</strong><p>不会迁移或删除。请基于原建议建立合格草稿并人工批准，再进入正式执行。</p></div></div>}
    <DetailSection index={1} title="为什么要做"><p className="task-detail-copy">{task.priority_reason || recommendation.reason || "历史任务未记录优先级理由，需在新草稿中补齐。"}</p></DetailSection>
    <DetailSection index={2} title="目标问题和受影响场景"><div className="task-token-list">{targetIds.map(value => <span key={value}>{value}</span>)}{scenes.map(value => <span key={value}>{sceneLabel(value)}</span>)}{!targetIds.length && !scenes.length && <p className="task-muted">历史任务未记录结构化目标范围。</p>}</div></DetailSection>
    <DetailSection index={3} title="唯一交付物"><p className="task-detail-copy">{task.deliverable || task.done_definition || "历史任务未记录独立交付物。"}</p></DetailSection>
    <DetailSection index={4} title="执行前所需材料和事实"><ol className="task-detail-list">{materials.map(item => <li key={item}>{item}</li>)}</ol>{!materials.length && <p className="task-muted">尚未记录。</p>}</DetailSection>
    <DetailSection index={5} title="分步骤执行方法"><ol className="task-detail-list">{steps.map(item => <li key={item}>{item}</li>)}</ol>{!steps.length && <p className="task-muted">尚未记录。</p>}</DetailSection>
    <DetailSection index={6} title="内容结构或交付模板"><ul className="task-detail-list">{requirements.map(item => <li key={item}>{item}</li>)}</ul>{!requirements.length && <p className="task-muted">尚未记录。</p>}</DetailSection>
    <DetailSection index={7} title="信源要求"><p className="task-detail-copy">{linkedDraft?.requires_confirmed_sources ? sources.length ? `已绑定 ${sources.length} 条人工确认信源。` : "要求已确认信源，但当前未找到合格绑定。" : "本任务未要求外部事实信源；仍只可使用人工确认事实。"}</p></DetailSection>
    <DetailSection index={8} title="人工验收标准"><ul className="task-detail-list">{acceptance.map(item => <li key={item}>{item}</li>)}</ul>{!acceptance.length && <p className="task-muted">历史任务未记录可判断的人工验收标准。</p>}</DetailSection>
    <DetailSection index={9} title="同题复测范围和计划">
      <p className="task-detail-copy">{linkedDraft?.retest_plan || "交付并人工验收后，对已选问题执行同题复测。"}</p>
      {baselineRunId && <p className="task-muted"><Target size={13} /> 本次从监测题集进入；准备复测时将锁定对应基线 {baselineRunId}。</p>}
      <div className="task-retest-options">{questions.length ? questions.map((question: Json) => <label key={question.question_id}><input type="checkbox" checked={selectedRetest.has(String(question.question_id))} disabled={!canEditScope || !question.selectable || !question.has_before_sample} onChange={event => { const next = new Set(selectedRetest); event.target.checked ? next.add(String(question.question_id)) : next.delete(String(question.question_id)); setSelectedRetest(next); }} /><span><strong>{question.question_id} · {question.question}</strong><small>{question.has_before_sample ? `精确基线 ${question.before_run_id}` : "缺少同批次精确样本"}</small></span></label>) : <p className="task-muted">尚未形成复测题范围。</p>}</div>
      <div className="row-actions"><Button variant="secondary" onClick={saveRetest} disabled={busy || !canEditScope || !selectedRetest.size}>保存范围</Button><Button onClick={prepareRetest} disabled={busy || !task.retest_ready || !selectedRetest.size}>准备复测批次</Button></div>
      {task.status !== "todo" && <p className="task-muted"><Lock size={13} /> 任务开始后复测核心范围已冻结，不再重新计算或静默缩减。</p>}
    </DetailSection>
    <DetailSection index={10} title="执行说明、证据和历史记录">
      <div className="task-detail-form two-columns"><label>负责人<input value={form.owner || ""} onChange={event => setForm({ ...form, owner: event.target.value })} disabled={!task.formal_approved} /></label><label>截止日期<input type="date" value={form.due_date || ""} onChange={event => setForm({ ...form, due_date: event.target.value })} disabled={!task.formal_approved} /></label><label className="span-all">执行说明<textarea value={form.execution_note || ""} onChange={event => setForm({ ...form, execution_note: event.target.value })} disabled={!task.formal_approved} /></label><label className="span-all">交付证据<textarea value={form.evidence_url || ""} onChange={event => setForm({ ...form, evidence_url: event.target.value })} disabled={!task.formal_approved} placeholder="填写可核验的交付链接或证据说明" /></label><label className="span-all">暂缓原因<textarea value={form.blocked_reason || ""} onChange={event => setForm({ ...form, blocked_reason: event.target.value })} disabled={!task.formal_approved} /></label></div>
      <label className="task-inline-check"><input type="checkbox" checked={acceptanceChecked} onChange={event => setAcceptanceChecked(event.target.checked)} disabled={!task.formal_approved || Boolean(task.delivery_accepted)} /><span>我已人工验收交付物，确认其符合上方验收标准</span></label>
      <div className="task-status-actions"><Button variant="secondary" onClick={() => updateStatus("todo")} disabled={busy || !task.formal_approved}>待执行</Button><Button variant="secondary" onClick={() => updateStatus("doing")} disabled={busy || !task.formal_approved}>执行中</Button><Button variant="secondary" onClick={() => updateStatus("blocked")} disabled={busy || !task.formal_approved}>已受阻</Button><Button icon={Check} onClick={() => updateStatus("done")} disabled={busy || !task.formal_approved || !acceptanceChecked}>记录已交付</Button></div>
      <div className="task-history-line"><span>创建：{formatDate(task.created_at, true)}</span><span>开始：{formatDate(task.started_at, true)}</span><span>交付：{formatDate(task.completed_at, true)}</span><span>最近更新：{formatDate(task.updated_at, true)}</span></div>
      {task.formal_approved && <Button variant="ghost" icon={Plus} onClick={() => onRevision(draftForTask(task, recommendation, linkedDraft))}>新建修订草稿</Button>}
    </DetailSection>
    {retest && <section className="task-effect-panel">
      <div><Target size={21} /><div><strong>复测效果</strong><p>{retest.comparison?.blocked_reason || retest.overall_verdict || `复测状态：${retest.status}`}</p></div><Badge tone={retest.effect_confirmed ? "success" : retest.final_effect_status === "awaiting_confirmation" ? "warning" : "neutral"}>{EFFECT_LABELS[retest.final_effect_status] || "尚未可确认"}</Badge></div>
      {retest.comparison?.comparable && !retest.effect_confirmed && <><label>人工最终结论<textarea value={effectConclusion} onChange={event => setEffectConclusion(event.target.value)} placeholder="结合系统计算结果，填写人工确认后的效果结论" /></label><label className="task-inline-check"><input type="checkbox" checked={effectChecked} onChange={event => setEffectChecked(event.target.checked)} /><span>我已核对完整同题范围和系统比较结果，确认该最终结论</span></label><Button icon={Check} onClick={confirmEffect} disabled={busy || !effectChecked || !effectConclusion.trim()}>确认最终效果</Button></>}
      {retest.effect_confirmed && <p className="task-final-conclusion">{retest.final_conclusion || retest.conclusion}</p>}
    </section>}
  </>;
}

function TaskDrawer({ row, data, projectId, baselineRunId, busy, setBusy, notify, reload, onClose, onSelect }: { row: TaskRow; data: AppData; projectId: string; baselineRunId?: string; busy: boolean; setBusy: (busy: boolean) => void; notify: (message: string, tone?: string) => void; reload: () => Promise<any>; onClose: () => void; onSelect: (row: TaskRow) => void }) {
  const linkedDraft = row.kind === "task" ? data.taskDrafts.find(item => item.linked_action_task_id === row.item.action_task_id) : undefined;
  return <Dialog.Root open onOpenChange={open => !open && onClose()}><Dialog.Portal><Dialog.Overlay className="task-drawer-overlay" /><Dialog.Content className="task-drawer" aria-describedby="task-drawer-description">
    <header className="task-drawer-head"><div><Dialog.Title>{row.item.title || row.recommendation.title || "任务详情"}</Dialog.Title><Dialog.Description id="task-drawer-description">{row.kind === "draft" ? "草稿经过质量检查和人工批准后才会成为正式任务。" : "交付状态与最终效果状态独立记录。"}</Dialog.Description></div><Dialog.Close asChild><button className="icon-button" aria-label="关闭任务详情"><X size={19} /></button></Dialog.Close></header>
    <div className="task-drawer-body">{row.kind === "draft" ? <DraftEditor draft={row.item} recommendation={row.recommendation} data={data} projectId={projectId} busy={busy} setBusy={setBusy} notify={notify} reload={reload} onSaved={draft => onSelect({ key: `draft:${draft.draft_id}`, kind: "draft", item: draft, recommendation: row.recommendation })} onApproved={task => onSelect({ key: `task:${task.action_task_id}`, kind: "task", item: task, recommendation: row.recommendation })} /> : <TaskExecution task={row.item} recommendation={row.recommendation} linkedDraft={linkedDraft} baselineRunId={baselineRunId} data={data} projectId={projectId} busy={busy} setBusy={setBusy} notify={notify} reload={reload} onRevision={draft => onSelect({ key: `new:${row.recommendation.recommendation_id}:${Date.now()}`, kind: "draft", item: draft, recommendation: row.recommendation })} />}</div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

export function TaskCenter({ data, mode, projectId, notify, reload }: { data: AppData; mode: ViewMode; projectId: string; notify: (message: string, tone?: string) => void; reload: () => Promise<any> }) {
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<TaskRow | null>(null);
  const [newRecommendationId, setNewRecommendationId] = useState("");
  const baselineRunId = new URLSearchParams(location.search).get("baseline_run_id")?.trim() || "";
  const recommendationById = useMemo(() => new Map(data.recommendations.map(item => [String(item.recommendation_id), item])), [data.recommendations]);
  const rows = useMemo<TaskRow[]>(() => {
    const result: TaskRow[] = [];
    data.taskDrafts.forEach(draft => {
      if (draft.status === "approved" && draft.linked_action_task_id) return;
      const recommendation = recommendationById.get(String(draft.recommendation_id)) || {};
      result.push({ key: `draft:${draft.draft_id}`, kind: "draft", item: draft, recommendation });
    });
    data.actionTasks.forEach(task => {
      const recommendation = recommendationById.get(String(task.recommendation_id)) || {};
      result.push({ key: `task:${task.action_task_id}`, kind: "task", item: task, recommendation });
    });
    const rank = (item: TaskRow) => ({ P0: 0, P1: 1, P2: 2 }[String(item.item.priority || "P2")] ?? 3);
    return result.sort((a, b) => rank(a) - rank(b) || String(b.item.updated_at || b.item.created_at || "").localeCompare(String(a.item.updated_at || a.item.created_at || "")) || a.key.localeCompare(b.key));
  }, [data.taskDrafts, data.actionTasks, recommendationById]);

  useEffect(() => { setFilter("all"); setQuery(""); setSelected(null); setNewRecommendationId(data.recommendations[0]?.recommendation_id || ""); }, [projectId]);
  useEffect(() => {
    if (!data.recommendations.some(item => String(item.recommendation_id) === newRecommendationId)) {
      setNewRecommendationId(String(data.recommendations[0]?.recommendation_id || ""));
    }
  }, [data.recommendations, newRecommendationId]);

  if (mode === "client") return <ClientActions data={data} />;

  const counts = Object.fromEntries(FILTERS.map(([id]) => [id, rows.filter(row => matchesFilter(row, id)).length])) as Record<TaskFilter, number>;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = rows.filter(row => matchesFilter(row, filter)).filter(row => !normalizedQuery || [row.item.title, row.item.priority_reason, row.item.owner, row.item.action_task_id, row.item.draft_id, taskSource(row), array(row.item.impacted_scenes).join(" ")].join(" ").toLowerCase().includes(normalizedQuery));

  async function runEnrichment() {
    const candidates = data.recommendations.filter(item => ["P0", "P1"].includes(item.priority));
    const selectedRecommendations = (candidates.length ? candidates : data.recommendations).slice(0, 3);
    if (!selectedRecommendations.length) return notify("当前没有可联网验证的建议", "error");
    if (!window.confirm("该操作会调用联网增强服务，确认现在执行？")) return;
    setBusy(true);
    try { await optimizationService.runEnrichment(projectId, { recommendation_ids: selectedRecommendations.map(item => item.recommendation_id) }); notify("联网增强草稿已生成，请核对后确认", "success"); await reload(); } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  async function confirmEnrichment() {
    const ids = data.recommendations.filter(item => item.enrichment_status === "preview" && item.enrichment_preview).slice(0, 3).map(item => item.recommendation_id);
    if (!ids.length) return notify("当前没有待确认的增强草稿", "error");
    setBusy(true);
    try { await optimizationService.confirmEnrichment(projectId, { recommendation_ids: ids }); notify(`已应用 ${ids.length} 条增强建议`, "success"); await reload(); } catch (error: any) { notify(error.message, "error"); } finally { setBusy(false); }
  }

  function createDraft() {
    const recommendation = recommendationById.get(newRecommendationId);
    if (!recommendation) return notify("请选择任务来源建议", "error");
    setSelected({ key: `new:${newRecommendationId}:${Date.now()}`, kind: "draft", item: draftFromRecommendation(recommendation), recommendation });
  }

  return <div className="task-center">
    <section className="task-center-command"><div><Badge>任务生命周期 P0</Badge><h2>从人工确认建议到交付与同题复测</h2><p>规则与 AI 只形成草稿；质量检查和人工批准后才创建正式任务。已交付不等于优化有效。</p></div><div className="task-center-command-actions"><select aria-label="选择任务来源建议" value={newRecommendationId} onChange={event => setNewRecommendationId(event.target.value)}>{data.recommendations.map(item => <option value={item.recommendation_id} key={item.recommendation_id}>{item.priority || "P1"} · {item.title}</option>)}</select><Button icon={Plus} onClick={createDraft} disabled={!data.recommendations.length}>新建任务草稿</Button><Button variant="secondary" icon={ArrowClockwise} onClick={() => reload()} disabled={busy}>刷新</Button></div></section>
    <div className="task-center-secondary-actions"><Button variant="ghost" onClick={runEnrichment} disabled={busy || !data.recommendations.length}>联网验证并增强</Button><Button variant="ghost" onClick={confirmEnrichment} disabled={busy || !data.recommendations.some(item => item.enrichment_status === "preview")}>确认增强草稿</Button></div>
    <section className="task-center-stats" aria-label="任务状态统计">{FILTERS.slice(1).map(([id, label]) => <button className={filter === id ? "active" : ""} key={id} onClick={() => setFilter(id)}><span>{label}</span><strong>{counts[id]}</strong></button>)}</section>
    <div className="task-center-toolbar"><div className="segmented" aria-label="任务筛选"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 {counts.all}</button>{FILTERS.slice(1, 5).map(([id, label]) => <button className={filter === id ? "active" : ""} key={id} onClick={() => setFilter(id)}>{label}</button>)}</div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、问题、负责人" aria-label="搜索任务" /></div>
    {visibleRows.length ? <section className="task-center-list"><div className="task-center-list-head"><span>任务 / 来源</span><span>场景</span><span>优先级理由</span><span>负责人 / 截止</span><span>执行</span><span>交付</span><span>复测</span><span>最终效果</span></div>{visibleRows.map(row => {
      const item = row.item;
      const isDraft = row.kind === "draft";
      return <button className="task-center-row" key={row.key} data-task-kind={row.kind} data-task-id={row.item.action_task_id || row.item.draft_id || ""} data-recommendation-id={row.recommendation.recommendation_id || ""} onClick={() => setSelected(row)}>
        <span className="task-center-main" data-label="任务 / 来源"><strong>{item.title || row.recommendation.title || "未命名任务草稿"}</strong><small>{isDraft ? "任务草稿" : item.approval_label || "正式任务"} · {taskSource(row)}</small></span>
        <span data-label="场景">{array(item.impacted_scenes).map(sceneLabel).join("、") || row.recommendation.category || "待补充"}</span>
        <span data-label="优先级理由"><Badge>{item.priority || "P1"}</Badge><small>{item.priority_reason || row.recommendation.reason || "待补充理由"}</small></span>
        <span data-label="负责人 / 截止"><strong>{item.owner || "待指派"}</strong><small>{item.due_date ? formatDate(item.due_date) : "待设置截止"}</small></span>
        <span data-label="执行"><Badge tone={isDraft ? "warning" : statusTone(item.status)}>{isDraft ? "待审批" : STATUS_LABELS[item.status] || item.status}</Badge>{item.status === "blocked" && <small>{item.blocked_reason || "已受阻"}</small>}</span>
        <span data-label="交付">{isDraft ? "未进入执行" : deliveryLabel(item)}</span>
        <span data-label="复测">{isDraft ? `${array(item.retest_question_ids).length} 题待确认` : retestLabel(item)}</span>
        <span data-label="最终效果"><Badge tone={!isDraft && item.final_effect_status === "verified" ? "success" : "neutral"}>{isDraft ? "尚未验证" : EFFECT_LABELS[item.final_effect_status] || "尚未验证"}</Badge></span>
      </button>;
    })}</section> : <EmptyState title={rows.length ? "当前筛选下没有任务" : "尚无任务草稿或历史任务"} description={rows.length ? "可切换筛选条件或清除搜索词。" : "先从已确认建议建立任务草稿；保存不会直接创建正式任务。"} />}
    <section className="task-center-retests"><div className="section-heading compact-heading"><div><h2>复测记录</h2><p>系统只生成比较预览，最终效果必须人工确认。</p></div><Badge>{data.retests.length} 个计划</Badge></div>{data.retests.length ? <div className="run-table">{data.retests.map(item => <div className="run-row" key={item.retest_run_id}><div><strong>{item.name || item.retest_run_id}</strong><span>{formatDate(item.created_at, true)} · 基线 {item.before_run_id || item.baseline_run_id || "-"} · 复测 {item.after_run_id || "待创建"}</span></div><Badge tone={item.effect_confirmed ? "success" : item.final_effect_status === "awaiting_confirmation" ? "warning" : "neutral"}>{item.effect_confirmed ? "效果已确认" : item.final_effect_status === "awaiting_confirmation" ? "待人工确认" : item.status}</Badge></div>)}</div> : <p className="task-muted">暂无真实复测运行和最终效果记录。</p>}</section>
    {selected && <TaskDrawer row={selected} data={data} projectId={projectId} baselineRunId={baselineRunId} busy={busy} setBusy={setBusy} notify={notify} reload={reload} onClose={() => setSelected(null)} onSelect={setSelected} />}
  </div>;
}
