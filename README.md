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
- Read a single Kubernetes/Istio object (`getResource`)
- Create a single object (`createResource`)
- Patch/update a single object via server-side apply (`patchResource`)
- Analyze delete impact and dependencies (`analyzeImpact`)

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

### Impact analysis

The `analyzeImpact` tool inspects reverse dependencies to estimate what would be affected if a resource were deleted. It reports:
- overall severity
- a summary
- a table of impacted resources (kind/name/namespace/refType/severity)

Supported impact targets include: ConfigMap, Secret, PersistentVolumeClaim, PersistentVolume, Service, Ingress, VirtualService, Gateway.
