import assert from "node:assert/strict";
import test from "node:test";
import { RelayAuthError, matchesAny, parseScope, validateScope, validateSubset } from "@relayauth/sdk";
import type { Policy, Role } from "@relayauth/types";
import { Hono } from "hono";

import type { StoredIdentity } from "../../durable-objects/identity-do.js";
import { writeAuditEntry } from "../../engine/audit-logger.js";
import { checkAccess, evaluatePermissions } from "../../engine/policy-evaluation.js";
import { getInheritanceChain } from "../../engine/scope-inheritance.js";
import type { AppEnv } from "../../env.js";
import { requireScope } from "../../middleware/scope.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "../test-helpers.js";
import { authenticate } from "../../lib/auth.js";

type StoredPolicy = Policy & { deletedAt?: string };

type StoredOrganization = {
  id: string;
  scopes: string[];
  roles: string[];
};

type StoredWorkspace = {
  id: string;
  orgId: string;
  scopes: string[];
  roles: string[];
};

type AuditLogRow = {
  id: string;
  action: string;
  identityId: string;
  orgId: string;
  workspaceId?: string;
  plane?: string;
  resource?: string;
  result: "allowed" | "denied" | "error";
  metadata: Record<string, string>;
  timestamp: string;
};

type HarnessState = {
  roles: Map<string, Role>;
  policies: Map<string, StoredPolicy>;
  identities: Map<string, StoredIdentity>;
  organizations: Map<string, StoredOrganization>;
  workspaces: Map<string, StoredWorkspace>;
  auditLogs: AuditLogRow[];
  executed: Array<{ query: string; params: unknown[] }>;
};

type RequestOptions = {
  body?: unknown;
  claims?: Record<string, unknown>;
  headers?: HeadersInit;
};

const ORG_ID = "org_rbac_e2e";
const WORKSPACE_ID = "ws_rbac_e2e";
const READ_SCOPE = "relaycast:channel:read:*";
const WRITE_SCOPE = "relaycast:channel:write:*";
const FILE_WRITE_SCOPE = "relayfile:fs:write:*";
const READ_GENERAL_SCOPE = "relaycast:channel:read:general";
const WRITE_GENERAL_SCOPE = "relaycast:channel:write:general";
const PRIORITY_SCOPE = "relaycast:channel:write:priority-room";
const ADMIN_SCOPES = ["relayauth:*:*:*"];

