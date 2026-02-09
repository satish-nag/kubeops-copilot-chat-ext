import * as vscode from "vscode";
import * as k8s from "@kubernetes/client-node";
import { analyzeImpact } from "./analyzer/impactAnalyzer";
import { analyzeTrafficFlow } from "./analyzer/trafficFlowAnalyzer";
import { investigatePodHealth, fetchPodEvents } from "./analyzer/podHealth/investigatePodHealth";


// IMPORTANT: must match contributes.chatParticipants[id] in package.json
const PARTICIPANT_ID = "kubecopilot.kubeops";

// Tool args for getResource
type GetResourceArgs = {
  kind: string;
  name: string;
  namespace?: string;
  /**
   * When true, include raw values for resources that may contain sensitive data.
   * Default false (secrets are redacted).
   */
  includeSensitiveData?: boolean;
};

// Tool args for searchResources
type SearchResourcesArgs = {
  kind: string;
  namespace?: string;
  /**
   * Client-side filter: include only resources whose metadata.name contains this substring.
   */
  nameContains?: string;
  /**
   * Kubernetes label selector (server-side), e.g. "app=nginx,version=v1".
   */
  labelSelector?: string;
  /**
   * Kubernetes field selector (server-side), e.g. "metadata.name=nginx".
   * Note: field selectors are limited and kind-dependent.
   */
  fieldSelector?: string;
  /**
   * Max number of results to return (default 25, max 100).
   */
  limit?: number;
};

// High-level values to merge into the manifest for create/patch
type ResourceValues = {
  metadata?: {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  /**
   * Additional top-level fields to merge into the manifest.
   * Common examples: spec, data, stringData, type.
   *
   * Note: apiVersion/kind/metadata.name/metadata.namespace are controlled by tool args and ignored if provided here.
   */
  [key: string]: unknown;
};

// Shared args for createResource and patchResource
type CreateOrPatchResourceArgs = {
  kind: string;
  name: string;
  namespace?: string;
  /**
   * Optional override. If omitted, resolved from kind (including Istio kinds).
   */
  apiVersion?: string;
  /**
   * Prefer using values so the extension can construct the manifest.
   * If provided, must be a single-object YAML manifest for ONE resource.
   */
  manifestYaml?: string;
  /**
   * High-level values to merge into the manifest.
   */
  values?: ResourceValues;
  /**
   * If true, send dryRun=All.
   */
  dryRun?: boolean;
};

// Additional args for patchResource
type PatchResourceArgs = CreateOrPatchResourceArgs & {
  /**
   * Server-side apply field manager. Defaults to "kubeops".
   */
  fieldManager?: string;
  /**
   * Server-side apply force conflicts. Defaults to false.
   */
  force?: boolean;
  /**
   * If true (default), require that the object already exists (update/patch).
   * If false, allow server-side apply to create if missing (upsert).
   */
  requireExists?: boolean;
};

// Tool execution results for the getResource
type ManifestToolResult = {
  identity: {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
  };
  sanitizedManifest: unknown;
  referencedResources: Array<{
    kind: string;
    name: string;
    namespace?: string;
    note: string;
  }>;
};

// Tool execution results for searchResources
type SearchToolResult = {
  kind: string;
  namespace?: string;
  query: {
    nameContains?: string;
    labelSelector?: string;
    fieldSelector?: string;
    limit: number;
  };
  results: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
  }>;
  returned: number;
  truncated: boolean;
};

// Tool execution results for createResource/patchResource
type WriteToolResult = {
  identity: ManifestToolResult["identity"];
  action: "created" | "patched";
  sanitizedManifest: unknown;
};

// KubeSession encapsulates the connected kubeconfig and tool functions
type KubeSession = {
  kubeConfig: k8s.KubeConfig;
  getResource: (args: GetResourceArgs) => Promise<ManifestToolResult>;
  createResource: (args: CreateOrPatchResourceArgs) => Promise<WriteToolResult>;
  patchResource: (args: PatchResourceArgs) => Promise<WriteToolResult>;
  searchResources: (args: SearchResourcesArgs) => Promise<SearchToolResult>;
};

// Tool call types used in planning
type ToolCall =
  | { tool: "getResource"; args: GetResourceArgs }
  | { tool: "createResource"; args: CreateOrPatchResourceArgs }
  | { tool: "patchResource"; args: PatchResourceArgs }
  | { tool: "analyzeTrafficFlow"; args: { kind: string; name: string; namespace?: string; maxDepth?: number; includeIstio?: boolean } }
  | { tool: "investigatePodHealth"; args: { kind: "Pod" | "Deployment"; name: string; namespace?: string; podName?: string; maxPods?: number; tailLines?: number; sinceSeconds?: number } }
  | { tool: "searchResources"; args: SearchResourcesArgs };

// JSON tool plan structure returned by the planner ( LLM )
type JsonToolPlan = {
  summary?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
};

// Single tool call execution result used across planning iterations
type ToolExecutionResult = { tool: string; args: unknown; result: unknown };

type WriteToolName = "createResource" | "patchResource";

type WritePreview = {
  tool: WriteToolName;
  target: { kind: string; name: string; namespace?: string };
  previous: unknown;
  proposed: unknown;
  valuesApplied: unknown;
  changes: Array<{ path: string; before: unknown; after: unknown }>;
  notes?: string[];
};

type PendingWriteBundle = {
  id: string;
  createdAt: string;
  ops: Array<
    | { tool: "createResource"; args: CreateOrPatchResourceArgs; preview: WritePreview }
    | { tool: "patchResource"; args: PatchResourceArgs; preview: WritePreview }
  >;
};

// Simple in-memory approval store (single extension host instance).
const pendingWriteApprovals = new Map<string, PendingWriteBundle>();

// CoPilot Chat Extension activation
export function activate(context: vscode.ExtensionContext) {
  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream) => {
    await chatRequestHandler(request, chatContext, stream);
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "kubeops.svg");
  context.subscriptions.push(participant);
}

// CoPilot Chat Extension deactivation
export function deactivate() { }

