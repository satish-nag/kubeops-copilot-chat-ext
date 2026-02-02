import * as k8s from "@kubernetes/client-node";

type Ref = {
  kind: "ConfigMap" | "Secret" | "PersistentVolumeClaim";
  name: string;
  namespace?: string;
  refType: string;
};

export async function findWorkloadsReferencing(
  kc: k8s.KubeConfig,
  target: { kind: Ref["kind"]; name: string; namespace: string }
) {
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const batch = kc.makeApiClient(k8s.BatchV1Api);

  const results: Array<{
    kind: string;
    name: string;
    namespace: string;
    refType: string;
  }> = [];

  const namespace = target.namespace;

  // Deployment
  const deployments = await apps.listNamespacedDeployment(namespace);
  for (const d of deployments.body.items) {
    const refs = extractRefsFromPodSpec(d.spec?.template?.spec, namespace);
    for (const r of refs) {
      if (matches(r, target)) {
        results.push({
          kind: "Deployment",
          name: d.metadata!.name!,
          namespace,
          refType: r.refType
        });
      }
    }
  }

  // StatefulSet
  const statefulSets = await apps.listNamespacedStatefulSet(namespace);
  for (const s of statefulSets.body.items) {
    const refs = extractRefsFromPodSpec(s.spec?.template?.spec, namespace);
    for (const r of refs) {
      if (matches(r, target)) {
        results.push({
          kind: "StatefulSet",
          name: s.metadata!.name!,
          namespace,
          refType: r.refType
        });
      }
    }
  }

  // DaemonSet
  const daemonSets = await apps.listNamespacedDaemonSet(namespace);
  for (const ds of daemonSets.body.items) {
    const refs = extractRefsFromPodSpec(ds.spec?.template?.spec, namespace);
    for (const r of refs) {
      if (matches(r, target)) {
        results.push({
          kind: "DaemonSet",
          name: ds.metadata!.name!,
          namespace,
          refType: r.refType
        });
      }
    }
  }

  // Job
  const jobs = await batch.listNamespacedJob(namespace);
  for (const j of jobs.body.items) {
    const refs = extractRefsFromPodSpec(j.spec?.template?.spec, namespace);
    for (const r of refs) {
      if (matches(r, target)) {
        results.push({
          kind: "Job",
          name: j.metadata!.name!,
          namespace,
          refType: r.refType
        });
      }
    }
  }

  return dedupe(results);
}

/* ---------------- helpers ---------------- */

function matches(ref: Ref, target: { kind: string; name: string; namespace: string }) {
  return (
    ref.kind === target.kind &&
    ref.name === target.name &&
    (ref.namespace ?? target.namespace) === target.namespace
  );
}

