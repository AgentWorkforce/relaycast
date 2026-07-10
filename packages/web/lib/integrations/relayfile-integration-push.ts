import {
  resolveRelayfileInternalHmacSecret,
  signRelayfileInternalRequest,
} from "./relayfile-writeback-auth";
import { resolveRelayfileConfig } from "../relayfile";
import {
  isAppWorkspaceId,
  isRelayWorkspaceId,
  readBoundRelayWorkspaceId,
} from "../workspaces/relay-workspace-binding";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

type RelayfileWritebackProvider =
  | "confluence"
  | "github"
  | "google-mail"
  | "hubspot"
  | "jira"
  | "linear"
  | "notion"
  | "slack";

export const RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV =
  "RELAYFILE_CLOUD_NANGO_INGEST_ENABLED";

const RELAYFILE_CLOUD_NANGO_INGEST_PROVIDER_CONFIG_KEYS = new Set([
  "github-relay",
  "github-sage",
  "github-app",
  "github-app-oauth",
  "linear-relay",
  "linear-sage",
  "notion-relay",
  "notion-sage",
  "slack-relay",
  "slack-sage",
  "slack-sage-preview",
  "google-mail-relay",
  "google-mail",
  "hubspot-relay",
]);

const RELAYFILE_CLOUD_NANGO_INGEST_CANONICAL_PROVIDERS = new Set([
  "github",
  "hubspot",
  "linear",
  "notion",
  "slack",
  "google-mail",
]);

const DEFAULT_RELAYFILE_CREDENTIAL_PUSH_TIMEOUT_MS = 5000;

export type RelayfileIntegrationPushResult =
  | { ok: true; provider: RelayfileWritebackProvider; status: number }
  | {
      ok: false;
      provider: RelayfileWritebackProvider | null;
      status?: number;
      error: string;
      responseSnippet?: string;
    };

type RelayfileCredentialPushOptions = {
  revoked?: boolean;
  updatedAt?: Date;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
};