// CoPilot Chat Extension request handler
async function chatRequestHandler(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream
) {
  stream.markdown(["### KubeOps", ""].join("\n"));

  // Ensure language model is available
  const model = request.model;
  if (!model) {
    stream.markdown("❌ No language model is available in this chat context.");
    return;
  }

  // Process user input, if none provided, display help
  const userText = (request.prompt ?? "").trim();
  if (!userText) {
    stream.markdown([
      "### Try asking things like:",
      "",
      "- Get deployment **<deployment-name>** in **<namespace>**",
      "- Search for pods managed by **<deployment-name>** in **<namespace>**",
      "- Create a deployment with name **nginx-test**, image **nginx**, replicas **3**, namespace **<namespace>**",
      "- Update configmap **<configmap-name>** with `key1: value1` in **<namespace>**",
      "- Analyze the impact of updating configmap **<configmap-name>** in **<namespace>**",
      "- Analyze the traffic flow for service **<service-name>** in **<namespace>**",
      "- Why pod **<pod-name>** is unhealthy in **<namespace>**",
      ""
    ].join("\n"));
    return;
  }

  // Establish Kubernetes connection
  const session = await kubeConnect(chatContext, stream);

  // No session, stop processing
  if (!session) return;


  // If the user is responding to a pending approval, handle it before invoking the planner.
  const approvalCmd = parseApprovalCommand(userText);
  if (approvalCmd) {
    const bundle = approvalCmd.id ? pendingWriteApprovals.get(approvalCmd.id) : latestPendingWriteBundle();

    if (!bundle) {
      stream.markdown("No pending approvals. Ask me to create or patch a resource first.");
      return;
    }

    if (approvalCmd.action === "cancel") {
      pendingWriteApprovals.delete(bundle.id);
      stream.markdown(`Canceled pending approval \`${bundle.id}\`.`);
      return;
    }

    // confirm
    pendingWriteApprovals.delete(bundle.id);
    stream.markdown(`Applying pending approval \`${bundle.id}\`...`);

    const results: ToolExecutionResult[] = [];
    for (const op of bundle.ops) {
      if (op.tool === "createResource") {
        try {
          const res = await session.createResource(op.args);
          results.push({ tool: "createResource", args: op.args, result: res });
        } catch (e) {
          results.push({
            tool: "createResource",
            args: op.args,
            result: { error: asErrorMessage(e), ...kubeHttpErrorDetails(e) }
          });
        }
      } else if (op.tool === "patchResource") {
        try {
          const res = await session.patchResource(op.args);
          results.push({ tool: "patchResource", args: op.args, result: res });
        } catch (e) {
          results.push({
            tool: "patchResource",
            args: op.args,
            result: { error: asErrorMessage(e), ...kubeHttpErrorDetails(e) }
          });
        }
      }
    }

    const reportRequest = `Apply approved patch bundle ${bundle.id}`;
    const finalPrompt = buildFinalPrompt(reportRequest, { tools: [] as any }, results);
    const finalText = await sendText(model, finalPrompt);
    stream.markdown(finalText);
    return;
  }

  // Define tool catalog (available tools and their input schemas) for the planner
  // currently we support getResource, createResource, patchResource
  const toolCatalog = {
    tools: [
      {
        name: "getResource",
        description:
          "Fetch ONE Kubernetes/Istio object manifest from the connected cluster. Returns a sanitized manifest (no annotations/extra metadata) and a list of referenced resources found inside the manifest.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            namespace: { type: "string" },
            includeSensitiveData: { type: "boolean" }
          },
          required: ["kind", "name"]
        }
      },
      {
        name: "createResource",
        description:
          "Create ONE Kubernetes/Istio object in the connected cluster. Prefer passing `values` (not a full manifest); the extension will construct the manifest and create it. Errors if it already exists.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            namespace: { type: "string" },
            apiVersion: { type: "string" },
            manifestYaml: { type: "string" },
            values: { type: "object" },
            dryRun: { type: "boolean" }
          },
          required: ["kind", "name"]
        }
      },
      {
        name: "patchResource",
        description:
          "Patch/update ONE Kubernetes/Istio object in the connected cluster using server-side apply. Prefer passing `values`; the extension constructs the manifest and applies it. By default requires the object to exist.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            namespace: { type: "string" },
            apiVersion: { type: "string" },
            manifestYaml: { type: "string" },
            values: { type: "object" },
            dryRun: { type: "boolean" },
            fieldManager: { type: "string" },
            force: { type: "boolean" },
            requireExists: { type: "boolean" }
          },
          required: ["kind", "name"]
        }
      },
      {
        name: "analyzeImpact",
        description:
          "Analyze the impact of deleting a Kubernetes resource by discovering reverse dependencies and classifying severity.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["delete", "update"] },
            kind: { type: "string" },
            name: { type: "string" },
            namespace: { type: "string" },
            changeSummary: { type: "string" }
          },
          required: ["action", "kind", "name"]
        }
      },
      {
        name: "analyzeTrafficFlow",
        description:
          "Discover upstream and downstream traffic-related Kubernetes/Istio objects for a given starting object and return a directed graph plus Mermaid output.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            name: { type: "string" },
            namespace: { type: "string" },
            maxDepth: { type: "number" },
            includeIstio: { type: "boolean" },
            fromKind: { type: "string" },
            fromName: { type: "string" },
            fromNamespace: { type: "string" }
          },
          required: ["kind", "name"]
        }
      },
      {
        name: "investigatePodHealth",
        description:
          "Investigate unhealthy pods by collecting recent Pod events and recent container logs. Supports starting from a Pod, or a Deployment (will inspect its pods). Returns a structured diagnosis summary and evidence.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["Pod", "Deployment"] },
            name: { type: "string" },
            namespace: { type: "string" },
            podName: { type: "string", description: "Optional: if kind=Deployment and a specific pod should be investigated." },
            maxPods: { type: "number", description: "Max pods to inspect when kind=Deployment (default 3)." },
            tailLines: { type: "number", description: "How many log lines to fetch per container (default 120)." },
            sinceSeconds: { type: "number", description: "Only return logs newer than this many seconds (default 1800)." }
          },
          required: ["kind", "name"]
        }
      },
      {
        name: "searchResources",
        description:
          "Search/list Kubernetes/Istio resources by kind with optional name substring filtering (client-side) and optional labelSelector/fieldSelector (server-side). Returns identities only (no full manifests).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string" },
            namespace: { type: "string" },
            nameContains: { type: "string" },
            labelSelector: { type: "string" },
            fieldSelector: { type: "string" },
            limit: { type: "number" }
          },
          required: ["kind"]
        }
      }
    ]
  };

  const toolResults: ToolExecutionResult[] = [];
  let iteration = 0;
  let plan: JsonToolPlan | undefined;
  const MAX_ITERATIONS = 5;

  while (iteration < MAX_ITERATIONS) {
    const planningPrompt = buildPlanningPrompt(userText, toolCatalog, toolResults, iteration);
    try {
      plan = await sendJsonOnly(model, planningPrompt);
    } catch (e) {
      stream.markdown(
        ["❌ Failed to parse planner output as JSON.", "", `Error: ${asErrorMessage(e)}`].join("\n")
      );
      return;
    }

    console.log("KubeOps tool plan:", { iteration, plan });
    if (plan.summary) stream.progress(`**Plan ${iteration + 1}:** ${plan.summary}`);

    // Require user approval before executing any write operations (create/patch).
    const writeCalls = (plan.toolCalls ?? []).filter(
      (c: any) => c?.tool === "createResource" || c?.tool === "patchResource"
    );
    if (writeCalls.length > 0) {
      const ops: PendingWriteBundle["ops"] = [];

      for (const c of writeCalls) {
        if ((c as any)?.tool === "createResource") {
          const validated = validateCreateOrPatchArgs((c as any)?.args);
          if (!validated.ok) {
            stream.markdown(`❌ Cannot preview create: ${validated.error}`);
            return;
          }
          const preview = await previewCreate(session.kubeConfig, validated.value);
          ops.push({ tool: "createResource", args: validated.value, preview });
        } else if ((c as any)?.tool === "patchResource") {
          const validated = validatePatchArgs((c as any)?.args);
          if (!validated.ok) {
            stream.markdown(`❌ Cannot preview patch: ${validated.error}`);
            return;
          }
          const preview = await previewPatch(session.kubeConfig, validated.value);
          ops.push({ tool: "patchResource", args: validated.value, preview });
        }
      }

      const bundle: PendingWriteBundle = { id: makeApprovalId(), createdAt: new Date().toISOString(), ops };
      pendingWriteApprovals.set(bundle.id, bundle);

      stream.markdown(renderWriteApprovalMarkdown(bundle));
      stream.markdown(`Type \`confirm ${bundle.id}\` to apply, or \`cancel ${bundle.id}\` to abort.`);
      return;
    }

    const executed = await executeToolCalls(session, plan.toolCalls ?? []);
    toolResults.push(...executed);
    console.log("KubeOps tool results:", { iteration, executed });

    const hasErrors = executed.some((r) => (r.result as any)?.error);

    // Stop only when planner says done AND no errors, or no further tool calls are requested.
    if ((plan.done && !hasErrors) || (plan.toolCalls ?? []).length === 0) break;

    // Allow planner to react to errors in next iteration.
    iteration++;
  }

  const finalPrompt = buildFinalPrompt(userText, toolCatalog, toolResults);
  const finalText = await sendText(model, finalPrompt);
  stream.markdown(finalText);
}

