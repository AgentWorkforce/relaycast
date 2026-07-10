import {
  StorageError,
  type ApiKeyStorage,
  type CreateApiKeyInput,
  type ListApiKeysOptions,
  type StoredApiKey,
} from "@relayauth/server/storage/interface";

// Mirrors @relayauth/server/storage/api-key-types.ts. Inlined because
// the canonical type isn't re-exported from /storage/interface.
type ApiKeyKind = "api_key" | "workspace_token";
import type { CloudflareStorageBindings } from "./types.js";

type ApiKeyStorageBindings = Pick<CloudflareStorageBindings, "DB">;

type ApiKeyRow = {
  id?: string;
  name?: string;
  keyHash?: string;
  key_hash?: string;
  keyPrefix?: string;
  key_prefix?: string;
  scopes?: string | string[];
  orgId?: string | null;
  org_id?: string | null;
  kind?: string | null;
  workspaceId?: string | null;
  workspace_id?: string | null;
  createdAt?: number | string;
  created_at?: number | string;
  lastUsedAt?: number | string | null;
  last_used_at?: number | string | null;
  revokedAt?: number | string | null;
  revoked_at?: number | string | null;
};

const API_KEY_SELECT_COLUMNS = `
  SELECT
    id,
    name,
    key_hash AS keyHash,
    key_prefix AS keyPrefix,
    scopes,
    org_id AS orgId,
    kind,
    workspace_id AS workspaceId,
    created_at AS createdAt,
    last_used_at AS lastUsedAt,
    revoked_at AS revokedAt
  FROM api_keys
`;

const API_KEY_TOUCH_DEBOUNCE_MS = 60_000;

/**
 * D1-backed API-key storage for Cloudflare workers.
 *
 * Implements `@relayauth/server/storage/interface`'s `ApiKeyStorage`. The
 * server generates the `id` internally — this adapter inherits that
 * contract, so the INSERT synthesizes an id from crypto.randomUUID().
 *
 * The underlying SQL schema (migrations/0002_api_keys.sql) does not carry
 * a separate `updated_at` column yet; `updatedAt` is derived: it mirrors
 * `createdAt` until the row is revoked, then mirrors `revokedAt`. A
 * follow-up migration can add a real column when another write path
 * needs distinct semantics.
 *
 * `kind` and `workspace_id` were added to the schema by
 * migrations/0002_workspace_agent_tokens.sql (from @relayauth/server).
 * They must be persisted on INSERT so /v1/tokens/path's
 * `resolveWorkspaceToken` accepts `relay_ws_*` keys minted via
 * /v1/tokens/workspace; otherwise the rows fall back to the column
 * default (kind='api_key') and the path-token mint returns 401
 * `workspace_token_required`.
 */
export class CloudflareApiKeyStorage implements ApiKeyStorage {
  constructor(private readonly bindings: ApiKeyStorageBindings) {}

  async create(input: CreateApiKeyInput): Promise<StoredApiKey> {
    const orgId = normalizeRequiredString(input.orgId, "orgId is required");
    const name = normalizeRequiredString(input.name, "apiKey name is required");
    const keyHash = normalizeRequiredString(input.keyHash, "keyHash is required");
    const prefix = normalizeRequiredString(input.prefix, "prefix is required");
    const scopes = normalizeStringArray(input.scopes);
    const kind = normalizeApiKeyKind(input.kind);
    const workspaceId = normalizeOptionalString(input.workspaceId);
    const id = `ak_${crypto.randomUUID().replace(/-/g, "")}`;
    const createdAtMs = input.createdAt
      ? normalizeRequiredTimestamp(input.createdAt, "createdAt must be a valid timestamp")
      : Date.now();

    await this.bindings.DB
      .prepare(`
        INSERT INTO api_keys (
          id,
          name,
          key_hash,
          key_prefix,
          scopes,
          org_id,
          kind,
          workspace_id,
          created_at,
          last_used_at,
          revoked_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `)
      .bind(id, name, keyHash, prefix, JSON.stringify(scopes), orgId, kind, workspaceId ?? null, createdAtMs)
      .run();

    const iso = new Date(createdAtMs).toISOString();
    return {
      id,
      orgId,
      name,
      prefix,
      keyHash,
      scopes,
      kind,
      ...(workspaceId ? { workspaceId } : {}),
      createdAt: iso,
      updatedAt: iso,
    };
  }

  async get(id: string): Promise<StoredApiKey | null> {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) {
      return null;
    }

    const row = await this.bindings.DB
      .prepare(`
        ${API_KEY_SELECT_COLUMNS}
        WHERE id = ?
        LIMIT 1
      `)
      .bind(normalizedId)
      .first<ApiKeyRow>();

