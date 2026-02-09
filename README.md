# KubeOps Copilot Chat Participant (`@kubeops`)

This repository contains a VS Code extension that registers a GitHub Copilot Chat participant named `@kubeops`.

## Quick start

1. Install dependencies:
   - `npm install`
2. Open this folder in VS Code.
3. Press `F5` to launch an Extension Development Host.
4. Open **Copilot Chat** and type `@kubeops`.

## Status

The extension implements an agentic, tool-calling flow that can:
- Read a single Kubernetes/Istio object (`getResource`, includes referenced resources and recent Events)
- Search/list resources by kind with filters (`searchResources`)
- Create a single object (`createResource`)
- Patch/update a single object via server-side apply (`patchResource`)
- Analyze impact for delete/update operations (`analyzeImpact`)
- Discover traffic paths and render Mermaid graphs (`analyzeTrafficFlow`)
- Investigate unhealthy Pods/Deployments with evidence (`investigatePodHealth`)

Write operations support common Kubernetes resources (Pod, Deployment, StatefulSet, DaemonSet, Job, CronJob, Service, Ingress, NetworkPolicy, ConfigMap, Secret) and Istio objects supported by `getResource` (VirtualService, DestinationRule, Gateway, PeerAuthentication, AuthorizationPolicy, ServiceEntry).

### Write approvals

Create and patch operations are gated by an explicit approval step. The extension previews:
- previous (sanitized) state
- proposed (sanitized) state
- detected changes

Then it asks the user to `confirm <id>` or `cancel <id>` before applying.

### How writes work

For `createResource` / `patchResource`, the model is encouraged to send `values` (not a full YAML manifest). The extension builds the manifest by combining:
- `apiVersion`, `kind`, `metadata.name`, `metadata.namespace` (from tool args / defaults)
- any additional fields in `values` (usually `spec`, or `data`/`stringData`/`type` for ConfigMap/Secret)

You can still provide `manifestYaml` as a fallback for complex objects, but it must contain exactly one YAML document.

### Search/list resources

The `searchResources` tool is used for “list/find” queries when you only need identities (not full manifests). It supports:

- `labelSelector` and `fieldSelector` (server-side filtering)
- `nameContains` (client-side substring filter)
- `namespace` and `limit` (default 25, max 100)

Important: at least one filter must be provided (`nameContains`, `labelSelector`, or `fieldSelector`), otherwise the tool rejects the call.

### Impact analysis

The `analyzeImpact` tool inspects reverse dependencies to estimate what would be affected by a delete or update request. It reports:
- action (`delete` or `update`)
- optional change summary
- overall severity
- a summary
- a table of impacted resources (kind/name/namespace/refType/severity)

Supported impact targets include: ConfigMap, Secret, PersistentVolumeClaim, PersistentVolume, Service, Ingress, VirtualService, Gateway.

### Traffic flow analysis

The `analyzeTrafficFlow` tool discovers upstream/downstream relationships and returns:
- graph nodes + edges with reasons
- optional warnings for unsupported/partial discovery
- Mermaid output for visualization in chat

Current supported start kinds: `Service`, `Pod`, `Ingress`, `VirtualService`.

Tool args:
- `namespace` (optional; defaults to current kube context namespace or `default`)
- `includeIstio` (optional; default true)
- `maxDepth` (optional; currently not used for a general BFS expansion)
- `fromKind` / `fromName` / `fromNamespace` (accepted by the tool schema for “source → target” questions, but not yet used to constrain discovery)

It also attempts to attach network-policy evidence to destination pods (best-effort) when discovering flows from Services.

### Pod health investigation

The `investigatePodHealth` tool helps debug why a Pod (or pods under a Deployment) are unhealthy by collecting structured evidence:
- pod phase/conditions, container states, restart counts
- recent Events
- recent container logs (tail)
- probe summaries
- service/endpoint evidence (selector + EndpointSlice membership)
- PVC and node condition hints
- NetworkPolicies selecting the pod (best-effort)

### Analyzer package layout

- `src/analyzer/impactAnalyzer.ts`: impact entrypoint and kind dispatch
- `src/analyzer/impactRules.ts`: severity/summaries per resource type
- `src/analyzer/reverseLookup.ts`: reverse dependency lookups
- `src/analyzer/trafficFlowAnalyzer.ts`: traffic flow entrypoint
- `src/analyzer/traffic/*`: traffic graph/discovery/rendering helpers
- `src/analyzer/podHealth/*`: pod health investigation helpers and evidence collectors
