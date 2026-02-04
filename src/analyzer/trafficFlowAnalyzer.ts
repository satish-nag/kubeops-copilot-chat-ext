import * as k8s from "@kubernetes/client-node";
import { GraphBuilder } from "./traffic/graph";
import { toMermaid } from "./traffic/mermaid";
import { makeNode, roleForKind } from "./traffic/nodeId";
import { TrafficFlowArgs, TrafficFlowResult } from "./traffic/types";
import { defaultNamespace } from "./traffic/k8s";
import { discoverTraffic } from "./traffic/router";

async function ensureStartExists(
  kc: k8s.KubeConfig,
  kind: string,
  name: string,
  namespace: string,
  includeIstio: boolean
) {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const net = kc.makeApiClient(k8s.NetworkingV1Api);
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);

  try {
    if (kind === "Service") {
      await core.readNamespacedService(name, namespace);
      return;
    }
    if (kind === "Pod") {
      await core.readNamespacedPod(name, namespace);
      return;
    }
    if (kind === "Ingress") {
      await net.readNamespacedIngress(name, namespace);
      return;
    }
    if (kind === "VirtualService") {
      if (!includeIstio) throw new Error("includeIstio=false: VirtualService lookup disabled");
      await custom.getNamespacedCustomObject(
        "networking.istio.io",
        "v1beta1",
        namespace,
        "virtualservices",
        name
      );
      return;
    }
    if (kind === "Gateway") {
      if (!includeIstio) throw new Error("includeIstio=false: Gateway lookup disabled");
      await custom.getNamespacedCustomObject(
        "networking.istio.io",
        "v1beta1",
        namespace,
        "gateways",
        name
      );
      return;
    }

    // For other kinds in this skeleton, skip validation for now.
    return;
  } catch (e: any) {
    const status = e?.statusCode ?? e?.response?.statusCode;
    if (status === 404) {
      throw new Error(`${kind} ${name} not found in namespace ${namespace}`);
    }
    throw e;
  }
}

export async function analyzeTrafficFlow(
  kc: k8s.KubeConfig,
  rawArgs: TrafficFlowArgs
): Promise<TrafficFlowResult> {
  const kind = (rawArgs.kind || "").trim();
  const name = (rawArgs.name || "").trim();
  if (!kind || !name) {
    throw new Error("analyzeTrafficFlow requires kind and name");
  }

  const ns = defaultNamespace(kc, rawArgs.namespace);
  const start = makeNode(kind, name, ns, roleForKind(kind));
  const includeIstio = rawArgs.includeIstio !== false;

  await ensureStartExists(kc, kind, name, ns, includeIstio);

  const gb = new GraphBuilder(start);
  await discoverTraffic(kc, gb, { ...rawArgs, kind, name, namespace: ns, includeIstio });

  const graph = gb.build();
  const mermaid = toMermaid(graph);

  return { ...graph, mermaid };
}