test("Scopes & RBAC E2E", async (t) => {
  const harness = createRbacHarness();

  const primaryIdentity = harness.seedIdentity(
    createStoredIdentity({
      id: "agent_rbac_primary",
      name: "Primary RBAC Agent",
      scopes: [],
      roles: [],
    }),
  );
  const priorityIdentity = harness.seedIdentity(
    createStoredIdentity({
      id: "agent_rbac_priority",
      name: "Priority Agent",
      scopes: [PRIORITY_SCOPE],
      roles: [],
    }),
  );
  const budgetIdentity = harness.seedIdentity(
    createStoredIdentity({
      id: "agent_rbac_budget",
      name: "Budget Limited Agent",
      scopes: [READ_GENERAL_SCOPE],
      roles: [],
      budget: {
        maxActionsPerHour: 1,
        alertThreshold: 0.8,
      },
      budgetUsage: {
        actionsThisHour: 2,
        costToday: 0,
        lastResetAt: "2026-03-25T10:00:00.000Z",
      },
    }),
  );
  const childIdentity = harness.seedIdentity(
    createStoredIdentity({
      id: "agent_rbac_child",
      name: "Child RBAC Agent",
      scopes: [READ_SCOPE, WRITE_SCOPE, FILE_WRITE_SCOPE],
      roles: [],
    }),
  );

  let createdRole: Role | undefined;
  let denyPolicy: Policy | undefined;

  await t.test("1. parses and validates scope strings", async () => {
    const parsed = parseScope("relayfile:fs:write:/docs//team/*");

    assert.equal(parsed.plane, "relayfile");
    assert.equal(parsed.resource, "fs");
    assert.equal(parsed.action, "write");
    assert.equal(parsed.path, "/docs/team/*");

    assert.equal(validateScope(READ_SCOPE), true);
    assert.equal(validateScope("relayfile:fs:write:docs/*"), false);
    assert.equal(validateScope("relaycast:channel:admin:*"), false);

    assert.throws(
      () => parseScope("relayfile:fs:write:docs/*"),
      /filesystem paths must start with \//i,
    );
  });

  await t.test("2. creates a role with relaycast read and write scopes", async () => {
    const response = await harness.request("POST", "/v1/roles", {
      body: {
        name: "channel-operator",
        description: "Can read and write relaycast channels",
        scopes: [READ_SCOPE, WRITE_SCOPE],
      },
    });

    createdRole = await assertJsonResponse<Role>(response, 201);
    assert.deepEqual(sortStrings(createdRole.scopes), sortStrings([READ_SCOPE, WRITE_SCOPE]));
  });

  await t.test("3. creates an identity and assigns the role", async () => {
    assert.ok(createdRole, "expected role to exist before assignment");

    const response = await harness.request("POST", `/v1/identities/${primaryIdentity.id}/roles`, {
      body: { roleId: createdRole.id },
    });

    const assigned = await assertJsonResponse<StoredIdentity>(response, 201);
    assert.deepEqual(assigned.roles, [createdRole.id]);
  });

  await t.test("4. token with the role scopes can access relaycast:channel:read:general", async () => {
    const token = await harness.issueEffectiveToken(primaryIdentity.id);
    const response = await requestProtectedScope(
      harness.app.bindings,
      READ_SCOPE,
      token,
      "/channels/general",
    );

    await assertJsonResponse<{ ok: boolean }>(response, 200, (body) => {
      assert.equal(body.ok, true);
    });
  });

  await t.test("5. token with the role scopes cannot access relayfile:fs:write:*", async () => {
    const token = await harness.issueEffectiveToken(primaryIdentity.id);
    const response = await requestProtectedScope(
      harness.app.bindings,
      FILE_WRITE_SCOPE,
      token,
      "/files/write",
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 403, (body) => {
      assert.equal(body.code, "insufficient_scope");
      assert.match(body.error, /insufficient scope/i);
    });
  });

  await t.test("6. creates a deny policy that blocks relaycast:channel:write:* for the identity", async () => {
    const response = await harness.request("POST", "/v1/policies", {
      body: {
        name: "deny-primary-write",
        effect: "deny",
        scopes: [WRITE_SCOPE],
        conditions: [
          {
            type: "identity",
            operator: "eq",
            value: primaryIdentity.id,
          },
        ],
        priority: 800,
      },
    });

    denyPolicy = await assertJsonResponse<Policy>(response, 201);
    assert.equal(denyPolicy.effect, "deny");
  });

  await t.test("7. identity can still read but cannot write after the deny policy", async () => {
    const readDecision = await checkAccess(
      harness.db,
      primaryIdentity.id,
      ORG_ID,
      READ_GENERAL_SCOPE,
    );
    const writeDecision = await checkAccess(
      harness.db,
      primaryIdentity.id,
      ORG_ID,
      WRITE_GENERAL_SCOPE,
    );

    assert.deepEqual(readDecision, {
      allowed: true,
      reason: "scope_allowed",
    });
    assert.equal(writeDecision.allowed, false);
    assert.equal(writeDecision.reason, "policy_denied");
    assert.equal(writeDecision.matchedPolicy, denyPolicy?.id);

    const effective = await evaluatePermissions(harness.db, primaryIdentity.id, ORG_ID);
    assert.deepEqual(
      sortStrings(effective.effectiveScopes),
      sortStrings([READ_SCOPE]),
    );
  });

  await t.test("8. scope inheritance narrows a child request to the parent boundary", async () => {
    const narrowed = matchesAny(
      [READ_SCOPE, WRITE_SCOPE, FILE_WRITE_SCOPE],
      [READ_SCOPE, WRITE_SCOPE],
    );
    assert.deepEqual(sortStrings(narrowed.matched), sortStrings([READ_SCOPE, WRITE_SCOPE]));
    assert.deepEqual(narrowed.denied, [FILE_WRITE_SCOPE]);

    const chain = await getInheritanceChain(harness.db, childIdentity.id);

    assert.deepEqual(chain.org.scopes, ["relaycast:*:*:*"]);
    assert.deepEqual(chain.workspace.scopes, ["relaycast:channel:*:*"]);
    assert.deepEqual(
      sortStrings(chain.agent.scopes),
      sortStrings([READ_SCOPE, WRITE_SCOPE]),
    );
    assert.equal(chain.agent.scopes.includes(FILE_WRITE_SCOPE), false);
  });

  await t.test("9. higher-priority allow overrides a lower-priority deny", async () => {
    const lowerDeny = await harness.request("POST", "/v1/policies", {
      body: {
        name: "priority-lower-deny",
        effect: "deny",
        scopes: [PRIORITY_SCOPE],
        conditions: [
          {
            type: "identity",
            operator: "eq",
            value: priorityIdentity.id,
          },
        ],
        priority: 100,
      },
    });
    const lowerDenyPolicy = await assertJsonResponse<Policy>(lowerDeny, 201);

    const higherAllow = await harness.request("POST", "/v1/policies", {
      body: {
        name: "priority-higher-allow",
        effect: "allow",
        scopes: [PRIORITY_SCOPE],
        conditions: [
          {
            type: "identity",
            operator: "eq",
            value: priorityIdentity.id,
          },
        ],
        priority: 900,
      },
    });
    const higherAllowPolicy = await assertJsonResponse<Policy>(higherAllow, 201);

    const decision = await checkAccess(
      harness.db,
      priorityIdentity.id,
      ORG_ID,
      PRIORITY_SCOPE,
    );
    const evaluation = await evaluatePermissions(harness.db, priorityIdentity.id, ORG_ID);

    assert.deepEqual(decision, {
      allowed: true,
      reason: "scope_allowed",
    });
    assert.equal(evaluation.effectiveScopes.includes(PRIORITY_SCOPE), true);
    assert.deepEqual(
      evaluation.appliedPolicies.map((policy) => policy.id),
      [higherAllowPolicy.id],
    );
  });

  await t.test("10. scope middleware returns 403 for insufficient scope", async () => {
    const token = generateTestToken({
      sub: primaryIdentity.id,
      org: ORG_ID,
      wks: WORKSPACE_ID,
      scopes: [READ_SCOPE],
      sponsorId: primaryIdentity.sponsorId,
      sponsorChain: primaryIdentity.sponsorChain,
    });

    const response = await requestProtectedScope(
      harness.app.bindings,
      WRITE_SCOPE,
      token,
      "/channels/write",
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 403, (body) => {
      assert.equal(body.code, "insufficient_scope");
      assert.match(body.error, /requires all of/i);
    });
  });

  await t.test("11. deleting the deny policy restores write access, then removing the role revokes inherited access", async () => {
    assert.ok(denyPolicy, "expected deny policy to exist before cleanup");
    assert.ok(createdRole, "expected role to exist before cleanup");

    const deletePolicyResponse = await harness.request("DELETE", `/v1/policies/${denyPolicy.id}`);
    assert.equal(deletePolicyResponse.status, 204);

    const restoredWrite = await checkAccess(
      harness.db,
      primaryIdentity.id,
      ORG_ID,
      WRITE_GENERAL_SCOPE,
    );
    assert.deepEqual(restoredWrite, {
      allowed: true,
      reason: "scope_allowed",
    });

    const removeRoleResponse = await harness.request(
      "DELETE",
      `/v1/identities/${primaryIdentity.id}/roles/${createdRole.id}`,
    );
    assert.equal(removeRoleResponse.status, 204);

    const afterRoleRemoval = await checkAccess(
      harness.db,
      primaryIdentity.id,
      ORG_ID,
      READ_GENERAL_SCOPE,
    );
    assert.deepEqual(afterRoleRemoval, {
      allowed: false,
      reason: "implicit_deny",
    });

    const deleteRoleResponse = await harness.request("DELETE", `/v1/roles/${createdRole.id}`);
    assert.equal(deleteRoleResponse.status, 204);
  });

  await t.test("budget exceeded denies access with a clear reason and records an audit event", async () => {
    const decision = await checkAccess(
      harness.db,
      budgetIdentity.id,
      ORG_ID,
      READ_GENERAL_SCOPE,
    );

    assert.deepEqual(decision, {
      allowed: false,
      reason: "budget_exceeded",
    });

    const audit = harness.state.auditLogs.find(
      (entry) =>
        entry.action === "budget.exceeded"
        && entry.identityId === budgetIdentity.id
        && entry.resource === READ_GENERAL_SCOPE,
    );

    assert.ok(audit, "expected a budget.exceeded audit log");
    assert.equal(audit?.result, "denied");
    assert.equal(audit?.metadata.actionAttempted, READ_GENERAL_SCOPE);
  });

  await t.test("scope escalation attempt returns 403 and writes a scope.escalation_denied audit event", async () => {
    const escalationApp = createScopeIssuanceApp();
    const parentToken = generateTestToken({
      sub: primaryIdentity.id,
      org: ORG_ID,
      wks: WORKSPACE_ID,
      scopes: [READ_SCOPE, WRITE_SCOPE],
      sponsorId: primaryIdentity.sponsorId,
      sponsorChain: primaryIdentity.sponsorChain,
    });

    const response = await escalationApp.request(
      createTestRequest(
        "POST",
        "/subagents",
        {
          scopes: [READ_SCOPE, WRITE_SCOPE, FILE_WRITE_SCOPE],
        },
        {
          Authorization: `Bearer ${parentToken}`,
        },
      ),
      undefined,
      harness.app.bindings,
    );

    await assertJsonResponse<{ error: string; code?: string }>(response, 403, (body) => {
      assert.equal(body.code, "scope_escalation");
      assert.match(body.error, /broader than the parent scope set/i);
    });

    const audit = harness.state.auditLogs.find(
      (entry) =>
        entry.action === "scope.escalation_denied"
        && entry.identityId === primaryIdentity.id
        && entry.resource === FILE_WRITE_SCOPE,
    );

    assert.ok(audit, "expected a scope.escalation_denied audit log");
    assert.equal(audit?.result, "denied");
    assert.equal(audit?.metadata.actionAttempted, FILE_WRITE_SCOPE);
  });
});

