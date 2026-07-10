import assert from "node:assert/strict";
import test from "node:test";
import type { Policy, PolicyCondition, PolicyEffect, Role } from "@relayauth/types";
import type { StoredIdentity } from "../durable-objects/identity-do.js";
import { generateTestIdentity, mockD1 } from "./test-helpers.js";

type OrganizationRecord = {
  id: string;
  name: string;
  scopes: string[];
  roles: string[];
  createdAt: string;
  updatedAt: string;
};

type WorkspaceRecord = {
  id: string;
  name: string;
  orgId: string;
  scopes: string[];
  roles: string[];
  createdAt: string;
  updatedAt: string;
};

type StoredPolicy = Policy & {
  deletedAt?: string | null;
};

type InheritanceChain = {
  org: {
    scopes: string[];
    roles: Role[];
    policies: Policy[];
  };
  workspace: {
    scopes: string[];
    roles: Role[];
    policies: Policy[];
  };
  agent: {
    scopes: string[];
    roles: Role[];
  };
  effective: string[];
};

type ScopeInheritanceModule = {
  resolveInheritedScopes?: (db: D1Database, identityId: string) => Promise<string[]>;
  getInheritanceChain?: (db: D1Database, identityId: string) => Promise<InheritanceChain>;
};

type IdentityRow = {
  id: string;
  name: string;
  type: string;
  orgId: string;
  org_id: string;
  status: string;
  scopes: string[];
  scopes_json: string;
  roles: string[];
  roles_json: string;
  metadata: Record<string, string>;
  metadata_json: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
  sponsorId: string;
  sponsor_id: string;
  sponsorChain: string[];
  sponsor_chain: string;
  sponsor_chain_json: string;
  workspaceId: string;
  workspace_id: string;
};

type RoleRow = {
  id: string;
  name: string;
  description: string;
  scopes: string[];
  scopes_json: string;
  orgId: string;
  org_id: string;
  workspaceId?: string;
  workspace_id?: string;
  builtIn: boolean;
  built_in: number;
  createdAt: string;
  created_at: string;
};

type PolicyRow = {
  id: string;
  name: string;
  effect: PolicyEffect;
  scopes: string[];
  scopes_json: string;
  conditions: PolicyCondition[];
  conditions_json: string;
  priority: number;
  orgId: string;
  org_id: string;
  workspaceId?: string;
  workspace_id?: string;
  createdAt: string;
  created_at: string;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

type OrganizationRow = {
  id: string;
  orgId: string;
  org_id: string;
  name: string;
  scopes: string[];
  scopes_json: string;
  roles: string[];
  roles_json: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  workspaceId: string;
  workspace_id: string;
  orgId: string;
  org_id: string;
  name: string;
  scopes: string[];
  scopes_json: string;
  roles: string[];
  roles_json: string;
  createdAt: string;
  created_at: string;
  updatedAt: string;
  updated_at: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity({
    ...overrides,
    id: overrides.id ?? "agent_scope_inheritance",
    orgId: overrides.orgId ?? "org_acme",
    roles: overrides.roles ?? [],
    scopes: overrides.scopes ?? [],
    status: overrides.status ?? "active",
  });
  const sponsorId = overrides.sponsorId ?? "user_owner_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, base.id],
    workspaceId: overrides.workspaceId ?? "ws_default",
  };
}

function createRole(overrides: Partial<Role> = {}): Role {
  return {
    id: overrides.id ?? "role_scope_reader",
    name: overrides.name ?? "scope-reader",
    description: overrides.description ?? "Scope inheritance role",
    scopes: overrides.scopes ?? ["relayfile:fs:read:/org/*"],
    orgId: overrides.orgId ?? "org_acme",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    builtIn: overrides.builtIn ?? false,
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function createPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: overrides.id ?? "pol_scope_rule",
    name: overrides.name ?? "scope-rule",
    effect: overrides.effect ?? "allow",
    scopes: overrides.scopes ?? ["relayfile:fs:read:/org/*"],
    conditions: overrides.conditions ?? [],
    priority: overrides.priority ?? 500,
    orgId: overrides.orgId ?? "org_acme",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
  };
}

