import type { Policy } from "@relayauth/types";
import type { PolicyStorage, PolicyUpdate } from "@relayauth/server/storage/interface";
import { StorageError } from "@relayauth/server/storage/interface";
import type { CloudflareStorageBindings } from "./types.js";

type PolicyStorageBindings = Pick<CloudflareStorageBindings, "DB">;

type PolicyRow = {
  id?: string;
  name?: string;
  effect?: Policy["effect"];
  scopes?: string | string[];
  scopes_json?: string | string[];
  conditions?: string | Policy["conditions"];
  conditions_json?: string | Policy["conditions"];
  priority?: number | string;
  orgId?: string;
  org_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  createdAt?: string;
  created_at?: string;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

const SELECT_POLICY_COLUMNS = `
  SELECT
    id,
    name,
    effect,
    scopes,
    scopes_json,
    conditions,
    conditions_json,
    priority,
    org_id AS orgId,
    workspace_id AS workspaceId,
    created_at AS createdAt,
    deleted_at AS deletedAt
  FROM policies
`;

/**
 * Provides D1-backed CRUD operations for policy records.
 */
export class CloudflarePolicyStorage implements PolicyStorage {
  constructor(private readonly bindings: PolicyStorageBindings) {}

  async create(policy: Policy): Promise<Policy> {
    await this.bindings.DB
      .prepare(`
        INSERT INTO policies (
          id,
          name,
          effect,
          scopes,
          scopes_json,
          conditions,
          conditions_json,
          priority,
          org_id,
          workspace_id,
          created_at,
          deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        policy.id,
        policy.name,
        policy.effect,
        JSON.stringify(policy.scopes),
        JSON.stringify(policy.scopes),
        JSON.stringify(policy.conditions),
        JSON.stringify(policy.conditions),
        policy.priority,
        policy.orgId,
        policy.workspaceId ?? null,
        policy.createdAt,
        null,
      )
      .run();

    return policy;
  }

  async get(id: string, orgId?: string): Promise<Policy | null> {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) {
      return null;
    }

    const normalizedOrgId = orgId ? normalizeOptionalString(orgId) : undefined;
    const row = normalizedOrgId
      ? await this.bindings.DB
          .prepare(`
            ${SELECT_POLICY_COLUMNS}
            WHERE id = ? AND org_id = ? AND deleted_at IS NULL
            LIMIT 1
          `)
          .bind(normalizedId, normalizedOrgId)
          .first<PolicyRow>()
      : await this.bindings.DB
          .prepare(`
            ${SELECT_POLICY_COLUMNS}
            WHERE id = ? AND deleted_at IS NULL
            LIMIT 1
          `)
          .bind(normalizedId)
          .first<PolicyRow>();

    return hydratePolicy(row);
  }

  async list(orgId: string, workspaceId?: string): Promise<Policy[]> {
    const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required");
    const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
    const query = normalizedWorkspaceId
      ? {
          sql: `
            ${SELECT_POLICY_COLUMNS}
            WHERE org_id = ?
              AND deleted_at IS NULL
              AND (workspace_id = ? OR workspace_id IS NULL)
            ORDER BY priority DESC, id ASC
          `,
          params: [normalizedOrgId, normalizedWorkspaceId],
        }
      : {
          sql: `
            ${SELECT_POLICY_COLUMNS}
            WHERE org_id = ?
              AND deleted_at IS NULL
            ORDER BY priority DESC, id ASC
          `,
          params: [normalizedOrgId],
        };

    const result = await this.bindings.DB.prepare(query.sql).bind(...query.params).all<PolicyRow>();
    return (result.results ?? [])
      .map(hydratePolicy)
      .filter((policy): policy is Policy => policy !== null)
      .filter((policy) =>
        policy.orgId === normalizedOrgId
        && (normalizedWorkspaceId === undefined
          || policy.workspaceId === undefined
          || policy.workspaceId === normalizedWorkspaceId),
      );
  }

  async update(id: string, patch: PolicyUpdate): Promise<Policy> {
    const current = await this.get(id);
    if (!current) {
      throw new StorageError("policy_not_found", 404, "policy_not_found");
    }

    const next: Policy = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.effect !== undefined ? { effect: patch.effect } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
      ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    };

    await this.bindings.DB
      .prepare(`
        UPDATE policies
        SET name = ?, effect = ?, scopes = ?, scopes_json = ?, conditions = ?, conditions_json = ?, priority = ?
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      `)
      .bind(
        next.name,
        next.effect,
        JSON.stringify(next.scopes),
        JSON.stringify(next.scopes),
        JSON.stringify(next.conditions),
        JSON.stringify(next.conditions),
        next.priority,
        current.id,
        current.orgId,
      )
      .run();

    return next;
  }

  async delete(id: string): Promise<void> {
    const policy = await this.get(id);
    if (!policy) {
      throw new StorageError("policy_not_found", 404, "policy_not_found");
    }

    await this.bindings.DB
      .prepare(`
        UPDATE policies
        SET deleted_at = ?
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      `)
      .bind(new Date().toISOString(), policy.id, policy.orgId)
      .run();
  }
}

function hydratePolicy(row: PolicyRow | null): Policy | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const effect = row.effect;
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  const deletedAt = normalizeOptionalString(row.deletedAt) ?? normalizeOptionalString(row.deleted_at);
  if (!id || !name || !effect || !orgId || !createdAt || deletedAt) {
    return null;
  }

  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const priority = typeof row.priority === "number" ? row.priority : Number(row.priority);
  if (!Number.isInteger(priority)) {
    return null;
  }

  return {
    id,
    name,
    effect,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    conditions: parseConditionsColumn(row.conditions_json ?? row.conditions),
    priority,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt,
  };
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

function parseConditionsColumn(value: unknown): Policy["conditions"] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Policy["conditions"][number] =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseConditionsColumn(parsed);
  } catch {
    return [];
  }
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
