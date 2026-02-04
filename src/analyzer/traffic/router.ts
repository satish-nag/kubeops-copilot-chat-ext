import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "./graph";
import { makeNode, roleForKind } from "./nodeId";
import { TrafficFlowArgs, TrafficNode } from "./types";
import { defaultNamespace } from "./k8s";

import { discoverFromService } from "./discover/serviceFlow";
import { discoverFromPod } from "./discover/podFlow";
import { discoverFromIngress } from "./discover/ingressFlow";
import { discoverFromVirtualService } from "./discover/virtualServiceFlow";

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