import * as k8s from "@kubernetes/client-node";

export function resolveNamespace(kc: k8s.KubeConfig, ns?: string): string {
  return ns || kc.getContextObject(kc.getCurrentContext())?.namespace || "default";
}

export function toLabelSelector(matchLabels: Record<string, string> | undefined): string | undefined {
  if (!matchLabels) return undefined;
  const parts = Object.entries(matchLabels).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(",") : undefined;
}

export function sumRestartCounts(pod: any): number {
  const statuses = pod?.status?.containerStatuses ?? [];
  return statuses.reduce((acc: number, s: any) => acc + (typeof s?.restartCount === "number" ? s.restartCount : 0), 0);
}

export function podReady(pod: any): boolean | undefined {
  const conds = pod?.status?.conditions ?? [];
  const ready = conds.find((c: any) => c?.type === "Ready");
  if (!ready) return undefined;
  return String(ready.status) === "True";
}

export function pickTopReason(pod: any): string | undefined {
  // Try container waiting/terminated reasons first
  const statuses = pod?.status?.containerStatuses ?? [];
  for (const s of statuses) {
    const waiting = s?.state?.waiting;
    if (waiting?.reason) return String(waiting.reason);
    const term = s?.state?.terminated;
    if (term?.reason) return String(term.reason);
    const lastTerm = s?.lastState?.terminated;
    if (lastTerm?.reason) return String(lastTerm.reason);
  }

  // Then pod phase / pod reason
  if (pod?.status?.reason) return String(pod.status.reason);
  if (pod?.status?.phase) return String(pod.status.phase);

  return undefined;
}

export function severityForReason(reason?: string): "high" | "medium" | "low" | "unknown" {
  if (!reason) return "unknown";
  const r = reason.toLowerCase();

  if (
    r.includes("crashloop") ||
    r.includes("imagepullbackoff") ||
    r.includes("errimagepull") ||
    r.includes("oomkilled") ||
    r.includes("containercannotrun") ||
    r.includes("createcontainerconfigerror") ||
    r.includes("runcontainererror")
  ) return "high";

  if (r.includes("notready") || r.includes("pending") || r.includes("evicted") || r.includes("unschedulable"))
    return "medium";

  return "low";
}

export function normalizeLogLines(text: string, maxLines = 300): { lines: string[]; truncated: boolean } {
  const all = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (all.length <= maxLines) return { lines: all, truncated: false };
  return { lines: all.slice(all.length - maxLines), truncated: true };
}

export function safeString(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s.trim() ? s : undefined;
}