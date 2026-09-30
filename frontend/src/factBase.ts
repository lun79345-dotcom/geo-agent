import type { Json } from "./types";

function factLineIdentity(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function mergeFactValueLines(
  facts: Json[],
  factType: string,
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const fact of facts || []) {
    if (fact?.fact_type !== factType) continue;
    for (const rawLine of String(fact?.fact_value || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      const identity = factLineIdentity(line);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      lines.push(line);
    }
  }
  return lines.join("\n");
}