function dedupe<T extends { kind: string; name: string; namespace: string }>(arr: T[]): T[] {
  const seen = new Set<string>();
  return arr.filter((i) => {
    const k = `${i.kind}|${i.namespace}|${i.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * This is the CRITICAL part:
 * schema-aware extraction of references from PodSpec
 */
function extractRefsFromPodSpec(spec: any, namespace: string): Ref[] {
  if (!spec) return [];
  const refs: Ref[] = [];

  // volumes
  for (const v of spec.volumes ?? []) {
    if (v?.configMap?.name) {
      refs.push({
        kind: "ConfigMap",
        name: v.configMap.name,
        namespace,
        refType: `volume:${v.name}`
      });
    }
    if (v?.secret?.secretName) {
      refs.push({
        kind: "Secret",
        name: v.secret.secretName,
        namespace,
        refType: `volume:${v.name}`
      });
    }
    if (v?.persistentVolumeClaim?.claimName) {
      refs.push({
        kind: "PersistentVolumeClaim",
        name: v.persistentVolumeClaim.claimName,
        namespace,
        refType: `volume:${v.name}`
      });
    }
    if (v?.projected?.sources) {
      for (const src of v.projected.sources) {
        if (src?.configMap?.name) {
          refs.push({
            kind: "ConfigMap",
            name: src.configMap.name,
            namespace,
            refType: `projected:${v.name}`
          });
        }
        if (src?.secret?.name) {
          refs.push({
            kind: "Secret",
            name: src.secret.name,
            namespace,
            refType: `projected:${v.name}`
          });
        }
      }
    }
  }

  // containers + initContainers
  const containers = [
    ...(spec.containers ?? []),
    ...(spec.initContainers ?? [])
  ];

  for (const c of containers) {
    for (const ef of c.envFrom ?? []) {
      if (ef?.configMapRef?.name) {
        refs.push({
          kind: "ConfigMap",
          name: ef.configMapRef.name,
          namespace,
          refType: `envFrom:${c.name}`
        });
      }
      if (ef?.secretRef?.name) {
        refs.push({
          kind: "Secret",
          name: ef.secretRef.name,
          namespace,
          refType: `envFrom:${c.name}`
        });
      }
    }

    for (const e of c.env ?? []) {
      if (e?.valueFrom?.configMapKeyRef?.name) {
        refs.push({
          kind: "ConfigMap",
          name: e.valueFrom.configMapKeyRef.name,
          namespace,
          refType: `env:${c.name}`
        });
      }
      if (e?.valueFrom?.secretKeyRef?.name) {
        refs.push({
          kind: "Secret",
          name: e.valueFrom.secretKeyRef.name,
          namespace,
          refType: `env:${c.name}`
        });
      }
    }
  }

  return refs;
}

// ---- Ingress & Istio reverse lookups ----

export async function findIngressesReferencingService(
  kc: k8s.KubeConfig,
  target: { name: string; namespace: string }
) {
  const networking = kc.makeApiClient(k8s.NetworkingV1Api);
  const res = await networking.listNamespacedIngress(target.namespace);

  const out: Array<{ kind: string; name: string; namespace: string; refType: string }> = [];

  for (const ing of res.body.items) {
    const ingName = ing.metadata?.name;
    if (!ingName) continue;

    const matches = ingressReferencesService(ing, target.name);
    if (matches.length) {
      // Keep one record per ingress (refType includes why)
      out.push({
        kind: "Ingress",
        name: ingName,
        namespace: target.namespace,
        refType: `backendService:${matches.join(",")}`
      });
    }
  }

  return out;
}

function ingressReferencesService(ing: k8s.V1Ingress, svcName: string): string[] {
  const hits: string[] = [];

  // defaultBackend
  const def = ing.spec?.defaultBackend?.service?.name;
  if (def === svcName) hits.push("defaultBackend");

  // rules[].http.paths[].backend.service.name
  for (const rule of ing.spec?.rules ?? []) {
    const paths = rule.http?.paths ?? [];
    for (const p of paths) {
      const backendSvc = p.backend?.service?.name;
      if (backendSvc === svcName) {
        hits.push(`rule:${rule.host ?? "*"} path:${p.path ?? "*"}`);
      }
    }
  }

  return hits;
}

export async function findVirtualServicesReferencingService(
  kc: k8s.KubeConfig,
  target: { name: string; namespace: string }
) {
  const co = kc.makeApiClient(k8s.CustomObjectsApi);

  // Istio networking group/version
  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "virtualservices";

  const res: any = await co.listNamespacedCustomObject(group, version, target.namespace, plural);
  const items: any[] = (res?.body as any)?.items ?? [];

  const out: Array<{ kind: string; name: string; namespace: string; refType: string }> = [];

  for (const vs of items) {
    const vsName = vs?.metadata?.name;
    if (!vsName) continue;

    const hits = virtualServiceReferencesService(vs, target.name, target.namespace);
    if (hits.length) {
      out.push({
        kind: "VirtualService",
        name: vsName,
        namespace: target.namespace,
        refType: `destHost:${hits.join(",")}`
      });
    }
  }

  return out;
}

/**
 * Matches service host references in VirtualService:
 * - short name: "reviews"
 * - FQDN: "reviews.default.svc.cluster.local"
 * - name.namespace: "reviews.default"
 */
function virtualServiceReferencesService(vs: any, svcName: string, ns: string): string[] {
  const hits: string[] = [];

  const candidates = new Set<string>([
    svcName,
    `${svcName}.${ns}`,
    `${svcName}.${ns}.svc`,
    `${svcName}.${ns}.svc.cluster.local`
  ]);

  const spec = vs?.spec ?? {};
  const http = spec.http ?? [];
  const tcp = spec.tcp ?? [];
  const tls = spec.tls ?? [];

  const collectFromRouteList = (routes: any[], label: string) => {
    for (const r of routes ?? []) {
      const host = r?.destination?.host;
      if (host && candidates.has(host)) hits.push(`${label}:${host}`);
    }
  };

  for (const h of http) collectFromRouteList(h.route ?? [], "http");
  for (const t of tcp) collectFromRouteList(t.route ?? [], "tcp");
  for (const t of tls) collectFromRouteList(t.route ?? [], "tls");

  return hits;
}

export async function findVirtualServicesReferencingGateway(
  kc: k8s.KubeConfig,
  target: { name: string; namespace: string }
) {
  const co = kc.makeApiClient(k8s.CustomObjectsApi);

  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "virtualservices";

  const res: any = await co.listNamespacedCustomObject(group, version, target.namespace, plural);
  const items: any[] = (res?.body as any)?.items ?? [];

  const out: Array<{ kind: string; name: string; namespace: string; refType: string }> = [];

  const gwShort = target.name;                 // "my-gw"
  const gwQualified = `${target.namespace}/${target.name}`; // "ns/my-gw"

  for (const vs of items) {
    const vsName = vs?.metadata?.name;
    if (!vsName) continue;

    const gws: string[] = (vs?.spec?.gateways ?? []) as string[];
    if (gws.includes(gwShort) || gws.includes(gwQualified)) {
      out.push({
        kind: "VirtualService",
        name: vsName,
        namespace: target.namespace,
        refType: `gatewayRef:${gws.includes(gwQualified) ? gwQualified : gwShort}`
      });
    }
  }

  return out;
}

export async function findServicesReferencedByIngress(
  kc: k8s.KubeConfig,
  ingress: { name: string; namespace: string }
) {
  const networking = kc.makeApiClient(k8s.NetworkingV1Api);
  const ing = await networking.readNamespacedIngress(ingress.name, ingress.namespace);

  const services = new Set<string>();

  const def = ing.body.spec?.defaultBackend?.service?.name;
  if (def) services.add(def);

  for (const rule of ing.body.spec?.rules ?? []) {
    for (const p of rule.http?.paths ?? []) {
      const s = p.backend?.service?.name;
      if (s) services.add(s);
    }
  }

  return [...services].map((s) => ({
    kind: "Service",
    name: s,
    namespace: ingress.namespace,
    refType: "ingressBackend"
  }));
}

export async function findServicesReferencedByVirtualService(
  kc: k8s.KubeConfig,
  vs: { name: string; namespace: string }
) {
  const co = kc.makeApiClient(k8s.CustomObjectsApi);
  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "virtualservices";

  const obj: any = await co.getNamespacedCustomObject(group, version, vs.namespace, plural, vs.name);
  const spec = (obj?.body as any)?.spec ?? {};

  const hosts = new Set<string>();

  const collect = (routes: any[]) => {
    for (const r of routes ?? []) {
      const host = r?.destination?.host;
      if (host) hosts.add(host);
    }
  };

  for (const h of spec.http ?? []) collect(h.route ?? []);
  for (const t of spec.tcp ?? []) collect(t.route ?? []);
  for (const t of spec.tls ?? []) collect(t.route ?? []);

  // Convert host strings into “Service-like” items (best-effort, deterministic)
  // If it’s FQDN/short, we still list the host as Name to avoid guessing other namespaces.
  return [...hosts].map((h) => ({
    kind: "Service",
    name: h,
    namespace: vs.namespace,
    refType: "virtualServiceDestination"
  }));
}

export async function findGatewaysReferencedByVirtualService(
  kc: k8s.KubeConfig,
  vs: { name: string; namespace: string }
) {
  const co = kc.makeApiClient(k8s.CustomObjectsApi);
  const group = "networking.istio.io";
  const version = "v1beta1";
  const plural = "virtualservices";

  const obj: any = await co.getNamespacedCustomObject(group, version, vs.namespace, plural, vs.name);
  const gws: string[] = ((obj?.body as any)?.spec?.gateways ?? []) as string[];

  // gateways can be "gw" or "ns/gw". Keep exact strings (no guessing).
  return gws.map((g) => ({
    kind: "Gateway",
    name: g,
    namespace: vs.namespace,
    refType: "virtualServiceGateway"
  }));
}

// ---- Service -> selector -> pods -> top workload (collapsed) ----

export async function findWorkloadsBackedByService(
  kc: k8s.KubeConfig,
  target: { name: string; namespace: string }
): Promise<Array<{ kind: string; name: string; namespace: string; refType: string }>> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  // 1) Read service and get selector
  const svc = await core.readNamespacedService(target.name, target.namespace);
  const selector = svc.body.spec?.selector;

  // If selector missing/empty, this Service may use manual Endpoints/EndpointSlices or be ExternalName
  if (!selector || Object.keys(selector).length === 0) {
    return [];
  }

  const labelSelector = Object.entries(selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  // 2) List pods selected by service selector
  const podsRes = await core.listNamespacedPod(
    target.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector
  );

  const pods = podsRes.body.items ?? [];
  if (pods.length === 0) return [];

  // 3) Collapse pods to top-level controller
  const rsToDeploymentCache = new Map<string, { kind: string; name: string }>();

  const counts = new Map<string, { kind: string; name: string; namespace: string; podCount: number }>();

  for (const pod of pods) {
    const owner = await resolveTopWorkloadForPod(apps, pod, target.namespace, rsToDeploymentCache);

    const key = `${owner.kind}|${target.namespace}|${owner.name}`;
    const existing = counts.get(key);
    if (existing) {
      existing.podCount += 1;
    } else {
      counts.set(key, { kind: owner.kind, name: owner.name, namespace: target.namespace, podCount: 1 });
    }
  }

  // 4) Convert to impacted resources (pod count in refType)
  return [...counts.values()].map((w) => ({
    kind: w.kind,
    name: w.name,
    namespace: w.namespace,
    refType: `serviceSelector pods=${w.podCount}`
  }));
}

async function resolveTopWorkloadForPod(
  apps: k8s.AppsV1Api,
  pod: k8s.V1Pod,
  namespace: string,
  rsToDeploymentCache: Map<string, { kind: string; name: string }>
): Promise<{ kind: string; name: string }> {
  const owners = pod.metadata?.ownerReferences ?? [];
  if (owners.length === 0) {
    return { kind: "Pod", name: pod.metadata?.name ?? "unknown" };
  }

  // pick controller owner if present; else first owner
  const controllerOwner = owners.find((o) => o.controller) ?? owners[0];

  // Direct top-level controllers
  if (controllerOwner.kind === "StatefulSet") return { kind: "StatefulSet", name: controllerOwner.name };
  if (controllerOwner.kind === "DaemonSet") return { kind: "DaemonSet", name: controllerOwner.name };
  if (controllerOwner.kind === "Deployment") return { kind: "Deployment", name: controllerOwner.name };

  // Pod owned by ReplicaSet -> resolve to Deployment if possible
  if (controllerOwner.kind === "ReplicaSet") {
    const rsName = controllerOwner.name;
    const cached = rsToDeploymentCache.get(rsName);
    if (cached) return cached;

    try {
      const rs = await apps.readNamespacedReplicaSet(rsName, namespace);
      const rsOwners = rs.body.metadata?.ownerReferences ?? [];
      const depOwner = rsOwners.find((o) => o.kind === "Deployment");
      if (depOwner) {
        const top = { kind: "Deployment", name: depOwner.name };
        rsToDeploymentCache.set(rsName, top);
        return top;
      }

      // fallback to ReplicaSet
      const top = { kind: "ReplicaSet", name: rsName };
      rsToDeploymentCache.set(rsName, top);
      return top;
    } catch {
      // Can't read RS (RBAC) -> show RS as fallback
      const top = { kind: "ReplicaSet", name: rsName };
      rsToDeploymentCache.set(rsName, top);
      return top;
    }
  }

  // fallback
  return { kind: controllerOwner.kind, name: controllerOwner.name };
}