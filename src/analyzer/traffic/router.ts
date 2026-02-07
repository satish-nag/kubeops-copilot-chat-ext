import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "./graph";
import { makeNode, roleForKind } from "./nodeId";
import { TrafficFlowArgs, TrafficNode } from "./types";
import { defaultNamespace } from "./k8s";

import { discoverFromService } from "./discover/serviceFlow";
import { discoverFromPod } from "./discover/podFlow";
import { discoverFromIngress } from "./discover/ingressFlow";
import { discoverFromVirtualService } from "./discover/virtualServiceFlow";

// helper function to list pods for a deployment
async function listPodsForDeployment(
  kc: k8s.KubeConfig,
  name: string,
  namespace: string
): Promise<string[]> {
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  // Read deployment to get selector
  const dep = await apps.readNamespacedDeployment(name, namespace);
  const matchLabels = dep.body.spec?.selector?.matchLabels ?? {};
  const labelSelector = Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  if (!labelSelector) return [];

  const pods = await core.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector
  );

  return (pods.body.items ?? [])
    .map(p => p.metadata?.name)
    .filter((n): n is string => !!n);
}

/**
 * This is a skeleton router. We keep it simple:
 * - For each supported start kind, we run the appropriate discovery.
 * - maxDepth is provided for future extension (BFS multi-hop). Right now,
 *   serviceFlow already discovers a multi-hop chain (Ingress/VS->Svc->ES->Pod).
 */
export async function discoverTraffic(
  kc: k8s.KubeConfig,
  gb: GraphBuilder,
  args: TrafficFlowArgs
) {
  const kind = args.kind;
  const ns = defaultNamespace(kc, args.namespace);
  const includeIstio = args.includeIstio !== false;

  // start node
  const start: TrafficNode = makeNode(kind, args.name, ns, roleForKind(kind));
  gb.addNode(start);

  switch (kind) {
    case "Deployment": {
      // Resolve pods belonging to the deployment and reuse Pod discovery logic
      const podNames = await listPodsForDeployment(kc, args.name, ns);

      if (podNames.length === 0) {
        gb.addWarning(`No pods found for Deployment ${args.name} in namespace ${ns}`);
        break;
      }

      for (const podName of podNames) {
        const services = await discoverFromPod(kc, gb, podName, ns);

        // Same expansion logic as Pod case
        for (const svcName of services) {
          await discoverFromService(kc, gb, svcName, ns, includeIstio, podName);
        }
      }
      break;
    }
    case "Service":
      await discoverFromService(kc, gb, args.name, ns, includeIstio);
      break;
    case "Pod": {
      const services = await discoverFromPod(kc, gb, args.name, ns);

      // Expand: Service -> (Ingress/VirtualService/Gateway) upstream
      // and Service -> EndpointSlice -> Pod downstream
      for (const svcName of services) {
        // ✅ Expand upstream routing but keep downstream limited to the starting pod
        await discoverFromService(kc, gb, svcName, ns, includeIstio, args.name);
      }
      break;
    }
    case "Ingress":
      await discoverFromIngress(kc, gb, args.name, ns, includeIstio);
      break;
    case "VirtualService":
      if (!includeIstio) {
        gb.addWarning("includeIstio=false: VirtualService discovery disabled");
        break;
      }
      await discoverFromVirtualService(kc, gb, args.name, ns);
      break;
    default:
      gb.addWarning(`Traffic flow discovery for kind=${kind} is not implemented yet (skeleton). Try Service/Pod/Ingress/VirtualService.`);
      break;
  }
}