import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, DownloadSimple, FilePdf, SignOut, Warning } from "@phosphor-icons/react";
import { ReportReader } from "./ReportCenter";
import type { Json } from "./types";
import type { ReportModel } from "./reportModel";
import { withBasePath } from "./basePath";

async function portalFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(withBasePath(path), { credentials: "same-origin", ...options, headers });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) throw Object.assign(new Error((payload as Json)?.error || `请求失败 (${response.status})`), { status: response.status, payload });
  return payload as Json;
}

function formatDate(value: unknown) { if (!value) return "-"; const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }); }
function typeLabel(value: string) { return value === "weekly" ? "周期跟踪报告" : "首次诊断报告"; }

async function downloadPortalPdf(version: Json) {
  const response = await fetch(withBasePath(`/api/portal/reports/${encodeURIComponent(version.report_version_id)}/pdf`), { credentials: "same-origin" });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "PDF 下载失败");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${version.title || "GEO诊断报告"}.pdf`; anchor.click(); URL.revokeObjectURL(url);
}

function PortalLogin({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await portalFetch("/api/portal/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); onLogin(); }
    catch (reason: any) { setError(reason.message || "登录失败"); } finally { setBusy(false); }
  }
  return <main className="portal-login"><section><div className="portal-login-brand"><img src={withBasePath("/assets/geo-logo.svg")} alt="GEO Agent" /><div><strong>GEO 可见度报告</strong><small>客户交付门户</small></div></div><h1>查看正式诊断报告</h1><p>使用项目团队提供的客户账号登录。这里只展示已发布报告和对应 PDF。</p><form onSubmit={submit}><label>客户账号<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required autoFocus /></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>{error && <div className="portal-login-error"><Warning size={17} />{error}</div>}<button disabled={busy}>{busy ? "正在登录" : "登录报告门户"}</button></form><small>账号由项目团队统一创建与维护。</small></section></main>;
}

export function PortalApp() {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [workspace, setWorkspace] = useState<Json | null>(null);
  const [projectId, setProjectId] = useState("");
  const [activeVersion, setActiveVersion] = useState<Json | null>(null);
  const [activeReport, setActiveReport] = useState<Json | null>(null);
  const [error, setError] = useState("");

  async function loadWorkspace() {
    setChecking(true); setError("");
    try {
      const status = await portalFetch("/api/portal/auth/status");
      if (!status.authenticated) { setAuthenticated(false); setWorkspace(null); return; }
      setAuthenticated(true);
      const response = await portalFetch("/api/portal/workspace");
      setWorkspace(response);
      const firstProject = projectId || response.projects?.[0]?.project_id || "";
      setProjectId(firstProject);
    } catch (reason: any) { if (reason.status === 401) setAuthenticated(false); else setError(reason.message); }
    finally { setChecking(false); }
  }

  useEffect(() => { loadWorkspace(); }, []);
  const reports = useMemo(() => (workspace?.reports || []).filter((item: Json) => !projectId || item.project_id === projectId), [workspace, projectId]);
  const latest = reports.find((item: Json) => item.status === "published") || reports[0];

  async function openReport(version: Json) {
    setError("");
    try { const response = await portalFetch(`/api/portal/reports/${encodeURIComponent(version.report_version_id)}`); setActiveVersion(version); setActiveReport(response.report); }
    catch (reason: any) { setError(reason.message); }
  }

  useEffect(() => { setActiveVersion(null); setActiveReport(null); if (latest) openReport(latest); }, [projectId, workspace?.reports?.length]);

  async function logout() { await portalFetch("/api/portal/auth/logout", { method: "POST", body: "{}" }).catch(() => null); setAuthenticated(false); setWorkspace(null); setActiveReport(null); }
  if (checking) return <main className="portal-loading"><span /><strong>正在载入正式报告</strong></main>;
  if (!authenticated) return <PortalLogin onLogin={loadWorkspace} />;

  const model = activeReport?.report as ReportModel | undefined;
  const logoUrl = workspace?.brand?.logo_available ? withBasePath("/api/portal/brand/logo") : "";
  return <div className="portal-shell"><header className="portal-topbar"><div className="portal-customer-brand">{logoUrl ? <img src={logoUrl} alt={`${workspace?.customer?.name || "客户"} Logo`} /> : <strong>{workspace?.customer?.name || "客户报告"}</strong>}<span>GEO 可见度报告中心</span></div><div className="portal-service-brand"><span>服务方</span><img src={withBasePath("/assets/geo-logo.svg")} alt="GEO Agent" /></div><div><select value={projectId} onChange={event => setProjectId(event.target.value)} aria-label="选择项目">{(workspace?.projects || []).map((project: Json) => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}</select><button onClick={logout}><SignOut size={17} />退出</button></div></header><main className="portal-content">{error && <div className="portal-notice"><Warning size={18} />{error}</div>}{!reports.length ? <section className="portal-empty"><FilePdf size={32} /><h1>正式报告准备中</h1><p>项目团队发布后，报告会出现在这里。</p></section> : activeVersion && model ? <><div className="portal-report-toolbar"><button onClick={() => { setActiveVersion(null); setActiveReport(null); }}><ArrowLeft />报告列表</button><div><span>{typeLabel(activeVersion.report_type)}</span><strong>V{activeVersion.version_no} · {formatDate(activeVersion.published_at || activeVersion.updated_at)}</strong></div>{activeVersion.pdf_available && <button className="portal-download" onClick={() => downloadPortalPdf(activeVersion).catch(reason => setError(reason.message))}><DownloadSimple />下载正式 PDF</button>}</div><ReportReader model={model} customerName={workspace?.customer?.name} logoUrl={logoUrl} /></> : <><section className="portal-hero"><span>已发布报告</span><h1>{workspace?.customer?.name} GEO 可见度报告</h1><p>查看最新诊断结论、周期变化和历史正式版本。</p></section><section className="portal-report-list">{reports.map((version: Json, index: number) => <article key={version.report_version_id}><div><span>{index === 0 && version.status === "published" ? "最新正式报告" : "历史正式报告"}</span><h2>{version.title}</h2><p>{typeLabel(version.report_type)} · V{version.version_no} · {formatDate(version.published_at || version.updated_at)}</p></div><button onClick={() => openReport(version)}>查看报告</button></article>)}</section></>}</main></div>;
}