async function executeToolCalls(
  session: KubeSession,
  toolCalls: ToolCall[] = []
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];

  for (const call of toolCalls) {
    const tool = (call as any)?.tool;
    const args = (call as any)?.args;

    if (tool === "getResource") {
      const validated = validateGetResourceArgs(args);
      if (!validated.ok) {
        results.push({ tool, args, result: { error: validated.error } });
        continue;
      }
      try {
        const res = await session.getResource(validated.value);
        results.push({ tool, args: validated.value, result: res });
      } catch (e) {
        results.push({ tool, args: validated.value, result: { error: asErrorMessage(e), ...kubeHttpErrorDetails(e) } });
      }
    } else if (tool === "createResource") {
      const validated = validateCreateOrPatchArgs(args);
      if (!validated.ok) {
        results.push({ tool, args, result: { error: validated.error } });
        continue;
      }
      try {
        const res = await session.createResource(validated.value);
        results.push({ tool, args: validated.value, result: res });
      } catch (e) {
        results.push({ tool, args: validated.value, result: { error: asErrorMessage(e), ...kubeHttpErrorDetails(e) } });
      }
    } else if (tool === "patchResource") {
      const validated = validatePatchArgs(args);
      if (!validated.ok) {
        results.push({ tool, args, result: { error: validated.error } });
        continue;
      }
      try {
        const res = await session.patchResource(validated.value);
        results.push({ tool, args: validated.value, result: res });
      } catch (e) {
        results.push({ tool, args: validated.value, result: { error: asErrorMessage(e), ...kubeHttpErrorDetails(e) } });
      }
    } else if (tool === "analyzeImpact") {
      try {
        const res = await analyzeImpact(session.kubeConfig, args as any);
        results.push({ tool, args, result: res });
      } catch (e) {
        results.push({ tool, args, result: { error: asErrorMessage(e) } });
      }
    } else if (tool === "analyzeTrafficFlow") {
      try {
        const res = await analyzeTrafficFlow(session.kubeConfig, args as any);
        results.push({ tool, args, result: res });
      } catch (e) {
        results.push({ tool, args, result: { error: asErrorMessage(e) } });
      }
    } else if (tool === "investigatePodHealth") {
      try {
        console.log("Invoking investigatePodHealth with args:", args);
        const res = await investigatePodHealth(session.kubeConfig, args as any);
        results.push({ tool, args, result: res });
      } catch (e) {
        results.push({ tool, args, result: { error: asErrorMessage(e) } });
      }
    } else if (tool === "searchResources") {
      const validated = validateSearchResourcesArgs(args);
      if (!validated.ok) {
        results.push({ tool, args, result: { error: validated.error } });
        continue;
      }
      try {
        const res = await session.searchResources(validated.value);
        results.push({ tool, args: validated.value, result: res });
      } catch (e) {
        results.push({ tool, args: validated.value, result: { error: asErrorMessage(e), ...kubeHttpErrorDetails(e) } });
      }
    } else if (tool) {
      results.push({ tool: String(tool), args, result: { error: "Unknown tool" } });
    }
  }

  return results;
}

function buildPlanningPrompt(
  userText: string,
  toolCatalog: { tools: Array<{ name: string; description: string; inputSchema: unknown }> },
  priorResults: ToolExecutionResult[] = [],
  iteration = 0
): vscode.LanguageModelChatMessage[] {
  const system = `You are KubeOps Planner. Decide which tools to call and return a short plan.

OUTPUT RULES
- Output ONLY valid JSON (no markdown, no extra text).
- Always return JSON even if no tools are called.
- If you cannot produce valid JSON, output EXACTLY:
  {"summary":"Please restate the request with kind/name/namespace.","toolCalls":[],"done":true}
- Prefer minimal tool calls.
- Allowed tools: ${toolCatalog.tools.map((t) => t.name).join(", ")}

MISSING INPUTS
- If kind OR name is missing → do NOT call tools. Set done=true and explain what is missing.

NAMESPACE RULE
- If the user mentions a namespace, ALWAYS include namespace in tool args.
- Never drop or ignore a provided namespace.
- Only omit namespace when the user did not mention it.

TOOL SELECTION

Read / Search
- One object details → call getResource once.
- List/search resources → call searchResources.
  - Must include at least one filter: nameContains OR labelSelector OR fieldSelector.
  - If no filter provided → done=true and ask for a filter.

Writes
- Create → createResource once.
- Update / patch / apply → patchResource once.
- Never call write tools unless user clearly requested a write.
- Never call delete tools.

Investigations
- Pod unhealthy / crashing / not ready / debug pods → investigatePodHealth.
- Traffic flow / routing / upstream / downstream / request path → analyzeTrafficFlow.
- Impact / “what breaks if” / delete or update impact → analyzeImpact.

REFERENCE-FIRST RULE (NO GUESSING)
Never guess labels like "app=xyz".

If filters can be derived from another object:
1) Call getResource first
2) Extract selectors/references from the manifest
3) Then call searchResources using those selectors

Examples:
- Pods managed by Deployment → Deployment → spec.selector → Pods
- Pods behind Service → Service → spec.selector → Pods
- Ingress backends → Ingress → backend.service → Services

If the selector/reference is missing → done=true. Do NOT invent selectors.

IMPACT ACTION RULES
- Deleting/removing → analyzeImpact with action="delete".
- Updating/changing/traffic shift → analyzeImpact with action="update".
  - Include changeSummary describing the change.
- Never describe delete impact when action="update".

PATCH SAFETY RULE
When patching:
- First read the object.
- Then patch ONLY the requested fields.

JSON FORMAT
{
  "summary": string,
  "toolCalls": [
    { "tool": "getResource", "args": {} },
    { "tool": "createResource", "args": {} },
    { "tool": "patchResource", "args": {} },
    { "tool": "searchResources", "args": {} },
    { "tool": "analyzeImpact", "args": {} },
    { "tool": "analyzeTrafficFlow", "args": {} },
    { "tool": "investigatePodHealth", "args": {} }
  ],
  "done": boolean
}
`;

  const user = `User request: ${userText}

Iteration: ${iteration}
Previous tool results (if any): ${priorResults.length ? JSON.stringify(priorResults, null, 2) : "[]"}`;

  return [vscode.LanguageModelChatMessage.Assistant(system), vscode.LanguageModelChatMessage.User(user)];
}

function buildFinalPrompt(
  userText: string,
  toolCatalog: { tools: Array<{ name: string; description: string; inputSchema: unknown }> },
  toolResults: ToolExecutionResult[]
): vscode.LanguageModelChatMessage[] {
  const system = `You are KubeOps Reporter.

Goal: Generate a clear, accurate Markdown report using ONLY the provided tool results.

HARD RULES
- NEVER invent or infer data.
- Use ONLY the provided tool results JSON.
- Do NOT call tools or request new data.
- Do NOT inspect other resources unless explicitly present in results.
- Ignore annotations and noisy metadata.
- Prefer Markdown tables for structured data.

BASE OUTPUT STRUCTURE
1) Start with a short 2-3 line summary of the answer.
2) If a primary resource exists, render an **Identity table**:
   Columns: Kind | Name | Namespace | apiVersion
3) Render resource-specific sections using tables when possible.
4) If referencedResources exist, render a **Referenced Resources** table.
5) If any tool returned an error, clearly explain the error and what input/permission is missing.

SECRET / CONFIGMAP HANDLING
- ConfigMap data/binaryData → always show as tables.
- Secret dataKeys/stringDataKeys → show keys table.
- Secret data/stringData → show ONLY if provided and label as **Sensitive**.
- Never decode base64.

SEARCH RESULTS
If searchResources exists:
- Render section **Search Results**.
- Table columns: Kind | Name | Namespace | apiVersion.
- If truncated=true, mention results were truncated and suggest narrowing filters.

TRAFFIC FLOW
If analyzeTrafficFlow exists:
- Section **Traffic Flow**.
- 2-3 sentence plain English summary.
- Render Mermaid graph EXACTLY as returned.
- Table columns: From | To | Reason.
- If no edges → say no traffic edges discovered.

IMPACT ANALYSIS
If analyzeImpact exists:
- Section **Impact Analysis**.
- Use action field strictly:
  - action=update → discuss update impact ONLY.
  - action=delete → discuss deletion impact ONLY.
- Render impactedResources table:
  Columns: Kind | Name | Namespace | Impact Type | Severity.
- If empty → say no resources are impacted.

POD HEALTH
If investigatePodHealth exists:
- Section **Pod Health Investigation**.
- 2-3 sentence summary from diagnosis.
- Table per pod: Pod | Phase | Ready | Restarts | Node | Top Reason.
- Evidence subsection:
  - Recent Events table (Time | Type | Reason | Message)
  - Recent Logs per container (truncate long lines)
- If diagnosis unknown → say what data is missing.
`;

  const user = `User request: ${userText}

Tool results (JSON):
${JSON.stringify(toolResults, null, 2)}`;

  return [vscode.LanguageModelChatMessage.Assistant(system), vscode.LanguageModelChatMessage.User(user)];
}