function createOrganization(overrides: Partial<OrganizationRecord> = {}): OrganizationRecord {
  return {
    id: overrides.id ?? "org_acme",
    name: overrides.name ?? "Acme",
    scopes: overrides.scopes ?? [],
    roles: overrides.roles ?? [],
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function createWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: overrides.id ?? "ws_default",
    name: overrides.name ?? "Default Workspace",
    orgId: overrides.orgId ?? "org_acme",
    scopes: overrides.scopes ?? [],
    roles: overrides.roles ?? [],
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function toIdentityRow(identity: StoredIdentity): IdentityRow {
  const metadata = clone(identity.metadata ?? {});

  return {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    orgId: identity.orgId,
    org_id: identity.orgId,
    status: identity.status,
    scopes: [...identity.scopes],
    scopes_json: JSON.stringify(identity.scopes),
    roles: [...identity.roles],
    roles_json: JSON.stringify(identity.roles),
    metadata,
    metadata_json: JSON.stringify(metadata),
    createdAt: identity.createdAt,
    created_at: identity.createdAt,
    updatedAt: identity.updatedAt,
    updated_at: identity.updatedAt,
    sponsorId: identity.sponsorId,
    sponsor_id: identity.sponsorId,
    sponsorChain: [...identity.sponsorChain],
    sponsor_chain: JSON.stringify(identity.sponsorChain),
    sponsor_chain_json: JSON.stringify(identity.sponsorChain),
    workspaceId: identity.workspaceId,
    workspace_id: identity.workspaceId,
  };
}

function toRoleRow(role: Role): RoleRow {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    scopes: [...role.scopes],
    scopes_json: JSON.stringify(role.scopes),
    orgId: role.orgId,
    org_id: role.orgId,
    ...(role.workspaceId !== undefined ? { workspaceId: role.workspaceId, workspace_id: role.workspaceId } : {}),
    builtIn: role.builtIn,
    built_in: role.builtIn ? 1 : 0,
    createdAt: role.createdAt,
    created_at: role.createdAt,
  };
}

function toPolicyRow(policy: StoredPolicy): PolicyRow {
  return {
    id: policy.id,
    name: policy.name,
    effect: policy.effect,
    scopes: [...policy.scopes],
    scopes_json: JSON.stringify(policy.scopes),
    conditions: clone(policy.conditions),
    conditions_json: JSON.stringify(policy.conditions),
    priority: policy.priority,
    orgId: policy.orgId,
    org_id: policy.orgId,
    ...(policy.workspaceId !== undefined
      ? { workspaceId: policy.workspaceId, workspace_id: policy.workspaceId }
      : {}),
    createdAt: policy.createdAt,
    created_at: policy.createdAt,
    ...(policy.deletedAt !== undefined ? { deletedAt: policy.deletedAt, deleted_at: policy.deletedAt } : {}),
  };
}

function toOrganizationRow(org: OrganizationRecord): OrganizationRow {
  return {
    id: org.id,
    orgId: org.id,
    org_id: org.id,
    name: org.name,
    scopes: [...org.scopes],
    scopes_json: JSON.stringify(org.scopes),
    roles: [...org.roles],
    roles_json: JSON.stringify(org.roles),
    createdAt: org.createdAt,
    created_at: org.createdAt,
    updatedAt: org.updatedAt,
    updated_at: org.updatedAt,
  };
}

function toWorkspaceRow(workspace: WorkspaceRecord): WorkspaceRow {
  return {
    id: workspace.id,
    workspaceId: workspace.id,
    workspace_id: workspace.id,
    orgId: workspace.orgId,
    org_id: workspace.orgId,
    name: workspace.name,
    scopes: [...workspace.scopes],
    scopes_json: JSON.stringify(workspace.scopes),
    roles: [...workspace.roles],
    roles_json: JSON.stringify(workspace.roles),
    createdAt: workspace.createdAt,
    created_at: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    updated_at: workspace.updatedAt,
  };
}

function extractClauseOrder<TField extends string>(
  sql: string,
  patterns: Array<{ field: TField; regexes: RegExp[] }>,
): Array<{ field: TField; index: number }> {
  return patterns
    .map((pattern) => ({
      field: pattern.field,
      index: Math.min(
        ...pattern.regexes
          .map((regex) => sql.search(regex))
          .filter((candidate) => candidate >= 0),
      ),
    }))
    .filter((candidate) => Number.isFinite(candidate.index))
    .sort((left, right) => left.index - right.index);
}

function filterIdentitiesByQuery(
  allIdentities: StoredIdentity[],
  query: string,
  params: unknown[],
): StoredIdentity[] {
  const sql = normalizeSql(query);
  let identities = [...allIdentities];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "status", regexes: [/\bstatus\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    identities = identities.filter((identity) => identity.orgId === orgId);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    identities = identities.filter((identity) => identity.id === id);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    identities = identities.filter((identity) => identity.workspaceId === workspaceId);
  }

  const status = values.get("status");
  if (typeof status === "string") {
    identities = identities.filter((identity) => identity.status === status);
  }

  return identities;
}

function filterRolesByQuery(allRoles: Role[], query: string, params: unknown[]): Role[] {
  const sql = normalizeSql(query);
  let roles = [...allRoles];

  // Handle WHERE id IN (?, ?, ...) queries
  const inMatch = /\bid\s+in\s*\(([^)]+)\)/i.exec(sql);
  if (inMatch) {
    const placeholderCount = (inMatch[1].match(/\?/g) ?? []).length;
    const inIds = params.slice(0, placeholderCount).filter((p): p is string => typeof p === "string");
    roles = roles.filter((role) => inIds.includes(role.id));
    roles.sort((left, right) => left.id.localeCompare(right.id));
    return roles;
  }

  const orderedClauses = extractClauseOrder(sql, [
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    roles = roles.filter((role) => role.orgId === orgId);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    roles = roles.filter((role) => role.id === id);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    const includeOrgScoped =
      /\bworkspace_id\s*=\s*\?\s+or\s+workspace_id\s+is\s+null\b/i.test(sql)
      || /\bworkspace_id\s+is\s+null\s+or\s+workspace_id\s*=\s*\?\b/i.test(sql)
      || /\bworkspaceid\s*=\s*\?\s+or\s+workspaceid\s+is\s+null\b/i.test(sql)
      || /\bworkspaceid\s+is\s+null\s+or\s+workspaceid\s*=\s*\?\b/i.test(sql);

    roles = roles.filter((role) =>
      includeOrgScoped
        ? role.workspaceId === workspaceId || role.workspaceId === undefined
        : role.workspaceId === workspaceId,
    );
  } else if (/\bworkspace_id\s+is\s+null\b/i.test(sql) || /\bworkspaceid\s+is\s+null\b/i.test(sql)) {
    roles = roles.filter((role) => role.workspaceId === undefined);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    roles = roles.filter((role) => role.name === name);
  }

  roles.sort((left, right) => left.id.localeCompare(right.id));
  return roles;
}

function filterPoliciesByQuery(
  allPolicies: StoredPolicy[],
  query: string,
  params: unknown[],
): StoredPolicy[] {
  const sql = normalizeSql(query);
  let policies = [...allPolicies];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    policies = policies.filter((policy) => policy.orgId === orgId);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    policies = policies.filter((policy) => policy.id === id);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    const includeOrgScoped =
      /\bworkspace_id\s*=\s*\?\s+or\s+workspace_id\s+is\s+null\b/i.test(sql)
      || /\bworkspace_id\s+is\s+null\s+or\s+workspace_id\s*=\s*\?\b/i.test(sql)
      || /\bworkspaceid\s*=\s*\?\s+or\s+workspaceid\s+is\s+null\b/i.test(sql)
      || /\bworkspaceid\s+is\s+null\s+or\s+workspaceid\s*=\s*\?\b/i.test(sql);

    policies = policies.filter((policy) =>
      includeOrgScoped
        ? policy.workspaceId === workspaceId || policy.workspaceId === undefined
        : policy.workspaceId === workspaceId,
    );
  } else if (/\bworkspace_id\s+is\s+null\b/i.test(sql) || /\bworkspaceid\s+is\s+null\b/i.test(sql)) {
    policies = policies.filter((policy) => policy.workspaceId === undefined);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    policies = policies.filter((policy) => policy.name === name);
  }

  if (/\bdeleted_at\s+is\s+null\b/i.test(sql) || /\bdeletedat\s+is\s+null\b/i.test(sql)) {
    policies = policies.filter((policy) => policy.deletedAt === undefined || policy.deletedAt === null);
  }

  policies.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return policies;
}