function createRbacHarness() {
  const state: HarnessState = {
    roles: new Map(),
    policies: new Map(),
    identities: new Map(),
    organizations: new Map([
      [
        ORG_ID,
        {
          id: ORG_ID,
          scopes: ["relaycast:*:*:*"],
          roles: [],
        },
      ],
    ]),
    workspaces: new Map([
      [
        WORKSPACE_ID,
        {
          id: WORKSPACE_ID,
          orgId: ORG_ID,
          scopes: ["relaycast:channel:*:*"],
          roles: [],
        },
      ],
    ]),
    auditLogs: [],
    executed: [],
  };

  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const db = {
    prepare(query: string) {
      return {
        bind: (...params: unknown[]) => ({
          first: async <T>() => (resolveAll(state, query, params)[0] as T | null) ?? null,
          all: async <T>() => ({
            results: resolveAll(state, query, params) as T[],
            success: true,
            meta,
          }),
          raw: async <T>() => resolveAll(state, query, params) as T[],
          run: async () => runMutation(state, query, params),
        }),
        first: async <T>() => (resolveAll(state, query, [])[0] as T | null) ?? null,
        all: async <T>() => ({
          results: resolveAll(state, query, []) as T[],
          success: true,
          meta,
        }),
        raw: async <T>() => resolveAll(state, query, []) as T[],
        run: async () => runMutation(state, query, []),
      };
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as D1Database;

  const identityDo = {
    idFromName(name: string) {
      return name;
    },
    get(identityId: string) {
      return {
        fetch: async (request: Request) => handleIdentityDoRequest(state, identityId, request),
      };
    },
  } as unknown as DurableObjectNamespace;

  const app = createTestApp({
    DB: db,
    IDENTITY_DO: identityDo,
  });

  async function request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (!headers.has("Authorization")) {
      headers.set(
        "Authorization",
        `Bearer ${generateTestToken({
          sub: "agent_rbac_admin",
          org: ORG_ID,
          wks: WORKSPACE_ID,
          scopes: ADMIN_SCOPES,
          sponsorId: "user_rbac_owner",
          sponsorChain: ["user_rbac_owner", "agent_rbac_admin"],
          ...(options.claims ?? {}),
        })}`,
      );
    }

    const request = createTestRequest(method, path, options.body, headers);
    return app.request(request, undefined, app.bindings);
  }

  function seedIdentity(identity: StoredIdentity): StoredIdentity {
    const cloned = clone(identity);
    state.identities.set(cloned.id, cloned);
    return clone(cloned);
  }

  async function issueEffectiveToken(identityId: string): Promise<string> {
    const identity = state.identities.get(identityId);
    assert.ok(identity, `expected seeded identity '${identityId}'`);

    const evaluation = await evaluatePermissions(db, identity.id, identity.orgId, {
      workspaceId: identity.workspaceId,
      identityId: identity.id,
    });

    return generateTestToken({
      sub: identity.id,
      org: identity.orgId,
      wks: identity.workspaceId,
      scopes: evaluation.effectiveScopes,
      sponsorId: identity.sponsorId,
      sponsorChain: identity.sponsorChain,
    });
  }

  return {
    app,
    db,
    state,
    request,
    seedIdentity,
    issueEffectiveToken,
  };
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_rbac_owner";

  return {
    ...base,
    orgId: overrides.orgId ?? ORG_ID,
    roles: overrides.roles ?? [],
    scopes: overrides.scopes ?? [],
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, base.id],
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createScopeIssuanceApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/subagents", async (c) => {
    const auth = await authenticate(c.req.header("Authorization"), c.env.SIGNING_KEY);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: "invalid_authorization" }, auth.status);
    }

    const claims = auth.claims;
    const body = await c.req.json<{ scopes?: string[] }>().catch(() => null);
    const requestedScopes = Array.isArray(body?.scopes) ? body.scopes : [];

    try {
      validateSubset(claims.scopes, requestedScopes);
      const narrowed = matchesAny(requestedScopes, claims.scopes).matched;
      return c.json({ scopes: narrowed }, 201);
    } catch (error) {
      const deniedScope = matchesAny(requestedScopes, claims.scopes).denied[0] ?? requestedScopes[0] ?? "*";
      await writeAuditEntry(c.env.DB, {
        action: "scope.escalation_denied",
        identityId: claims.sub,
        orgId: claims.org,
        workspaceId: claims.wks,
        plane: safeScopePlane(deniedScope),
        resource: deniedScope,
        result: "denied",
        metadata: {
          sponsorId: claims.sponsorId,
          sponsorChain: JSON.stringify(claims.sponsorChain),
          actionAttempted: deniedScope,
        },
      });

      const relayError = error instanceof RelayAuthError ? error : new RelayAuthError(
        String(error),
        "scope_escalation",
        403,
      );

      return c.json(
        {
          error: relayError.message,
          code: relayError.code,
        },
        relayError.statusCode ?? 403,
      );
    }
  });

  return app;
}

