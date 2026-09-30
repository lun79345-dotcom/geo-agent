import type { Json } from "./types";
import { withBasePath } from "./basePath";

export class ApiError extends Error {
  status: number; payload: Json;
  constructor(status: number, payload: Json) { super(payload.error || payload.message || `请求失败 (${status})`); this.status = status; this.payload = payload; }
}

export async function api<T = Json>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(withBasePath(path), { credentials: "same-origin", cache: "no-store", ...options, headers });
  if (response.status === 401) {
    location.href = withBasePath(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, { error: "登录已失效" });
  }
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) throw new ApiError(response.status, payload as Json);
  return payload as T;
}

export const get = <T = Json>(path: string) => {
  const separator = path.includes("?") ? "&" : "?";
  return api<T>(`${path}${separator}_fresh=${Date.now()}`, {
    headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
  });
};
export const post = <T = Json>(path: string, body: Json) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T = Json>(path: string, body: Json) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = <T = Json>(path: string) => api<T>(path, { method: "DELETE" });

export async function download(path: string, body: Json, fallbackName: string) {
  const response = await fetch(withBasePath(path), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => ({ error: `下载失败 (${response.status})` })));
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = href; anchor.download = fallbackName; anchor.click();
  URL.revokeObjectURL(href);
}

export async function downloadGet(path: string, fallbackName: string) {
  const response = await fetch(withBasePath(path), { credentials: "same-origin" });
  if (response.status === 401) {
    location.href = withBasePath(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError(401, { error: "登录已失效" });
  }
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => ({ error: `下载失败 (${response.status})` })));
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : fallbackName;
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = href; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(href);
}
