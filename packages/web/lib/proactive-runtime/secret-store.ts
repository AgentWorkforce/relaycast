import {
  credentialCryptoRuntimeInfo,
  decryptCredentialAsync,
  encryptCredentialAsync,
  type EncryptedEnvelope,
} from "@cloud/core/auth/credential-encryption.js";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import { RelayFileApiError, RelayFileClient } from "@relayfile/sdk";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import { getWorkflowScheduleCredentialEncryptionKey } from "@/lib/workflow-schedules/config";

const SECRET_ROOT = "/_agents/secrets";
const STORE_AGENT_NAME = "cloud-proactive-runtime";
const SECRET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

type StoredWorkspaceSecretRecord = {
  name: string;
  envVar: string;
  maskedValue: string;
  valueEnvelope: EncryptedEnvelope;
  createdAt: string;
  updatedAt: string;
};

export type ProactiveWorkspaceSecretRecord = {
  name: string;
  envVar: string;
  maskedValue: string;
  createdAt: string;
  updatedAt: string;
  value?: string;
};

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

function secretPath(name: string): string {
  return `${SECRET_ROOT}/${encodeURIComponent(name)}.json`;
}

function normalizeSecretName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || !SECRET_NAME_PATTERN.test(trimmed)) {
    throw new Error("Secret names must match /^[A-Za-z0-9._-]+$/");
  }
  return trimmed;
}

export function inferSecretEnvVarName(name: string): string {
  const normalized = normalizeSecretName(name).toLowerCase();
  if (normalized.includes("openrouter")) return "OPENROUTER_API_KEY";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "ANTHROPIC_API_KEY";
  if (normalized.includes("openai") || normalized.includes("gpt")) return "OPENAI_API_KEY";
  if (normalized.includes("google") || normalized.includes("gemini")) return "GOOGLE_API_KEY";
  return normalized.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

function maskValue(value: string): string {
  if (value.length <= 8) {
    return "*".repeat(Math.max(4, value.length));
  }
  return `${value.slice(0, 2)}${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

async function normalizeStoredRecord(
  record: StoredWorkspaceSecretRecord,
  includeValue: boolean,
  diagnostics: {
    relayWorkspaceId?: string;
    secretName?: string;
    provider?: string;
    deploymentId?: string;
    agentId?: string;
    source?: string;
  } = {},
): Promise<ProactiveWorkspaceSecretRecord> {
  const normalized: ProactiveWorkspaceSecretRecord = {
    name: record.name,
    envVar: record.envVar,
    maskedValue: record.maskedValue,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (includeValue) {
    try {
      normalized.value = await decryptCredentialAsync(
        record.valueEnvelope,
        getWorkflowScheduleCredentialEncryptionKey(),
      );
    } catch (error) {
      console.error("[proactive-runtime] workspace secret decrypt failed", {
        ...diagnostics,
        secretName: diagnostics.secretName ?? record.name,
        envVar: record.envVar,
        crypto: credentialCryptoRuntimeInfo(record.valueEnvelope),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  return normalized;
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

async function readStoredRecord(
  relayWorkspaceId: string,
  name: string,
): Promise<{ record: StoredWorkspaceSecretRecord; revision: string } | null> {
  const client = createStoreClient(relayWorkspaceId);
  try {
    const file = await client.readFile(relayWorkspaceId, secretPath(name));
    return {
      record: JSON.parse(file.content) as StoredWorkspaceSecretRecord,
      revision: file.revision,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

export async function listWorkspaceSecrets(
  relayWorkspaceId: string,
): Promise<ProactiveWorkspaceSecretRecord[]> {
  const client = createStoreClient(relayWorkspaceId);
  const results: ProactiveWorkspaceSecretRecord[] = [];
  let cursor: string | undefined;

  do {
    const listing = await client.queryFiles(relayWorkspaceId, {
      path: SECRET_ROOT,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });

    for (const item of listing.items) {
      try {
        const file = await client.readFile(relayWorkspaceId, item.path);
        const parsed = JSON.parse(file.content) as StoredWorkspaceSecretRecord;
        results.push(await normalizeStoredRecord(parsed, false));
      } catch {
        // Ignore malformed or concurrently removed records.
      }
    }

    cursor = listing.nextCursor ?? undefined;
  } while (cursor);

  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readWorkspaceSecret(
  relayWorkspaceId: string,
  name: string,
  options: {
    includeValue?: boolean;
    provider?: string;
    deploymentId?: string;
    agentId?: string;
    source?: string;
  } = {},
): Promise<ProactiveWorkspaceSecretRecord | null> {
  const normalizedName = normalizeSecretName(name);
  const stored = await readStoredRecord(relayWorkspaceId, normalizedName);
  if (!stored) {
    return null;
  }
  return normalizeStoredRecord(stored.record, Boolean(options.includeValue), {
    relayWorkspaceId,
    secretName: normalizedName,
    provider: options.provider,
    deploymentId: options.deploymentId,
    agentId: options.agentId,
    source: options.source,
  });
}

export async function writeWorkspaceSecret(input: {
  relayWorkspaceId: string;
  name: string;
  value: string;
  envVar?: string;
}): Promise<ProactiveWorkspaceSecretRecord> {
  const normalizedName = normalizeSecretName(input.name);
  const trimmedValue = input.value.trim();
  if (!trimmedValue) {
    throw new Error("Secret value is required");
  }

  const existing = await readStoredRecord(input.relayWorkspaceId, normalizedName);
  const now = new Date().toISOString();
  const record: StoredWorkspaceSecretRecord = {
    name: normalizedName,
    envVar: input.envVar?.trim() || inferSecretEnvVarName(normalizedName),
    maskedValue: maskValue(trimmedValue),
    valueEnvelope: await encryptCredentialAsync(trimmedValue, getWorkflowScheduleCredentialEncryptionKey()),
    createdAt: existing?.record.createdAt ?? now,
    updatedAt: now,
  };

  const client = createStoreClient(input.relayWorkspaceId);
  const write = await client.writeFile({
    workspaceId: input.relayWorkspaceId,
    path: secretPath(normalizedName),
    baseRevision: existing?.revision ?? "0",
    content: JSON.stringify(record, null, 2),
    contentType: "application/json; charset=utf-8",
  });
  await waitForWrite(client, input.relayWorkspaceId, write.opId);
  return normalizeStoredRecord(record, false);
}

export async function deleteWorkspaceSecret(
  relayWorkspaceId: string,
  name: string,
): Promise<ProactiveWorkspaceSecretRecord | null> {
  const normalizedName = normalizeSecretName(name);
  const existing = await readStoredRecord(relayWorkspaceId, normalizedName);
  if (!existing) {
    return null;
  }

  const client = createStoreClient(relayWorkspaceId);
  const deletion = await client.deleteFile({
    workspaceId: relayWorkspaceId,
    path: secretPath(normalizedName),
    baseRevision: existing.revision,
  });
  await waitForWrite(client, relayWorkspaceId, deletion.opId);
  return normalizeStoredRecord(existing.record, false);
}
