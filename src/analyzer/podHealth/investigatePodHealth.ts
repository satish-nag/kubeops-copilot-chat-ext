import * as k8s from "@kubernetes/client-node";
import {
    InvestigatePodHealthArgs,
    PodHealthInvestigationResult,
    PodHealthSummary,
    PodEventItem,
    PodLogSnippet
} from "./types";
import {
    resolveNamespace,
    toLabelSelector,
    sumRestartCounts,
    podReady,
    pickTopReason,
    severityForReason,
    normalizeLogLines,
    safeString
} from "./k8sHelpers";

import {
    extractProbeSummaries,
    discoverServiceEndpointEvidence,
    discoverPVCs,
    discoverNodeConditions,
    discoverNetworkPoliciesSelectingPod,
    fetchDeploymentConditions,
    listPodsForDeployment
} from "./evidence";

export async function investigatePodHealth(
    kc: k8s.KubeConfig,
    args: InvestigatePodHealthArgs
): Promise<PodHealthInvestigationResult> {
    const ns = resolveNamespace(kc, args.namespace);
    const maxPods = typeof args.maxPods === "number" && args.maxPods > 0 ? Math.floor(args.maxPods) : 3;
    const tailLines = typeof args.tailLines === "number" && args.tailLines > 0 ? Math.floor(args.tailLines) : 120;
    const sinceSeconds = typeof args.sinceSeconds === "number" && args.sinceSeconds > 0 ? Math.floor(args.sinceSeconds) : 1800;

    const core = kc.makeApiClient(k8s.CoreV1Api);
    const apps = kc.makeApiClient(k8s.AppsV1Api);

    let pods: any[] = [];

    if (args.kind === "Pod") {
        const p = await core.readNamespacedPod(args.name, ns);
        console.log("Pod read result:", p);
        pods = [(p as any)?.body ?? p];
    } else {
        // Deployment -> pods
        const dep = await apps.readNamespacedDeployment(args.name, ns);
        const depBody = (dep as any)?.body ?? dep;
        const sel = toLabelSelector(depBody?.spec?.selector?.matchLabels);

        if (!sel) {
            // Fallback: cannot resolve pods reliably
            return {
                start: { kind: "Deployment", name: args.name, namespace: ns },
                inspectedPods: [],
                overall: {
                    status: "unknown",
                    summary: `Deployment ${args.name} has no spec.selector.matchLabels; cannot list managed pods reliably.`,
                    topFindings: ["Missing spec.selector.matchLabels"]
                }
            };
        }

        const list = await core.listNamespacedPod(ns, undefined, undefined, undefined, undefined, sel);
        const items = ((list as any)?.body?.items ?? (list as any)?.items ?? []) as any[];

        // If user asked for a specific pod under deployment, filter it
        if (args.podName) {
            pods = items.filter((p) => p?.metadata?.name === args.podName);
        } else {
            // pick “worst” pods first: not ready, then restarts, then phase != Running
            const scored = items.map((p) => {
                const ready = podReady(p) === true;
                const restarts = sumRestartCounts(p);
                const phase = String(p?.status?.phase ?? "");
                const badPhase = phase && phase !== "Running" ? 1 : 0;
                const notReady = ready ? 0 : 2;
                const score = notReady * 100 + badPhase * 10 + restarts;
                return { p, score };
            });

            scored.sort((a, b) => b.score - a.score);
            pods = scored.slice(0, maxPods).map((x) => x.p);
        }
    }
    const inspected: PodHealthSummary[] = [];
    for (const pod of pods) {
        inspected.push(await inspectOnePod(kc, core, pod, ns, { tailLines, sinceSeconds }));
    }

    const findings: string[] = [];
    const issues = inspected.filter((p) => (p.severity ?? "unknown") !== "low" && (p.severity ?? "unknown") !== "unknown");
    const high = inspected.filter((p) => p.severity === "high");

    for (const p of inspected) {
        const reason = p.topReason ?? "unknown";
        if (reason !== "unknown") findings.push(`${p.pod}: ${reason}`);
    }

    let overallStatus: PodHealthInvestigationResult["overall"]["status"] = "unknown";
    if (inspected.length === 0) overallStatus = "unknown";
    else if (high.length > 0 || issues.length > 0) overallStatus = "issues_found";
    else overallStatus = "ok";

    const summary =
        overallStatus === "ok"
            ? `Pods look healthy based on readiness, recent events, and recent logs.`
            : overallStatus === "issues_found"
                ? `Found signs of unhealthy pods (events/logs/status indicate issues).`
                : `Could not determine health (no pods inspected or insufficient data).`;

    return {
        start: { kind: args.kind, name: args.name, namespace: ns },
        inspectedPods: inspected,
        overall: {
            status: overallStatus,
            summary,
            topFindings: findings.slice(0, 8)
        },
        ...(args.kind === "Deployment"
            ? {
                  deploymentStatus: {
                      deployment: args.name,
                      namespace: ns,
                      conditions: await fetchDeploymentConditions(kc, ns, args.name)
                  }
              }
            : {}),
    };
}

