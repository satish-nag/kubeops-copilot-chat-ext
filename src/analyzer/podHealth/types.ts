export type InvestigatePodHealthArgs = {
  kind: "Pod" | "Deployment";
  name: string;
  namespace?: string;

  // If kind=Deployment and user wants a specific pod
  podName?: string;

  // Limits
  maxPods?: number;        // default 3
  tailLines?: number;      // default 120
  sinceSeconds?: number;   // default 1800 (30 min)
};

export type PodLogSnippet = {
  container: string;
  lines: string[];
  truncated: boolean;
  error?: string;
};

export type PodEventItem = {
  time?: string;
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
};

export type PodHealthSummary = {
  pod: string;
  namespace: string;
  phase?: string;
  ready?: boolean;
  restarts?: number;
  node?: string;

  topReason?: string;   // CrashLoopBackOff, ImagePullBackOff, etc.
  severity?: "high" | "medium" | "low" | "unknown";

  // key evidence
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
  containerStates?: Array<{
    container: string;
    ready?: boolean;
    restartCount?: number;
    state?: string;
    reason?: string;
    message?: string;
    lastState?: string;
    lastReason?: string;
  }>;

  events: PodEventItem[];
  logs: PodLogSnippet[];
   probes?: Array<{
    container: string;
    readiness?: string;
    liveness?: string;
    startup?: string;
  }>;

  services?: Array<{
    service: string;
    selectedByService: boolean;   // selector matches pod labels
    inEndpoints: boolean;         // pod appears in EndpointSlice targets
    notes?: string;
  }>;

  pvcs?: Array<{
    claim: string;
    phase?: string;
    storageClass?: string;
    volumeName?: string;
    reason?: string;
    message?: string;
  }>;

  nodeConditions?: Array<{
    type: string;
    status: string;
    reason?: string;
    message?: string;
  }>;

  networkPolicies?: Array<{
    name: string;
    policyTypes: string[];
    podSelector?: Record<string, string>;
  }>;
};

export type PodHealthInvestigationResult = {
  start: { kind: "Pod" | "Deployment"; name: string; namespace?: string };
  inspectedPods: PodHealthSummary[];
  overall: {
    status: "ok" | "issues_found" | "unknown";
    summary: string;
    topFindings: string[];
  };
    deploymentStatus?: {
    deployment: string;
    namespace: string;
    conditions: Array<{ type: string; status: string; reason?: string; message?: string }>;
  };
};
