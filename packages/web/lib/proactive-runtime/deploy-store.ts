import { RelayFileApiError, RelayFileClient } from "@relayfile/sdk";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import { resolveRelayfileConfig } from "@/lib/relayfile";

const DEPLOYMENT_ROOT = "/_agents/deployments";
const STORE_AGENT_NAME = "cloud-proactive-runtime";

export type AgentTriggerManifest = {
  workspaceLiteral: string | null;
  agentNameLiteral: string | null;
  schedule: unknown[];
  watch: string[];
  inbox: string[];
};

export type ProactiveDeploymentRecord = {
  agentId: string;
  deploymentId: string;
  relayWorkspaceId: string;
  appWorkspaceId: string | null;
  organizationId: string | null;
  userId: string;
  name: string;
  entrypoint: string;
  sourceText: string;
  sourceKind: "entrypoint" | "hosted-custom" | "hosted-default";
  sourceHash: string;
  bundleHash: string;
  sandboxId: string;
  status: "deploying" | "running" | "degraded" | "failed" | "deleted";
  lastError: string | null;
  deployedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
  manifest: AgentTriggerManifest;
  hosted?: {
    model: string;
    instructions: string;
    provider: {
      mode: "managed" | "byok";
      secretRef?: string;
    };
  } | null;
  runtime: {
    workdir: string;
    bundlePath: string;
    supervisorPath: string;
    statusPath: string;
    logPath: string;
  };
};

function deploymentPath(agentId: string): string {
  return `${DEPLOYMENT_ROOT}/${encodeURIComponent(agentId)}.json`;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof RelayFileApiError && error.status === 404) {
    return true;
  }
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && (error as { status?: unknown }).status === 404,
  );
}

function createStoreClient(relayWorkspaceId: string): RelayFileClient {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  return new RelayFileClient({
    baseUrl: relayfileUrl,
    token: () =>
      mintRelayfileToken({
        workspaceId: relayWorkspaceId,
        relayAuthUrl,
        relayAuthApiKey,
        agentName: STORE_AGENT_NAME,
      }),
  });
}

async function waitForWrite(
  client: RelayFileClient,
  relayWorkspaceId: string,
  opId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const op = await client.getOp(relayWorkspaceId, opId);
    if (op.status === "succeeded") {
      return;
    }
    if (op.status === "failed" || op.status === "dead_lettered" || op.status === "canceled") {
      throw new Error(op.lastError || `Relayfile write ${opId} failed with status ${op.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for relayfile write ${opId}`);
}

export async function readDeploymentRecord(
  relayWorkspaceId: string,
  agentId: string,
): Promise<ProactiveDeploymentRecord | null> {
  const client = createStoreClient(relayWorkspaceId);
  try {
    const file = await client.readFile(relayWorkspaceId, deploymentPath(agentId));
    return JSON.parse(file.content) as ProactiveDeploymentRecord;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function listDeploymentRecords(
  relayWorkspaceId: string,
): Promise<ProactiveDeploymentRecord[]> {
  const client = createStoreClient(relayWorkspaceId);
  const results: ProactiveDeploymentRecord[] = [];
  let cursor: string | undefined;

  do {
    const listing = await client.queryFiles(relayWorkspaceId, {
      path: DEPLOYMENT_ROOT,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });

    for (const item of listing.items) {
      try {
        const file = await client.readFile(relayWorkspaceId, item.path);
        results.push(JSON.parse(file.content) as ProactiveDeploymentRecord);
      } catch {
        // Ignore malformed or concurrently removed records.
      }
    }

    cursor = listing.nextCursor ?? undefined;
  } while (cursor);

  return results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function writeDeploymentRecord(record: ProactiveDeploymentRecord): Promise<void> {
  const client = createStoreClient(record.relayWorkspaceId);
  const path = deploymentPath(record.agentId);
  let baseRevision = "0";

  try {
    const existing = await client.readFile(record.relayWorkspaceId, path);
    baseRevision = existing.revision;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  const write = await client.writeFile({
    workspaceId: record.relayWorkspaceId,
    path,
    baseRevision,
    content: JSON.stringify(record, null, 2),
    contentType: "application/json; charset=utf-8",
  });
  await waitForWrite(client, record.relayWorkspaceId, write.opId);
}

export async function deleteDeploymentRecord(
  relayWorkspaceId: string,
  agentId: string,
): Promise<void> {
  const client = createStoreClient(relayWorkspaceId);
  const path = deploymentPath(agentId);
  let baseRevision = "0";

  try {
    const existing = await client.readFile(relayWorkspaceId, path);
    baseRevision = existing.revision;
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  const deletion = await client.deleteFile({
    workspaceId: relayWorkspaceId,
    path,
    baseRevision,
  });
  await waitForWrite(client, relayWorkspaceId, deletion.opId);
}
