import assert from "node:assert/strict";
import test from "node:test";
import type { RelayAuthTokenClaims, Role } from "@relayauth/types";
import type { StoredIdentity } from "../durable-objects/identity-do.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "./test-helpers.js";

type ErrorResponse = {
  error: string;
};

type RoleListResponse = {
  data: Role[];
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

type DurableObjectCall = {
  identityId: string;
  method: string;
  path: string;
  body: unknown;
};

type RoleAssignmentScenario = {
  db: D1Database;
  roles: Map<string, Role>;
  identities: Map<string, StoredIdentity>;
  identityNamespace: DurableObjectNamespace;
  doCalls: DurableObjectCall[];
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createRole(overrides: Partial<Role> = {}): Role {
  return {
    id: overrides.id ?? "role_platform_operator",
    name: overrides.name ?? "platform-operator",
    description: overrides.description ?? "Platform operator role",
    scopes: overrides.scopes ?? ["relayauth:identity:read:*"],
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    builtIn: overrides.builtIn ?? false,
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_owner_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, "agent_parent_1", base.id],
    workspaceId: overrides.workspaceId ?? "ws_test",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
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

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractClauseOrder(
  sql: string,
): Array<{ field: "orgId" | "id" | "name" | "workspaceId" | "builtIn"; index: number }> {
  const patterns = [
    { field: "orgId" as const, regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id" as const, regexes: [/\bid\s*=\s*\?/i] },
    { field: "name" as const, regexes: [/\bname\s*=\s*\?/i] },
    { field: "workspaceId" as const, regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "builtIn" as const, regexes: [/\bbuilt_in\s*=\s*\?/i, /\bbuiltin\s*=\s*\?/i] },
  ];

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

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return value === "1" || value.toLowerCase() === "true";
  }

  return false;
}

function filterRolesByQuery(allRoles: Role[], query: string, params: unknown[]): Role[] {
  const sql = normalizeSql(query);
  let roles = [...allRoles];
  const orderedClauses = extractClauseOrder(sql);
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

  const name = values.get("name");
  if (typeof name === "string") {
    roles = roles.filter((role) => role.name === name);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    const includeOrgScoped = /\bworkspace_id\s*=\s*\?\s+or\s+workspace_id\s+is\s+null\b/i.test(sql)
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

  const builtIn = values.get("builtIn");
  if (builtIn !== undefined) {
    const expected = parseBoolean(builtIn);
    roles = roles.filter((role) => role.builtIn === expected);
  }

  if (/\border by\b.*\bname\b.*\basc\b/i.test(sql)) {
    roles.sort((left, right) => left.name.localeCompare(right.name));
  } else {
    roles.sort((left, right) => left.id.localeCompare(right.id));
  }

  const limitMatch = sql.match(/\blimit\s+(\d+)\b/i);
  if (limitMatch?.[1]) {
    const limit = Number.parseInt(limitMatch[1], 10);
    if (Number.isFinite(limit)) {
      roles = roles.slice(0, limit);
    }
  }

  return roles;
}

function createRoleDb(initialRoles: Role[]): D1Database {
  const roles = new Map(initialRoles.map((role) => [role.id, clone(role)]));
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    if (!/\broles\b/.test(normalizeSql(query))) {
      return [];
    }

    return filterRolesByQuery([...roles.values()], query, params).map(toRoleRow);
  };

  const createPreparedStatement = (query: string) => ({
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
  });

  return {
    prepare: (query: string) => createPreparedStatement(query),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;
}

function createIdentityNamespace(seedIdentities: StoredIdentity[]): {
  namespace: DurableObjectNamespace;
  identities: Map<string, StoredIdentity>;
  calls: DurableObjectCall[];
} {
  const identities = new Map(seedIdentities.map((identity) => [identity.id, clone(identity)]));
  const calls: DurableObjectCall[] = [];

  return {
    identities,
    calls,
    namespace: {
      idFromName: (name: string) => name,
      get: (id: DurableObjectId) => ({
        fetch: async (request: Request) => {
          const identityId = String(id);
          const current = identities.get(identityId) ?? null;
          const { pathname } = new URL(request.url);
          const body = await request.clone().json().catch(() => undefined);

          calls.push({
            identityId,
            method: request.method,
            path: pathname,
            body,
          });

          if (pathname === "/internal/get" && request.method === "GET") {
            return current
              ? jsonResponse(current, 200)
              : jsonResponse({ error: "identity_not_found" }, 404);
          }

          if (pathname === "/internal/update" && (request.method === "PATCH" || request.method === "POST")) {
            if (!current) {
              return jsonResponse({ error: "identity_not_found" }, 404);
            }

            const update = await request.clone().json<Partial<StoredIdentity>>().catch(() => null);
            if (!update || typeof update !== "object" || Array.isArray(update) || Object.keys(update).length === 0) {
              return jsonResponse({ error: "Invalid JSON body" }, 400);
            }

            const timestamp = new Date().toISOString();
            const next: StoredIdentity = {
              ...current,
              ...update,
              metadata: update.metadata ? { ...current.metadata, ...update.metadata } : current.metadata,
              scopes: update.scopes ?? current.scopes,
              roles: update.roles ?? current.roles,
              sponsorChain: update.sponsorChain ?? current.sponsorChain,
              budget: update.budget ?? current.budget,
              budgetUsage: update.budgetUsage ?? current.budgetUsage,
              updatedAt: timestamp,
            };

            identities.set(identityId, next);
            return jsonResponse(next, 200);
          }

          return jsonResponse({ error: `unexpected_do_request:${request.method}:${pathname}` }, 500);
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
}

function createRoleAssignmentScenario({
  roles = [],
  identities = [],
}: {
  roles?: Role[];
  identities?: StoredIdentity[];
} = {}): RoleAssignmentScenario {
  const identityNamespace = createIdentityNamespace(identities);

  return {
    db: createRoleDb(roles),
    roles: new Map(roles.map((role) => [role.id, clone(role)])),
    identities: identityNamespace.identities,
    identityNamespace: identityNamespace.namespace,
    doCalls: identityNamespace.calls,
  };
}

async function requestRoleAssignmentApi(
  method: string,
  path: string,
  {
    body,
    claims,
    scenario,
  }: {
    body?: unknown;
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleAssignmentScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleAssignmentScenario }> {
  const activeScenario = scenario ?? createRoleAssignmentScenario();
  const app = createTestApp({
    DB: activeScenario.db,
    IDENTITY_DO: activeScenario.identityNamespace,
  });
  const token = generateTestToken({
    org: "org_test",
    wks: "ws_test",
    scopes: [
      "relayauth:identity:manage:*",
      "relayauth:identity:read:*",
      "relayauth:role:manage:*",
      "relayauth:role:read:*",
    ],
    ...claims,
  });
  const request = createTestRequest(method, path, body, {
    Authorization: `Bearer ${token}`,
  });

  const response = await app.request(request, undefined, app.bindings);
  return { response, scenario: activeScenario };
}

async function assignRole(
  identityId: string,
  roleId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleAssignmentScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleAssignmentScenario }> {
  return requestRoleAssignmentApi("POST", `/v1/identities/${identityId}/roles`, {
    ...options,
    body: { roleId },
  });
}

async function removeRole(
  identityId: string,
  roleId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleAssignmentScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleAssignmentScenario }> {
  return requestRoleAssignmentApi("DELETE", `/v1/identities/${identityId}/roles/${roleId}`, options);
}

async function listAssignedRoles(
  identityId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleAssignmentScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleAssignmentScenario }> {
  return requestRoleAssignmentApi("GET", `/v1/identities/${identityId}/roles`, options);
}

test("POST /v1/identities/:id/roles assigns a role to an identity", async () => {
  const role = createRole({
    id: "role_backend_deployer",
    name: "backend-deployer",
  });
  const identity = createStoredIdentity({
    id: "agent_assign_role_200",
    orgId: role.orgId,
    roles: [],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [role],
    identities: [identity],
  });

  const { response } = await assignRole(identity.id, role.id, { scenario });

  assert.equal(response.status, 201);
  assert.deepEqual(scenario.identities.get(identity.id)?.roles, [role.id]);
});

test("POST /v1/identities/:id/roles returns 404 if identity not found", async () => {
  const role = createRole({
    id: "role_identity_missing",
  });
  const scenario = createRoleAssignmentScenario({
    roles: [role],
    identities: [],
  });

  const { response } = await assignRole("agent_missing_identity", role.id, { scenario });
  const body = await assertJsonResponse<ErrorResponse>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/roles returns 404 if role not found", async () => {
  const identity = createStoredIdentity({
    id: "agent_role_missing",
    orgId: "org_test",
    roles: [],
  });
  const scenario = createRoleAssignmentScenario({
    identities: [identity],
  });

  const { response } = await assignRole(identity.id, "role_missing", { scenario });
  const body = await assertJsonResponse<ErrorResponse>(response, 404);

  assert.deepEqual(body, { error: "role_not_found" });
});

test("POST /v1/identities/:id/roles returns 409 if role already assigned", async () => {
  const role = createRole({
    id: "role_duplicate_assignment",
  });
  const identity = createStoredIdentity({
    id: "agent_duplicate_assignment",
    orgId: role.orgId,
    roles: [role.id],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [role],
    identities: [identity],
  });

  const { response } = await assignRole(identity.id, role.id, { scenario });
  const body = await assertJsonResponse<ErrorResponse>(response, 409);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("DELETE /v1/identities/:id/roles/:roleId removes role from identity", async () => {
  const role = createRole({
    id: "role_remove_target",
  });
  const keepRoleId = "role_keep_after_delete";
  const identity = createStoredIdentity({
    id: "agent_remove_role_204",
    orgId: role.orgId,
    roles: [role.id, keepRoleId],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [
      role,
      createRole({
        id: keepRoleId,
        name: "observer",
      }),
    ],
    identities: [identity],
  });

  const { response } = await removeRole(identity.id, role.id, { scenario });

  assert.equal(response.status, 204);
  assert.deepEqual(scenario.identities.get(identity.id)?.roles, [keepRoleId]);
});

test("DELETE /v1/identities/:id/roles/:roleId returns 404 if not assigned", async () => {
  const role = createRole({
    id: "role_not_assigned",
  });
  const identity = createStoredIdentity({
    id: "agent_role_not_assigned",
    orgId: role.orgId,
    roles: [],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [role],
    identities: [identity],
  });

  const { response } = await removeRole(identity.id, role.id, { scenario });
  const body = await assertJsonResponse<ErrorResponse>(response, 404);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("GET /v1/identities/:id/roles lists all roles for an identity", async () => {
  const roleA = createRole({
    id: "role_prod_operator",
    name: "prod-operator",
  });
  const roleB = createRole({
    id: "role_incident_reviewer",
    name: "incident-reviewer",
  });
  const unassignedRole = createRole({
    id: "role_unassigned",
    name: "unassigned-role",
  });
  const identity = createStoredIdentity({
    id: "agent_list_roles_200",
    orgId: "org_test",
    roles: [roleA.id, roleB.id],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [roleA, roleB, unassignedRole],
    identities: [identity],
  });

  const { response } = await listAssignedRoles(identity.id, { scenario });
  const body = await assertJsonResponse<RoleListResponse>(response, 200);

  assert.deepEqual(
    body.data.map((role) => role.id).sort(),
    [roleA.id, roleB.id].sort(),
  );
});

test("Assigning a role updates the identity's roles array", async () => {
  const existingRoleId = "role_existing_assignment";
  const newRole = createRole({
    id: "role_new_assignment",
  });
  const identity = createStoredIdentity({
    id: "agent_roles_array_updates_on_assign",
    orgId: newRole.orgId,
    roles: [existingRoleId],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [
      createRole({
        id: existingRoleId,
        name: "existing-assignment",
      }),
      newRole,
    ],
    identities: [identity],
  });

  const { response } = await assignRole(identity.id, newRole.id, { scenario });

  assert.equal(response.status, 201);
  assert.deepEqual(scenario.identities.get(identity.id)?.roles, [existingRoleId, newRole.id]);
});

test("Removing a role updates the identity's roles array", async () => {
  const removedRoleId = "role_remove_from_array";
  const retainedRoleId = "role_retain_in_array";
  const identity = createStoredIdentity({
    id: "agent_roles_array_updates_on_remove",
    orgId: "org_test",
    roles: [removedRoleId, retainedRoleId],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [
      createRole({
        id: removedRoleId,
        name: "remove-from-array",
      }),
      createRole({
        id: retainedRoleId,
        name: "retain-in-array",
      }),
    ],
    identities: [identity],
  });

  const { response } = await removeRole(identity.id, removedRoleId, { scenario });

  assert.equal(response.status, 204);
  assert.deepEqual(scenario.identities.get(identity.id)?.roles, [retainedRoleId]);
});

test("Cannot assign roles across different orgs", async () => {
  const role = createRole({
    id: "role_cross_org",
    orgId: "org_test",
  });
  const identity = createStoredIdentity({
    id: "agent_cross_org_identity",
    orgId: "org_other",
    roles: [],
  });
  const scenario = createRoleAssignmentScenario({
    roles: [role],
    identities: [identity],
  });

  const { response } = await assignRole(identity.id, role.id, {
    scenario,
    claims: {
      org: "org_test",
    },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(scenario.identities.get(identity.id)?.roles, []);
});