async function sendText(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  opts?: { modelOptions?: Record<string, any> }
): Promise<string> {
  const cts = new vscode.CancellationTokenSource();
  const models: vscode.LanguageModelChat[] = await vscode.lm.selectChatModels({ vendor: "copilot", family: model.family });
  const res = await models[0].sendRequest(
    messages,
    {
      // Best-effort: some providers accept these. Ignored safely if unsupported.
      modelOptions: { temperature: 0, ...(opts?.modelOptions ?? {}) }
    },
    cts.token
  );
  let text = "";
  for await (const part of res.text) {
    text += part;
  }
  return text.trim();
}

async function sendJsonOnly(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[]
): Promise<JsonToolPlan> {
  const raw = await sendText(model, messages);
  console.log("Raw JSON from model:", raw);
  try {
    return parsePlannerJson(raw);
  } catch (e1) {
    const clipped = clipForPrompt(raw, 6000);
    const repairMessages: vscode.LanguageModelChatMessage[] = [
      ...messages,
      vscode.LanguageModelChatMessage.Assistant(`Previous output (invalid JSON):\n${clipped}`),
      vscode.LanguageModelChatMessage.User(
        [
          "Rewrite the previous output as STRICT valid JSON only (no markdown, no code fences, no trailing commas).",
          "Return exactly one JSON object matching the planner schema.",
          "If you are unsure, return this exact fallback JSON and nothing else:",
          '{"summary":"I could not produce a valid tool plan. Please restate the request with kind/name/namespace.","toolCalls":[],"done":true}',
          "",
          `Parse error: ${asErrorMessage(e1)}`
        ].join("\n")
      )
    ];
    const raw2 = await sendText(model, repairMessages);
    console.log("Repaired JSON from model:", raw2);
    return parsePlannerJson(raw2);
  }

  function parsePlannerJson(rawText: string): JsonToolPlan {
    const cleaned = stripMarkdownCodeFences(rawText);
    const objText = extractFirstJsonObject(cleaned);
    const parsed = JSON.parse(objText) as JsonToolPlan;

    if (!parsed.toolCalls) parsed.toolCalls = [];
    if (typeof parsed.done !== "boolean") parsed.done = false;
    return parsed;
  }
}

function extractFirstJsonObject(s: string): string {
  const start = s.indexOf("{");
  if (start < 0) throw new Error("Model response did not contain a JSON object");

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return s.slice(start, i + 1);
  }
  throw new Error("Unterminated JSON object in model response");
}

function stripMarkdownCodeFences(s: string): string {
  // Handles common cases like ```json ... ``` or ``` ... ```
  return s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
}

function clipForPrompt(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n...[truncated]...";
}

function parseApprovalCommand(
  userText: string
): { action: "confirm" | "cancel"; id?: string } | undefined {
  const t = userText.trim();
  const m = t.match(/^(confirm|cancel)(?:\s+([A-Za-z0-9_-]+))?$/i);
  if (!m) return undefined;
  const action = m[1].toLowerCase() as "confirm" | "cancel";
  const id = m[2];
  return { action, ...(id ? { id } : {}) };
}

function latestPendingWriteBundle(): PendingWriteBundle | undefined {
  // Map preserves insertion order. Take the most recent inserted bundle.
  let last: PendingWriteBundle | undefined;
  for (const v of pendingWriteApprovals.values()) last = v;
  return last;
}

function makeApprovalId(): string {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `write-${Date.now().toString(36)}-${rnd}`;
}

async function previewCreate(kc: k8s.KubeConfig, args: CreateOrPatchResourceArgs): Promise<WritePreview> {
  const kind = normalizeKind(args.kind);
  const namespaced = isNamespacedKind(kind);
  const ns = namespaced
    ? (args.namespace || kc.getContextObject(kc.getCurrentContext())?.namespace || "default")
    : undefined;

  const target = { kind, name: args.name, ...(ns ? { namespace: ns } : {}) };
  const built = await buildWriteManifest(kc, { ...args, kind });

  const proposed = sanitizeManifest(built.manifest);
  let previous: unknown = "(resource does not exist)";
  const notes: string[] = [];

  try {
    const prev = await getResource(kc, { kind, name: args.name, ...(ns ? { namespace: ns } : {}) });
    previous = prev.sanitizedManifest;
    notes.push("Resource already exists; create will likely fail with AlreadyExists unless name/namespace is changed.");
  } catch (e) {
    if (!isNotFoundError(e)) notes.push(`Could not confirm existence via read: ${asErrorMessage(e)}`);
  }

  const changes = diffForPreview(previous, proposed);
  return {
    tool: "createResource",
    target,
    previous,
    proposed,
    valuesApplied: args.values ?? (args.manifestYaml ? { manifestYaml: args.manifestYaml } : {}),
    changes,
    ...(notes.length ? { notes } : {})
  };
}

async function previewPatch(kc: k8s.KubeConfig, args: PatchResourceArgs): Promise<WritePreview> {
  const kind = normalizeKind(args.kind);
  const namespaced = isNamespacedKind(kind);
  const ns = namespaced
    ? (args.namespace || kc.getContextObject(kc.getCurrentContext())?.namespace || "default")
    : undefined;

  const prev = await getResource(kc, { kind, name: args.name, ...(ns ? { namespace: ns } : {}) });
  const built = await buildWriteManifest(kc, { ...args, kind });

  const previous = prev.sanitizedManifest;
  const proposed = sanitizeManifest(built.manifest);
  const changes = diffForPreview(previous, proposed);

  return {
    tool: "patchResource",
    target: { kind, name: args.name, ...(ns ? { namespace: ns } : {}) },
    previous,
    proposed,
    valuesApplied: args.values ?? (args.manifestYaml ? { manifestYaml: args.manifestYaml } : {}),
    changes
  };
}

function diffForPreview(before: any, after: any): Array<{ path: string; before: unknown; after: unknown }> {
  const out: Array<{ path: string; before: unknown; after: unknown }> = [];
  walkDiff(before, after, "$", 0, out);
  return out;

  function walkDiff(a: any, b: any, path: string, depth: number, acc: typeof out) {
    if (acc.length >= 200) return;
    if (depth > 8) return;

    if (a === b) return;

    const aIsObj = a && typeof a === "object";
    const bIsObj = b && typeof b === "object";

    if (!aIsObj || !bIsObj) {
      acc.push({ path, before: a, after: b });
      return;
    }

    const aIsArr = Array.isArray(a);
    const bIsArr = Array.isArray(b);
    if (aIsArr || bIsArr) {
      if (!(aIsArr && bIsArr)) {
        acc.push({ path, before: a, after: b });
        return;
      }
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i++) {
        walkDiff(a[i], b[i], `${path}[${i}]`, depth + 1, acc);
        if (acc.length >= 200) return;
      }
      return;
    }

    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of Array.from(keys).sort()) {
      walkDiff(a[k], b[k], `${path}.${k}`, depth + 1, acc);
      if (acc.length >= 200) return;
    }
  }
}

function renderWriteApprovalMarkdown(bundle: PendingWriteBundle): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require("yaml") as typeof import("yaml");

  const lines: string[] = [];
  lines.push(`## Pending write approval`);
  lines.push(`- Approval ID: \`${bundle.id}\``);
  lines.push(`- Created: \`${bundle.createdAt}\``);
  lines.push("");

  for (let i = 0; i < bundle.ops.length; i++) {
    const p = bundle.ops[i].preview;
    const actionLabel = p.tool === "createResource" ? "Create" : "Patch";
    lines.push(
      `### ${actionLabel} ${i + 1}: ${p.target.kind}/${p.target.name}${p.target.namespace ? " (ns " + p.target.namespace + ")" : ""}`
    );
    lines.push("");
    lines.push("**Requested change (values/manifest input):**");
    lines.push("```yaml");
    lines.push(yaml.stringify(p.valuesApplied ?? {}));
    lines.push("```");
    lines.push("");

    if (p.notes?.length) {
      lines.push("**Notes:**");
      for (const n of p.notes) lines.push(`- ${n}`);
      lines.push("");
    }

    lines.push("**Detected changes (sanitized):**");
    if (!p.changes.length) {
      lines.push("- (no differences detected in sanitized view)");
    } else {
      for (const c of p.changes.slice(0, 50)) {
        lines.push(`- \`${c.path}\`: \`${stringifyInline(c.before)}\` → \`${stringifyInline(c.after)}\``);
      }
      if (p.changes.length > 50) lines.push(`- ...and ${p.changes.length - 50} more`);
    }
    lines.push("");

    lines.push("**Previous State (sanitized):**");
    lines.push("```yaml");
    lines.push(yaml.stringify(p.previous ?? {}));
    lines.push("```");
    lines.push("");

    lines.push("**Proposed State (sanitized):**");
    lines.push("```yaml");
    lines.push(yaml.stringify(p.proposed ?? {}));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function stringifyInline(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 77) + "..." : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return String(v);
  }
}

