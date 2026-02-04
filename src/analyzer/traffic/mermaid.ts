import { TrafficGraph } from "./types";

function escapeLabel(s: string): string {
  return s.replace(/"/g, '\\"');
}

export function toMermaid(graph: TrafficGraph): string {
  // graph LR is easiest for “request path”
  const lines: string[] = [];
  lines.push("graph LR");

  // Node declarations
  for (const n of graph.nodes) {
    const label = `${n.kind}\\n${n.name}${n.namespace ? `\\nns:${n.namespace}` : ""}`;
    // Use a stable node key (avoid pipes)
    const key = keyFor(n.id);
    lines.push(`  ${key}["${escapeLabel(label)}"]`);
  }

  // Edge declarations
  for (const e of graph.edges) {
    const from = keyFor(e.from);
    const to = keyFor(e.to);
    const reason = escapeLabel(e.reason);
    lines.push(`  ${from} -->|\"${reason}\"| ${to}`);
  }

  return lines.join("\n");
}

function keyFor(id: string): string {
  // Mermaid node ids must be simple: replace non-word with underscore
  return "n_" + id.replace(/[^a-zA-Z0-9_]/g, "_");
}