export async function pushRelayfileIntegrationCredential(
  integration: WorkspaceIntegrationRecord,
  options: RelayfileCredentialPushOptions = {},
): Promise<RelayfileIntegrationPushResult> {
  const provider = normalizeWritebackProvider(integration.provider);
  if (!provider) {
    return {
      ok: false,
      provider: null,
      error: `unsupported writeback provider: ${integration.provider}`,
    };
  }
  const relayWorkspaceId = await resolveRelayfileCredentialWorkspaceId(
    integration.workspaceId,
  );
  const credential = await resolveRelayfileCredentialPayload(
    integration,
    provider,
    options.revoked ?? false,
  );

  const body = JSON.stringify({
    provider,
    providerConfigKey: credential.providerConfigKey,
    connectionId: credential.connectionId,
    aliasFields: integration.metadata,
    revoked: options.revoked ?? false,
    updatedAt: (options.updatedAt ?? integration.updatedAt).toISOString(),
    writebackDispatchVia: resolveRelayfileCredentialDispatchVia(
      integration,
      options,
    ),
  });
  const timestamp = new Date().toISOString();
  const signature = signRelayfileInternalRequest(
    timestamp,
    body,
    resolveRelayfileInternalHmacSecret(),
  );
  const { relayfileUrl } = resolveRelayfileConfig();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_RELAYFILE_CREDENTIAL_PUSH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(
      `${relayfileUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(
        relayWorkspaceId,
      )}/integrations/${encodeURIComponent(provider)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signature,
          "X-Correlation-Id": crypto.randomUUID(),
        },
        body,
        signal: controller.signal,
      },
    );
  } catch (error) {
    const message = sanitizeLogSnippet(
      error instanceof Error ? error.message : String(error),
    );
    console.error("[relayfile] failed to push integration credential", {
      workspaceId: integration.workspaceId,
      relayWorkspaceId,
      provider,
      error: message,
    });
    return { ok: false, provider, error: message };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const responseSnippet = sanitizeLogSnippet(
      await safeResponseText(response),
    );
    console.error("[relayfile] failed to push integration credential", {
      workspaceId: integration.workspaceId,
      relayWorkspaceId,
      provider,
      status: response.status,
      responseSnippet,
    });
    return {
      ok: false,
      provider,
      status: response.status,
      error: `relayfile credential push returned ${response.status}`,
      responseSnippet,
    };
  }

  return { ok: true, provider, status: response.status };
}

function resolveRelayfileCredentialDispatchVia(
  integration: WorkspaceIntegrationRecord,
  options: Pick<RelayfileCredentialPushOptions, "env">,
): "bridge" | "cf" {
  if (shouldPushRelayfileCloudNangoIngestCredential(integration, options.env)) {
    return "cf";
  }

  return integration.writebackDispatchVia ?? "bridge";
}

export function shouldPushRelayfileCloudNangoIngestCredential(
  integration: Pick<
    WorkspaceIntegrationRecord,
    "provider" | "providerConfigKey"
  >,
  env: Record<string, string | undefined> | null | undefined = readProcessEnv(),
): boolean {
  if (!env || !truthyFlag(env[RELAYFILE_CLOUD_NANGO_INGEST_ENABLED_ENV])) {
    return false;
  }

  return isRelayfileCloudNangoIngestCredentialTarget(integration);
}

export function isRelayfileCloudNangoIngestCredentialTarget(
  integration:
    | Pick<WorkspaceIntegrationRecord, "provider" | "providerConfigKey">
    | null
    | undefined,
): boolean {
  if (!integration) {
    return false;
  }

  const providerConfigKey = integration.providerConfigKey?.trim().toLowerCase();
  if (providerConfigKey) {
    return RELAYFILE_CLOUD_NANGO_INGEST_PROVIDER_CONFIG_KEYS.has(
      providerConfigKey,
    );
  }

  const provider = integration.provider?.trim().toLowerCase();
  return provider
    ? RELAYFILE_CLOUD_NANGO_INGEST_CANONICAL_PROVIDERS.has(provider)
    : false;
}

async function resolveRelayfileCredentialPayload(
  integration: WorkspaceIntegrationRecord,
  provider: RelayfileWritebackProvider,
  revoked: boolean,
): Promise<{ providerConfigKey: string; connectionId: string }> {
  if (provider === "github" && !revoked) {
    const { isGithubInstallationCentricEnabled } =
      await import("./github-installation-centric-flag");
    if (isGithubInstallationCentricEnabled()) {
      const { resolveGithubConnectionForWorkspace } =
        await import("./github-installation-connection");
      const connection = await resolveGithubConnectionForWorkspace(
        integration.workspaceId,
      );
      if (connection) {
        return {
          providerConfigKey: connection.providerConfigKey,
          connectionId: connection.connectionId,
        };
      }
    }
  }

  return {
    providerConfigKey:
      integration.providerConfigKey?.trim() || integration.provider,
    connectionId: integration.connectionId,
  };
}

export function normalizeWritebackProvider(
  provider: string,
): RelayfileWritebackProvider | null {
  const normalized = provider.trim().toLowerCase();
  if (normalized.startsWith("github")) return "github";
  if (
    normalized === "google-mail" ||
    normalized === "google-mail-relay" ||
    normalized === "gmail"
  ) {
    return "google-mail";
  }
  if (normalized.startsWith("slack")) return "slack";
  if (normalized === "hubspot" || normalized === "hubspot-relay") {
    return "hubspot";
  }
  if (
    normalized === "confluence" ||
    normalized === "jira" ||
    normalized === "linear" ||
    normalized === "notion"
  ) {
    return normalized;
  }
  return null;
}

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled"
  );
}

function readProcessEnv(): Record<string, string | undefined> {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }

  return process.env;
}

export async function resolveRelayfileCredentialWorkspaceId(
  workspaceId: string,
): Promise<string> {
  const normalized = workspaceId.trim();
  if (isRelayWorkspaceId(normalized)) {
    return normalized;
  }
  if (isAppWorkspaceId(normalized)) {
    const relayWorkspaceId = await readBoundRelayWorkspaceId(normalized);
    if (relayWorkspaceId) {
      return relayWorkspaceId;
    }
  }
  return normalized;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "unavailable response body";
  }
}

function sanitizeLogSnippet(value: string): string {
  return value
    .replace(
      /authorization\s*:\s*bearer\s+[^\s,;]+/gi,
      "authorization: Bearer [REDACTED]",
    )
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/token[=:]\s*[^\s,;]+/gi, "token=[REDACTED]")
    .slice(0, 512);
}