function filterOrganizationsByQuery(
  allOrganizations: OrganizationRecord[],
  query: string,
  params: unknown[],
): OrganizationRecord[] {
  const sql = normalizeSql(query);
  let organizations = [...allOrganizations];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    organizations = organizations.filter((organization) => organization.id === id);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    organizations = organizations.filter((organization) => organization.id === orgId);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    organizations = organizations.filter((organization) => organization.name === name);
  }

  organizations.sort((left, right) => left.id.localeCompare(right.id));
  return organizations;
}

function filterWorkspacesByQuery(
  allWorkspaces: WorkspaceRecord[],
  query: string,
  params: unknown[],
): WorkspaceRecord[] {
  const sql = normalizeSql(query);
  let workspaces = [...allWorkspaces];
  const orderedClauses = extractClauseOrder(sql, [
    { field: "id", regexes: [/\bid\s*=\s*\?/i] },
    { field: "workspaceId", regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "orgId", regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "name", regexes: [/\bname\s*=\s*\?/i] },
  ]);

  const values = new Map<string, unknown>();
  for (let index = 0; index < orderedClauses.length; index += 1) {
    values.set(orderedClauses[index].field, params[index]);
  }

  const id = values.get("id");
  if (typeof id === "string") {
    workspaces = workspaces.filter((workspace) => workspace.id === id);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    workspaces = workspaces.filter((workspace) => workspace.id === workspaceId);
  }

  const orgId = values.get("orgId");
  if (typeof orgId === "string") {
    workspaces = workspaces.filter((workspace) => workspace.orgId === orgId);
  }

  const name = values.get("name");
  if (typeof name === "string") {
    workspaces = workspaces.filter((workspace) => workspace.name === name);
  }

  workspaces.sort((left, right) => left.id.localeCompare(right.id));
  return workspaces;
}