async function requestProtectedScope(
  bindings: AppEnv["Bindings"],
  requiredScope: string,
  token: string,
  path: string,
): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use(path, requireScope(requiredScope));
  app.get(path, (c) => c.json({ ok: true }));

  return app.request(
    createTestRequest(
      "GET",
      path,
      undefined,
      { Authorization: `Bearer ${token}` },
    ),
    undefined,
    bindings,
  );
}

async function handleIdentityDoRequest(
  state: HarnessState,
  identityId: string,
  request: Request,
): Promise<Response> {
  const current = state.identities.get(identityId);
  const pathname = new URL(request.url).pathname;

  if (pathname === "/internal/get" && request.method === "GET") {
    if (!current) {
      return jsonResponse({ error: "identity_not_found" }, 404);
    }
    return jsonResponse(current, 200);
  }

  if (pathname === "/internal/create" && request.method === "POST") {
    const created = await request.json<StoredIdentity>().catch(() => null);
    if (!created) {
      return jsonResponse({ error: "invalid_identity_payload" }, 400);
    }

    state.identities.set(created.id, clone(created));
    return jsonResponse(created, 201);
  }

  if (pathname === "/internal/update" && request.method === "PATCH") {
    if (!current) {
      return jsonResponse({ error: "identity_not_found" }, 404);
    }

    const patch = await request.json<Partial<StoredIdentity>>().catch(() => null);
    if (!patch) {
      return jsonResponse({ error: "invalid_identity_patch" }, 400);
    }

    return jsonResponse(mergeIdentity(state, current, patch), 200);
  }

  return jsonResponse({ error: `unexpected_do_request:${request.method}:${pathname}` }, 500);
}

