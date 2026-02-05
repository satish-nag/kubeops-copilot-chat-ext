import * as k8s from "@kubernetes/client-node";
import { toLabelSelector } from "./k8sHelpers";

/** Simple matchLabels-only matcher (keeps this bounded and reliable). */
function matchLabels(podLabels: Record<string, string> | undefined, selector: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  if (!podLabels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (podLabels[k] !== v) return false;
  }
  return true;
}

/** EndpointSlice listing (robust across client-node versions) */
async function listEndpointSlicesForService(kc: k8s.KubeConfig, ns: string, serviceName: string): Promise<any[]> {
  const labelSelector = `kubernetes.io/service-name=${serviceName}`;

  // Prefer typed API when available
  try {
    const discovery: any = kc.makeApiClient((k8s as any).DiscoveryV1Api);
    const callable = discovery?.["listNamespacedEndpointSlice"];
    if (typeof callable === "function") {
      const res = await callable.call(
        discovery,
        ns,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        undefined, // fieldSelector
        labelSelector // labelSelector
      );
      return res?.body?.items ?? [];
    }
  } catch {
    // ignore -> fallback
  }

  // Fallback to CustomObjectsApi; pad args to avoid selector landing in fieldSelector
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const res = await custom.listNamespacedCustomObject(
    "discovery.k8s.io",
    "v1",
    ns,
    "endpointslices",
    undefined, // pretty
    undefined, // allowWatchBookmarks
    undefined, // _continue
    undefined, // fieldSelector
    labelSelector // labelSelector
  );

  return ((res.body as any)?.items ?? []) as any[];
}

function podInEndpointSlices(podName: string, slices: any[]): boolean {
  for (const s of slices) {
    for (const ep of s?.endpoints ?? []) {
      const tr = ep?.targetRef;
      if (tr?.kind === "Pod" && tr?.name === podName) return true;
    }
  }
  return false;
}

function probeToString(p: any): string | undefined {
  if (!p) return undefined;
  if (p.httpGet) {
    const path = p.httpGet.path ?? "/";
    const port = p.httpGet.port;
    return `httpGet ${path} port=${port} (period=${p.periodSeconds ?? ""}s, timeout=${p.timeoutSeconds ?? ""}s, fail=${p.failureThreshold ?? ""})`;
  }
  if (p.tcpSocket) {
    return `tcpSocket port=${p.tcpSocket.port} (period=${p.periodSeconds ?? ""}s, timeout=${p.timeoutSeconds ?? ""}s)`;
  }
  if (p.exec?.command) {
    return `exec ${p.exec.command.join(" ")} (period=${p.periodSeconds ?? ""}s, timeout=${p.timeoutSeconds ?? ""}s)`;
  }
  return `probe (period=${p.periodSeconds ?? ""}s, timeout=${p.timeoutSeconds ?? ""}s)`;
}

export function extractProbeSummaries(pod: any) {
  const out: Array<{ container: string; readiness?: string; liveness?: string; startup?: string }> = [];
  for (const c of pod?.spec?.containers ?? []) {
    out.push({
      container: String(c?.name ?? ""),
      readiness: probeToString(c?.readinessProbe),
      liveness: probeToString(c?.livenessProbe),
      startup: probeToString(c?.startupProbe)
    });
  }
  return out;
}

export async function discoverServiceEndpointEvidence(
  kc: k8s.KubeConfig,
  ns: string,
  pod: any,
  opts?: { maxServices?: number }
) {
  const maxServices = opts?.maxServices ?? 5;
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const podName = String(pod?.metadata?.name ?? "");
  const podLabels = (pod?.metadata?.labels ?? {}) as Record<string, string>;

  const services = (await core.listNamespacedService(ns)).body.items ?? [];
  const evidence: Array<{ service: string; selectedByService: boolean; inEndpoints: boolean; notes?: string }> = [];

  for (const s of services) {
    if (evidence.length >= maxServices) break;
    const svcName = s?.metadata?.name;
    if (!svcName) continue;

    const selector = s?.spec?.selector as Record<string, string> | undefined;
    const selected = matchLabels(podLabels, selector);
    if (!selected) continue;

    // Check EndpointSlice membership
    let inEndpoints = false;
    let notes: string | undefined;

    try {
      const slices = await listEndpointSlicesForService(kc, ns, svcName);
      inEndpoints = podInEndpointSlices(podName, slices);
      if (!inEndpoints) notes = "Selector matches, but pod not present in EndpointSlices (likely NotReady or endpoints delayed).";
    } catch (e: any) {
      notes = `EndpointSlice lookup failed: ${e?.message ?? String(e)}`;
    }

    evidence.push({ service: svcName, selectedByService: true, inEndpoints, ...(notes ? { notes } : {}) });
  }

  return evidence;
}

