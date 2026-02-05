import * as k8s from "@kubernetes/client-node";

/** matchLabels-only selector matcher (keeps it simple + reliable) */
function matchLabels(podLabels: Record<string, string> | undefined, selector: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return true; // empty selector selects all
  if (!podLabels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (podLabels[k] !== v) return false;
  }
  return true;
}

function nsMatchLabels(nsLabels: Record<string, string> | undefined, selector: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  if (!nsLabels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (nsLabels[k] !== v) return false;
  }
  return true;
}

export type NetworkPolicyFinding = {
  policy: string;
  selectsDestinationPod: boolean;
  policyTypes: string[];
  denyAllIngress: boolean;
  allowFromSource?: boolean;
  note: string;
};

export async function discoverNetworkPoliciesForTraffic(
  kc: k8s.KubeConfig,
  ns: string,
  destPod: any,
  opts?: {
    sourcePodName?: string;
    sourceNamespace?: string;
    destPort?: number; // optional (Service port or target port)
    maxPolicies?: number;
  }
): Promise<NetworkPolicyFinding[]> {
  const maxPolicies = opts?.maxPolicies ?? 20;
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const podLabels = (destPod?.metadata?.labels ?? {}) as Record<string, string>;
  const podName = String(destPod?.metadata?.name ?? "");
  const findings: NetworkPolicyFinding[] = [];

  // If source pod given, fetch its labels + namespace labels (for namespaceSelector checks)
  let srcPodLabels: Record<string, string> | undefined;
  let srcNsLabels: Record<string, string> | undefined;
  const srcNs = opts?.sourceNamespace ?? ns;
  const srcPodName = opts?.sourcePodName;

  if (srcPodName) {
    try {
      const p = await core.readNamespacedPod(srcPodName, srcNs);
      srcPodLabels = ((p as any)?.body?.metadata?.labels ?? {}) as Record<string, string>;
    } catch {
      // ignore; we can still report policies selecting dest
    }
    try {
      const n = await core.readNamespace(srcNs);
      srcNsLabels = ((n as any)?.body?.metadata?.labels ?? {}) as Record<string, string>;
    } catch {
      // ignore
    }
  }

  const pols = (await net.listNamespacedNetworkPolicy(ns)).body.items ?? [];
  for (const p of pols.slice(0, maxPolicies)) {
    const name = String(p?.metadata?.name ?? "");
    const spec: any = (p as any)?.spec ?? {};
    const pt: string[] = (spec?.policyTypes ?? []) as string[];

    // Only policies affecting dest pod
    const sel = spec?.podSelector?.matchLabels as Record<string, string> | undefined;
    const selects = matchLabels(podLabels, sel);
    if (!selects) continue;

    const ingressRules: any[] | undefined = spec?.ingress;
    const hasIngressType = pt.includes("Ingress") || ingressRules !== undefined;

    const denyAllIngress = hasIngressType && Array.isArray(ingressRules) && ingressRules.length === 0;

    let allowFromSource: boolean | undefined = undefined;
    let note = `NetworkPolicy selects destination pod ${podName}.`;

    // Optional: try a basic allow/deny evaluation for ingress from source pod
    if (srcPodName && hasIngressType) {
      if (denyAllIngress) {
        allowFromSource = false;
        note = `DENY: policy has Ingress with empty rules (deny-all ingress).`;
      } else if (!Array.isArray(ingressRules) || ingressRules.length === 0) {
        // If ingress is not defined but policyTypes includes Ingress, behavior depends; keep conservative
        allowFromSource = undefined;
        note = `Policy has Ingress type but rules are not explicitly listed; cannot fully evaluate.`;
      } else {
        // Evaluate: if ANY ingress rule allows source pod/namespace (and optionally port) => allowed
        allowFromSource = false;
        const destPort = opts?.destPort;

        for (const rule of ingressRules) {
          // ports check (optional)
          if (destPort && Array.isArray(rule?.ports) && rule.ports.length > 0) {
            const portAllowed = rule.ports.some((pr: any) => {
              const pnum = pr?.port;
              if (typeof pnum === "number") return pnum === destPort;
              // named port -> we can’t resolve reliably without container port mapping; treat as unknown/allow-ish
              if (typeof pnum === "string") return true;
              return true;
            });
            if (!portAllowed) continue;
          }

          const fromArr: any[] = Array.isArray(rule?.from) ? rule.from : [];

          // If rule has no "from", it allows from all sources
          if (fromArr.length === 0) {
            allowFromSource = true;
            note = `ALLOW: ingress rule allows all sources (no 'from' restrictions).`;
            break;
          }

          for (const fr of fromArr) {
            // podSelector only
            if (fr?.podSelector?.matchLabels) {
              if (matchLabels(srcPodLabels, fr.podSelector.matchLabels)) {
                allowFromSource = true;
                note = `ALLOW: ingress rule matches source podSelector.`;
                break;
              }
            }

            // namespaceSelector only
            if (fr?.namespaceSelector?.matchLabels) {
              if (nsMatchLabels(srcNsLabels, fr.namespaceSelector.matchLabels)) {
                allowFromSource = true;
                note = `ALLOW: ingress rule matches source namespaceSelector.`;
                break;
              }
            }

            // both namespaceSelector + podSelector
            if (fr?.namespaceSelector?.matchLabels && fr?.podSelector?.matchLabels) {
              const nsOk = nsMatchLabels(srcNsLabels, fr.namespaceSelector.matchLabels);
              const podOk = matchLabels(srcPodLabels, fr.podSelector.matchLabels);
              if (nsOk && podOk) {
                allowFromSource = true;
                note = `ALLOW: ingress rule matches both namespaceSelector and podSelector.`;
                break;
              }
            }
          }

          if (allowFromSource) break;
        }

        if (allowFromSource === false) {
          note = `POTENTIAL DENY: no ingress rule matched source pod/namespace (may block traffic).`;
        }
      }
    }

    findings.push({
      policy: name,
      selectsDestinationPod: true,
      policyTypes: pt,
      denyAllIngress,
      ...(allowFromSource !== undefined ? { allowFromSource } : {}),
      note
    });
  }

  return findings;
}