function createScopeInheritanceDb(input: {
  organizations?: OrganizationRecord[];
  workspaces?: WorkspaceRecord[];
  identities: StoredIdentity[];
  roles?: Role[];
  policies?: StoredPolicy[];
}): D1Database {
  const organizations = new Map(
    (input.organizations ?? []).map((organization) => [organization.id, clone(organization)]),
  );
  const workspaces = new Map(
    (input.workspaces ?? []).map((workspace) => [workspace.id, clone(workspace)]),
  );
  const identities = new Map(input.identities.map((identity) => [identity.id, clone(identity)]));
  const roles = new Map((input.roles ?? []).map((role) => [role.id, clone(role)]));
  const policies = new Map((input.policies ?? []).map((policy) => [policy.id, clone(policy)]));

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    const sql = normalizeSql(query);

    if (/\bfrom organizations\b/.test(sql)) {
      return filterOrganizationsByQuery([...organizations.values()], query, params).map(toOrganizationRow);
    }

    if (/\bfrom workspaces\b/.test(sql)) {
      return filterWorkspacesByQuery([...workspaces.values()], query, params).map(toWorkspaceRow);
    }

    if (/\bfrom identities\b/.test(sql)) {
      return filterIdentitiesByQuery([...identities.values()], query, params).map(toIdentityRow);
    }

    if (/\bfrom roles\b/.test(sql)) {
      return filterRolesByQuery([...roles.values()], query, params).map(toRoleRow);
    }

    if (/\bfrom policies\b/.test(sql)) {
      return filterPoliciesByQuery([...policies.values()], query, params).map(toPolicyRow);
    }

    return [];
  };

  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const base = mockD1();

  return {
    ...base,
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async <T>() => (resolveRows(query, params)[0] as T | null) ?? null,
        run: async () => ({ success: true, meta }),
        raw: async <T>() => resolveRows(query, params) as T[],
        all: async <T>() => ({ results: resolveRows(query, params) as T[], success: true, meta }),
      }),
      first: async <T>() => (resolveRows(query, [])[0] as T | null) ?? null,
      run: async () => ({ success: true, meta }),
      raw: async <T>() => resolveRows(query, []) as T[],
      all: async <T>() => ({ results: resolveRows(query, []) as T[], success: true, meta }),
    }),
  } as D1Database;
}

