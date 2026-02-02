// src/analysis/impactAnalyzer.ts
import * as k8s from "@kubernetes/client-node";
import {
  analyzeConfigMapImpact,
  analyzePVCImpact,
  analyzePVImpact,
  analyzeSecretImpact,
  analyzeServiceImpact,
  analyzeIngressImpact,
  analyzeVirtualServiceImpact,
  analyzeGatewayImpact
} from "./impactRules";

export type ImpactSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

export type ImpactedResource = {
    kind: string;
    name: string;
    namespace?: string;
    impactType: string;
    severity: ImpactSeverity;
};

export type ImpactResult = {
    target: { kind: string; name: string; namespace?: string };
    severity: ImpactSeverity;
    summary: string;
    impactedResources: ImpactedResource[];
};

export async function analyzeImpact(
    kc: k8s.KubeConfig,
    target: { kind: string; name: string; namespace?: string }
): Promise<ImpactResult> {
    const kind = target.kind;
    if (kind === "ConfigMap") return analyzeConfigMapImpact(kc, target);
    if (kind === "Secret") return analyzeSecretImpact(kc, target);
    if (kind === "PersistentVolumeClaim") return analyzePVCImpact(kc, target);
    if (kind === "PersistentVolume") return analyzePVImpact(kc, target);
    if (kind === "Service") return analyzeServiceImpact(kc, target);
    if (kind === "Ingress") return analyzeIngressImpact(kc, target);
    if (kind === "VirtualService") return analyzeVirtualServiceImpact(kc, target);
    if (kind === "Gateway") return analyzeGatewayImpact(kc, target);

    return {
        target,
        severity: "NONE",
        summary: "No impact rules defined for this resource type.",
        impactedResources: []
    };
}