function mergeIdentity(
  state: HarnessState,
  current: StoredIdentity,
  patch: Partial<StoredIdentity>,
): StoredIdentity {
  const next: StoredIdentity = {
    ...current,
    ...patch,
    roles: patch.roles ?? current.roles,
    scopes: patch.scopes ?? current.scopes,
    metadata: patch.metadata ?? current.metadata,
    sponsorChain: patch.sponsorChain ?? current.sponsorChain,
    updatedAt: new Date().toISOString(),
  };

  state.identities.set(next.id, clone(next));
  return next;
}

function resolveAll(state: HarnessState, query: string, params: unknown[]): unknown[] {
  const sql = normalizeSql(query);
  state.executed.push({ query: sql, params: [...params] });

  if (/\bfrom roles\b/.test(sql)) {
    return selectRoles(state, sql, params);
  }

  if (/\bfrom policies\b/.test(sql)) {
    return selectPolicies(state, sql, params);
  }

  if (/\bfrom identities\b/.test(sql)) {
    return selectIdentities(state, sql, params);
  }

  if (/\bfrom organizations\b/.test(sql)) {
    return selectOrganizations(state, params);
  }

  if (/\bfrom workspaces\b/.test(sql)) {
    return selectWorkspaces(state, params);
  }

  return [];
}

