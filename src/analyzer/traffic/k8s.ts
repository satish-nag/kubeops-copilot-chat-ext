import * as k8s from "@kubernetes/client-node";

export function defaultNamespace(kc: k8s.KubeConfig, ns?: string): string {
  return (
    ns ||
    kc.getContextObject(kc.getCurrentContext())?.namespace ||
    "default"
  );
}

export function makeClients(kc: k8s.KubeConfig) {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    net: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi)
  };
}

export function selectorToQuery(selector?: Record<string, string>): string | undefined {
  if (!selector) return undefined;
  const parts = Object.entries(selector)
    .filter(([k, v]) => k && v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(",") : undefined;
}

export function podLabelsMatchSelector(
  podLabels: Record<string, string> | undefined,
  selector: Record<string, string> | undefined
): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  if (!podLabels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (podLabels[k] !== v) return false;
  }
  return true;
}

export async function listPodsBySelector(
  kc: k8s.KubeConfig,
  ns: string,
  selector?: Record<string, string>
) {
  const { core } = makeClients(kc);
  const labelSelector = selectorToQuery(selector);
  const res = await core.listNamespacedPod(ns, undefined, undefined, undefined, undefined, labelSelector);
  return res.body.items;
}

export async function readService(kc: k8s.KubeConfig, ns: string, name: string) {
  const { core } = makeClients(kc);
  return (await core.readNamespacedService(name, ns)).body;
}

export async function listServices(kc: k8s.KubeConfig, ns: string) {
  const { core } = makeClients(kc);
  return (await core.listNamespacedService(ns)).body.items;
}

export async function listIngresses(kc: k8s.KubeConfig, ns: string) {
  const { net } = makeClients(kc);
  return (await net.listNamespacedIngress(ns)).body.items;
}

export async function listDestinationRules(kc: k8s.KubeConfig, ns: string) {
  const { custom } = makeClients(kc);
  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "destinationrules";
  const res = await custom.listNamespacedCustomObject(group, version, ns, plural);
  return ((res.body as any)?.items ?? []) as any[];
}

export async function listEndpointSlicesForService(kc: k8s.KubeConfig, ns: string, serviceName: string) {
  const labelSelector = `kubernetes.io/service-name=${serviceName}`;

  // ✅ Preferred: typed API (no positional confusion)
  try {
    // Some versions of client-node may not have DiscoveryV1Api exported
    const discovery: any = kc.makeApiClient((k8s as any).DiscoveryV1Api);

    const fn = discovery?.listNamespacedEndpointSlice ?? discovery?.listNamespacedEndpointSlice;
    // Some generated clients use different casing; prefer the OpenAPI-generated name.
    const listFn = discovery?.["listNamespacedEndpointSlice"] ?? discovery?.["listNamespacedEndpointSlice"];

    const callable = fn ?? listFn;
    if (typeof callable === "function") {
      const res = await callable.call(
        discovery,
        ns,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        undefined, // fieldSelector
        labelSelector // labelSelector ✅
      );
      return res?.body?.items ?? [];
    }
  } catch {
    // fallback below
  }

  // If DiscoveryV1Api isn't available (older client-node), fall back to CustomObjectsApi.
  // ✅ Fallback: CustomObjectsApi (pad args to avoid labelSelector slipping into fieldSelector)
  const { custom } = makeClients(kc);
  const group = "discovery.k8s.io";
  const version = "v1";
  const plural = "endpointslices";

  const res = await custom.listNamespacedCustomObject(
    group,
    version,
    ns,
    plural,
    undefined, // pretty
    undefined, // allowWatchBookmarks (exists in many versions)
    undefined, // _continue
    undefined, // fieldSelector ✅ keep empty
    labelSelector // labelSelector ✅
  );

  const body = res.body as any;
  return (body?.items ?? []) as any[];
}

/** Istio helpers (assumes Istio CRDs exist; caller can disable includeIstio). */
export async function listVirtualServices(kc: k8s.KubeConfig, ns: string) {
  const { custom } = makeClients(kc);
  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "virtualservices";
  const res = await custom.listNamespacedCustomObject(group, version, ns, plural);
  return ((res.body as any)?.items ?? []) as any[];
}

export async function listGateways(kc: k8s.KubeConfig, ns: string) {
  const { custom } = makeClients(kc);
  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "gateways";
  const res = await custom.listNamespacedCustomObject(group, version, ns, plural);
  return ((res.body as any)?.items ?? []) as any[];
}