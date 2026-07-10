import assert from "node:assert/strict";
import test from "node:test";
import type {
  Policy,
  PolicyCondition,
  PolicyEffect,
  RelayAuthTokenClaims,
} from "@relayauth/types";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "./test-helpers.js";

type CreatePolicyRequest = {
  name?: string;
  effect?: PolicyEffect;
  scopes?: string[];
  conditions?: PolicyCondition[];
  priority?: number;
  workspaceId?: string;
};

type UpdatePolicyRequest = Partial<
  Pick<Policy, "name" | "effect" | "scopes" | "conditions" | "priority">
>;

type PolicyListResponse = {
  data: Policy[];
};

type ErrorResponse = {
  error: string;
};

type StoredPolicy = Policy & {
  deletedAt?: string;
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

type PolicyScenario = {
  db: D1Database;
  policies: Map<string, StoredPolicy>;
};

function createPolicy(overrides: Partial<StoredPolicy> = {}): StoredPolicy {
  return {
    id: overrides.id ?? "pol_test_123",
    name: overrides.name ?? "deny-prod-delete",
    effect: overrides.effect ?? "deny",
    scopes: overrides.scopes ?? ["cloud:workflow:delete:prod-*"],
    conditions: overrides.conditions ?? [],
    priority: overrides.priority ?? 500,
    orgId: overrides.orgId ?? "org_test",
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {}),
    createdAt: overrides.createdAt ?? "2026-03-25T10:00:00.000Z",
    ...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
  };
}

function clonePolicy(policy: StoredPolicy): StoredPolicy {
  return JSON.parse(JSON.stringify(policy)) as StoredPolicy;
}

