import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "../graph";
import { makeNode, roleForKind } from "../nodeId";
import {
  defaultNamespace,
  listEndpointSlicesForService,
  listIngresses,
  listVirtualServices,
  listGateways,
  listDestinationRules
} from "../k8s";

export async function discoverFromService(
  kc: k8s.KubeConfig,
  gb: GraphBuilder,
  name: string,
  namespace?: string,
  includeIstio = true,
  focusPodName?: string
) {
  const ns = defaultNamespace(kc, namespace);

  // Downstream: Service -> EndpointSlice -> Pods
  const svc = makeNode("Service", name, ns, roleForKind("Service"));

  // NOTE: We don't “read” the service here to stay light.
  // If you want, you can read it and use selector directly.
  // In practice: list pods by endpointslice is more precise than selector.
  const slices = await listEndpointSlicesForService(kc, ns, name);
  for (const es of slices) {
    const esName = es?.metadata?.name;
    if (!esName) continue;

    const esNode = makeNode("EndpointSlice", esName, ns, roleForKind("EndpointSlice"));
    gb.addEdge(svc, esNode, "Service selects EndpointSlice (kubernetes.io/service-name)");

    // Endpoints -> Pods (targetRef kind=Pod)
    const endpoints = es?.endpoints ?? [];
    for (const ep of endpoints) {
      const tr = ep?.targetRef;
      if (tr?.kind === "Pod" && tr?.name) {
        // ✅ If we're analyzing flow starting from a specific pod, keep it limited to that pod.
        if (focusPodName && tr.name !== focusPodName) continue;

        const podNode = makeNode("Pod", tr.name, tr.namespace ?? ns, roleForKind("Pod"));
        gb.addEdge(esNode, podNode, "EndpointSlice endpoint targetRef -> Pod");
      }
    }
  }

  // Upstream: Ingress routes to Service
  const ingresses = await listIngresses(kc, ns);
  for (const ing of ingresses) {
    const ingName = ing?.metadata?.name;
    if (!ingName) continue;

    const rules = ing?.spec?.rules ?? [];
    const defaultBackend = ing?.spec?.defaultBackend?.service?.name;
    let matched = false;

    if (defaultBackend === name) matched = true;

    for (const r of rules) {
      const paths = r?.http?.paths ?? [];
      for (const p of paths) {
        const backendSvc = p?.backend?.service?.name;
        if (backendSvc === name) matched = true;
      }
    }

    if (matched) {
      const ingNode = makeNode("Ingress", ingName, ns, roleForKind("Ingress"));
      gb.addEdge(ingNode, svc, "Ingress backend routes to this Service");
    }
  }

  if (!includeIstio) return;

  const destinationRules = await listDestinationRules(kc, ns);

  // Upstream: VirtualService routes to Service (destination.host)
  const vss = await listVirtualServices(kc, ns);
  for (const vs of vss) {
    const vsName = vs?.metadata?.name;
    if (!vsName) continue;

    const http = vs?.spec?.http ?? [];
    let hitsService = false;

    // Track which destination hosts/subsets in this VS pointed to this service
    const matchedDestinations: Array<{ host: string; subset?: string; weight?: number }> = [];

    for (const h of http) {
      for (const rt of h?.route ?? []) {
        const host = rt?.destination?.host;
        if (!host) continue;

        const normalized = String(host);
        const subset = rt?.destination?.subset ? String(rt.destination.subset) : undefined;

        // Common patterns: "svc", "svc.ns", "svc.ns.svc.cluster.local"
        if (
          normalized === name ||
          normalized.startsWith(`${name}.`) ||
          normalized === `${name}.${ns}.svc.cluster.local`
        ) {
          hitsService = true;
          const weightRaw = (rt as any)?.weight;
          const weight = typeof weightRaw === "number" ? weightRaw : undefined;

          matchedDestinations.push({ host: normalized, subset, weight });
        }
      }
    }

    if (hitsService) {
      const vsNode = makeNode("VirtualService", vsName, ns, roleForKind("VirtualService"));
      // NOTE: We'll add the direct VirtualService -> Service edge only if no matching DestinationRule is found.

      let matchedAnyDestinationRule = false;

      // VS -> Gateway(s)
      for (const gw of vs?.spec?.gateways ?? []) {
        if (typeof gw === "string" && gw !== "mesh") {
          const gwNode = makeNode("Gateway", gw, ns, roleForKind("Gateway"));
          gb.addEdge(gwNode, vsNode, "Gateway is referenced by VirtualService");
        }
      }

      // ✅ NEW: VirtualService -> DestinationRule -> Service (if DR host matches)
      for (const dest of matchedDestinations) {
        const dr = findMatchingDestinationRule(destinationRules, dest.host, name, ns);
        if (!dr) continue;
        matchedAnyDestinationRule = true;

        const drName = dr?.metadata?.name;
        if (!drName) continue;

        const drNode = makeNode("DestinationRule", drName, ns, roleForKind("DestinationRule"));

        const subsetInfo = dest.subset ? `subset: ${dest.subset}` : undefined;
        const weightInfo = typeof dest.weight === "number" ? `traffic: ${dest.weight}%` : undefined;

        const extras = [subsetInfo, weightInfo].filter(Boolean).join(", ");
        const suffix = extras ? ` (${extras})` : "";

        gb.addEdge(vsNode, drNode, `VirtualService traffic policy via DestinationRule${suffix}`);
        gb.addEdge(drNode, svc, "DestinationRule applies to this service host");
      }
      if (!matchedAnyDestinationRule) {
        const weights = matchedDestinations
          .map((d) => d.weight)
          .filter((w): w is number => typeof w === "number");

        let weightSuffix = "";
        if (weights.length === 1) weightSuffix = ` (traffic: ${weights[0]}%)`;
        else if (weights.length > 1) weightSuffix = ` (traffic weights: ${weights.join("/")}%)`;

        gb.addEdge(vsNode, svc, `VirtualService routes to Service via destination.host${weightSuffix}`);
      }
    }
  }

  // (Optional) If you want to ensure Gateway exists, you can list gateways, but not necessary for edges.
  // We keep it light by not validating gateway existence here.
}

function findMatchingDestinationRule(
  destinationRules: any[],
  destinationHost: string,
  serviceName: string,
  namespace: string
): any | undefined {
  const dest = String(destinationHost);

  // Normalize likely host variants
  const candidates = new Set<string>([
    serviceName,
    `${serviceName}.${namespace}`,
    `${serviceName}.${namespace}.svc.cluster.local`,
    dest
  ]);

  for (const dr of destinationRules) {
    const host = dr?.spec?.host;
    if (!host) continue;

    const h = String(host);
    // Match exact or service prefix patterns
    if (candidates.has(h)) return dr;

    // Some DRs use short form like `svc.ns` while VS uses FQDN (or vice-versa)
    if (h === serviceName || h.startsWith(`${serviceName}.`)) return dr;
  }

  return undefined;
}