async function loadScopeInheritanceModule(): Promise<Required<ScopeInheritanceModule>> {
  let module: ScopeInheritanceModule;

  try {
    module = await import("../engine/scope-inheritance.js") as ScopeInheritanceModule;
  } catch (error) {
    assert.fail(
      [
        "Expected ../engine/scope-inheritance.js to exist.",
        "Implement and export resolveInheritedScopes(db, identityId) and getInheritanceChain(db, identityId).",
        error instanceof Error ? error.message : String(error),
      ].join(" "),
    );
  }

  assert.equal(
    typeof module.resolveInheritedScopes,
    "function",
    "Expected scope inheritance engine to export resolveInheritedScopes(db, identityId)",
  );
  assert.equal(
    typeof module.getInheritanceChain,
    "function",
    "Expected scope inheritance engine to export getInheritanceChain(db, identityId)",
  );

  return module as Required<ScopeInheritanceModule>;
}

function sortScopes(scopes: string[]): string[] {
  return [...scopes].sort((left, right) => left.localeCompare(right));
}

function sortIds(values: Array<{ id: string }>): string[] {
  return values.map((value) => value.id).sort((left, right) => left.localeCompare(right));
}

function assertIncludes(scopes: string[], expected: string, message: string) {
  assert.equal(scopes.includes(expected), true, message);
}

function assertExcludes(scopes: string[], unexpected: string, message: string) {
  assert.equal(scopes.includes(unexpected), false, message);
}

test("org-level scopes are inherited by identities in every workspace in the org", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_reports_reader",
    name: "org-reports-reader",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const wsAlpha = createWorkspace({ id: "ws_alpha", orgId: org.id });
  const wsBeta = createWorkspace({ id: "ws_beta", orgId: org.id });
  const alphaIdentity = createStoredIdentity({
    id: "agent_alpha",
    orgId: org.id,
    workspaceId: wsAlpha.id,
    scopes: [],
    roles: [],
  });
  const betaIdentity = createStoredIdentity({
    id: "agent_beta",
    orgId: org.id,
    workspaceId: wsBeta.id,
    scopes: [],
    roles: [],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [wsAlpha, wsBeta],
    identities: [alphaIdentity, betaIdentity],
    roles: [orgRole],
  });

  const [alphaScopes, betaScopes] = await Promise.all([
    resolveInheritedScopes(db, alphaIdentity.id),
    resolveInheritedScopes(db, betaIdentity.id),
  ]);

  assertIncludes(alphaScopes, "relayfile:fs:read:/org/*", "org scopes should flow into ws_alpha");
  assertIncludes(betaScopes, "relayfile:fs:read:/org/*", "org scopes should flow into ws_beta");
});

