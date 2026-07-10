import type {
  IntegrationCredential,
  WritebackProvider,
} from "../../writeback/types.js";

type Row = Record<string, unknown>;

type SqlStorageLike = {
  exec(query: string, ...bindings: unknown[]): unknown;
};

export interface IntegrationHandlerContext {
  sql: SqlStorageLike;
  one<T extends Row = Row>(query: string, ...bindings: unknown[]): T | null;
  readJson<T>(request: Request): Promise<T>;
  resolveWorkspaceId(
    request: Request,
    body?: { workspaceId?: string },
  ): Promise<string | null>;
  json(payload: unknown, status?: number, headers?: HeadersInit): Response;
  errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Response;
}

type IntegrationCredentialPush = {
  provider?: string;
  providerConfigKey?: string;
  connectionId?: string;
  aliasFields?: Record<string, unknown>;
  revoked?: boolean;
  updatedAt?: string;
  writebackDispatchVia?: "bridge" | "cf";
};

const WRITEBACK_PROVIDERS = new Set<string>([
  "confluence",
  "github",
  "jira",
  "linear",
  "notion",
  "slack",
]);

export async function handleUpsertIntegrationCredential(
  ctx: IntegrationHandlerContext,
  request: Request,
  providerParam: string,
): Promise<Response> {
  const body = await ctx.readJson<IntegrationCredentialPush>(request);
  const workspaceId = await ctx.resolveWorkspaceId(request);
  const provider = normalizeProvider(providerParam);
  if (!workspaceId) {
    return ctx.errorResponse(
      request,
      400,
      "invalid_input",
      "missing workspaceId",
    );
  }
  if (!provider) {
    return ctx.errorResponse(
      request,
      400,
      "invalid_input",
      "unsupported provider",
    );
  }
  if (body.provider && normalizeProvider(body.provider) !== provider) {
    return ctx.errorResponse(
      request,
      400,
      "invalid_input",
      "provider does not match route",
    );
  }
  const updatedAt = normalizeIsoTimestamp(body.updatedAt);
  if (!updatedAt) {
    return ctx.errorResponse(
      request,
      400,
      "invalid_input",
      "invalid updatedAt",
    );
  }

  const existing = readIntegrationRow(ctx, provider);
  if (existing && Date.parse(existing.updated_at) > Date.parse(updatedAt)) {
    return ctx.json({
      status: "ignored",
      provider,
      updatedAt: existing.updated_at,
    });
  }

  if (body.revoked) {
    ctx.sql.exec("DELETE FROM integrations WHERE provider = ?", provider);
    return ctx.json({ status: "deleted", provider, updatedAt });
  }

  const providerConfigKey = body.providerConfigKey?.trim();
  const connectionId = body.connectionId?.trim();
  if (!providerConfigKey || !connectionId) {
    return ctx.errorResponse(
      request,
      400,
      "invalid_input",
      "providerConfigKey and connectionId are required",
    );
  }
  const dispatchVia = normalizeWritebackDispatchVia(body.writebackDispatchVia);
  if (!dispatchVia) {
    return ctx.errorResponse(
      request,
      400,
      "invalid_input",
      "invalid writebackDispatchVia",
    );
  }

  ctx.sql.exec(
    `
      INSERT INTO integrations (
        provider,
        provider_config_key,
        connection_id,
        alias_fields_json,
        writeback_dispatch_via,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        provider_config_key = excluded.provider_config_key,
        connection_id = excluded.connection_id,
        alias_fields_json = excluded.alias_fields_json,
        writeback_dispatch_via = excluded.writeback_dispatch_via,
        updated_at = excluded.updated_at
    `,
    provider,
    providerConfigKey,
    connectionId,
    JSON.stringify(body.aliasFields ?? {}),
    dispatchVia,
    updatedAt,
  );

  return ctx.json({
    status: "stored",
    provider,
    writebackDispatchVia: dispatchVia,
    updatedAt,
  });
}

export async function handleGetIntegrationCredential(
  ctx: IntegrationHandlerContext,
  request: Request,
  providerParam: string,
): Promise<Response> {
  const provider = normalizeProvider(providerParam);
  if (!provider) {
    return ctx.errorResponse(
      request,
      404,
      "not_found",
      "integration not found",
    );
  }
  const row = readIntegrationRow(ctx, provider);
  if (!row) {
    return ctx.errorResponse(
      request,
      404,
      "not_found",
      "integration not found",
    );
  }
  return ctx.json(rowToCredential(row));
}

function readIntegrationRow(
  ctx: IntegrationHandlerContext,
  provider: WritebackProvider,
): {
  provider: string;
  provider_config_key: string;
  connection_id: string;
  alias_fields_json: string;
  writeback_dispatch_via: string;
  updated_at: string;
} | null {
  return ctx.one(
    `
      SELECT provider, provider_config_key, connection_id, alias_fields_json,
             writeback_dispatch_via, updated_at
      FROM integrations
      WHERE provider = ?
    `,
    provider,
  );
}

function rowToCredential(row: {
  provider: string;
  provider_config_key: string;
  connection_id: string;
  alias_fields_json: string;
  writeback_dispatch_via: string;
  updated_at: string;
}): IntegrationCredential {
  return {
    provider: normalizeProvider(row.provider) ?? "notion",
    providerConfigKey: row.provider_config_key,
    connectionId: row.connection_id,
    aliasFields: parseAliasFields(row.alias_fields_json),
    writebackDispatchVia: row.writeback_dispatch_via === "cf" ? "cf" : "bridge",
    updatedAt: row.updated_at,
  };
}

function normalizeProvider(
  value: string | undefined,
): WritebackProvider | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && WRITEBACK_PROVIDERS.has(normalized)
    ? (normalized as WritebackProvider)
    : null;
}

function normalizeWritebackDispatchVia(value: unknown): "bridge" | "cf" | null {
  if (value === undefined) {
    return "bridge";
  }
  return value === "bridge" || value === "cf" ? value : null;
}

function normalizeIsoTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseAliasFields(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