function isNotFoundError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const anyErr = e as any;
  const statusCode = anyErr.statusCode ?? anyErr?.response?.statusCode;
  return statusCode === 404;
}

function validateGetResourceArgs(args: unknown):
  | { ok: true; value: GetResourceArgs }
  | { ok: false; error: string } {
  if (!args || typeof args !== "object") return { ok: false, error: "args must be an object" };

  const kind = (args as any).kind;
  const name = (args as any).name;
  const namespace = (args as any).namespace;

  if (typeof kind !== "string" || !kind.trim()) return { ok: false, error: "kind is required" };
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name is required" };
  if (namespace !== undefined && (typeof namespace !== "string" || !namespace.trim())) {
    return { ok: false, error: "namespace must be a non-empty string when provided" };
  }

  return { ok: true, value: { kind: kind.trim(), name: name.trim(), namespace: namespace?.trim() } };
}

function validateSearchResourcesArgs(args: unknown):
  | { ok: true; value: SearchResourcesArgs }
  | { ok: false; error: string } {
  if (!args || typeof args !== "object") return { ok: false, error: "args must be an object" };

  const kind = (args as any).kind;
  const namespace = (args as any).namespace;
  const nameContains = (args as any).nameContains;
  const labelSelector = (args as any).labelSelector;
  const fieldSelector = (args as any).fieldSelector;
  const limitRaw = (args as any).limit;

  if (typeof kind !== "string" || !kind.trim()) return { ok: false, error: "kind is required" };
  if (namespace !== undefined && (typeof namespace !== "string" || !namespace.trim())) {
    return { ok: false, error: "namespace must be a non-empty string when provided" };
  }

  if (
    (nameContains === undefined || !nameContains.trim()) &&
    (labelSelector === undefined || !labelSelector.trim()) &&
    (fieldSelector === undefined || !fieldSelector.trim())
  ) {
    return { ok: false, error: "at least one of nameContains, labelSelector, or fieldSelector must be provided" };
  }

  if (nameContains !== undefined && (typeof nameContains !== "string" || !nameContains.trim())) {
    return { ok: false, error: "nameContains must be a non-empty string when provided" };
  }
  if (labelSelector !== undefined && (typeof labelSelector !== "string" || !labelSelector.trim())) {
    return { ok: false, error: "labelSelector must be a non-empty string when provided" };
  }
  if (fieldSelector !== undefined && (typeof fieldSelector !== "string" || !fieldSelector.trim())) {
    return { ok: false, error: "fieldSelector must be a non-empty string when provided" };
  }

  let limit = 25;
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== "number" || !Number.isFinite(limitRaw)) {
      return { ok: false, error: "limit must be a number when provided" };
    }
    limit = Math.max(1, Math.min(100, Math.floor(limitRaw)));
  }

  return {
    ok: true,
    value: {
      kind: kind.trim(),
      namespace: namespace?.trim(),
      nameContains: nameContains?.trim(),
      labelSelector: labelSelector?.trim(),
      fieldSelector: fieldSelector?.trim(),
      limit
    }
  };
}

function asErrorMessage(e: unknown): string {
  const base = e instanceof Error ? e.message : String(e);
  const details = formatKubernetesHttpError(e);
  return details ? `${base} (${details})` : base;
}

function formatKubernetesHttpError(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;

  const anyErr = e as any;
  const statusCode = anyErr.statusCode ?? anyErr?.response?.statusCode;
  const body = anyErr.body;

  if (statusCode === undefined && body === undefined) return undefined;

  const msg = extractKubernetesStatusMessage(body);
  if (statusCode !== undefined && msg) return `HTTP ${statusCode}: ${msg}`;
  if (statusCode !== undefined) return `HTTP ${statusCode}`;
  if (msg) return msg;
  return truncateForLog(safeJson(body), 1200);
}

function extractKubernetesStatusMessage(body: any): string | undefined {
  if (!body) return undefined;
  if (typeof body === "string") return truncateForLog(body, 1200);
  if (typeof body !== "object") return truncateForLog(String(body), 1200);

  if (typeof body.message === "string" && body.message.trim()) return truncateForLog(body.message, 1200);
  if (typeof body.reason === "string" && body.reason.trim()) return truncateForLog(body.reason, 1200);

  const nested = body?.status?.message;
  if (typeof nested === "string" && nested.trim()) return truncateForLog(nested, 1200);

  return undefined;
}

function safeJson(v: any): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncateForLog(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function kubeHttpErrorDetails(e: unknown): {
  statusCode?: number;
  statusMessage?: string;
} {
  if (!e || typeof e !== "object") return {};

  const anyErr = e as any;
  const statusCode = anyErr.statusCode ?? anyErr?.response?.statusCode;
  const body = anyErr.body;
  const statusMessage = extractKubernetesStatusMessage(body);

  return {
    ...(typeof statusCode === "number" ? { statusCode } : {}),
    ...(statusMessage ? { statusMessage } : {}),
  };
}

async function kubeConnect(
  _chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream
): Promise<KubeSession | undefined> {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();

    // quick auth/connectivity check
    const core = kc.makeApiClient(k8s.CoreV1Api);
    // Add timeout to avoid hanging when cluster is unreachable
    const TIMEOUT_MS = 5000;
    await Promise.race([
      core.listNamespace(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Kubernetes API timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
      )
    ]);

    return {
      kubeConfig: kc,
      getResource: (args) => getResource(kc, args),
      createResource: (args) => createResource(kc, args),
      patchResource: (args) => patchResource(kc, args),
      searchResources: (args) => searchResources(kc, args),
    };
  } catch (e) {
    stream.markdown(
      [
        "❌ **Kubernetes connection failed**",
        "",
        `**Error:** ${asErrorMessage(e)}`,
        "",
        "Fix tips:",
        "- Ensure `kubectl get ns` works in your terminal.",
        "- Verify `KUBECONFIG` or `~/.kube/config` is valid.",
        "- Ensure your current context has permissions."
      ].join("\n")
    );
    return undefined;
  }
}