test("workspace-level scopes are inherited by all agents in that workspace", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_docs_reader",
    name: "org-docs-reader",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_docs_reader",
    name: "workspace-docs-reader",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const agentOne = createStoredIdentity({
    id: "agent_team_a_1",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const agentTwo = createStoredIdentity({
    id: "agent_team_a_2",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [agentOne, agentTwo],
    roles: [orgRole, workspaceRole],
  });

  const [agentOneScopes, agentTwoScopes] = await Promise.all([
    resolveInheritedScopes(db, agentOne.id),
    resolveInheritedScopes(db, agentTwo.id),
  ]);

  assertIncludes(
    agentOneScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scopes should be inherited by the first agent in ws_team_a",
  );
  assertIncludes(
    agentTwoScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scopes should be inherited by the second agent in ws_team_a",
  );
});

test("agent direct scopes are combined with inherited scopes", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_reader_direct",
    name: "org-reader-direct",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_reader_direct",
    name: "workspace-reader-direct",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_direct_scope",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: ["relayfile:fs:read:/org/team-a/reports/q1.csv"],
    roles: [],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole],
  });

  const effectiveScopes = await resolveInheritedScopes(db, identity.id);

  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scope should remain present in the effective scope set",
  );
  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/reports/q1.csv",
    "direct scope should be merged into the inherited scope set",
  );
});

