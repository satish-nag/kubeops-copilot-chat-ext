import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "../graph";
import { makeNode, roleForKind } from "../nodeId";
import { defaultNamespace, listIngresses } from "../k8s";
import { discoverFromService } from "./serviceFlow";

export async function discoverFromIngress(
  kc: k8s.KubeConfig,
  gb: GraphBuilder,
  name: string,
  namespace?: string,
  includeIstio = true
) {
  const ns = defaultNamespace(kc, namespace);

  const ingresses = await listIngresses(kc, ns);
  const ing = ingresses.find((i) => i?.metadata?.name === name);
  if (!ing) {
    gb.addWarning(`Ingress ${name} not found in namespace ${ns}`);
    return;
  }

  const ingNode = makeNode("Ingress", name, ns, roleForKind("Ingress"));

  const svcs = new Set<string>();
  const rules = ing?.spec?.rules ?? [];
  for (const r of rules) {
    const paths = r?.http?.paths ?? [];
    for (const p of paths) {
      const svc = p?.backend?.service?.name;
      if (svc) svcs.add(svc);
    }
  }
  const defSvc = ing?.spec?.defaultBackend?.service?.name;
  if (defSvc) svcs.add(defSvc);

  for (const svcName of Array.from(svcs)) {
    const svcNode = makeNode("Service", svcName, ns, roleForKind("Service"));
    gb.addEdge(ingNode, svcNode, "Ingress routes to Service backend");
    await discoverFromService(kc, gb, svcName, ns, includeIstio,undefined);
  }
}