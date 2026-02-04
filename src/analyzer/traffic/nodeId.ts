import { TrafficNode, TrafficNodeId, NodeRole } from "./types";

export function nodeId(kind: string, name: string, namespace?: string): TrafficNodeId {
  return `${kind}|${namespace ?? ""}|${name}`;
}

export function makeNode(kind: string, name: string, namespace?: string, role: NodeRole = "unknown"): TrafficNode {
  return { id: nodeId(kind, name, namespace), kind, name, namespace, role };
}

export function roleForKind(kind: string): NodeRole {
  switch (kind) {
    case "Ingress":
    case "Gateway":
      return "entry";
    case "VirtualService":
      return "router";
    case "Service":
      return "service";
    case "EndpointSlice":
    case "Endpoints":
      return "endpoint";
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
      return "workload";
    case "Pod":
      return "pod";
    case "DestinationRule":
      return "router";
    default:
      return "unknown";
  }
}