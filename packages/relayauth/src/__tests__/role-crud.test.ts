import assert from "node:assert/strict";
import test from "node:test";
import type { RelayAuthTokenClaims, Role } from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type CreateRoleRequest = {
  name?: string;
  description?: string;
  scopes?: string[];
  workspaceId?: string;
};

type UpdateRoleRequest = Partial<Pick<Role, "name" | "description" | "scopes">>;

type RoleListResponse = {
  data: Role[];
};

type ErrorResponse = {
  error: string;
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

type RoleScenario = {
  db: D1Database;
  roles: Map<string, Role>;
};

function createRole(overrides: Partial<Role> = {}): Role {
  return {
    id: overrides.id ?? "role_test_123",
    name: overrides.name ?? "platform-operator",
    description: overrides.description ?? "Platform operator role",
    scopes: overrides.scopes ?? ["relayauth:identity:read:*"],
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    builtIn: overrides.builtIn ?? false,
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
  };
}

function cloneRole(role: Role): Role {
  return JSON.parse(JSON.stringify(role)) as Role;
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

function normalizeColumn(column: string): string {
  return column.replace(/["'`[\]]/g, "").trim().toLowerCase();
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
    } catch {
      return value ? [value] : [];
    }
  }

  return [];
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

function applyColumn(target: Partial<Role>, column: string, value: unknown): void {
  const normalized = normalizeColumn(column);

  if (normalized === "id") {
    if (typeof value === "string") {
      target.id = value;
    }
    return;
  }

  if (normalized === "name") {
    if (typeof value === "string") {
      target.name = value;
    }
    return;
  }

  if (normalized === "description") {
    if (typeof value === "string") {
      target.description = value;
    }
    return;
  }

  if (normalized === "org_id" || normalized === "orgid") {
    if (typeof value === "string") {
      target.orgId = value;
    }
    return;
  }

  if (normalized === "workspace_id" || normalized === "workspaceid") {
    if (typeof value === "string" && value.length > 0) {
      target.workspaceId = value;
    }
    return;
  }

  if (normalized === "built_in" || normalized === "builtin") {
    target.builtIn = parseBoolean(value);
    return;
  }

  if (normalized === "created_at" || normalized === "createdat") {
    if (typeof value === "string") {
      target.createdAt = value;
    }
    return;
  }

  if (normalized === "scopes" || normalized === "scopes_json") {
    target.scopes = parseScopes(value);
  }
}

function extractClauseOrder(sql: string): Array<{ field: "orgId" | "id" | "name" | "workspaceId" | "builtIn"; index: number }> {
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
  } else if (/\border by\b.*\bcreated_at\b.*\bdesc\b/i.test(sql) || /\border by\b.*\bcreatedat\b.*\bdesc\b/i.test(sql)) {
    roles.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

function createRoleScenario(initialRoles: Role[] = []): RoleScenario {
  const roles = new Map(initialRoles.map((role) => [role.id, cloneRole(role)]));
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const execute = (
    query: string,
    params: unknown[],
  ): {
    rows: unknown[];
    changes: number;
  } => {
    const sql = normalizeSql(query);

    if (!/\broles\b/.test(sql)) {
      return { rows: [], changes: 0 };
    }

    if (/\binsert\s+into\s+roles\b/i.test(sql)) {
      const columnsMatch = query.match(/\binsert\s+into\s+roles\s*\(([^)]+)\)/i);
      const columns = columnsMatch?.[1]
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
      const draft: Partial<Role> = {};

      columns.forEach((column, index) => {
        applyColumn(draft, column, params[index]);
      });

      const role = createRole({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        scopes: draft.scopes,
        orgId: draft.orgId,
        ...(draft.workspaceId !== undefined ? { workspaceId: draft.workspaceId } : {}),
        builtIn: draft.builtIn,
        createdAt: draft.createdAt,
      });

      roles.set(role.id, cloneRole(role));
      return { rows: [], changes: 1 };
    }

    if (/\bupdate\s+roles\b/i.test(sql)) {
      const setMatch = query.match(/\bset\s+(.+?)\s+\bwhere\b/i);
      const assignments = setMatch?.[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
      const setColumns = assignments.map((assignment) => assignment.split("=")[0]?.trim() ?? "");
      const setParams = params.slice(0, setColumns.length);
      const whereParams = params.slice(setColumns.length);
      const whereSql = query.split(/\bwhere\b/i)[1] ?? "";
      const matches = filterRolesByQuery([...roles.values()], whereSql, whereParams);

      for (const current of matches) {
        const next = cloneRole(current);
        setColumns.forEach((column, index) => {
          applyColumn(next, column, setParams[index]);
        });
        roles.set(next.id, next);
      }

      return { rows: [], changes: matches.length };
    }

    if (/\bdelete\s+from\s+roles\b/i.test(sql)) {
      const whereSql = query.split(/\bwhere\b/i)[1] ?? "";
      const matches = filterRolesByQuery([...roles.values()], whereSql, params);
      for (const current of matches) {
        roles.delete(current.id);
      }
      return { rows: [], changes: matches.length };
    }

    return {
      rows: filterRolesByQuery([...roles.values()], query, params).map(toRoleRow),
      changes: 0,
    };
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => (execute(query, params).rows[0] as T | null) ?? null,
      run: async () => {
        const result = execute(query, params);
        return {
          success: true,
          meta: {
            ...meta,
            changes: result.changes,
            rows_written: result.changes,
          },
        };
      },
      raw: async <T>() => execute(query, params).rows as T[],
      all: async <T>() => ({
        results: execute(query, params).rows as T[],
        success: true,
        meta,
      }),
    }),
    first: async <T>() => (execute(query, []).rows[0] as T | null) ?? null,
    run: async () => ({
      success: true,
      meta,
    }),
    raw: async <T>() => execute(query, []).rows as T[],
    all: async <T>() => ({
      results: execute(query, []).rows as T[],
      success: true,
      meta,
    }),
  });

  return {
    roles,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(statements: D1PreparedStatement[]) =>
        Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

async function requestRolesApi(
  method: string,
  path: string,
  {
    body,
    claims,
    scenario,
  }: {
    body?: unknown;
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleScenario }> {
  const activeScenario = scenario ?? createRoleScenario();
  const app = createTestApp({
    DB: activeScenario.db,
  });
  const token = generateTestToken({
    org: "org_test",
    wks: "ws_test",
    scopes: ["relayauth:role:manage:*", "relayauth:role:read:*"],
    ...claims,
  });
  const request = createTestRequest(
    method,
    path,
    body,
    {
      Authorization: `Bearer ${token}`,
    },
  );

  const response = await app.request(request, undefined, app.bindings);
  return { response, scenario: activeScenario };
}

async function postRole(
  body: CreateRoleRequest,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleScenario }> {
  return requestRolesApi("POST", "/v1/roles", { ...options, body });
}

async function getRole(
  roleId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleScenario;
  } = {},
): Promise<Response> {
  const { response } = await requestRolesApi("GET", `/v1/roles/${roleId}`, options);
  return response;
}

async function listRoles(
  search = "",
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleScenario;
  } = {},
): Promise<Response> {
  const { response } = await requestRolesApi("GET", `/v1/roles${search}`, options);
  return response;
}

async function patchRole(
  roleId: string,
  body: UpdateRoleRequest,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleScenario;
  } = {},
): Promise<Response> {
  const { response } = await requestRolesApi("PATCH", `/v1/roles/${roleId}`, { ...options, body });
  return response;
}

async function deleteRole(
  roleId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: RoleScenario;
  } = {},
): Promise<{ response: Response; scenario: RoleScenario }> {
  return requestRolesApi("DELETE", `/v1/roles/${roleId}`, options);
}

