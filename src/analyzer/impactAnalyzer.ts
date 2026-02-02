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
export type ImpactAction = "delete" | "update";

export type ImpactedResource = {
    kind: string;
    name: string;
    namespace?: string;
    impactType: string;
    severity: ImpactSeverity;
};

export type ImpactResult = {
  action: ImpactAction;
  changeSummary?: string;
  target: { kind: string; name: string; namespace?: string };
  severity: ImpactSeverity;
  summary: string;
  impactedResources: ImpactedResource[];
};

export async function analyzeImpact(
  kc: k8s.KubeConfig,
  input: { action?: ImpactAction; changeSummary?: string; kind: string; name: string; namespace?: string }
): Promise<ImpactResult> {
  const action: ImpactAction = input.action ?? "delete";
  const target = { kind: input.kind, name: input.name, namespace: input.namespace };

  const kind = target.kind;

  if (kind === "ConfigMap") return analyzeConfigMapImpact(kc, { action, changeSummary: input.changeSummary, target });
  if (kind === "Secret") return analyzeSecretImpact(kc, { action, changeSummary: input.changeSummary, target });
  if (kind === "PersistentVolumeClaim") return analyzePVCImpact(kc, { action, changeSummary: input.changeSummary, target });
  if (kind === "PersistentVolume") return analyzePVImpact(kc, { action, changeSummary: input.changeSummary, target });

  if (kind === "Service") return analyzeServiceImpact(kc, { action, changeSummary: input.changeSummary, target });
  if (kind === "Ingress") return analyzeIngressImpact(kc, { action, changeSummary: input.changeSummary, target });
  if (kind === "VirtualService") return analyzeVirtualServiceImpact(kc, { action, changeSummary: input.changeSummary, target });
  if (kind === "Gateway") return analyzeGatewayImpact(kc, { action, changeSummary: input.changeSummary, target });

  return {
    action,
    changeSummary: input.changeSummary,
    target,
    severity: "NONE",
    summary: "No impact rules defined for this resource type.",
    impactedResources: []
  };
}