function selectRoles(state: HarnessState, sql: string, params: unknown[]): unknown[] {
  let roles = [...state.roles.values()];

  if (/\bwhere id in \(/.test(sql)) {
    const ids = new Set(params.filter((value): value is string => typeof value === "string"));
    roles = roles.filter((role) => ids.has(role.id));
  } else if (/\bwhere id = \?/.test(sql)) {
    const [id] = params;
    roles = roles.filter((role) => role.id === id);
  } else if (/\bwhere org_id = \? and name = \?/.test(sql)) {
    const [orgId, name] = params;
    roles = roles.filter((role) => role.orgId === orgId && role.name === name);
  } else if (/\bwhere org_id = \? and \(workspace_id = \? or workspace_id is null\)/.test(sql)) {
    const [orgId, workspaceId] = params;
    roles = roles.filter(
      (role) => role.orgId === orgId && (role.workspaceId === workspaceId || role.workspaceId === undefined),
    );
  } else if (/\bwhere org_id = \?/.test(sql)) {
    const [orgId] = params;
    roles = roles.filter((role) => role.orgId === orgId);
  }

  if (/\border by name asc, id asc\b/.test(sql)) {
    roles.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  } else {
    roles.sort((left, right) => left.id.localeCompare(right.id));
  }

  return roles.map(toRoleRow);
}

function selectPolicies(state: HarnessState, sql: string, params: unknown[]): unknown[] {
  let policies = [...state.policies.values()].filter((policy) => policy.deletedAt === undefined);

  if (/\bwhere id = \? and deleted_at is null\b/.test(sql)) {
    const [id] = params;
    policies = policies.filter((policy) => policy.id === id);
  } else if (/\bwhere org_id = \? and name = \? and deleted_at is null\b/.test(sql)) {
    const [orgId, name] = params;
    policies = policies.filter((policy) => policy.orgId === orgId && policy.name === name);
  } else if (/\bwhere org_id = \? and deleted_at is null and \(workspace_id = \? or workspace_id is null\)/.test(sql)) {
    const [orgId, workspaceId] = params;
    policies = policies.filter(
      (policy) => policy.orgId === orgId && (policy.workspaceId === workspaceId || policy.workspaceId === undefined),
    );
  } else if (/\bwhere org_id = \? and deleted_at is null\b/.test(sql)) {
    const [orgId] = params;
    policies = policies.filter((policy) => policy.orgId === orgId);
  }

  if (/\border by priority desc, id asc\b/.test(sql)) {
    policies.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  } else {
    policies.sort((left, right) => left.id.localeCompare(right.id));
  }

  return policies.map(toPolicyRow);
}

function selectIdentities(state: HarnessState, sql: string, params: unknown[]): unknown[] {
  if (/\bselect roles, roles_json\b/.test(sql)) {
    const [id] = params;
    const identity = typeof id === "string" ? state.identities.get(id) : undefined;
    if (!identity) {
      return [];
    }
    return [{
      roles: [...identity.roles],
      roles_json: JSON.stringify(identity.roles),
    }];
  }

  if (/\bselect org_id as orgid\b/.test(sql) && /\bwhere id = \?/.test(sql)) {
    const [id] = params;
    const identity = typeof id === "string" ? state.identities.get(id) : undefined;
    if (!identity) {
      return [];
    }
    return [{
      orgId: identity.orgId,
      org_id: identity.orgId,
    }];
  }

  if (/\bwhere org_id = \? and id = \?/.test(sql)) {
    const [orgId, id] = params;
    const identity = typeof id === "string" ? state.identities.get(id) : undefined;
    if (!identity || identity.orgId !== orgId) {
      return [];
    }
    return [toIdentityRow(identity)];
  }

  if (/\bwhere id = \? limit 1\b/.test(sql)) {
    const [id] = params;
    const identity = typeof id === "string" ? state.identities.get(id) : undefined;
    return identity ? [toIdentityRow(identity)] : [];
  }

  return [];
}

function selectOrganizations(state: HarnessState, params: unknown[]): unknown[] {
  const [id] = params;
  const organization = typeof id === "string" ? state.organizations.get(id) : undefined;
  if (!organization) {
    return [];
  }

  return [{
    id: organization.id,
    orgId: organization.id,
    org_id: organization.id,
    scopes: [...organization.scopes],
    scopes_json: JSON.stringify(organization.scopes),
    roles: [...organization.roles],
    roles_json: JSON.stringify(organization.roles),
  }];
}

function selectWorkspaces(state: HarnessState, params: unknown[]): unknown[] {
  const [id] = params;
  const workspace = typeof id === "string" ? state.workspaces.get(id) : undefined;
  if (!workspace) {
    return [];
  }

  return [{
    id: workspace.id,
    workspaceId: workspace.id,
    workspace_id: workspace.id,
    orgId: workspace.orgId,
    org_id: workspace.orgId,
    scopes: [...workspace.scopes],
    scopes_json: JSON.stringify(workspace.scopes),
    roles: [...workspace.roles],
    roles_json: JSON.stringify(workspace.roles),
  }];
}

function runMutation(state: HarnessState, query: string, params: unknown[]) {
  const sql = normalizeSql(query);
  state.executed.push({ query: sql, params: [...params] });

  if (/^insert into roles\b/.test(sql)) {
    const [id, name, description, scopes, _scopesJson, orgId, workspaceId, builtIn, createdAt] = params;
    state.roles.set(String(id), {
      id: String(id),
      name: String(name),
      description: String(description),
      scopes: parseStringArray(scopes),
      orgId: String(orgId),
      ...(typeof workspaceId === "string" && workspaceId.length > 0 ? { workspaceId } : {}),
      builtIn: builtIn === 1 || builtIn === true,
      createdAt: String(createdAt),
    });
    return successResult();
  }

  if (/^update roles\b/.test(sql)) {
    const [name, description, scopes, _scopesJson, id, orgId] = params;
    const existing = state.roles.get(String(id));
    if (existing && existing.orgId === orgId) {
      state.roles.set(existing.id, {
        ...existing,
        name: String(name),
        description: String(description),
        scopes: parseStringArray(scopes),
      });
    }
    return successResult();
  }

  if (/^delete from roles\b/.test(sql)) {
    const [id, orgId] = params;
    const existing = state.roles.get(String(id));
    if (existing && existing.orgId === orgId) {
      state.roles.delete(existing.id);
    }
    return successResult();
  }

  if (/^insert into policies\b/.test(sql)) {
    const [
      id,
      name,
      effect,
      scopes,
      _scopesJson,
      conditions,
      _conditionsJson,
      priority,
      orgId,
      workspaceId,
      createdAt,
      deletedAt,
    ] = params;

    state.policies.set(String(id), {
      id: String(id),
      name: String(name),
      effect: effect as Policy["effect"],
      scopes: parseStringArray(scopes),
      conditions: parseConditions(conditions),
      priority: Number(priority),
      orgId: String(orgId),
      ...(typeof workspaceId === "string" && workspaceId.length > 0 ? { workspaceId } : {}),
      createdAt: String(createdAt),
      ...(typeof deletedAt === "string" && deletedAt.length > 0 ? { deletedAt } : {}),
    });
    return successResult();
  }

  if (/^update policies\b/.test(sql) && /\bset name = \?, effect = \?/.test(sql)) {
    const [name, effect, scopes, _scopesJson, conditions, _conditionsJson, priority, id, orgId] = params;
    const existing = state.policies.get(String(id));
    if (existing && existing.orgId === orgId && existing.deletedAt === undefined) {
      state.policies.set(existing.id, {
        ...existing,
        name: String(name),
        effect: effect as Policy["effect"],
        scopes: parseStringArray(scopes),
        conditions: parseConditions(conditions),
        priority: Number(priority),
      });
    }
    return successResult();
  }

  if (/^update policies\b/.test(sql) && /\bset deleted_at = \?/.test(sql)) {
    const [deletedAt, id, orgId] = params;
    const existing = state.policies.get(String(id));
    if (existing && existing.orgId === orgId && existing.deletedAt === undefined) {
      state.policies.set(existing.id, {
        ...existing,
        deletedAt: String(deletedAt),
      });
    }
    return successResult();
  }

  if (/^insert into audit_logs\b/.test(sql)) {
    const [
      id,
      action,
      identityId,
      orgId,
      workspaceId,
      plane,
      resource,
      result,
      metadataJson,
      _ip,
      _userAgent,
      timestamp,
    ] = params;

    state.auditLogs.push({
      id: String(id),
      action: String(action),
      identityId: String(identityId),
      orgId: String(orgId),
      ...(typeof workspaceId === "string" ? { workspaceId } : {}),
      ...(typeof plane === "string" ? { plane } : {}),
      ...(typeof resource === "string" ? { resource } : {}),
      result: result as AuditLogRow["result"],
      metadata: parseRecord(metadataJson),
      timestamp: String(timestamp),
    });
    return successResult();
  }

  return successResult();
}

function toRoleRow(role: Role) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    scopes: [...role.scopes],
    scopes_json: JSON.stringify(role.scopes),
    orgId: role.orgId,
    org_id: role.orgId,
    ...(role.workspaceId ? { workspaceId: role.workspaceId, workspace_id: role.workspaceId } : {}),
    builtIn: role.builtIn,
    built_in: role.builtIn ? 1 : 0,
    createdAt: role.createdAt,
    created_at: role.createdAt,
  };
}