async function getResource(kc: k8s.KubeConfig, args: GetResourceArgs): Promise<ManifestToolResult> {
  const kind = normalizeKind(args.kind);
  const apiVersion = resolveApiVersion(kind);

  const namespaced = isNamespacedKind(kind);
  const ns = namespaced
    ? (args.namespace || kc.getContextObject(kc.getCurrentContext())?.namespace || "default")
    : undefined;

  const objApi = k8s.KubernetesObjectApi.makeApiClient(kc);

  const baseObj: k8s.KubernetesObject & { metadata: { name: string; namespace?: string } } = {
    apiVersion,
    kind,
    metadata: {
      name: args.name,
      ...(ns ? { namespace: ns } : {})
    }
  };

  const apiVersionsToTry = apiVersionFallbacks(kind, apiVersion);

  let lastErr: unknown;
  let readObj: any;
  let events: any
  for (const ver of apiVersionsToTry) {
    try {
      (baseObj as any).apiVersion = ver;
      readObj = await objApi.read(baseObj);
      events = await fetchPodEvents(kc.makeApiClient(k8s.CoreV1Api), ns ?? "default", args.name);
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) {
    throw new Error(
      `Failed to read ${kind}/${args.name}${ns ? " in " + ns : ""}: ${asErrorMessage(lastErr)}`
    );
  }

  const body = (readObj as any)?.body ?? readObj;

  const identity = {
    apiVersion: body.apiVersion ?? apiVersion,
    kind: body.kind ?? kind,
    name: body?.metadata?.name ?? args.name,
    ...(body?.metadata?.namespace ? { namespace: body.metadata.namespace } : ns ? { namespace: ns } : {})
  };

  return {
    identity,
    sanitizedManifest: sanitizeManifest(body, { includeSensitiveData: args.includeSensitiveData === true }),
    referencedResources: extractReferencedResources(body),
    ...(events ? { events } : {})
  };
}

async function searchResources(kc: k8s.KubeConfig, args: SearchResourcesArgs): Promise<SearchToolResult> {
  const kind = normalizeKind(args.kind);
  const apiVersion = resolveApiVersion(kind);

  const namespaced = isNamespacedKind(kind);
  const ns = namespaced
    ? (args.namespace || kc.getContextObject(kc.getCurrentContext())?.namespace || "default")
    : undefined;

  const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 25)));

  const objApi = k8s.KubernetesObjectApi.makeApiClient(kc);

  const baseObj: k8s.KubernetesObject & { metadata: { name?: string; namespace?: string } } = {
    apiVersion,
    kind,
    metadata: {
      ...(ns ? { namespace: ns } : {})
    }
  };

  const apiVersionsToTry = apiVersionFallbacks(kind, apiVersion);

  let lastErr: unknown;
  let listObj: any;

  for (const ver of apiVersionsToTry) {
    try {
      (baseObj as any).apiVersion = ver;
      listObj = await objApi.list(
        apiVersion,
        kind,
        ns,
        undefined,   // pretty
        undefined,   // exact
        undefined,   // exportt
        args?.fieldSelector?.trim(),
        args?.labelSelector?.trim(),
        limit,
        undefined,   // continueToken
        undefined    // options
      );
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr) {
    throw new Error(`Failed to list ${kind}${ns ? " in " + ns : ""}: ${asErrorMessage(lastErr)}`);
  }

  const body = (listObj as any)?.body ?? listObj;
  const items: any[] = body?.items ?? [];

  const needle = args.nameContains?.trim();
  const filtered = needle
    ? items.filter((it) => String(it?.metadata?.name ?? "").includes(needle))
    : items;

  // Hard cap returned identities to limit (even if server ignores limit).
  const capped = filtered.slice(0, limit);

  const results = capped
    .map((it) => ({
      apiVersion: String(it?.apiVersion ?? apiVersion),
      kind: String(it?.kind ?? kind),
      name: String(it?.metadata?.name ?? ""),
      ...(it?.metadata?.namespace ? { namespace: String(it.metadata.namespace) } : ns ? { namespace: ns } : {})
    }))
    .filter((r) => r.name);

  return {
    kind,
    ...(ns ? { namespace: ns } : {}),
    query: {
      ...(needle ? { nameContains: needle } : {}),
      ...(args.labelSelector ? { labelSelector: args.labelSelector.trim() } : {}),
      ...(args.fieldSelector ? { fieldSelector: args.fieldSelector.trim() } : {}),
      limit
    },
    results,
    returned: results.length,
    truncated: filtered.length > limit
  };
}

function validateCreateOrPatchArgs(args: unknown):
  | { ok: true; value: CreateOrPatchResourceArgs }
  | { ok: false; error: string } {
  if (!args || typeof args !== "object") return { ok: false, error: "args must be an object" };

  const kind = (args as any).kind;
  const name = (args as any).name;
  const namespace = (args as any).namespace;
  const apiVersion = (args as any).apiVersion;
  const manifestYaml = (args as any).manifestYaml;
  const values = (args as any).values;
  const dryRun = (args as any).dryRun;

  if (typeof kind !== "string" || !kind.trim()) return { ok: false, error: "kind is required" };
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "name is required" };
  if (namespace !== undefined && (typeof namespace !== "string" || !namespace.trim())) {
    return { ok: false, error: "namespace must be a non-empty string when provided" };
  }
  if (apiVersion !== undefined && (typeof apiVersion !== "string" || !apiVersion.trim())) {
    return { ok: false, error: "apiVersion must be a non-empty string when provided" };
  }
  if (manifestYaml !== undefined && (typeof manifestYaml !== "string" || !manifestYaml.trim())) {
    return { ok: false, error: "manifestYaml must be a non-empty string when provided" };
  }
  if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) {
    return { ok: false, error: "values must be an object when provided" };
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    return { ok: false, error: "dryRun must be a boolean when provided" };
  }

  if (manifestYaml === undefined && values === undefined) {
    return { ok: false, error: "Provide either values or manifestYaml" };
  }

  return {
    ok: true,
    value: {
      kind: kind.trim(),
      name: name.trim(),
      namespace: namespace?.trim(),
      apiVersion: apiVersion?.trim(),
      manifestYaml: manifestYaml?.trim(),
      values: values as any,
      dryRun
    }
  };
}

function validatePatchArgs(args: unknown):
  | { ok: true; value: PatchResourceArgs }
  | { ok: false; error: string } {
  const base = validateCreateOrPatchArgs(args);
  if (!base.ok) return base;

  const fieldManager = (args as any).fieldManager;
  const force = (args as any).force;
  const requireExists = (args as any).requireExists;

  if (fieldManager !== undefined && (typeof fieldManager !== "string" || !fieldManager.trim())) {
    return { ok: false, error: "fieldManager must be a non-empty string when provided" };
  }
  if (force !== undefined && typeof force !== "boolean") {
    return { ok: false, error: "force must be a boolean when provided" };
  }
  if (requireExists !== undefined && typeof requireExists !== "boolean") {
    return { ok: false, error: "requireExists must be a boolean when provided" };
  }

  return {
    ok: true,
    value: {
      ...base.value,
      fieldManager: fieldManager?.trim(),
      force,
      requireExists
    }
  };
}

function normalizeKind(kind: string): string {
  const k = kind.trim();
  const map: Record<string, string> = {
    ns: "Namespace",
    namespaces: "Namespace",
    po: "Pod",
    pod: "Pod",
    deploy: "Deployment",
    deployment: "Deployment",
    rs: "ReplicaSet",
    replicaset: "ReplicaSet",
    sts: "StatefulSet",
    statefulset: "StatefulSet",
    ds: "DaemonSet",
    daemonset: "DaemonSet",
    job: "Job",
    cj: "CronJob",
    cronjob: "CronJob",
    svc: "Service",
    service: "Service",
    ing: "Ingress",
    ingress: "Ingress",
    netpol: "NetworkPolicy",
    networkpolicy: "NetworkPolicy",
    cm: "ConfigMap",
    configmap: "ConfigMap",
    secret: "Secret",
    pvc: "PersistentVolumeClaim",
    pv: "PersistentVolume",
    sa: "ServiceAccount",
    hpa: "HorizontalPodAutoscaler",
    pdb: "PodDisruptionBudget",
    vs: "VirtualService",
    dr: "DestinationRule",
    gw: "Gateway"
  };
  return map[k.toLowerCase()] ?? k;
}

function resolveApiVersion(kind: string): string {
  const k8sMap: Record<string, string> = {
    Namespace: "v1",
    Pod: "v1",
    Service: "v1",
    ConfigMap: "v1",
    Secret: "v1",
    ServiceAccount: "v1",
    Node: "v1",
    Event: "v1",

    PersistentVolume: "v1",
    PersistentVolumeClaim: "v1",
    StorageClass: "storage.k8s.io/v1",

    Deployment: "apps/v1",
    ReplicaSet: "apps/v1",
    StatefulSet: "apps/v1",
    DaemonSet: "apps/v1",

    Job: "batch/v1",
    CronJob: "batch/v1",

    Ingress: "networking.k8s.io/v1",
    IngressClass: "networking.k8s.io/v1",
    NetworkPolicy: "networking.k8s.io/v1",
    EndpointSlice: "discovery.k8s.io/v1",

    Role: "rbac.authorization.k8s.io/v1",
    RoleBinding: "rbac.authorization.k8s.io/v1",
    ClusterRole: "rbac.authorization.k8s.io/v1",
    ClusterRoleBinding: "rbac.authorization.k8s.io/v1",

    HorizontalPodAutoscaler: "autoscaling/v2",
    PodDisruptionBudget: "policy/v1",
    PriorityClass: "scheduling.k8s.io/v1"
  };

  const istioMap: Record<string, string> = {
    VirtualService: "networking.istio.io/v1beta1",
    DestinationRule: "networking.istio.io/v1beta1",
    Gateway: "networking.istio.io/v1beta1",
    ServiceEntry: "networking.istio.io/v1beta1",
    PeerAuthentication: "security.istio.io/v1beta1",
    AuthorizationPolicy: "security.istio.io/v1beta1"
  };

  return k8sMap[kind] ?? istioMap[kind] ?? "v1";
}

