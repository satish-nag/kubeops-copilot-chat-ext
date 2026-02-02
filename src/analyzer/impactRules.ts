// src/analysis/impactRules.ts
import * as k8s from "@kubernetes/client-node";
import { ImpactResult } from "./impactAnalyzer";
import { ImpactSeverity } from "./impactAnalyzer";
import {
    findWorkloadsReferencing,
    findIngressesReferencingService,
    findVirtualServicesReferencingService,
    findVirtualServicesReferencingGateway,
    findServicesReferencedByIngress,
    findServicesReferencedByVirtualService,
    findGatewaysReferencedByVirtualService,
    findWorkloadsBackedByService
} from "./reverseLookup";
import { ImpactAction } from "./impactAnalyzer";

type ImpactContext = {
    action: ImpactAction;
    changeSummary?: string;
    target: { kind: string; name: string; namespace?: string };
};

export async function analyzeConfigMapImpact(kc: k8s.KubeConfig, ctx: ImpactContext) {
    const { action, changeSummary, target } = ctx;
    const consumers = await findWorkloadsReferencing(kc, {
        kind: "ConfigMap",
        name: target.name,
        namespace: target.namespace ?? 'default'
    });

    return {
        action,
        changeSummary,
        target,
        severity: consumers.length ? "MEDIUM" : "NONE" as ImpactSeverity,
        summary: consumers.length
            ? "Deleting this ConfigMap will restart dependent pods. Applications may fail to start if configuration is required."
            : "No workloads reference this ConfigMap.",
        impactedResources: consumers.map((c) => ({
            kind: c.kind,
            name: c.name,
            namespace: c.namespace,
            impactType: c.refType,
            severity: "MEDIUM" as ImpactSeverity
        }))
    };
}

export async function analyzeSecretImpact(kc: k8s.KubeConfig, ctx: ImpactContext) {
    const { action, changeSummary, target } = ctx;

    const consumers = await findWorkloadsReferencing(kc, {
        kind: "Secret",
        name: target.name,
        namespace: target.namespace ?? 'default'
    });

    return {
        action,
        changeSummary,
        target,
        severity: consumers.length ? "HIGH" : "NONE" as ImpactSeverity,
        summary: consumers.length
            ? "Deleting this Secret will cause authentication or startup failures in dependent workloads."
            : "No workloads reference this Secret.",
        impactedResources: consumers.map((c) => ({
            kind: c.kind,
            name: c.name,
            namespace: c.namespace,
            impactType: c.refType,
            severity: "HIGH" as ImpactSeverity
        }))
    };
}

export async function analyzePVCImpact(kc: k8s.KubeConfig, ctx: ImpactContext): Promise<ImpactResult> {
    const { action, changeSummary, target } = ctx;
    return {
        action,
        changeSummary,
        target,
        severity: "HIGH" as ImpactSeverity,
        summary: "Pods using this PVC will fail to start or lose storage access.",
        impactedResources: [
            {
                kind: "Pod",
                name: "*",
                namespace: target.namespace ?? 'default',
                impactType: "StorageUnavailable",
                severity: "HIGH" as ImpactSeverity
            }
        ]
    };
}

export async function analyzePVImpact(kc: k8s.KubeConfig, ctx: ImpactContext): Promise<ImpactResult> {
    const { action, changeSummary, target } = ctx;

    return {
        action,
        changeSummary,
        target,
        severity: "HIGH" as ImpactSeverity,
        summary: "Deleting this PV breaks the bound PVC and all consuming pods.",
        impactedResources: [
            {
                kind: "PersistentVolumeClaim",
                name: "*",
                impactType: "VolumeDetached",
                severity: "HIGH" as ImpactSeverity
            }
        ]
    };
}

export async function analyzeServiceImpact(kc: k8s.KubeConfig, ctx: ImpactContext) {
    const { action, changeSummary, target } = ctx;
    const ns = target.namespace!;
    const name = target.name;

    // Who depends on this Service?
    const ing = await findIngressesReferencingService(kc, { name, namespace: ns });
    const vs = await findVirtualServicesReferencingService(kc, { name, namespace: ns });
    const backedWorkloads = await findWorkloadsBackedByService(kc, { name, namespace: ns });

    const workloadImpacts = backedWorkloads.map((w) => ({
        kind: w.kind,
        name: w.name,
        namespace: w.namespace,
        impactType: w.refType,
        severity: "HIGH" as ImpactSeverity
    }));

    const impacted = [
        ...ing.map((x) => ({
            kind: x.kind,
            name: x.name,
            namespace: x.namespace,
            impactType: x.refType,
            severity: "CRITICAL" as ImpactSeverity
        })),
        ...vs.map((x) => ({
            kind: x.kind,
            name: x.name,
            namespace: x.namespace,
            impactType: x.refType,
            severity: "CRITICAL" as ImpactSeverity
        })),
        ...workloadImpacts
    ];

    const severity: ImpactSeverity =
        (ing.length + vs.length) > 0
            ? ("CRITICAL" as ImpactSeverity)
            : backedWorkloads.length > 0
                ? ("HIGH" as ImpactSeverity)
                : ("LOW" as ImpactSeverity);

    return {
        action,
        changeSummary,
        target,
        severity,
        summary:
            action === "delete"
                ? (impacted.length
                    ? "Deleting this Service will break routing rules (Ingress/VirtualService) and stop traffic from reaching workloads behind the Service selector."
                    : "Deleting this Service removes the stable service endpoint; no Ingress/VirtualService routes found and no selector-backed workloads detected.")
                : (changeSummary
                    ? `Updating this Service (${changeSummary}) may change which pods receive traffic (selector/ports). Routing rules remain, but traffic distribution could change.`
                    : "Updating this Service may change which pods receive traffic (selector/ports). Routing rules remain, but traffic distribution could change."),
        impactedResources: impacted
    };
}

