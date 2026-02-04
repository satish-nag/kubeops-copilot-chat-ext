import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "../graph";
import { makeNode, roleForKind } from "../nodeId";
import { defaultNamespace, listServices, podLabelsMatchSelector } from "../k8s";

export async function discoverFromPod(
  kc: k8s.KubeConfig,
  gb: GraphBuilder,
  name: string,
  namespace?: string
): Promise<string[]> {
  const ns = defaultNamespace(kc, namespace);
  const podNode = makeNode("Pod", name, ns, roleForKind("Pod"));

  const core = kc.makeApiClient(k8s.CoreV1Api);
  const pod = (await core.readNamespacedPod(name, ns)).body;
  const labels = pod?.metadata?.labels ?? {};

  // Workload owner (best-effort)
  const owners = pod?.metadata?.ownerReferences ?? [];
  for (const o of owners) {
    if (o?.kind && o?.name) {
      const ownerNode = makeNode(o.kind, o.name, ns, roleForKind(o.kind));
      gb.addEdge(ownerNode, podNode, "Workload owns Pod (ownerReferences)");
    }
  }

  const matchedServices: string[] = [];

  // Upstream Services that select this pod
  const services = await listServices(kc, ns);
  for (const svc of services) {
    const svcName = svc?.metadata?.name;
    if (!svcName) continue;

    const selector = svc?.spec?.selector;
    if (podLabelsMatchSelector(labels, selector)) {
      const svcNode = makeNode("Service", svcName, ns, roleForKind("Service"));
      gb.addEdge(svcNode, podNode, "Service selector matches Pod labels");
      matchedServices.push(svcName);
    }
  }

  return matchedServices;
}