function toPolicyRow(policy: StoredPolicy) {
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
    ...(policy.workspaceId ? { workspaceId: policy.workspaceId, workspace_id: policy.workspaceId } : {}),
    createdAt: policy.createdAt,
    created_at: policy.createdAt,
    deletedAt: policy.deletedAt ?? null,
    deleted_at: policy.deletedAt ?? null,
  };
}

function toIdentityRow(identity: StoredIdentity) {
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
    metadata: { ...identity.metadata },
    metadata_json: JSON.stringify(identity.metadata),
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
    budget: identity.budget ?? null,
    budget_json: identity.budget ? JSON.stringify(identity.budget) : null,
    budgetUsage: identity.budgetUsage ?? null,
    budget_usage: identity.budgetUsage ? JSON.stringify(identity.budgetUsage) : null,
    budget_usage_json: identity.budgetUsage ? JSON.stringify(identity.budgetUsage) : null,
  };
}

function parseStringArray(value: unknown): string[] {
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

function parseConditions(value: unknown): StoredPolicy["conditions"] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is StoredPolicy["conditions"][number] => typeof entry === "object" && entry !== null)
      .map((entry) => ({ ...entry }));
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is StoredPolicy["conditions"][number] => typeof entry === "object" && entry !== null)
          .map((entry) => ({ ...entry }))
      : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function sortStrings(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function safeScopePlane(scope: string): string | undefined {
  try {
    return parseScope(scope).plane;
  } catch {
    return undefined;
  }
}

function successResult() {
  return {
    success: true,
    meta: {
      changed_db: false,
      changes: 0,
      duration: 0,
      rows_read: 0,
      rows_written: 0,
    },
  };
}

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