test("workspace scopes cannot exceed org-level scopes and must be intersected", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_boundary",
    name: "org-boundary",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceReadRole = createRole({
    id: "role_ws_allowed_read",
    name: "workspace-allowed-read",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const workspaceWriteRole = createRole({
    id: "role_ws_disallowed_write",
    name: "workspace-disallowed-write",
    scopes: ["relayfile:fs:write:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const workspaceOutsideRole = createRole({
    id: "role_ws_outside_boundary",
    name: "workspace-outside-boundary",
    scopes: ["relayfile:fs:read:/finance/*"],
    workspaceId: "ws_team_a",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: [
      ...workspaceReadRole.scopes,
      ...workspaceWriteRole.scopes,
      ...workspaceOutsideRole.scopes,
    ],
    roles: [workspaceReadRole.id, workspaceWriteRole.id, workspaceOutsideRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_workspace_intersection",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceReadRole, workspaceWriteRole, workspaceOutsideRole],
  });

  const effectiveScopes = await resolveInheritedScopes(db, identity.id);

  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/*",
    "workspace scope that is inside the org boundary should survive intersection",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:write:/org/team-a/*",
    "workspace scopes outside the org action boundary must be filtered out",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:read:/finance/*",
    "workspace scopes outside the org path boundary must be filtered out",
  );
});

test("agent scopes cannot exceed the workspace-level boundary", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_agent_boundary",
    name: "org-agent-boundary",
    scopes: ["relayfile:fs:read:/org/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_agent_boundary",
    name: "workspace-agent-boundary",
    scopes: ["relayfile:fs:read:/org/team-a/*"],
    workspaceId: "ws_team_a",
  });
  const allowedAgentRole = createRole({
    id: "role_agent_allowed",
    name: "agent-allowed",
    scopes: ["relayfile:fs:read:/org/team-a/runbooks/*"],
  });
  const disallowedAgentRole = createRole({
    id: "role_agent_disallowed",
    name: "agent-disallowed",
    scopes: ["relayfile:fs:write:/org/team-a/runbooks/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_team_a",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_workspace_boundary",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [allowedAgentRole.id, disallowedAgentRole.id],
    scopes: [
      "relayfile:fs:read:/org/team-a/runbooks/deploy.md",
      "relayfile:fs:read:/org/team-b/secrets.txt",
    ],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, allowedAgentRole, disallowedAgentRole],
  });

  const effectiveScopes = await resolveInheritedScopes(db, identity.id);

  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/runbooks/*",
    "agent role scopes within the workspace boundary should be preserved",
  );
  assertIncludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-a/runbooks/deploy.md",
    "direct scopes within the workspace boundary should be preserved",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:write:/org/team-a/runbooks/*",
    "agent role scopes outside the workspace action boundary must be removed",
  );
  assertExcludes(
    effectiveScopes,
    "relayfile:fs:read:/org/team-b/secrets.txt",
    "direct scopes outside the workspace path boundary must be removed",
  );
});

test("org deny policies block scopes even when the workspace level allows them", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_deploy",
    name: "org-deploy",
    scopes: ["cloud:workflow:run:prod-eu-*"],
  });
  const orgDeny = createPolicy({
    id: "pol_org_deny_deploy",
    name: "org-deny-deploy",
    effect: "deny",
    scopes: ["cloud:workflow:run:prod-eu-*"],
    priority: 900,
  });
  const workspaceAllow = createPolicy({
    id: "pol_ws_allow_deploy",
    name: "workspace-allow-deploy",
    effect: "allow",
    scopes: ["cloud:workflow:run:prod-eu-*"],
    priority: 100,
    workspaceId: "ws_prod",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_prod",
    orgId: org.id,
    scopes: orgRole.scopes,
    roles: [],
  });
  const identity = createStoredIdentity({
    id: "agent_prod_operator",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: [],
    roles: [],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole],
    policies: [orgDeny, workspaceAllow],
  });

  const effectiveScopes = await resolveInheritedScopes(db, identity.id);

  assertExcludes(
    effectiveScopes,
    "cloud:workflow:run:prod-eu-*",
    "an org-level deny must outrank a workspace-level allow for the same scope",
  );
});

test("workspace deny policies block scopes even when the agent has them directly", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_finance_reader",
    name: "org-finance-reader",
    scopes: ["relayfile:fs:read:/finance/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_finance_reader",
    name: "workspace-finance-reader",
    scopes: ["relayfile:fs:read:/finance/*"],
    workspaceId: "ws_finance",
  });
  const workspaceDeny = createPolicy({
    id: "pol_ws_finance_deny",
    name: "workspace-finance-deny",
    effect: "deny",
    scopes: ["relayfile:fs:read:/finance/*"],
    priority: 800,
    workspaceId: "ws_finance",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_finance",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_finance",
    orgId: org.id,
    workspaceId: workspace.id,
    scopes: ["relayfile:fs:read:/finance/*"],
    roles: [],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole],
    policies: [workspaceDeny],
  });

  const effectiveScopes = await resolveInheritedScopes(db, identity.id);

  assertExcludes(
    effectiveScopes,
    "relayfile:fs:read:/finance/*",
    "workspace deny policies must remove directly assigned agent scopes",
  );
});

test("resolveInheritedScopes resolves the effective scopes from the full inheritance chain", async () => {
  const { resolveInheritedScopes } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_docs",
    name: "org-docs",
    scopes: ["relayfile:fs:read:/docs/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_docs",
    name: "workspace-docs",
    scopes: ["relayfile:fs:read:/docs/team-a/*"],
    workspaceId: "ws_docs",
  });
  const agentRole = createRole({
    id: "role_agent_docs",
    name: "agent-docs",
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_docs",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_docs",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [agentRole.id],
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/deploy.md"],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, agentRole],
  });

  const effectiveScopes = await resolveInheritedScopes(db, identity.id);

  assert.deepEqual(
    sortScopes(effectiveScopes),
    sortScopes([
      "relayfile:fs:read:/docs/*",
      "relayfile:fs:read:/docs/team-a/*",
      "relayfile:fs:read:/docs/team-a/runbooks/*",
      "relayfile:fs:read:/docs/team-a/runbooks/deploy.md",
    ]),
  );
});

test("inheritance chain is ordered org roles then workspace roles then agent roles then direct scopes", async () => {
  const { getInheritanceChain } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_chain",
    name: "org-chain",
    scopes: ["relayfile:fs:read:/docs/*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_chain",
    name: "workspace-chain",
    scopes: ["relayfile:fs:read:/docs/team-a/*"],
    workspaceId: "ws_docs",
  });
  const agentRole = createRole({
    id: "role_agent_chain",
    name: "agent-chain",
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/*"],
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_docs",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_chain",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [agentRole.id],
    scopes: ["relayfile:fs:read:/docs/team-a/runbooks/deploy.md"],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, agentRole],
  });

  const chain = await getInheritanceChain(db, identity.id);

  assert.deepEqual(sortIds(chain.org.roles), [orgRole.id]);
  assert.deepEqual(sortIds(chain.workspace.roles), [workspaceRole.id]);
  assert.deepEqual(sortIds(chain.agent.roles), [agentRole.id]);
  assert.deepEqual(sortScopes(chain.org.scopes), sortScopes(orgRole.scopes));
  assert.deepEqual(sortScopes(chain.workspace.scopes), sortScopes(workspaceRole.scopes));
  assert.deepEqual(
    sortScopes(chain.agent.scopes),
    sortScopes([
      "relayfile:fs:read:/docs/team-a/runbooks/*",
      "relayfile:fs:read:/docs/team-a/runbooks/deploy.md",
    ]),
  );
});

test("getInheritanceChain returns the org, workspace, and agent scope breakdown", async () => {
  const { getInheritanceChain } = await loadScopeInheritanceModule();
  const orgRole = createRole({
    id: "role_org_breakdown",
    name: "org-breakdown",
    scopes: ["cloud:workflow:run:prod-*"],
  });
  const workspaceRole = createRole({
    id: "role_ws_breakdown",
    name: "workspace-breakdown",
    scopes: ["cloud:workflow:run:prod-eu-*"],
    workspaceId: "ws_prod",
  });
  const agentRole = createRole({
    id: "role_agent_breakdown",
    name: "agent-breakdown",
    scopes: ["cloud:workflow:run:prod-eu-api"],
  });
  const orgPolicy = createPolicy({
    id: "pol_org_breakdown",
    name: "org-breakdown-policy",
    effect: "deny",
    scopes: ["cloud:workflow:delete:prod-*"],
    priority: 900,
  });
  const workspacePolicy = createPolicy({
    id: "pol_ws_breakdown",
    name: "workspace-breakdown-policy",
    effect: "allow",
    scopes: ["cloud:workflow:run:prod-eu-api"],
    priority: 400,
    workspaceId: "ws_prod",
  });
  const org = createOrganization({
    id: "org_acme",
    scopes: orgRole.scopes,
    roles: [orgRole.id],
  });
  const workspace = createWorkspace({
    id: "ws_prod",
    orgId: org.id,
    scopes: workspaceRole.scopes,
    roles: [workspaceRole.id],
  });
  const identity = createStoredIdentity({
    id: "agent_breakdown",
    orgId: org.id,
    workspaceId: workspace.id,
    roles: [agentRole.id],
    scopes: ["cloud:workflow:run:prod-eu-api"],
  });
  const db = createScopeInheritanceDb({
    organizations: [org],
    workspaces: [workspace],
    identities: [identity],
    roles: [orgRole, workspaceRole, agentRole],
    policies: [orgPolicy, workspacePolicy],
  });

  const chain = await getInheritanceChain(db, identity.id);

  assert.deepEqual(sortScopes(chain.org.scopes), sortScopes(orgRole.scopes));
  assert.deepEqual(sortScopes(chain.workspace.scopes), sortScopes(workspaceRole.scopes));
  assert.deepEqual(
    sortScopes(chain.agent.scopes),
    sortScopes([
      "cloud:workflow:run:prod-eu-api",
    ]),
  );
  assert.deepEqual(sortIds(chain.org.roles), [orgRole.id]);
  assert.deepEqual(sortIds(chain.workspace.roles), [workspaceRole.id]);
  assert.deepEqual(sortIds(chain.agent.roles), [agentRole.id]);
  assert.deepEqual(sortIds(chain.org.policies), [orgPolicy.id]);
  assert.deepEqual(sortIds(chain.workspace.policies), [workspacePolicy.id]);
  assert.deepEqual(
    sortScopes(chain.effective),
    sortScopes([
      "cloud:workflow:run:prod-*",
      "cloud:workflow:run:prod-eu-*",
      "cloud:workflow:run:prod-eu-api",
    ]),
  );
});