export async function discoverPVCs(kc: k8s.KubeConfig, ns: string, pod: any, opts?: { maxPVCs?: number }) {
  const maxPVCs = opts?.maxPVCs ?? 5;
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const claims: string[] = [];
  for (const v of pod?.spec?.volumes ?? []) {
    const claim = v?.persistentVolumeClaim?.claimName;
    if (claim) claims.push(String(claim));
  }

  const unique = Array.from(new Set(claims)).slice(0, maxPVCs);
  const out: Array<{
    claim: string;
    phase?: string;
    storageClass?: string;
    volumeName?: string;
    reason?: string;
    message?: string;
  }> = [];

  for (const claim of unique) {
    try {
      const pvc = (await core.readNamespacedPersistentVolumeClaim(claim, ns)).body as any;
      const cond = (pvc?.status?.conditions ?? [])[0];
      out.push({
        claim,
        phase: pvc?.status?.phase,
        storageClass: pvc?.spec?.storageClassName,
        volumeName: pvc?.spec?.volumeName,
        reason: cond?.reason,
        message: cond?.message
      });
    } catch (e: any) {
      out.push({ claim, reason: "PVCReadFailed", message: e?.message ?? String(e) });
    }
  }

  return out;
}

export async function discoverNodeConditions(kc: k8s.KubeConfig, nodeName?: string) {
  if (!nodeName) return [];
  const core = kc.makeApiClient(k8s.CoreV1Api);

  try {
    const node = (await core.readNode(nodeName)).body as any;
    const conds = (node?.status?.conditions ?? []).map((c: any) => ({
      type: String(c?.type ?? ""),
      status: String(c?.status ?? ""),
      reason: c?.reason,
      message: c?.message
    }));
    // Keep the most relevant few first
    const priority = ["Ready", "MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];
    conds.sort((a: any, b: any) => priority.indexOf(a.type) - priority.indexOf(b.type));
    return conds.slice(0, 10);
  } catch (e) {
    return [{ type: "NodeReadFailed", status: "Unknown", reason: "NodeReadFailed", message: e instanceof Error ? e.message : String(e) }];
  }
}

export async function discoverNetworkPoliciesSelectingPod(
  kc: k8s.KubeConfig,
  ns: string,
  pod: any,
  opts?: { maxPolicies?: number }
) {
  const maxPolicies = opts?.maxPolicies ?? 6;
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const podLabels = (pod?.metadata?.labels ?? {}) as Record<string, string>;

  try {
    const pols = (await net.listNamespacedNetworkPolicy(ns)).body.items ?? [];
    const matched: Array<{ name: string; policyTypes: string[]; podSelector?: Record<string, string> }> = [];

    for (const p of pols) {
      if (matched.length >= maxPolicies) break;
      const sel = (p as any)?.spec?.podSelector?.matchLabels as Record<string, string> | undefined;
      const selects = matchLabels(podLabels, sel) || (!sel || Object.keys(sel).length === 0); // empty selector selects all
      if (!selects) continue;

      matched.push({
        name: String(p?.metadata?.name ?? ""),
        policyTypes: ((p as any)?.spec?.policyTypes ?? []) as string[],
        podSelector: sel
      });
    }

    return matched;
  } catch (e: any) {
    return [
      {
        name: "NetworkPolicyListFailed",
        policyTypes: [],
        podSelector: {},
      }
    ];
  }
}

export async function fetchDeploymentConditions(kc: k8s.KubeConfig, ns: string, deploymentName: string) {
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const dep = (await apps.readNamespacedDeployment(deploymentName, ns)).body as any;
  const conditions = (dep?.status?.conditions ?? []).map((c: any) => ({
    type: String(c?.type ?? ""),
    status: String(c?.status ?? ""),
    reason: c?.reason,
    message: c?.message
  }));
  return conditions.slice(0, 10);
}

export async function listPodsForDeployment(kc: k8s.KubeConfig, ns: string, deploymentName: string) {
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const dep = (await apps.readNamespacedDeployment(deploymentName, ns)).body as any;
  const sel = dep?.spec?.selector?.matchLabels as Record<string, string> | undefined;
  const labelSelector = toLabelSelector(sel);

  if (!labelSelector) return [];
  const pods = (await core.listNamespacedPod(ns, undefined, undefined, undefined, undefined, labelSelector)).body.items ?? [];
  return pods;
}