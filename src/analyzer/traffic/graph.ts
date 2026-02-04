import { TrafficEdge, TrafficGraph, TrafficNode } from "./types";

export class GraphBuilder {
  private nodes = new Map<string, TrafficNode>();
  private edges: TrafficEdge[] = [];
  private warnings: string[] = [];

  constructor(private start: TrafficNode) {
    this.addNode(start);
  }

  addWarning(w: string) {
    this.warnings.push(w);
  }

  addNode(n: TrafficNode) {
    this.nodes.set(n.id, n);
  }

  addEdge(from: TrafficNode, to: TrafficNode, reason: string) {
    this.addNode(from);
    this.addNode(to);

    // de-dupe edges
    if (!this.edges.some((e) => e.from === from.id && e.to === to.id && e.reason === reason)) {
      this.edges.push({ from: from.id, to: to.id, reason });
    }
  }

  build(): TrafficGraph {
    return {
      start: this.start,
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
      ...(this.warnings.length ? { warnings: this.warnings } : {})
    };
  }
}