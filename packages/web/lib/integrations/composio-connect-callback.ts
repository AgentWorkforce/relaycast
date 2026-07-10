import { createHmac, timingSafeEqual } from "node:crypto";
import {
  markProviderInitialSyncComplete,
  markProviderInitialSyncFailed,
  markProviderInitialSyncQueued,
  markProviderOAuthConnected,
} from "@cloud/core/provider-readiness.js";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { getComposioConnectedAccount, type ComposioConnectedAccount } from "./composio-service";
import {
  getComposioBridgeProviderConfigKey,
  getComposioBridgeSyncNames,
  triggerNangoSyncs,
  upsertNangoComposioBridgeConnection,
} from "./nango-service";
import {
  resolveWorkspaceIntegrationProvider,
} from "./providers";
import {
  upsertWorkspaceIntegration,
  type WorkspaceIntegrationRecord,
} from "./workspace-integrations";

const STATE_VERSION = 1;
const CALLBACK_PATH = "/api/v1/webhooks/composio/connect/callback";
const STATE_MAX_AGE_MS = 60 * 60 * 1000;

export type ComposioConnectCallbackState = {
  workspaceId: string;
  provider: string;
  authConfigId?: string | null;
  toolkitSlug?: string | null;
  integrationId?: string | null;
  returnTo?: string | null;
  dockerHubUsername?: string | null;
};

type EncodedComposioConnectCallbackState = ComposioConnectCallbackState & {
  version: typeof STATE_VERSION;
  issuedAt: string;
};

export type ComposioConnectCallbackResult = {
  ok: true;
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string;
  syncs: string[];
  syncTriggered: boolean;
  returnTo: string | null;
  integration: WorkspaceIntegrationRecord;
};

type CallbackDeps = {
  getConnectedAccount: typeof getComposioConnectedAccount;
  upsertIntegration: typeof upsertWorkspaceIntegration;
  markOAuthConnected: typeof markProviderOAuthConnected;
  markInitialSyncQueued: typeof markProviderInitialSyncQueued;
  markInitialSyncComplete: typeof markProviderInitialSyncComplete;
  markInitialSyncFailed: typeof markProviderInitialSyncFailed;
  upsertNangoBridgeConnection: typeof upsertNangoComposioBridgeConnection;
  triggerSyncs: typeof triggerNangoSyncs;
};

const defaultDeps: CallbackDeps = {
  getConnectedAccount: getComposioConnectedAccount,
  upsertIntegration: upsertWorkspaceIntegration,
  markOAuthConnected: markProviderOAuthConnected,
  markInitialSyncQueued: markProviderInitialSyncQueued,
  markInitialSyncComplete: markProviderInitialSyncComplete,
  markInitialSyncFailed: markProviderInitialSyncFailed,
  upsertNangoBridgeConnection: upsertNangoComposioBridgeConnection,
  triggerSyncs: triggerNangoSyncs,
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readNestedString(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    const record = readRecord(current);
    if (!record) return null;
    current = record[key];
  }
  return readString(current);
}

function normalizeReturnTo(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return null;
  }
  return trimmed;
}

function assertFreshState(state: EncodedComposioConnectCallbackState): void {
  const issuedAtMs = Date.parse(state.issuedAt);
  if (!Number.isFinite(issuedAtMs) || Date.now() - issuedAtMs > STATE_MAX_AGE_MS) {
    throw new Error("expired_state");
  }
}

export function createComposioConnectCallbackState(
  input: ComposioConnectCallbackState,
  secret = getAuthSessionSecret(),
): string {
  const payload: EncodedComposioConnectCallbackState = {
    ...input,
    returnTo: normalizeReturnTo(input.returnTo),
    version: STATE_VERSION,
    issuedAt: new Date().toISOString(),
  };
  const encoded = base64UrlJson(payload);
  return `${encoded}.${signPayload(encoded, secret)}`;
}

export function parseComposioConnectCallbackState(
  state: string,
  secret = getAuthSessionSecret(),
): EncodedComposioConnectCallbackState {
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra !== undefined) {
    throw new Error("invalid_state");
  }

  const expected = signPayload(encoded, secret);
  if (!safeEqual(signature, expected)) {
    throw new Error("invalid_state_signature");
  }

  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  const record = readRecord(parsed);
  const workspaceId = readString(record?.workspaceId);
  const provider = readString(record?.provider);
  if (!record || record.version !== STATE_VERSION || !workspaceId || !provider) {
    throw new Error("invalid_state_payload");
  }

  return {
    version: STATE_VERSION,
    issuedAt: readString(record.issuedAt) ?? new Date(0).toISOString(),
    workspaceId,
    provider: resolveWorkspaceIntegrationProvider(provider) ?? provider,
    authConfigId: readString(record.authConfigId),
    toolkitSlug: readString(record.toolkitSlug),
    integrationId: readString(record.integrationId),
    returnTo: normalizeReturnTo(readString(record.returnTo)),
    dockerHubUsername: readString(record.dockerHubUsername),
  };
}

export function buildComposioConnectCallbackUrl(input: {
  baseUrl: string;
  state: ComposioConnectCallbackState;
  secret?: string;
}): string {
  const url = toAbsoluteAppUrl(new URL(input.baseUrl).origin, CALLBACK_PATH);
  url.searchParams.set(
    "state",
    createComposioConnectCallbackState(input.state, input.secret ?? getAuthSessionSecret()),
  );
  return url.toString();
}

