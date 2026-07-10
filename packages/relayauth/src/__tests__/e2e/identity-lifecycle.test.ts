import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentIdentity, RelayAuthTokenClaims } from "@relayauth/types";
import type { IdentityBudget, StoredIdentity } from "../../durable-objects/identity-do.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestToken,
} from "../test-helpers.js";

type ListIdentitiesResponse = {
  data: AgentIdentity[];
  cursor?: string;
};

type ActiveToken = {
  id: string;
  identityId: string;
};

type D1Call = {
  query: string;
  params: unknown[];
};

type DurableObjectCall = {
  identityId: string;
  method: string;
  path: string;
  body: unknown;
};

type KvPutCall = {
  key: string;
  value: string;
};

type LifecycleHarness = ReturnType<typeof createLifecycleHarness>;

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

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function createListRow(identity: StoredIdentity) {
  return {
    id: identity.id,
    name: identity.name,
    type: identity.type,
    orgId: identity.orgId,
    org_id: identity.orgId,
    status: identity.status,
    scopes: JSON.stringify(identity.scopes),
    scopes_json: JSON.stringify(identity.scopes),
    roles: JSON.stringify(identity.roles),
    roles_json: JSON.stringify(identity.roles),
    metadata: JSON.stringify(identity.metadata),
    metadata_json: JSON.stringify(identity.metadata),
    createdAt: identity.createdAt,
    created_at: identity.createdAt,
    updatedAt: identity.updatedAt,
    updated_at: identity.updatedAt,
    ...(identity.lastActiveAt !== undefined
      ? { lastActiveAt: identity.lastActiveAt, last_active_at: identity.lastActiveAt }
      : {}),
    ...(identity.suspendedAt !== undefined
      ? { suspendedAt: identity.suspendedAt, suspended_at: identity.suspendedAt }
      : {}),
    ...(identity.suspendReason !== undefined
      ? { suspendReason: identity.suspendReason, suspend_reason: identity.suspendReason }
      : {}),
  };
}