function toPolicyRow(policy: StoredPolicy): PolicyRow {
  return {
    id: policy.id,
    name: policy.name,
    effect: policy.effect,
    scopes: [...policy.scopes],
    scopes_json: JSON.stringify(policy.scopes),
    conditions: policy.conditions.map((condition) => ({ ...condition })),
    conditions_json: JSON.stringify(policy.conditions),
    priority: policy.priority,
    orgId: policy.orgId,
    org_id: policy.orgId,
    ...(policy.workspaceId !== undefined
      ? { workspaceId: policy.workspaceId, workspace_id: policy.workspaceId }
      : {}),
    createdAt: policy.createdAt,
    created_at: policy.createdAt,
    ...(policy.deletedAt !== undefined
      ? { deletedAt: policy.deletedAt, deleted_at: policy.deletedAt }
      : {}),
  };
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeColumn(column: string): string {
  return column.replace(/["'`[\]]/g, "").trim().toLowerCase();
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
    } catch {
      return value.trim().length > 0 ? [value] : [];
    }
  }

  return [];
}

function parseConditions(value: unknown): PolicyCondition[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is PolicyCondition => typeof entry === "object" && entry !== null)
      .map((entry) => ({ ...entry }));
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed
            .filter((entry): entry is PolicyCondition => typeof entry === "object" && entry !== null)
            .map((entry) => ({ ...entry }))
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function applyColumn(target: Partial<StoredPolicy>, column: string, value: unknown): void {
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

  if (normalized === "effect") {
    if (value === "allow" || value === "deny") {
      target.effect = value;
    }
    return;
  }

  if (normalized === "scopes" || normalized === "scopes_json") {
    target.scopes = parseStringArray(value);
    return;
  }

  if (normalized === "conditions" || normalized === "conditions_json") {
    target.conditions = parseConditions(value);
    return;
  }

  if (normalized === "priority") {
    const priority = parseNumber(value);
    if (priority !== undefined) {
      target.priority = priority;
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
      return;
    }
    if (value === null) {
      delete target.workspaceId;
    }
    return;
  }

  if (normalized === "created_at" || normalized === "createdat") {
    if (typeof value === "string") {
      target.createdAt = value;
    }
    return;
  }

  if (normalized === "deleted_at" || normalized === "deletedat") {
    if (typeof value === "string" && value.length > 0) {
      target.deletedAt = value;
      return;
    }
    if (value === null) {
      delete target.deletedAt;
    }
  }
}

function extractClauseOrder(
  sql: string,
): Array<{
  field:
    | "orgId"
    | "id"
    | "name"
    | "workspaceId"
    | "effect"
    | "priority"
    | "deletedAt";
  index: number;
}> {
  const patterns = [
    { field: "orgId" as const, regexes: [/\borg_id\s*=\s*\?/i, /\borgid\s*=\s*\?/i] },
    { field: "id" as const, regexes: [/\bid\s*=\s*\?/i] },
    { field: "name" as const, regexes: [/\bname\s*=\s*\?/i] },
    { field: "workspaceId" as const, regexes: [/\bworkspace_id\s*=\s*\?/i, /\bworkspaceid\s*=\s*\?/i] },
    { field: "effect" as const, regexes: [/\beffect\s*=\s*\?/i] },
    { field: "priority" as const, regexes: [/\bpriority\s*=\s*\?/i] },
    { field: "deletedAt" as const, regexes: [/\bdeleted_at\s*=\s*\?/i, /\bdeletedat\s*=\s*\?/i] },
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

function filterPoliciesByQuery(allPolicies: StoredPolicy[], query: string, params: unknown[]): StoredPolicy[] {
  const sql = normalizeSql(query);
  let policies = [...allPolicies];
  const orderedClauses = extractClauseOrder(sql);
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

  const name = values.get("name");
  if (typeof name === "string") {
    policies = policies.filter((policy) => policy.name === name);
  }

  const workspaceId = values.get("workspaceId");
  if (typeof workspaceId === "string") {
    const includeOrgScoped = /\bworkspace_id\s*=\s*\?\s+or\s+workspace_id\s+is\s+null\b/i.test(sql)
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

  const effect = values.get("effect");
  if (effect === "allow" || effect === "deny") {
    policies = policies.filter((policy) => policy.effect === effect);
  }

  const deletedAt = values.get("deletedAt");
  if (typeof deletedAt === "string") {
    policies = policies.filter((policy) => policy.deletedAt === deletedAt);
  } else if (/\bdeleted_at\s+is\s+null\b/i.test(sql) || /\bdeletedat\s+is\s+null\b/i.test(sql)) {
    policies = policies.filter((policy) => policy.deletedAt === undefined);
  }

  if (/\border by\b.*\bpriority\b.*\bdesc\b/i.test(sql)) {
    policies.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  } else if (/\border by\b.*\bcreated_at\b.*\bdesc\b/i.test(sql) || /\border by\b.*\bcreatedat\b.*\bdesc\b/i.test(sql)) {
    policies.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } else {
    policies.sort((left, right) => left.id.localeCompare(right.id));
  }

  const limitMatch = sql.match(/\blimit\s+(\d+)\b/i);
  if (limitMatch?.[1]) {
    const limit = Number.parseInt(limitMatch[1], 10);
    if (Number.isFinite(limit)) {
      policies = policies.slice(0, limit);
    }
  }

  return policies;
}

function createPolicyScenario(initialPolicies: StoredPolicy[] = []): PolicyScenario {
  const policies = new Map(initialPolicies.map((policy) => [policy.id, clonePolicy(policy)]));
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

    if (!/\bpolicies\b/.test(sql)) {
      return { rows: [], changes: 0 };
    }

    if (/\binsert\s+into\s+policies\b/i.test(sql)) {
      const columnsMatch = query.match(/\binsert\s+into\s+policies\s*\(([^)]+)\)/i);
      const columns = columnsMatch?.[1]
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
      const draft: Partial<StoredPolicy> = {};

      columns.forEach((column, index) => {
        applyColumn(draft, column, params[index]);
      });

      const policy = createPolicy({
        id: draft.id,
        name: draft.name,
        effect: draft.effect,
        scopes: draft.scopes,
        conditions: draft.conditions,
        priority: draft.priority,
        orgId: draft.orgId,
        ...(draft.workspaceId !== undefined ? { workspaceId: draft.workspaceId } : {}),
        createdAt: draft.createdAt,
        ...(draft.deletedAt !== undefined ? { deletedAt: draft.deletedAt } : {}),
      });

      policies.set(policy.id, clonePolicy(policy));
      return { rows: [], changes: 1 };
    }

    if (/\bupdate\s+policies\b/i.test(sql)) {
      const setMatch = query.match(/\bset\s+(.+?)\s+\bwhere\b/i);
      const assignments = setMatch?.[1]
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
      const setColumns = assignments.map((assignment) => assignment.split("=")[0]?.trim() ?? "");
      const setParams = params.slice(0, setColumns.length);
      const whereParams = params.slice(setColumns.length);
      const whereSql = query.split(/\bwhere\b/i)[1] ?? "";
      const matches = filterPoliciesByQuery([...policies.values()], whereSql, whereParams);

      for (const current of matches) {
        const next = clonePolicy(current);
        setColumns.forEach((column, index) => {
          applyColumn(next, column, setParams[index]);
        });
        policies.set(next.id, next);
      }

      return { rows: [], changes: matches.length };
    }

    if (/\bdelete\s+from\s+policies\b/i.test(sql)) {
      const whereSql = query.split(/\bwhere\b/i)[1] ?? "";
      const matches = filterPoliciesByQuery([...policies.values()], whereSql, params);
      for (const current of matches) {
        policies.delete(current.id);
      }
      return { rows: [], changes: matches.length };
    }

    return {
      rows: filterPoliciesByQuery([...policies.values()], query, params).map(toPolicyRow),
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
    policies,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(statements: D1PreparedStatement[]) =>
        Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

async function requestPoliciesApi(
  method: string,
  path: string,
  {
    body,
    claims,
    scenario,
  }: {
    body?: unknown;
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: PolicyScenario;
  } = {},
): Promise<{ response: Response; scenario: PolicyScenario }> {
  const activeScenario = scenario ?? createPolicyScenario();
  const app = createTestApp({
    DB: activeScenario.db,
  });
  const token = generateTestToken({
    org: "org_test",
    wks: "ws_test",
    scopes: ["relayauth:policy:manage:*", "relayauth:policy:read:*"],
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

async function postPolicy(
  body: CreatePolicyRequest,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: PolicyScenario;
  } = {},
): Promise<{ response: Response; scenario: PolicyScenario }> {
  return requestPoliciesApi("POST", "/v1/policies", { ...options, body });
}

async function getPolicy(
  policyId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: PolicyScenario;
  } = {},
): Promise<Response> {
  const { response } = await requestPoliciesApi("GET", `/v1/policies/${policyId}`, options);
  return response;
}

async function listPolicies(
  search = "",
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: PolicyScenario;
  } = {},
): Promise<Response> {
  const { response } = await requestPoliciesApi("GET", `/v1/policies${search}`, options);
  return response;
}

async function patchPolicy(
  policyId: string,
  body: UpdatePolicyRequest,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: PolicyScenario;
  } = {},
): Promise<Response> {
  const { response } = await requestPoliciesApi("PATCH", `/v1/policies/${policyId}`, { ...options, body });
  return response;
}

async function deletePolicy(
  policyId: string,
  options: {
    claims?: Partial<RelayAuthTokenClaims>;
    scenario?: PolicyScenario;
  } = {},
): Promise<{ response: Response; scenario: PolicyScenario }> {
  return requestPoliciesApi("DELETE", `/v1/policies/${policyId}`, options);
}

function assertIsoTimestamp(value: string): void {
  assert.equal(typeof value, "string");
  assert.equal(Number.isNaN(Date.parse(value)), false);
}

test("POST /v1/policies creates a policy with name, effect, scopes, conditions, and priority", async () => {
  const response = (
    await postPolicy({
      name: "deny-non-corp-ip-for-admin",
      effect: "deny",
      scopes: ["relayauth:admin:manage:*", "relayauth:policy:manage:*"],
      conditions: [
        {
          type: "ip",
          operator: "not_in",
          value: ["10.0.0.0/8", "192.168.0.0/16"],
        },
      ],
      priority: 950,
    })
  ).response;

  const body = await assertJsonResponse<Policy>(response, 201);

  assert.equal(body.name, "deny-non-corp-ip-for-admin");
  assert.equal(body.effect, "deny");
  assert.deepEqual(body.scopes, ["relayauth:admin:manage:*", "relayauth:policy:manage:*"]);
  assert.deepEqual(body.conditions, [
    {
      type: "ip",
      operator: "not_in",
      value: ["10.0.0.0/8", "192.168.0.0/16"],
    },
  ]);
  assert.equal(body.priority, 950);
  assert.equal(body.orgId, "org_test");
  assertIsoTimestamp(body.createdAt);
});

test("POST /v1/policies returns 400 when required fields are missing", async () => {
  const response = (
    await postPolicy({
      name: "missing-required-fields",
      scopes: ["relayauth:policy:manage:*"],
    })
  ).response;

  const body = await assertJsonResponse<ErrorResponse>(response, 400);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("POST /v1/policies validates effect is allow or deny", async () => {
  const response = (
    await postPolicy({
      name: "invalid-effect",
      effect: "block" as PolicyEffect,
      scopes: ["relayauth:policy:manage:*"],
      conditions: [],
      priority: 10,
    })
  ).response;

  const body = await assertJsonResponse<ErrorResponse>(response, 400);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("POST /v1/policies validates conditions format", async () => {
  const response = (
    await postPolicy({
      name: "invalid-conditions",
      effect: "deny",
      scopes: ["cloud:workflow:run:prod-*"],
      conditions: [
        {
          type: "timezone" as PolicyCondition["type"],
          operator: "eq",
          value: "UTC",
        },
      ],
      priority: 800,
    })
  ).response;

  const body = await assertJsonResponse<ErrorResponse>(response, 400);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("GET /v1/policies/:id returns a policy by ID", async () => {
  const policy = createPolicy({
    id: "pol_get_123",
    name: "deny-after-hours-deploy",
    effect: "deny",
    scopes: ["cloud:workflow:run:prod-*"],
    conditions: [
      { type: "time", operator: "lt", value: "09:00" },
      { type: "time", operator: "gt", value: "17:00" },
    ],
    priority: 800,
    orgId: "org_test",
    createdAt: "2026-03-20T12:00:00.000Z",
  });
  const scenario = createPolicyScenario([policy]);
  const response = await getPolicy(policy.id, { scenario });

  const body = await assertJsonResponse<Policy>(response, 200);

  assert.deepEqual(body, {
    id: policy.id,
    name: policy.name,
    effect: policy.effect,
    scopes: policy.scopes,
    conditions: policy.conditions,
    priority: policy.priority,
    orgId: policy.orgId,
    createdAt: policy.createdAt,
  });
});

test("GET /v1/policies/:id returns 404 for a nonexistent policy", async () => {
  const response = await getPolicy("pol_missing_404");

  const body = await assertJsonResponse<ErrorResponse>(response, 404);

  assert.deepEqual(body, { error: "policy_not_found" });
});

test("GET /v1/policies lists all policies for the authenticated org ordered by priority", async () => {
  const highestPriority = createPolicy({
    id: "pol_list_900",
    name: "deny-prod-delete",
    priority: 900,
    orgId: "org_test",
  });
  const middlePriority = createPolicy({
    id: "pol_list_500",
    name: "allow-prod-read",
    effect: "allow",
    scopes: ["cloud:workflow:read:prod-*"],
    priority: 500,
    orgId: "org_test",
  });
  const lowestPriority = createPolicy({
    id: "pol_list_100",
    name: "allow-staging-read",
    effect: "allow",
    scopes: ["cloud:workflow:read:staging-*"],
    priority: 100,
    orgId: "org_test",
  });
  const scenario = createPolicyScenario([
    middlePriority,
    highestPriority,
    lowestPriority,
    createPolicy({
      id: "pol_other_org",
      name: "foreign-policy",
      orgId: "org_other",
      priority: 999,
    }),
  ]);
  const response = await listPolicies("", { scenario });

  const body = await assertJsonResponse<PolicyListResponse>(response, 200);

  assert.deepEqual(
    body.data.map((policy) => policy.id),
    [highestPriority.id, middlePriority.id, lowestPriority.id],
  );
});

test("PATCH /v1/policies/:id updates policy fields", async () => {
  const original = createPolicy({
    id: "pol_patch_123",
    name: "deny-non-corp-ip-for-admin",
    effect: "deny",
    scopes: ["relayauth:admin:manage:*"],
    conditions: [
      {
        type: "ip",
        operator: "not_in",
        value: ["10.0.0.0/8"],
      },
    ],
    priority: 950,
    orgId: "org_test",
    createdAt: "2026-03-01T00:00:00.000Z",
  });
  const scenario = createPolicyScenario([original]);
  const response = await patchPolicy(
    original.id,
    {
      name: "deny-admin-outside-approved-network",
      effect: "deny",
      scopes: ["relayauth:admin:manage:*", "relayauth:policy:manage:*"],
      conditions: [
        {
          type: "ip",
          operator: "not_in",
          value: ["10.0.0.0/8", "192.168.0.0/16"],
        },
      ],
      priority: 975,
    },
    { scenario },
  );

  const body = await assertJsonResponse<Policy>(response, 200);

  assert.equal(body.id, original.id);
  assert.equal(body.orgId, original.orgId);
  assert.equal(body.createdAt, original.createdAt);
  assert.equal(body.name, "deny-admin-outside-approved-network");
  assert.equal(body.effect, "deny");
  assert.deepEqual(body.scopes, ["relayauth:admin:manage:*", "relayauth:policy:manage:*"]);
  assert.deepEqual(body.conditions, [
    {
      type: "ip",
      operator: "not_in",
      value: ["10.0.0.0/8", "192.168.0.0/16"],
    },
  ]);
  assert.equal(body.priority, 975);
});

test("PATCH /v1/policies/:id validates scope format on update", async () => {
  const policy = createPolicy({
    id: "pol_patch_invalid_scope",
    name: "deny-prod-delete",
    orgId: "org_test",
  });
  const scenario = createPolicyScenario([policy]);
  const response = await patchPolicy(
    policy.id,
    {
      scopes: ["not-a-valid-scope"],
    },
    { scenario },
  );

  const body = await assertJsonResponse<ErrorResponse>(response, 400);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("DELETE /v1/policies/:id soft-deletes a policy", async () => {
  const policy = createPolicy({
    id: "pol_delete_123",
    name: "temporary-guardrail",
    orgId: "org_test",
  });
  const scenario = createPolicyScenario([policy]);
  const { response } = await deletePolicy(policy.id, { scenario });

  assert.equal(response.status, 204);
  assert.equal(scenario.policies.has(policy.id), true);
  assert.equal(typeof scenario.policies.get(policy.id)?.deletedAt, "string");
});
