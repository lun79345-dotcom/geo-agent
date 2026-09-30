const ENTRY_PATH_PATTERN = /\/(?:dashboard(?:-v2|-legacy)?\.html|portal\.html|login)\/?$/;

export function normalizeBasePath(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text || text === "/") return "";
  const withLeadingSlash = text.startsWith("/") ? text : `/${text}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function inferBasePath(): string {
  const configured = document
    .querySelector<HTMLMetaElement>('meta[name="geo-agent-base-path"]')
    ?.content;
  if (configured) return normalizeBasePath(configured);

  const pathname = location.pathname || "/";
  const entryMatch = pathname.match(ENTRY_PATH_PATTERN);
  if (entryMatch) return normalizeBasePath(pathname.slice(0, entryMatch.index));
  const assetIndex = pathname.indexOf("/v2-assets/");
  return assetIndex > 0 ? normalizeBasePath(pathname.slice(0, assetIndex)) : "";
}

export const GEO_AGENT_BASE_PATH = inferBasePath();

export function withBasePath(path: string): string {
  const value = String(path || "");
  if (!value || !value.startsWith("/") || value.startsWith("//")) return value;
  if (!GEO_AGENT_BASE_PATH) return value;
  if (value === GEO_AGENT_BASE_PATH || value.startsWith(`${GEO_AGENT_BASE_PATH}/`)) return value;
  return `${GEO_AGENT_BASE_PATH}${value}`;
}