    return hydrateApiKey(row);
  }

  async list(orgId: string, options: ListApiKeysOptions = {}): Promise<StoredApiKey[]> {
    const built = buildListApiKeysQuery(orgId, options);
    const result = await this.bindings.DB.prepare(built.sql).bind(...built.params).all<ApiKeyRow>();
    return (result.results ?? [])
      .map(hydrateApiKey)
      .filter((apiKey): apiKey is StoredApiKey => apiKey !== null);
  }

  async revoke(id: string, revokedAt: string): Promise<StoredApiKey> {
    const normalizedId = normalizeRequiredString(id, "apiKey id is required");
    const revokedAtMs = normalizeRequiredTimestamp(revokedAt, "revokedAt is required");

    const existing = await this.get(normalizedId);
    if (!existing) {
      throw new StorageError("api_key_not_found", 404, "api_key_not_found");
    }

    await this.bindings.DB
      .prepare(`
        UPDATE api_keys
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ?
      `)
      .bind(revokedAtMs, normalizedId)
      .run();

    const updated = await this.get(normalizedId);
    if (!updated) {
      throw new StorageError("api_key_not_found", 404, "api_key_not_found");
    }

    return updated;
  }

  async getByHash(keyHash: string): Promise<StoredApiKey | null> {
    const normalizedKeyHash = normalizeOptionalString(keyHash);
    if (!normalizedKeyHash) {
      return null;
    }

    const row = await this.bindings.DB
      .prepare(`
        ${API_KEY_SELECT_COLUMNS}
        WHERE key_hash = ? AND revoked_at IS NULL
        LIMIT 1
      `)
      .bind(normalizedKeyHash)
      .first<ApiKeyRow>();

    return hydrateApiKey(row);
  }

  async touchLastUsed(id: string, usedAt: string): Promise<void> {
    const normalizedId = normalizeRequiredString(id, "apiKey id is required");
    const usedAtMs = normalizeRequiredTimestamp(usedAt, "usedAt is required");
    const updateThresholdMs = usedAtMs - API_KEY_TOUCH_DEBOUNCE_MS;

    await this.bindings.DB
      .prepare(`
        UPDATE api_keys
        SET last_used_at = ?
        WHERE id = ?
          AND revoked_at IS NULL
          AND (last_used_at IS NULL OR last_used_at < ?)
      `)
      .bind(usedAtMs, normalizedId, updateThresholdMs)
      .run();
  }
}

function buildListApiKeysQuery(
  orgId: string,
  options: ListApiKeysOptions,
): { sql: string; params: Array<string | number> } {
  const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required");
  const clauses = ["org_id = ?"];
  const params: Array<string | number> = [normalizedOrgId];

  if (options.cursorId) {
    const normalizedCursorId = normalizeRequiredString(options.cursorId, "cursorId is required");
    clauses.push("(created_at, id) < (SELECT created_at, id FROM api_keys WHERE id = ?)");
    params.push(normalizedCursorId);
  }

  params.push(normalizeListLimit(options.limit));

  return {
    sql: `
      ${API_KEY_SELECT_COLUMNS}
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    params,
  };
}

function hydrateApiKey(row: ApiKeyRow | null): StoredApiKey | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const prefix = normalizeOptionalString(row.keyPrefix) ?? normalizeOptionalString(row.key_prefix);
  const keyHash = normalizeOptionalString(row.keyHash) ?? normalizeOptionalString(row.key_hash);
  const createdAt = normalizeOptionalTimestamp(row.createdAt) ?? normalizeOptionalTimestamp(row.created_at);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  if (!id || !name || !prefix || !keyHash || !createdAt || !orgId) {
    return null;
  }

  const lastUsedAt =
    normalizeOptionalTimestamp(row.lastUsedAt) ?? normalizeOptionalTimestamp(row.last_used_at);
  const revokedAt =
    normalizeOptionalTimestamp(row.revokedAt) ?? normalizeOptionalTimestamp(row.revoked_at);
  const kind = normalizeApiKeyKind(row.kind);
  const workspaceId =
    normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);

  return {
    id,
    orgId,
    name,
    prefix,
    keyHash,
    scopes: parseStringArrayColumn(row.scopes),
    kind,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt,
    updatedAt: revokedAt ?? createdAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function normalizeApiKeyKind(value: unknown): ApiKeyKind {
  return value === "workspace_token" ? "workspace_token" : "api_key";
}

function parseStringArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeListLimit(value: number | undefined): number {
  if (value === undefined) {
    return 50;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new StorageError("limit must be a positive integer", 400, "invalid_storage_input");
  }

  return Math.min(value, 100);
}

function normalizeRequiredString(value: unknown, message: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new StorageError(message, 400, "invalid_storage_input");
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeOptionalString(value) ?? "")
        .filter((value): value is string => value.length > 0),
    ),
  );
}

function normalizeRequiredTimestamp(value: unknown, message: string): number {
  const timestamp = toEpochMilliseconds(value);
  if (timestamp === undefined) {
    throw new StorageError(message, 400, "invalid_storage_input");
  }

  return timestamp;
}

function normalizeOptionalTimestamp(value: unknown): string | undefined {
  const timestamp = toEpochMilliseconds(value);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function toEpochMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return undefined;
    }

    if (/^\d+$/.test(normalized)) {
      const parsedNumber = Number(normalized);
      if (!Number.isFinite(parsedNumber)) {
        return undefined;
      }
      return parsedNumber < 100_000_000_000 ? parsedNumber * 1000 : parsedNumber;
    }

    const parsedDate = Date.parse(normalized);
    return Number.isNaN(parsedDate) ? undefined : parsedDate;
  }

  return undefined;
}