async function inspectOnePod(
    kc: k8s.KubeConfig,
    core: k8s.CoreV1Api,
    pod: any,
    ns: string,
    opts: { tailLines: number; sinceSeconds: number }
): Promise<PodHealthSummary> {
    const name = String(pod?.metadata?.name ?? "unknown");
    const phase = safeString(pod?.status?.phase);
    const node = safeString(pod?.spec?.nodeName);

    const ready = podReady(pod);
    const restarts = sumRestartCounts(pod);
    const topReason = pickTopReason(pod);
    const severity = severityForReason(topReason);

    const conditions = (pod?.status?.conditions ?? []).map((c: any) => ({
        type: String(c?.type ?? ""),
        status: String(c?.status ?? ""),
        ...(c?.reason ? { reason: String(c.reason) } : {}),
        ...(c?.message ? { message: String(c.message) } : {})
    }));

    const containerStates = (pod?.status?.containerStatuses ?? []).map((s: any) => {
        const waiting = s?.state?.waiting;
        const term = s?.state?.terminated;
        const lastTerm = s?.lastState?.terminated;

        const state =
            waiting ? "waiting" :
                term ? "terminated" :
                    s?.state?.running ? "running" :
                        undefined;

        return {
            container: String(s?.name ?? ""),
            ready: s?.ready,
            restartCount: s?.restartCount,
            state,
            reason: waiting?.reason ?? term?.reason,
            message: waiting?.message ?? term?.message,
            lastState: lastTerm ? "terminated" : undefined,
            lastReason: lastTerm?.reason
        };
    });

    const events = await fetchPodEvents(core, ns, name);
    const logs = await fetchPodLogs(core, ns, name, pod, opts);
    const probes = extractProbeSummaries(pod);
    const services = await discoverServiceEndpointEvidence(kc, ns, pod).catch(() => []);
    const pvcs = await discoverPVCs(kc, ns, pod, { maxPVCs: 5 });
    const nodeConditions = await discoverNodeConditions(kc, node ?? undefined);
    const networkPolicies = await discoverNetworkPoliciesSelectingPod(kc, ns, pod, { maxPolicies: 6 });
    return {
        pod: name,
        namespace: ns,
        phase,
        ready,
        restarts,
        node,
        topReason,
        severity,
        conditions,
        containerStates,
        events,
        logs,
        probes,
        services,
        pvcs,
        nodeConditions,
        networkPolicies,
    };
}

export async function fetchPodEvents(core: k8s.CoreV1Api, ns: string, podName: string): Promise<PodEventItem[]> {
    try {
        // Use fieldSelector for involvedObject.name (works widely)
        const fieldSelector = `involvedObject.name=${podName}`;
        const res = await core.listNamespacedEvent(ns, undefined, undefined, undefined, fieldSelector);
        const items = ((res as any)?.body?.items ?? (res as any)?.items ?? []) as any[];

        // Sort newest first based on lastTimestamp/eventTime/firstTimestamp
        const withTs = items.map((e) => {
            const t =
                e?.eventTime ||
                e?.lastTimestamp ||
                e?.firstTimestamp ||
                e?.metadata?.creationTimestamp ||
                "";
            return { e, t: String(t) };
        });

        withTs.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));

        return withTs.slice(0, 20).map(({ e }) => ({
            time: e?.eventTime || e?.lastTimestamp || e?.firstTimestamp || e?.metadata?.creationTimestamp,
            type: e?.type,
            reason: e?.reason,
            message: e?.message,
            count: e?.count
        }));
    } catch (e) {
        return [
            {
                time: new Date().toISOString(),
                type: "Warning",
                reason: "EventFetchFailed",
                message: e instanceof Error ? e.message : String(e)
            }
        ];
    }
}

async function fetchPodLogs(
    core: k8s.CoreV1Api,
    ns: string,
    podName: string,
    pod: any,
    opts: { tailLines: number; sinceSeconds: number }
): Promise<PodLogSnippet[]> {
    const out: PodLogSnippet[] = [];

    const containerNames: string[] = [];
    for (const c of pod?.spec?.containers ?? []) {
        if (c?.name) containerNames.push(String(c.name));
    }

    for (const container of containerNames) {
        try {
            const res = await core.readNamespacedPodLog(
                podName,
                ns,
                container,
                false,            // follow
                undefined,        // insecureSkipTLSVerifyBackend
                undefined,        // limitBytes
                undefined,        // pretty
                undefined,        // previous
                opts.sinceSeconds,
                opts.tailLines,
                false             // timestamps
            );

            const text = (res as any)?.body ?? res;
            const s = typeof text === "string" ? text : String(text);
            const norm = normalizeLogLines(s, opts.tailLines * 2);

            out.push({
                container,
                lines: norm.lines,
                truncated: norm.truncated
            });
        } catch (e) {
            out.push({
                container,
                lines: [],
                truncated: false,
                error: e instanceof Error ? e.message : String(e)
            });
        }
    }

    return out;
}