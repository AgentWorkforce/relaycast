import type { Role } from "@relayauth/types";
import type { RoleStorage, RoleUpdate } from "@relayauth/server/storage/interface";
import { StorageError } from "@relayauth/server/storage/interface";
import type { CloudflareStorageBindings } from "./types.js";

type RoleStorageBindings = Pick<CloudflareStorageBindings, "DB">;

type RoleRow = {
  id?: string;
  name?: string;
  description?: string;
  scopes?: string | string[];
  scopes_json?: string | string[];
  orgId?: string;
  org_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  builtIn?: boolean | number;
  built_in?: boolean | number;
  createdAt?: string;
  created_at?: string;
};

const SELECT_ROLE_COLUMNS = `
  SELECT
    id,
    name,
    description,
    scopes,
    scopes_json,
    org_id AS orgId,
    workspace_id AS workspaceId,
    built_in AS builtIn,
    created_at AS createdAt
  FROM roles
`;

/**
 * Provides D1-backed CRUD operations for role records.
 */
export class CloudflareRoleStorage implements RoleStorage {
  constructor(private readonly bindings: RoleStorageBindings) {}

  async create(role: Role): Promise<Role> {
    await this.bindings.DB
      .prepare(`
        INSERT INTO roles (
          id,
          name,
          description,
          scopes,
          scopes_json,
          org_id,
          workspace_id,
          built_in,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        role.id,
        role.name,
        role.description,
        JSON.stringify(role.scopes),
        JSON.stringify(role.scopes),
        role.orgId,
        role.workspaceId ?? null,
        role.builtIn ? 1 : 0,
        role.createdAt,
      )
      .run();

    return role;
  }

  async get(id: string, orgId?: string): Promise<Role | null> {
    const normalizedId = normalizeOptionalString(id);
    if (!normalizedId) {
      return null;
    }

    const normalizedOrgId = orgId ? normalizeOptionalString(orgId) : undefined;
    const row = normalizedOrgId
      ? await this.bindings.DB
          .prepare(`
            ${SELECT_ROLE_COLUMNS}
            WHERE id = ? AND org_id = ?
            LIMIT 1
          `)
          .bind(normalizedId, normalizedOrgId)
          .first<RoleRow>()
      : await this.bindings.DB
          .prepare(`
            ${SELECT_ROLE_COLUMNS}
            WHERE id = ?
            LIMIT 1
          `)
          .bind(normalizedId)
          .first<RoleRow>();

    return hydrateRole(row);
  }

  async list(orgId: string, workspaceId?: string): Promise<Role[]> {
    const normalizedOrgId = normalizeRequiredString(orgId, "orgId is required");
    const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
    const query = normalizedWorkspaceId
      ? {
          sql: `
            ${SELECT_ROLE_COLUMNS}
            WHERE org_id = ?
              AND (workspace_id = ? OR workspace_id IS NULL)
            ORDER BY name ASC, id ASC
          `,
          params: [normalizedOrgId, normalizedWorkspaceId],
        }
      : {
          sql: `
            ${SELECT_ROLE_COLUMNS}
            WHERE org_id = ?
            ORDER BY name ASC, id ASC
          `,
          params: [normalizedOrgId],
        };

    const result = await this.bindings.DB.prepare(query.sql).bind(...query.params).all<RoleRow>();
    return (result.results ?? [])
      .map(hydrateRole)
      .filter((role): role is Role => role !== null)
      .filter((role) =>
        role.orgId === normalizedOrgId
        && (normalizedWorkspaceId === undefined
          || role.workspaceId === undefined
          || role.workspaceId === normalizedWorkspaceId),
      );
  }

  async update(id: string, patch: RoleUpdate): Promise<Role> {
    const current = await this.get(id);
    if (!current) {
      throw new StorageError("role_not_found", 404, "role_not_found");
    }

    const next: Role = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
    };

    await this.bindings.DB
      .prepare(`
        UPDATE roles
        SET name = ?, description = ?, scopes = ?, scopes_json = ?
        WHERE id = ? AND org_id = ?
      `)
      .bind(
        next.name,
        next.description,
        JSON.stringify(next.scopes),
        JSON.stringify(next.scopes),
        current.id,
        current.orgId,
      )
      .run();

    return next;
  }

  async delete(id: string): Promise<void> {
    const role = await this.get(id);
    if (!role) {
      throw new StorageError("role_not_found", 404, "role_not_found");
    }

    await this.bindings.DB
      .prepare(`
        DELETE FROM roles
        WHERE id = ? AND org_id = ?
      `)
      .bind(role.id, role.orgId)
      .run();
  }

  async listByIds(roleIds: string[]): Promise<Role[]> {
    const uniqueRoleIds = Array.from(
      new Set(
        roleIds
          .filter((roleId): roleId is string => typeof roleId === "string")
          .map((roleId) => roleId.trim())
          .filter(Boolean),
      ),
    );
    if (uniqueRoleIds.length === 0) {
      return [];
    }

    const placeholders = uniqueRoleIds.map(() => "?").join(", ");
    const result = await this.bindings.DB
      .prepare(`
        ${SELECT_ROLE_COLUMNS}
        WHERE id IN (${placeholders})
      `)
      .bind(...uniqueRoleIds)
      .all<RoleRow>();

    return (result.results ?? [])
      .map(hydrateRole)
      .filter((role): role is Role => role !== null);
  }
}

function hydrateRole(row: RoleRow | null): Role | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const description = normalizeOptionalString(row.description);
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  if (!id || !name || !description || !orgId || !createdAt) {
    return null;
  }

  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const builtIn = row.builtIn === true || row.builtIn === 1 || row.built_in === true || row.built_in === 1;

  return {
    id,
    name,
    description,
    scopes: parseStringArrayColumn(row.scopes_json ?? row.scopes),
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    builtIn,
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