export async function analyzeIngressImpact(kc: k8s.KubeConfig, ctx: ImpactContext) {
    const { action, changeSummary, target } = ctx;
    const ns = target.namespace!;
    const name = target.name;

    // What backend services does this ingress route to?
    const svcs = await findServicesReferencedByIngress(kc, { name, namespace: ns });

    const impacted = svcs.map((s) => ({
        kind: s.kind,
        name: s.name,
        namespace: s.namespace,
        impactType: s.refType,
        severity: "HIGH" as ImpactSeverity
    }));

    const severity: ImpactSeverity = ("HIGH" as ImpactSeverity);

    return {
        action,
        changeSummary,
        target,
        severity,
        summary:
            action === "delete"
                ? "Deleting this Ingress will remove external HTTP(S) routing to its backend services."
                : (changeSummary
                    ? `Updating this Ingress (${changeSummary}) will change external routing behavior to backend services.`
                    : "Updating this Ingress will change external routing behavior to backend services."),
        impactedResources: impacted
    };
}

export async function analyzeVirtualServiceImpact(kc: k8s.KubeConfig, ctx: ImpactContext) {
    const { action, changeSummary, target } = ctx;
    const ns = target.namespace!;
    const name = target.name;

    const svcs = await findServicesReferencedByVirtualService(kc, { name, namespace: ns });
    const gws = await findGatewaysReferencedByVirtualService(kc, { name, namespace: ns });

    const impacted = [
        ...gws.map((g) => ({
            kind: g.kind,
            name: g.name,
            namespace: g.namespace,
            impactType: g.refType,
            severity: "CRITICAL" as ImpactSeverity
        })),
        ...svcs.map((s) => ({
            kind: s.kind,
            name: s.name,
            namespace: s.namespace,
            impactType: s.refType,
            severity: "CRITICAL" as ImpactSeverity
        }))
    ];

    const severity: ImpactSeverity = ("CRITICAL" as ImpactSeverity);

    return {
        action,
        changeSummary,
        target,
        severity,
        summary:
            action === "delete"
                ? "Deleting this VirtualService will remove routing rules, and traffic may stop reaching destination services via the referenced gateways."
                : (changeSummary
                    ? `Updating this VirtualService (${changeSummary}) changes traffic routing behavior (e.g., weights/matches). No resources are deleted; only routing distribution changes.`
                    : "Updating this VirtualService changes traffic routing behavior (e.g., weights/matches). No resources are deleted; only routing distribution changes."),
        impactedResources: impacted
    };
}

export async function analyzeGatewayImpact(kc: k8s.KubeConfig, ctx: ImpactContext) {
    const { action, changeSummary, target } = ctx;
    const ns = target.namespace!;
    const name = target.name;

    // Which VirtualServices bind to this gateway?
    const vss = await findVirtualServicesReferencingGateway(kc, { name, namespace: ns });

    const impacted = vss.map((v) => ({
        kind: v.kind,
        name: v.name,
        namespace: v.namespace,
        impactType: v.refType,
        severity: "CRITICAL" as ImpactSeverity
    }));

    const severity: ImpactSeverity = impacted.length ? ("CRITICAL" as ImpactSeverity) : ("HIGH" as ImpactSeverity);

    return {
        action,
        changeSummary,
        target,
        severity,
        summary:
            action === "delete"
                ? (impacted.length
                    ? "Deleting this Gateway will break ingress traffic handled by VirtualServices that reference it."
                    : "Deleting this Gateway will remove an ingress listener; no VirtualServices in the same namespace explicitly reference it.")
                : (changeSummary
                    ? `Updating this Gateway (${changeSummary}) may alter listeners/hosts/tls settings and change which traffic is accepted.`
                    : "Updating this Gateway may alter listeners/hosts/tls settings and change which traffic is accepted."),
        impactedResources: impacted
    };
}