function getConnectedAccountId(url: URL): string | null {
  return (
    readString(url.searchParams.get("connected_account_id")) ??
    readString(url.searchParams.get("connectedAccountId")) ??
    readString(url.searchParams.get("connected_accountId")) ??
    readString(url.searchParams.get("connectionId"))
  );
}

function getAccountStatus(account: ComposioConnectedAccount): string | null {
  return readString(account.status)?.toUpperCase() ?? null;
}

function getAccountAuthConfigId(account: ComposioConnectedAccount): string | null {
  return (
    readNestedString(account, "auth_config", "id") ??
    readNestedString(account, "authConfig", "id") ??
    readString(account.auth_config_id) ??
    readString(account.authConfigId)
  );
}

function getAccountToolkitSlug(account: ComposioConnectedAccount): string | null {
  return (
    readNestedString(account, "toolkit", "slug") ??
    readString(account.toolkit_slug) ??
    readString(account.toolkitSlug)
  );
}

function getAccountIntegrationId(account: ComposioConnectedAccount): string | null {
  return (
    readNestedString(account, "integration", "id") ??
    readString(account.integration_id) ??
    readString(account.integrationId)
  );
}

function buildMetadata(input: {
  state: EncodedComposioConnectCallbackState;
  account: ComposioConnectedAccount;
  connectionId: string;
  providerConfigKey: string;
  syncs: string[];
}): Record<string, unknown> {
  const authConfigId = getAccountAuthConfigId(input.account) ?? input.state.authConfigId ?? null;
  const toolkitSlug = getAccountToolkitSlug(input.account) ?? input.state.toolkitSlug ?? null;
  const integrationId = getAccountIntegrationId(input.account) ?? input.state.integrationId ?? null;
  const dockerHubUsername = input.state.dockerHubUsername?.trim() || null;

  return {
    backend: "composio",
    ...(dockerHubUsername ? { namespace: dockerHubUsername } : {}),
    composio: {
      connectedAccountId: input.connectionId,
      authConfigId,
      toolkitSlug,
      integrationId,
      status: getAccountStatus(input.account),
    },
    nangoBridge: {
      providerConfigKey: input.providerConfigKey,
      syncs: input.syncs,
    },
  };
}

export async function handleComposioConnectCallback(
  url: URL,
  deps: CallbackDeps = defaultDeps,
): Promise<ComposioConnectCallbackResult> {
  const stateParam = readString(url.searchParams.get("state"));
  if (!stateParam) {
    throw new Error("missing_state");
  }

  const state = parseComposioConnectCallbackState(stateParam);
  assertFreshState(state);
  const status = readString(url.searchParams.get("status"))?.toLowerCase();
  if (status && status !== "success") {
    throw new Error("composio_connection_failed");
  }

  const connectionId = getConnectedAccountId(url);
  if (!connectionId) {
    throw new Error("missing_connected_account_id");
  }

  const account = await deps.getConnectedAccount(connectionId);
  if (!account) {
    throw new Error("connected_account_not_found");
  }

  const accountStatus = getAccountStatus(account);
  if (accountStatus !== "ACTIVE") {
    throw new Error(`connected_account_not_active:${accountStatus ?? "UNKNOWN"}`);
  }

  const providerConfigKey = getComposioBridgeProviderConfigKey(state.provider);
  const syncs = getComposioBridgeSyncNames(state.provider);
  const metadata = buildMetadata({
    state,
    account,
    connectionId,
    providerConfigKey,
    syncs,
  });

  const integration = await deps.upsertIntegration({
    workspaceId: state.workspaceId,
    provider: state.provider,
    connectionId,
    providerConfigKey,
    metadata,
  });
  await deps.markOAuthConnected({
    workspaceId: state.workspaceId,
    provider: state.provider,
    connectionId,
    providerConfigKey,
  });

  const bridgeResult = await deps.upsertNangoBridgeConnection({
    workspaceId: state.workspaceId,
    provider: state.provider,
    providerConfigKey,
    connectionId,
    metadata,
  });
  if (!bridgeResult.ok) {
    await deps.markInitialSyncFailed({
      workspaceId: state.workspaceId,
      provider: state.provider,
      error: `Failed to create Nango Composio bridge connection: ${bridgeResult.status}`,
      syncName: syncs.join(","),
    });
    throw new Error("nango_bridge_connection_failed");
  }

  if (syncs.length === 0) {
    await deps.markInitialSyncComplete({
      workspaceId: state.workspaceId,
      provider: state.provider,
      syncName: null,
    });
    return {
      ok: true,
      workspaceId: state.workspaceId,
      provider: state.provider,
      connectionId,
      providerConfigKey,
      syncs,
      syncTriggered: false,
      returnTo: state.returnTo ?? null,
      integration,
    };
  }

  const syncResult = await deps.triggerSyncs({
    providerConfigKey,
    connectionId,
    syncs,
    syncMode: "incremental",
  });
  if (!syncResult.ok) {
    await deps.markInitialSyncFailed({
      workspaceId: state.workspaceId,
      provider: state.provider,
      error: `Failed to trigger Nango syncs: ${syncResult.status}`,
      syncName: syncs.join(","),
    });
    throw new Error("nango_sync_trigger_failed");
  }

  await deps.markInitialSyncQueued({
    workspaceId: state.workspaceId,
    provider: state.provider,
    syncName: syncs.join(","),
  });

  return {
    ok: true,
    workspaceId: state.workspaceId,
    provider: state.provider,
    connectionId,
    providerConfigKey,
    syncs,
    syncTriggered: true,
    returnTo: state.returnTo ?? null,
    integration,
  };
}
