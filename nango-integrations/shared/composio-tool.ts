import type { NangoAction, NangoSync } from "nango";

export const COMPOSIO_BASE_URL = "https://backend.composio.dev";
export const COMPOSIO_TOOLS_API = "/api/v3/tools/execute";
export const COMPOSIO_PROXY_USER_AGENT = "axios/1.15.0";

export type NangoClient = NangoSync | NangoAction;

interface ComposioExecuteResponse<TData = unknown> {
  data: TData;
  successful: boolean;
  error: string | { message?: string } | null;
}

export interface ComposioContext {
  apiKey: string;
  connectedAccountId: string;
  userId: string;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const extractComposioConnectedAccountId = (
  connection: Record<string, unknown> | undefined,
  connectionId: string,
): string => {
  const tags = (connection?.["tags"] ?? {}) as Record<string, unknown>;
  const tagId = tags["composio_connected_account_id"];
  if (isNonEmptyString(tagId)) return tagId;
  const metadata = (connection?.["metadata"] ?? {}) as Record<string, unknown>;
  const composio = (metadata["composio"] ?? {}) as Record<string, unknown>;
  const composioId = composio["connectedAccountId"];
  if (isNonEmptyString(composioId)) return composioId;
  return connectionId;
};

const extractComposioUserId = (
  connection: Record<string, unknown> | undefined,
  missingUserIdMessage: string,
): string => {
  const tags = (connection?.["tags"] ?? {}) as Record<string, unknown>;
  const endUser = tags["end_user_id"];
  if (isNonEmptyString(endUser)) return endUser;
  const workspace = tags["workspaceid"];
  if (isNonEmptyString(workspace)) return workspace;
  throw new Error(missingUserIdMessage);
};

export interface GetComposioContextOptions {
  missingUserIdMessage?: string;
}

export const getComposioContext = async (
  nango: NangoClient,
  options: GetComposioContextOptions = {},
): Promise<ComposioContext> => {
  const envVars = await nango.getEnvironmentVariables();
  const apiKeyVar = (envVars ?? []).find((v) => v.name === "COMPOSIO_API_KEY");
  if (!apiKeyVar?.value) {
    throw new Error(
      "COMPOSIO_API_KEY env var missing on Nango environment. Set it via Nango UI > Environment Settings.",
    );
  }

  const connection = (await nango.getConnection()) as unknown as Record<string, unknown>;
  const connectionId = String(connection["connection_id"] ?? "");
  if (!connectionId) throw new Error("Nango connection_id unavailable in sync context");

  return {
    apiKey: apiKeyVar.value,
    connectedAccountId: extractComposioConnectedAccountId(connection, connectionId),
    userId: extractComposioUserId(
      connection,
      options.missingUserIdMessage ??
        "Composio user_id missing: expected `tags.end_user_id` on the Nango connection. Re-link the connection.",
    ),
  };
};

export interface ExecuteComposioToolRequestOptions<TArgs extends Record<string, unknown>> {
  toolSlug: string;
  arguments: TArgs;
  version?: string;
  retries?: number;
}

export const executeComposioToolRequest = async <
  TData = unknown,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
>(
  nango: NangoClient,
  ctx: ComposioContext,
  options: ExecuteComposioToolRequestOptions<TArgs>,
): Promise<TData> => {
  const proxyConfig: Parameters<NangoClient["proxy"]>[0] = {
    method: "POST",
    baseUrlOverride: COMPOSIO_BASE_URL,
    endpoint: `${COMPOSIO_TOOLS_API}/${options.toolSlug}`,
    headers: {
      "x-api-key": ctx.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": COMPOSIO_PROXY_USER_AGENT,
    },
    data: {
      connected_account_id: ctx.connectedAccountId,
      user_id: ctx.userId,
      ...(options.version ? { version: options.version } : {}),
      arguments: options.arguments,
    },
  };
  if (options.retries !== undefined) {
    proxyConfig.retries = options.retries;
  }
  const response = await nango.proxy(proxyConfig);

  const body = response.data as ComposioExecuteResponse<TData>;
  if (!body || typeof body !== "object") {
    throw new Error(`Composio tool ${options.toolSlug} returned non-JSON response`);
  }
  if (body.successful === false) {
    const message =
      typeof body.error === "string"
        ? body.error
        : body.error && typeof body.error === "object"
          ? body.error.message ?? JSON.stringify(body.error)
          : "unknown error";
    throw new Error(`Composio tool ${options.toolSlug} failed: ${message}`);
  }
  return body.data;
};
