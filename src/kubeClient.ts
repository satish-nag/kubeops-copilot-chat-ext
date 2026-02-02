import * as k8s from "@kubernetes/client-node";
import * as vscode from "vscode";

/**
 * Minimal Kubernetes client wrapper for the extension.
 *
 * Loads kubeconfig using the standard kubeconfig loading rules:
 * - KUBECONFIG env var
 * - ~/.kube/config
 * - in-cluster service account (if applicable)
 */
export async function kubeConnect(_chatContext: vscode.ChatContext, stream: vscode.ChatResponseStream): Promise<k8s.KubeConfig | undefined> {
  try {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
    await coreV1.listNamespace(undefined, undefined, undefined, undefined, undefined, 1)
    return kc;
  } catch (err) {
    stream.markdown(`**KubeOps Error:** Unable to connect to Kubernetes cluster. Please ensure your kubeconfig is valid and accessible. \n\n Error details: ${err}`);
    return;
  }
}