function apiVersionFallbacks(kind: string, primary: string): string[] {
  if (!isIstioKind(kind)) return [primary];

  const versions = [primary];
  if (primary.endsWith("/v1")) {
    versions.push(primary.replace("/v1", "/v1beta1"), primary.replace("/v1", "/v1alpha3"));
  } else if (primary.endsWith("/v1beta1")) {
    versions.push(primary.replace("/v1beta1", "/v1"), primary.replace("/v1beta1", "/v1alpha3"));
  } else if (primary.endsWith("/v1alpha3")) {
    versions.push(primary.replace("/v1alpha3", "/v1beta1"), primary.replace("/v1alpha3", "/v1"));
  } else {
    versions.push(primary.replace(/\/v\w+$/, "/v1beta1"), primary.replace(/\/v\w+$/, "/v1"));
  }

  return Array.from(new Set(versions));
}

function isIstioKind(kind: string): boolean {
  return (
    kind === "VirtualService" ||
    kind === "DestinationRule" ||
    kind === "Gateway" ||
    kind === "PeerAuthentication" ||
    kind === "AuthorizationPolicy" ||
    kind === "ServiceEntry"
  );
}

function isNamespacedKind(kind: string): boolean {
  const clusterScoped = new Set([
    "Namespace",
    "Node",
    "PersistentVolume",
    "StorageClass",
    "ClusterRole",
    "ClusterRoleBinding",
    "IngressClass",
    "PriorityClass"
  ]);
  return !clusterScoped.has(kind);
}

async function createResource(kc: k8s.KubeConfig, args: CreateOrPatchResourceArgs): Promise<WriteToolResult> {
  const objApi = k8s.KubernetesObjectApi.makeApiClient(kc);
  const dryRun = args.dryRun ? "All" : undefined;

  const kind = normalizeKind(args.kind);
  const primary = args.apiVersion?.trim() || resolveApiVersion(kind);
  const versionsToTry = apiVersionFallbacks(kind, primary);

  let lastErr: unknown;
  let body: any;
  let identity: ManifestToolResult["identity"] | undefined;

  for (const ver of versionsToTry) {
    try {
      const built = await buildWriteManifest(kc, { ...args, kind, apiVersion: ver });
      identity = built.identity;
      const created = await objApi.create(built.manifest as any, undefined, dryRun, "kubeops");
      body = (created as any)?.body ?? created;
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr || !identity) {
    throw new Error(
      `Failed to create ${kind}/${args.name}${args.namespace ? " in " + args.namespace : ""}: ${asErrorMessage(lastErr)}`
    );
  }

  return {
    identity: {
      apiVersion: body.apiVersion ?? identity.apiVersion,
      kind: body.kind ?? identity.kind,
      name: body?.metadata?.name ?? identity.name,
      ...(body?.metadata?.namespace
        ? { namespace: body.metadata.namespace }
        : identity.namespace
          ? { namespace: identity.namespace }
          : {})
    },
    action: "created",
    sanitizedManifest: sanitizeManifest(body)
  };
}

async function patchResource(kc: k8s.KubeConfig, args: PatchResourceArgs): Promise<WriteToolResult> {
  const objApi = k8s.KubernetesObjectApi.makeApiClient(kc);

  const dryRun = args.dryRun ? "All" : undefined;
  const fieldManager = args.fieldManager?.trim() || "kubeops";
  const force = args.force === true ? true : undefined;
  const requireExists = args.requireExists !== false;

  const kind = normalizeKind(args.kind);
  const primary = args.apiVersion?.trim() || resolveApiVersion(kind);
  const versionsToTry = apiVersionFallbacks(kind, primary);

  let lastErr: unknown;
  let body: any;
  let identity: ManifestToolResult["identity"] | undefined;

  for (const ver of versionsToTry) {
    try {
      const built = await buildWriteManifest(kc, { ...args, kind, apiVersion: ver });
      identity = built.identity;

      if (requireExists) {
        await objApi.read({
          apiVersion: identity.apiVersion,
          kind: identity.kind,
          metadata: { name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}) }
        } as any);
      }

      const patched = await objApi.patch(
        built.manifest as any,
        undefined,
        dryRun,
        fieldManager,
        force,
        { headers: { "Content-Type": "application/apply-patch+yaml" } }
      );
      body = (patched as any)?.body ?? patched;
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastErr || !identity) {
    throw new Error(
      `Failed to patch ${kind}/${args.name}${args.namespace ? " in " + args.namespace : ""}: ${asErrorMessage(lastErr)}`
    );
  }

  return {
    identity: {
      apiVersion: body.apiVersion ?? identity.apiVersion,
      kind: body.kind ?? identity.kind,
      name: body?.metadata?.name ?? identity.name,
      ...(body?.metadata?.namespace
        ? { namespace: body.metadata.namespace }
        : identity.namespace
          ? { namespace: identity.namespace }
          : {})
    },
    action: "patched",
    sanitizedManifest: sanitizeManifest(body)
  };
}

async function buildWriteManifest(
  kc: k8s.KubeConfig,
  args: CreateOrPatchResourceArgs
): Promise<{ manifest: k8s.KubernetesObject; identity: ManifestToolResult["identity"] }> {
  const kind = normalizeKind(args.kind);
  const resolvedApiVersion = args.apiVersion?.trim() || resolveApiVersion(kind);

  const namespaced = isNamespacedKind(kind);
  const ns = namespaced
    ? (args.namespace || kc.getContextObject(kc.getCurrentContext())?.namespace || "default")
    : undefined;

  const identity: ManifestToolResult["identity"] = {
    apiVersion: resolvedApiVersion,
    kind,
    name: args.name,
    ...(ns ? { namespace: ns } : {})
  };

  const fromYaml = args.manifestYaml ? parseSingleManifestYaml(args.manifestYaml) : undefined;
  const values = normalizeValuesForKind(kind, (args.values ?? {}) as ResourceValues);

  const base: any = {
    apiVersion: identity.apiVersion,
    kind: identity.kind,
    metadata: {
      name: identity.name,
      ...(identity.namespace ? { namespace: identity.namespace } : {})
    }
  };

  const merged: any = fromYaml && typeof fromYaml === "object" ? fromYaml : base;

  // Always enforce identity fields from args, regardless of provided yaml/values.
  merged.apiVersion = identity.apiVersion;
  merged.kind = identity.kind;
  merged.metadata = merged.metadata && typeof merged.metadata === "object" ? merged.metadata : {};
  merged.metadata.name = identity.name;
  if (identity.namespace) merged.metadata.namespace = identity.namespace;
  else delete merged.metadata.namespace;

  // Merge values (preferred over yaml for spec/data etc), but never allow identity override.
  const valueMetadata = (values as any).metadata;
  if (valueMetadata && typeof valueMetadata === "object") {
    if (valueMetadata.labels && typeof valueMetadata.labels === "object") {
      merged.metadata.labels = { ...(merged.metadata.labels ?? {}), ...(valueMetadata.labels as any) };
    }
    if (valueMetadata.annotations && typeof valueMetadata.annotations === "object") {
      merged.metadata.annotations = { ...(merged.metadata.annotations ?? {}), ...(valueMetadata.annotations as any) };
    }
  }

  for (const [k, v] of Object.entries(values)) {
    if (k === "apiVersion" || k === "kind" || k === "metadata") continue;
    if (v === undefined) continue;
    merged[k] = v;
  }

  // Ensure no accidental identity override inside metadata.
  merged.metadata.name = identity.name;
  if (identity.namespace) merged.metadata.namespace = identity.namespace;

  return { manifest: merged as k8s.KubernetesObject, identity };
}

function normalizeValuesForKind(kind: string, values: ResourceValues): ResourceValues {
  if (!values || typeof values !== "object") return values;
  if ((values as any).spec !== undefined) return values;

  const specWrapperKinds = new Set([
    "Pod",
    "Deployment",
    "StatefulSet",
    "DaemonSet",
    "Job",
    "CronJob",
    "Service",
    "Ingress",
    "NetworkPolicy",
    "VirtualService",
    "DestinationRule",
    "Gateway",
    "PeerAuthentication",
    "AuthorizationPolicy",
    "ServiceEntry"
  ]);

  if (!specWrapperKinds.has(kind)) return values;

  const { metadata, ...rest } = values as any;
  const hasNonMetadataKeys = Object.keys(rest).length > 0;
  if (!hasNonMetadataKeys) return values;

  return {
    ...(metadata ? { metadata } : {}),
    spec: rest
  };
}