function assertIsoTimestamp(value: string): void {
  assert.equal(typeof value, "string");
  assert.equal(Number.isNaN(Date.parse(value)), false);
}

test("POST /v1/roles creates a role with name, description, and scopes", async () => {
  const response = (
    await postRole({
      name: "incident-reviewer",
      description: "Can review incident channels and audits",
      scopes: ["relayauth:audit:read:*", "relaycast:channel:read:#incidents"],
    })
  ).response;

  const body = await assertJsonResponse<Role>(response, 201);

  assert.equal(body.name, "incident-reviewer");
  assert.equal(body.description, "Can review incident channels and audits");
  assert.deepEqual(body.scopes, ["relayauth:audit:read:*", "relaycast:channel:read:#incidents"]);
  assert.equal(body.orgId, "org_test");
  assert.equal(body.builtIn, false);
  assertIsoTimestamp(body.createdAt);
});

test("POST /v1/roles returns 400 when required fields are missing", async () => {
  const response = (
    await postRole({
      name: "missing-fields-role",
    })
  ).response;

  const body = await assertJsonResponse<ErrorResponse>(response, 400);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("POST /v1/roles returns 409 for a duplicate role name in the same org", async () => {
  const scenario = createRoleScenario([
    createRole({
      id: "role_duplicate",
      name: "backend-deployer",
      orgId: "org_test",
    }),
  ]);
  const response = (
    await postRole(
      {
        name: "backend-deployer",
        description: "Duplicate name attempt",
        scopes: ["cloud:workflow:run:prod-*"],
      },
      { scenario },
    )
  ).response;

  const body = await assertJsonResponse<ErrorResponse>(response, 409);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("GET /v1/roles/:id returns a role by ID", async () => {
  const role = createRole({
    id: "role_get_123",
    name: "prod-observer",
    description: "Read-only access to production operations",
    scopes: ["cloud:workflow:read:prod-*", "relaycast:channel:read:#prod-ops"],
    orgId: "org_test",
    createdAt: "2026-03-20T12:00:00.000Z",
  });
  const scenario = createRoleScenario([role]);
  const response = await getRole(role.id, { scenario });

  const body = await assertJsonResponse<Role>(response, 200);

  assert.deepEqual(body, role);
});

test("GET /v1/roles/:id returns 404 for a nonexistent role", async () => {
  const response = await getRole("role_missing_404");

  const body = await assertJsonResponse<ErrorResponse>(response, 404);

  assert.deepEqual(body, { error: "role_not_found" });
});

test("GET /v1/roles lists all roles for the authenticated org", async () => {
  const expectedRoles = [
    createRole({
      id: "role_list_org_1",
      name: "relayauth-admin-lite",
      orgId: "org_test",
    }),
    createRole({
      id: "role_list_org_2",
      name: "backend-deployer",
      orgId: "org_test",
      workspaceId: "ws_prod",
    }),
  ];
  const scenario = createRoleScenario([
    ...expectedRoles,
    createRole({
      id: "role_other_org",
      name: "foreign-role",
      orgId: "org_other",
    }),
  ]);
  const response = await listRoles("", { scenario });

  const body = await assertJsonResponse<RoleListResponse>(response, 200);

  assert.equal(body.data.length, 2);
  assert.deepEqual(
    body.data.map((role) => role.id).sort(),
    expectedRoles.map((role) => role.id).sort(),
  );
});

test("GET /v1/roles?workspaceId=ws_xxx filters roles by workspace while preserving org-scoped roles", async () => {
  const orgScopedRole = createRole({
    id: "role_workspace_org_scope",
    name: "org-reader",
    orgId: "org_test",
  });
  const matchingWorkspaceRole = createRole({
    id: "role_workspace_match",
    name: "prod-operator",
    orgId: "org_test",
    workspaceId: "ws_prod",
  });
  const otherWorkspaceRole = createRole({
    id: "role_workspace_other",
    name: "staging-operator",
    orgId: "org_test",
    workspaceId: "ws_staging",
  });
  const scenario = createRoleScenario([orgScopedRole, matchingWorkspaceRole, otherWorkspaceRole]);
  const response = await listRoles("?workspaceId=ws_prod", { scenario });

  const body = await assertJsonResponse<RoleListResponse>(response, 200);

  assert.deepEqual(
    body.data.map((role) => role.id).sort(),
    [orgScopedRole.id, matchingWorkspaceRole.id].sort(),
  );
  assert.ok(body.data.every((role) => role.workspaceId === undefined || role.workspaceId === "ws_prod"));
});

test("PATCH /v1/roles/:id updates a role name, description, and scopes", async () => {
  const original = createRole({
    id: "role_patch_123",
    name: "incident-reviewer",
    description: "Original description",
    scopes: ["relayauth:audit:read:*"],
    orgId: "org_test",
    createdAt: "2026-03-01T00:00:00.000Z",
  });
  const scenario = createRoleScenario([original]);
  const response = await patchRole(
    original.id,
    {
      name: "incident-commander",
      description: "Can coordinate incident response",
      scopes: ["relayauth:audit:read:*", "relaycast:channel:send:#incidents"],
    },
    { scenario },
  );

  const body = await assertJsonResponse<Role>(response, 200);

  assert.equal(body.id, original.id);
  assert.equal(body.orgId, original.orgId);
  assert.equal(body.createdAt, original.createdAt);
  assert.equal(body.builtIn, false);
  assert.equal(body.name, "incident-commander");
  assert.equal(body.description, "Can coordinate incident response");
  assert.deepEqual(body.scopes, ["relayauth:audit:read:*", "relaycast:channel:send:#incidents"]);
});

test("PATCH /v1/roles/:id returns 403 for built-in roles", async () => {
  const builtInRole = createRole({
    id: "role_builtin_patch",
    name: "relayauth-admin",
    builtIn: true,
  });
  const scenario = createRoleScenario([builtInRole]);
  const response = await patchRole(
    builtInRole.id,
    {
      description: "Attempted mutation",
    },
    { scenario },
  );

  const body = await assertJsonResponse<ErrorResponse>(response, 403);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("DELETE /v1/roles/:id deletes a custom role", async () => {
  const role = createRole({
    id: "role_delete_123",
    name: "temporary-role",
  });
  const scenario = createRoleScenario([role]);
  const { response } = await deleteRole(role.id, { scenario });

  assert.equal(response.status, 204);
  assert.equal(scenario.roles.has(role.id), false);
});

test("DELETE /v1/roles/:id returns 403 for built-in roles", async () => {
  const builtInRole = createRole({
    id: "role_builtin_delete",
    name: "relayauth-developer",
    builtIn: true,
  });
  const scenario = createRoleScenario([builtInRole]);
  const { response } = await deleteRole(builtInRole.id, { scenario });

  const body = await assertJsonResponse<ErrorResponse>(response, 403);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
  assert.equal(scenario.roles.has(builtInRole.id), true);
});