function mergeIdentity(current: StoredIdentity, update: Partial<StoredIdentity>, timestamp: string): StoredIdentity {
  return {
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
}

function isBudgetExceeded(identity: StoredIdentity): boolean {
  const budget = identity.budget;
  const usage = identity.budgetUsage;
  if (!budget || !usage) {
    return false;
  }

  const actionsExceeded =
    typeof budget.maxActionsPerHour === "number" && usage.actionsThisHour > budget.maxActionsPerHour;
  const costExceeded = typeof budget.maxCostPerDay === "number" && usage.costToday > budget.maxCostPerDay;

  return actionsExceeded || costExceeded;
}

function applyBudgetPolicy(previous: StoredIdentity, identity: StoredIdentity, timestamp: string): StoredIdentity {
  if (!isBudgetExceeded(identity) || identity.status === "retired" || !identity.budget?.autoSuspend) {
    return identity;
  }

  return {
    ...identity,
    status: "suspended",
    suspendReason: "budget_exceeded",
    suspendedAt: identity.suspendedAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function assertCreateInput(input: StoredIdentity): void {
  if (!input.sponsorId) {
    throw new Error("sponsorId is required");
  }

  if (!Array.isArray(input.sponsorChain) || input.sponsorChain.length === 0) {
    throw new Error("sponsorChain is required");
  }

  if (!input.workspaceId) {
    throw new Error("workspaceId is required");
  }
}

function createLifecycleHarness({
  orgBudgets = {},
  activeTokens = [],
}: {
  orgBudgets?: Record<string, IdentityBudget | undefined>;
  activeTokens?: ActiveToken[];
} = {}) {
  const identities = new Map<string, StoredIdentity>();
  const d1Calls: D1Call[] = [];
  const doCalls: DurableObjectCall[] = [];
  const kvPuts: KvPutCall[] = [];
  const kvStore = new Map<string, string>();
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const listIdentities = () =>
    Array.from(identities.values()).sort(
      (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    const normalized = normalizeSql(query);

    if (/from identities/.test(normalized) && /where org_id = \? and name = \?/.test(normalized)) {
      const [orgId, name] = params;
      const duplicate = listIdentities().find(
        (identity) => identity.orgId === orgId && identity.name === name,
      );
      return duplicate
        ? [
            {
              id: duplicate.id,
              name: duplicate.name,
              orgId: duplicate.orgId,
              org_id: duplicate.orgId,
            },
          ]
        : [];
    }

    if (/from org_budgets/.test(normalized)) {
      const [orgId] = params;
      const budget = typeof orgId === "string" ? orgBudgets[orgId] : undefined;
      if (!budget) {
        return [];
      }

      const budgetJson = JSON.stringify(budget);
      return [
        {
          budget,
          budget_json: budgetJson,
          defaultBudget: budget,
          default_budget: budgetJson,
          data: budgetJson,
          settings_json: JSON.stringify({ budget }),
        },
      ];
    }

    if (/select id from identities/.test(normalized) && /sponsor_id = \?/.test(normalized)) {
      const [orgId, sponsorId] = params;
      return listIdentities()
        .filter((identity) => identity.orgId === orgId && identity.sponsorId === sponsorId)
        .map((identity) => ({ id: identity.id }));
    }

    if (/from tokens/.test(normalized)) {
      const [identityId] = params;
      return activeTokens
        .filter((token) => token.identityId === identityId)
        .map((token) => ({
          id: token.id,
          jti: token.id,
          tokenId: token.id,
          token_id: token.id,
        }));
    }

    if (/select \* from identities/.test(normalized)) {
      const [orgId, ...rest] = params;
      let rows = listIdentities().filter((identity) => identity.orgId === orgId);

      const status = rest.find(
        (value): value is StoredIdentity["status"] =>
          value === "active" || value === "suspended" || value === "retired",
      );
      if (status) {
        rows = rows.filter((identity) => identity.status === status);
      }

      const type = rest.find(
        (value): value is StoredIdentity["type"] =>
          value === "agent" || value === "human" || value === "service",
      );
      if (type) {
        rows = rows.filter((identity) => identity.type === type);
      }

      return rows.map(createListRow);
    }

    return [];
  };

  const db = {
    prepare(query: string) {
      return {
        bind: (...params: unknown[]) => ({
          first: async <T>() => {
            d1Calls.push({ query: normalizeSql(query), params });
            return (resolveRows(query, params)[0] as T | null) ?? null;
          },
          run: async () => {
            d1Calls.push({ query: normalizeSql(query), params });
            return { success: true, meta };
          },
          raw: async <T>() => {
            d1Calls.push({ query: normalizeSql(query), params });
            return resolveRows(query, params) as T[];
          },
          all: async <T>() => {
            d1Calls.push({ query: normalizeSql(query), params });
            return { results: resolveRows(query, params) as T[], success: true, meta };
          },
        }),
        first: async <T>() => {
          d1Calls.push({ query: normalizeSql(query), params: [] });
          return (resolveRows(query, [])[0] as T | null) ?? null;
        },
        run: async () => {
          d1Calls.push({ query: normalizeSql(query), params: [] });
          return { success: true, meta };
        },
        raw: async <T>() => {
          d1Calls.push({ query: normalizeSql(query), params: [] });
          return resolveRows(query, []) as T[];
        },
        all: async <T>() => {
          d1Calls.push({ query: normalizeSql(query), params: [] });
          return { results: resolveRows(query, []) as T[], success: true, meta };
        },
      };
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
    exec: async (query: string) => {
      d1Calls.push({ query: normalizeSql(query), params: [] });
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as D1Database;

  const kv = {
    get: async (key: string) => kvStore.get(key) ?? null,
    put: async (key: string, value: string) => {
      kvPuts.push({ key, value });
      kvStore.set(key, value);
    },
    delete: async (key: string) => {
      kvStore.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async (key: string) => ({
      value: kvStore.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as KVNamespace;

  const namespace = {
    idFromName: (name: string) => name,
    get: (id: DurableObjectId) => ({
      fetch: async (request: Request) => {
        const identityId = String(id);
        const pathname = new URL(request.url).pathname;
        const body = await request.clone().json().catch(() => undefined);
        const current = identities.get(identityId) ?? null;

        doCalls.push({
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

        if (pathname === "/internal/create" && request.method === "POST") {
          if (current) {
            return jsonResponse({ error: "identity_already_exists" }, 409);
          }

          const input = body as StoredIdentity;
          try {
            assertCreateInput(input);
            const timestamp = new Date().toISOString();
            const created = applyBudgetPolicy(input, clone(input), timestamp);
            identities.set(identityId, created);
            return jsonResponse(created, 201);
          } catch (error) {
            const message = error instanceof Error ? error.message : "failed_to_create_identity";
            return jsonResponse({ error: message }, 400);
          }
        }

        if (pathname === "/internal/update" && request.method === "PATCH") {
          if (!current) {
            return jsonResponse({ error: "identity_not_found" }, 404);
          }

          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return jsonResponse({ error: "Invalid JSON body" }, 400);
          }

          const timestamp = new Date().toISOString();
          const merged = mergeIdentity(current, body as Partial<StoredIdentity>, timestamp);
          const updated = applyBudgetPolicy(current, merged, timestamp);
          identities.set(identityId, updated);
          return jsonResponse(updated, 200);
        }

        if (pathname === "/internal/suspend" && request.method === "POST") {
          if (!current) {
            return jsonResponse({ error: "identity_not_found" }, 404);
          }

          const reason = typeof (body as { reason?: unknown } | undefined)?.reason === "string"
            ? (body as { reason: string }).reason
            : "";
          if (!reason) {
            return jsonResponse({ error: "reason is required" }, 400);
          }

          if (current.status === "retired") {
            return jsonResponse({ error: "Retired identities cannot be suspended" }, 409);
          }

          if (current.status === "suspended") {
            return jsonResponse({ error: "Identity already suspended" }, 409);
          }

          const timestamp = new Date().toISOString();
          const suspended: StoredIdentity = {
            ...current,
            status: "suspended",
            suspendedAt: timestamp,
            suspendReason: reason,
            updatedAt: timestamp,
          };

          identities.set(identityId, suspended);
          return jsonResponse(suspended, 200);
        }

        if (pathname === "/internal/reactivate" && request.method === "POST") {
          if (!current) {
            return jsonResponse({ error: "identity_not_found" }, 404);
          }

          if (current.status === "retired") {
            return jsonResponse({ error: "Retired identities cannot be reactivated" }, 409);
          }

          if (current.status === "active") {
            return jsonResponse({ error: "Identity already active" }, 409);
          }

          const timestamp = new Date().toISOString();
          const reactivated: StoredIdentity = {
            ...current,
            status: "active",
            suspendedAt: undefined,
            suspendReason: undefined,
            updatedAt: timestamp,
          };

          identities.set(identityId, reactivated);
          return jsonResponse(reactivated, 200);
        }

        if (pathname === "/internal/retire" && request.method === "POST") {
          if (!current) {
            return jsonResponse({ error: "identity_not_found" }, 404);
          }

          if (current.status === "retired") {
            return jsonResponse({ error: "Identity already retired" }, 409);
          }

          const timestamp = new Date().toISOString();
          const retired: StoredIdentity = {
            ...current,
            status: "retired",
            suspendedAt: undefined,
            suspendReason: undefined,
            updatedAt: timestamp,
          };

          identities.set(identityId, retired);
          return jsonResponse(retired, 200);
        }

        if (pathname === "/internal/delete" && request.method === "DELETE") {
          if (!current) {
            return jsonResponse({ error: "identity_not_found" }, 404);
          }

          identities.delete(identityId);
          return new Response(null, { status: 204 });
        }

        return jsonResponse({ error: `unexpected_do_request:${request.method}:${pathname}` }, 500);
      },
    }),
  } as unknown as DurableObjectNamespace;

  const app = createTestApp({
    IDENTITY_DO: namespace,
    DB: db,
    REVOCATION_KV: kv,
  });

  async function request(
    method: string,
    path: string,
    body?: unknown,
    {
      claims,
      headers,
    }: {
      claims?: Partial<RelayAuthTokenClaims>;
      headers?: HeadersInit;
    } = {},
  ): Promise<Response> {
    const authHeaders = new Headers(headers);
    authHeaders.set("Authorization", `Bearer ${generateTestToken(claims)}`);
    const request = createTestRequest(method, path, body, authHeaders);
    return app.request(request, undefined, app.bindings);
  }

  return {
    app,
    d1Calls,
    doCalls,
    identities,
    kvPuts,
    request,
  };
}

async function createIdentity(
  harness: LifecycleHarness,
  body: {
    name: string;
    sponsorId?: string;
    budget?: IdentityBudget;
    metadata?: Record<string, string>;
  },
  claims: Partial<RelayAuthTokenClaims>,
): Promise<StoredIdentity> {
  const response = await harness.request("POST", "/v1/identities", body, { claims });
  return assertJsonResponse<StoredIdentity>(response, 201);
}

async function getIdentity(harness: LifecycleHarness, identityId: string, claims: Partial<RelayAuthTokenClaims>) {
  const response = await harness.request("GET", `/v1/identities/${identityId}`, undefined, { claims });
  return assertJsonResponse<StoredIdentity>(response, 200);
}

async function incrementActionUsage(
  harness: LifecycleHarness,
  identityId: string,
  claims: Partial<RelayAuthTokenClaims>,
): Promise<StoredIdentity> {
  const current = await getIdentity(harness, identityId, claims);
  const currentUsage = current.budgetUsage ?? {
    actionsThisHour: 0,
    costToday: 0,
    lastResetAt: new Date().toISOString(),
  };

  const response = await harness.request(
    "PATCH",
    `/v1/identities/${identityId}`,
    {
      budgetUsage: {
        actionsThisHour: currentUsage.actionsThisHour + 1,
        costToday: currentUsage.costToday,
        lastResetAt: currentUsage.lastResetAt,
      },
    },
    { claims },
  );

  return assertJsonResponse<StoredIdentity>(response, 200);
}

describe("Identity lifecycle e2e", () => {
  test("creates an identity with a sponsor and returns sponsor metadata", async () => {
    const harness = createLifecycleHarness();
    const claims = {
      sub: "agent_creator_root",
      org: "org_lifecycle",
      wks: "ws_lifecycle",
      sponsorId: "user_sponsor_root",
      sponsorChain: ["user_sponsor_root"],
    } satisfies Partial<RelayAuthTokenClaims>;

    const created = await createIdentity(
      harness,
      {
        name: "sponsored-agent",
        sponsorId: "user_sponsor_root",
      },
      claims,
    );

    assert.equal(created.name, "sponsored-agent");
    assert.equal(created.sponsorId, "user_sponsor_root");
    assert.deepEqual(created.sponsorChain, ["user_sponsor_root", "agent_creator_root"]);
    assert.equal(created.workspaceId, "ws_lifecycle");
  });

  test("creates a sub-agent and includes the parent in sponsorChain", async () => {
    const harness = createLifecycleHarness();
    const rootClaims = {
      sub: "agent_creator_root",
      org: "org_lifecycle",
      wks: "ws_lifecycle",
      sponsorId: "user_sponsor_root",
      sponsorChain: ["user_sponsor_root"],
    } satisfies Partial<RelayAuthTokenClaims>;

    const parent = await createIdentity(
      harness,
      {
        name: "parent-agent",
        sponsorId: "user_sponsor_root",
      },
      rootClaims,
    );

    const child = await createIdentity(
      harness,
      {
        name: "child-agent",
        sponsorId: parent.id,
      },
      {
        sub: parent.id,
        org: parent.orgId,
        wks: parent.workspaceId,
        sponsorId: parent.sponsorId,
        sponsorChain: parent.sponsorChain,
      },
    );

    assert.equal(child.sponsorId, parent.id);
    assert.equal(child.sponsorChain.includes(parent.id), true);
    assert.deepEqual(child.sponsorChain, [...parent.sponsorChain, parent.id]);
  });

  test("auto-suspends an identity after six actions when maxActionsPerHour is five", async () => {
    const harness = createLifecycleHarness();
    const claims = {
      sub: "agent_budget_root",
      org: "org_budget",
      wks: "ws_budget",
      sponsorId: "user_budget_owner",
      sponsorChain: ["user_budget_owner"],
    } satisfies Partial<RelayAuthTokenClaims>;

    const identity = await createIdentity(
      harness,
      {
        name: "budgeted-agent",
        sponsorId: "user_budget_owner",
        budget: {
          maxActionsPerHour: 5,
          autoSuspend: true,
        },
      },
      claims,
    );

    let updated = identity;
    for (let actionIndex = 0; actionIndex < 6; actionIndex += 1) {
      updated = await incrementActionUsage(harness, identity.id, {
        sub: identity.id,
        org: identity.orgId,
        wks: identity.workspaceId,
        sponsorId: identity.sponsorId,
        sponsorChain: identity.sponsorChain,
      });
    }

    assert.equal(updated.budgetUsage?.actionsThisHour, 6);
    assert.equal(updated.status, "suspended");
    assert.equal(updated.suspendReason, "budget_exceeded");

    const fetched = await getIdentity(harness, identity.id, {
      sub: identity.id,
      org: identity.orgId,
      wks: identity.workspaceId,
      sponsorId: identity.sponsorId,
      sponsorChain: identity.sponsorChain,
    });

    assert.equal(fetched.status, "suspended");
    assert.equal(fetched.suspendReason, "budget_exceeded");
  });

  test("suspending a parent also suspends its sub-agents", async () => {
    const harness = createLifecycleHarness();
    const rootClaims = {
      sub: "agent_supervisor_root",
      org: "org_suspend_tree",
      wks: "ws_suspend_tree",
      sponsorId: "user_suspend_owner",
      sponsorChain: ["user_suspend_owner"],
    } satisfies Partial<RelayAuthTokenClaims>;

    const parent = await createIdentity(
      harness,
      {
        name: "parent-to-suspend",
        sponsorId: "user_suspend_owner",
      },
      rootClaims,
    );
    const child = await createIdentity(
      harness,
      {
        name: "child-to-suspend",
        sponsorId: parent.id,
      },
      {
        sub: parent.id,
        org: parent.orgId,
        wks: parent.workspaceId,
        sponsorId: parent.sponsorId,
        sponsorChain: parent.sponsorChain,
      },
    );

    const suspendResponse = await harness.request(
      "POST",
      `/v1/identities/${parent.id}/suspend`,
      { reason: "manual_review" },
      { claims: rootClaims },
    );
    const suspendedParent = await assertJsonResponse<StoredIdentity>(suspendResponse, 200);

    assert.equal(suspendedParent.status, "suspended");
    assert.equal(suspendedParent.suspendReason, "manual_review");

    const suspendedChild = await getIdentity(harness, child.id, {
      sub: parent.id,
      org: child.orgId,
      wks: child.workspaceId,
      sponsorId: parent.id,
      sponsorChain: child.sponsorChain.slice(0, -1),
    });

    assert.equal(suspendedChild.status, "suspended");
    assert.equal(suspendedChild.suspendReason, "parent_suspended");
    assert.equal(
      harness.doCalls.some(
        (call) => call.identityId === child.id && call.method === "POST" && call.path === "/internal/suspend",
      ),
      true,
    );
  });

  test("rejects create identity requests without sponsorId", async () => {
    const harness = createLifecycleHarness();
    const response = await harness.request(
      "POST",
      "/v1/identities",
      { name: "missing-sponsor" },
      {
        claims: {
          sub: "agent_creator_root",
          org: "org_missing_sponsor",
          wks: "ws_missing_sponsor",
          sponsorId: "user_missing_sponsor",
          sponsorChain: ["user_missing_sponsor"],
        },
      },
    );

    const body = await assertJsonResponse<{ error: string }>(response, 400);
    assert.deepEqual(body, { error: "sponsorId is required" });
  });

  test("runs the full identity lifecycle flow end to end", async () => {
    const harness = createLifecycleHarness();
    const rootClaims = {
      sub: "agent_lifecycle_root",
      org: "org_full_lifecycle",
      wks: "ws_full_lifecycle",
      sponsorId: "user_full_lifecycle",
      sponsorChain: ["user_full_lifecycle"],
    } satisfies Partial<RelayAuthTokenClaims>;

    const createResponse = await harness.request(
      "POST",
      "/v1/identities",
      {
        name: "lifecycle-agent",
        sponsorId: "user_full_lifecycle",
        metadata: {
          team: "qa",
        },
      },
      { claims: rootClaims },
    );
    const created = await assertJsonResponse<StoredIdentity>(createResponse, 201);

    const getCreatedResponse = await harness.request(
      "GET",
      `/v1/identities/${created.id}`,
      undefined,
      { claims: rootClaims },
    );
    const fetchedCreated = await assertJsonResponse<StoredIdentity>(getCreatedResponse, 200);
    assert.equal(fetchedCreated.id, created.id);

    const listResponse = await harness.request("GET", "/v1/identities", undefined, { claims: rootClaims });
    const listed = await assertJsonResponse<ListIdentitiesResponse>(listResponse, 200);
    assert.equal(listed.data.some((identity) => identity.id === created.id), true);

    const patchResponse = await harness.request(
      "PATCH",
      `/v1/identities/${created.id}`,
      {
        name: "lifecycle-agent-renamed",
        metadata: {
          owner: "platform",
        },
      },
      { claims: rootClaims },
    );
    const patched = await assertJsonResponse<StoredIdentity>(patchResponse, 200);
    assert.equal(patched.name, "lifecycle-agent-renamed");

    const getPatchedResponse = await harness.request(
      "GET",
      `/v1/identities/${created.id}`,
      undefined,
      { claims: rootClaims },
    );
    const fetchedPatched = await assertJsonResponse<StoredIdentity>(getPatchedResponse, 200);
    assert.equal(fetchedPatched.name, "lifecycle-agent-renamed");
    assert.deepEqual(fetchedPatched.metadata, {
      team: "qa",
      owner: "platform",
    });

    const suspendResponse = await harness.request(
      "POST",
      `/v1/identities/${created.id}/suspend`,
      { reason: "manual_review" },
      { claims: rootClaims },
    );
    const suspended = await assertJsonResponse<StoredIdentity>(suspendResponse, 200);
    assert.equal(suspended.status, "suspended");

    const getSuspendedResponse = await harness.request(
      "GET",
      `/v1/identities/${created.id}`,
      undefined,
      { claims: rootClaims },
    );
    const fetchedSuspended = await assertJsonResponse<StoredIdentity>(getSuspendedResponse, 200);
    assert.equal(fetchedSuspended.status, "suspended");

    const reactivateResponse = await harness.request(
      "POST",
      `/v1/identities/${created.id}/reactivate`,
      undefined,
      { claims: rootClaims },
    );
    const reactivated = await assertJsonResponse<StoredIdentity>(reactivateResponse, 200);
    assert.equal(reactivated.status, "active");

    const getReactivatedResponse = await harness.request(
      "GET",
      `/v1/identities/${created.id}`,
      undefined,
      { claims: rootClaims },
    );
    const fetchedReactivated = await assertJsonResponse<StoredIdentity>(getReactivatedResponse, 200);
    assert.equal(fetchedReactivated.status, "active");

    const retireResponse = await harness.request(
      "POST",
      `/v1/identities/${created.id}/retire`,
      undefined,
      { claims: rootClaims },
    );
    const retired = await assertJsonResponse<StoredIdentity>(retireResponse, 200);
    assert.equal(retired.status, "retired");

    const getRetiredResponse = await harness.request(
      "GET",
      `/v1/identities/${created.id}`,
      undefined,
      { claims: rootClaims },
    );
    const fetchedRetired = await assertJsonResponse<StoredIdentity>(getRetiredResponse, 200);
    assert.equal(fetchedRetired.status, "retired");

    const reactivateRetiredResponse = await harness.request(
      "POST",
      `/v1/identities/${created.id}/reactivate`,
      undefined,
      { claims: rootClaims },
    );
    const reactivateRetiredBody = await assertJsonResponse<{ error: string }>(reactivateRetiredResponse, 409);
    assert.match(reactivateRetiredBody.error, /retired/i);

    const deleteResponse = await harness.request(
      "DELETE",
      `/v1/identities/${created.id}`,
      undefined,
      {
        claims: rootClaims,
        headers: {
          "x-confirm-delete": "true",
        },
      },
    );
    assert.equal(deleteResponse.status, 204);

    const getDeletedResponse = await harness.request(
      "GET",
      `/v1/identities/${created.id}`,
      undefined,
      { claims: rootClaims },
    );
    const getDeletedBody = await assertJsonResponse<{ error: string }>(getDeletedResponse, 404);
    assert.deepEqual(getDeletedBody, { error: "identity_not_found" });
  });
});