function parseSingleManifestYaml(yamlText: string): any {
  // Lazy import to avoid bundling costs if unused in most sessions.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require("yaml") as typeof import("yaml");

  const docs = yaml.parseAllDocuments(yamlText);
  const nonEmpty = docs
    .map((d) => d.toJSON())
    .filter((d) => d !== null && d !== undefined && !(typeof d === "string" && !d.trim()));
  if (nonEmpty.length !== 1) {
    throw new Error(`manifestYaml must contain exactly 1 YAML document, got ${nonEmpty.length}`);
  }
  if (typeof nonEmpty[0] !== "object" || nonEmpty[0] === null || Array.isArray(nonEmpty[0])) {
    throw new Error("manifestYaml must parse into a single object");
  }
  return nonEmpty[0];
}

function sanitizeManifest(obj: any, opts?: { includeSensitiveData?: boolean }): any {
  if (!obj || typeof obj !== "object") return obj;

  const kind = String(obj?.kind ?? "");
  const includeSensitive = opts?.includeSensitiveData === true;

  const out: any = {
    apiVersion: obj.apiVersion,
    kind: obj.kind,
    metadata: {
      name: obj?.metadata?.name,
      ...(obj?.metadata?.namespace ? { namespace: obj.metadata.namespace } : {})
    }
  };

  // Resource-specific payloads
  if (kind === "ConfigMap") {
    // Often safe/expected to include config content
    if (obj.data !== undefined) out.data = obj.data;
    if (obj.binaryData !== undefined) out.binaryData = obj.binaryData;
    if (obj.immutable !== undefined) out.immutable = obj.immutable;
  }

  if (kind === "Secret") {
    // Safe by default: include only keys + type, redact values unless explicitly requested
    out.type = obj.type;
    if (obj.immutable !== undefined) out.immutable = obj.immutable;

    const dataObj = obj.data ?? {};
    const stringDataObj = obj.stringData ?? {};

    const dataKeys = dataObj && typeof dataObj === "object" ? Object.keys(dataObj) : [];
    const stringDataKeys = stringDataObj && typeof stringDataObj === "object" ? Object.keys(stringDataObj) : [];

    out.dataKeys = dataKeys;
    out.stringDataKeys = stringDataKeys;

    if (includeSensitive) {
      // NOTE: Secret .data is base64-encoded; we return as-is (do not decode in tool)
      if (obj.data !== undefined) out.data = obj.data;
      if (obj.stringData !== undefined) out.stringData = obj.stringData;
      out.dataRedacted = false;
    } else {
      out.dataRedacted = true;
    }
  }

  // Keep spec/status (this is your primary manifest info)
  if (obj.spec !== undefined) out.spec = obj.spec;
  if (obj.status !== undefined) out.status = obj.status;

  // Keep a small allowlist for Event-like objects
  for (const k of Object.keys(obj)) {
    if (k === "apiVersion" || k === "kind" || k === "metadata" || k === "spec" || k === "status") continue;
    if (
      k === "involvedObject" ||
      k === "reason" ||
      k === "message" ||
      k === "type" ||
      k === "count" ||
      k === "firstTimestamp" ||
      k === "lastTimestamp"
    ) {
      out[k] = obj[k];
    }
  }

  return out;
}

function extractReferencedResources(obj: any): ManifestToolResult["referencedResources"] {
  const refs: ManifestToolResult["referencedResources"] = [];
  const ns = obj?.metadata?.namespace;

  const add = (kind: string, name?: string, note?: string, namespace?: string) => {
    if (!name || typeof name !== "string") return;
    refs.push({ kind, name, namespace, note: note ?? "referenced" });
  };

  const tpl = obj?.spec?.template ?? obj?.spec?.jobTemplate?.spec?.template;
  const podSpec = tpl?.spec;

  if (podSpec) {
    if (podSpec.serviceAccountName) add("ServiceAccount", podSpec.serviceAccountName, "serviceAccountName", ns);

    for (const s of podSpec.imagePullSecrets ?? []) {
      add("Secret", s?.name, "imagePullSecret", ns);
    }

    for (const v of podSpec.volumes ?? []) {
      if (v?.configMap?.name) add("ConfigMap", v.configMap.name, `volume:${v.name} configMap`, ns);
      if (v?.secret?.secretName) add("Secret", v.secret.secretName, `volume:${v.name} secret`, ns);
      if (v?.persistentVolumeClaim?.claimName)
        add("PersistentVolumeClaim", v.persistentVolumeClaim.claimName, `volume:${v.name} pvc`, ns);
      if (v?.projected?.sources) {
        for (const src of v.projected.sources) {
          if (src?.configMap?.name) add("ConfigMap", src.configMap.name, `projected:${v.name} configMap`, ns);
          if (src?.secret?.name) add("Secret", src.secret.name, `projected:${v.name} secret`, ns);
        }
      }
    }

    const containers = [...(podSpec.containers ?? []), ...(podSpec.initContainers ?? [])];
    for (const c of containers) {
      for (const ef of c?.envFrom ?? []) {
        if (ef?.configMapRef?.name) add("ConfigMap", ef.configMapRef.name, `envFrom:${c.name} configMap`, ns);
        if (ef?.secretRef?.name) add("Secret", ef.secretRef.name, `envFrom:${c.name} secret`, ns);
      }
      for (const e of c?.env ?? []) {
        const vf = e?.valueFrom;
        if (vf?.configMapKeyRef?.name)
          add("ConfigMap", vf.configMapKeyRef.name, `env:${c.name} ${e.name} configMapKeyRef`, ns);
        if (vf?.secretKeyRef?.name)
          add("Secret", vf.secretKeyRef.name, `env:${c.name} ${e.name} secretKeyRef`, ns);
      }
    }
  }

  if (obj?.kind === "Ingress") {
    const rules = obj?.spec?.rules ?? [];
    for (const r of rules) {
      const paths = r?.http?.paths ?? [];
      for (const p of paths) {
        const svcName = p?.backend?.service?.name;
        if (svcName) add("Service", svcName, `ingress backend for path ${p?.path ?? ""}`, ns);
      }
    }
    const defSvc = obj?.spec?.defaultBackend?.service?.name;
    if (defSvc) add("Service", defSvc, "ingress defaultBackend service", ns);
    if (obj?.spec?.ingressClassName) add("IngressClass", obj.spec.ingressClassName, "ingressClassName", undefined);
  }

  if (obj?.kind === "VirtualService") {
    for (const gw of obj?.spec?.gateways ?? []) {
      if (typeof gw === "string" && gw !== "mesh") add("Gateway", gw, "virtualservice.gateway", ns);
    }
    const http = obj?.spec?.http ?? [];
    for (const h of http) {
      for (const r of h?.route ?? []) {
        const host = r?.destination?.host;
        if (host) add("Service", host, "virtualservice.destination.host", ns);
      }
    }
  }

  if (obj?.kind === "DestinationRule") {
    const host = obj?.spec?.host;
    if (host) add("Service", host, "destinationrule.host", ns);
  }

  if (obj?.kind === "HorizontalPodAutoscaler") {
    const tr = obj?.spec?.scaleTargetRef;
    if (tr?.kind && tr?.name) add(tr.kind, tr.name, "hpa.scaleTargetRef", ns);
  }

  if (obj?.kind === "RoleBinding" || obj?.kind === "ClusterRoleBinding") {
    const rr = obj?.roleRef;
    if (rr?.kind && rr?.name) add(rr.kind, rr.name, "roleRef", rr.kind.startsWith("Cluster") ? undefined : ns);
    for (const s of obj?.subjects ?? []) {
      if (s?.kind === "ServiceAccount" && s?.name) add("ServiceAccount", s.name, "subject", s?.namespace ?? ns);
    }
  }

  if (obj?.kind === "Event") {
    const involved = obj?.involvedObject;
    if (involved?.kind && involved?.name) add(involved.kind, involved.name, "event.involvedObject", involved?.namespace);
  }

  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.kind}|${r.namespace ?? ""}|${r.name}|${r.note}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
