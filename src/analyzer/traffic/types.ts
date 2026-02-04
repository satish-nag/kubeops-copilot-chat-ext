export type TrafficFlowArgs = {
  kind: string;
  name: string;
  namespace?: string;
  maxDepth?: number;       // default 3
  includeIstio?: boolean;  // default true
};

export type NodeRole = "entry" | "router" | "service" | "endpoint" | "workload" | "pod" | "unknown";

export type TrafficNodeId = string; // `${kind}|${ns}|${name}` (ns can be "")

export type TrafficNode = {
  id: TrafficNodeId;
  kind: string;
  name: string;
  namespace?: string;
  role: NodeRole;
};

export type TrafficEdge = {
  from: TrafficNodeId;
  to: TrafficNodeId;
  reason: string;
};

export type TrafficGraph = {
  start: TrafficNode;
  nodes: TrafficNode[];
  edges: TrafficEdge[];
  warnings?: string[];
};

export type TrafficFlowResult = TrafficGraph & {
  mermaid: string; // `graph LR ...`
};