import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "../graph";
import { makeNode, roleForKind } from "../nodeId";
import { defaultNamespace, listVirtualServices } from "../k8s";
import { discoverFromService } from "./serviceFlow";

export async function discoverFromVirtualService(
  kc: k8s.KubeConfig,
  gb: GraphBuilder,
  name: string,
  namespace?: string
) {
  const ns = defaultNamespace(kc, namespace);
  const vss = await listVirtualServices(kc, ns);
  const vs = vss.find((v) => v?.metadata?.name === name);
  if (!vs) {
    gb.addWarning(`VirtualService ${name} not found in namespace ${ns}`);
    return;
  }

  const vsNode = makeNode("VirtualService", name, ns, roleForKind("VirtualService"));

  // Upstream gateways
  for (const gw of vs?.spec?.gateways ?? []) {
    if (typeof gw === "string" && gw !== "mesh") {
      gb.addEdge(makeNode("Gateway", gw, ns, roleForKind("Gateway")), vsNode, "Gateway referenced by VirtualService");
    }
  }

  // Downstream service destinations
  const http = vs?.spec?.http ?? [];
  const svcNames = new Set<string>();
  for (const h of http) {
    for (const r of h?.route ?? []) {
      const host = r?.destination?.host;
      if (typeof host === "string" && host.trim()) {
        // keep only the first label as service name
        svcNames.add(host.split(".")[0]);
      }
    }
  }

  for (const svcName of Array.from(svcNames)) {
    // const svcNode = makeNode("Service", svcName, ns, roleForKind("Service"));
    // gb.addEdge(vsNode, svcNode, "VirtualService routes to Service (destination.host)");
    await discoverFromService(kc, gb, svcName, ns, true,undefined);
  }
}