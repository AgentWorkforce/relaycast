import assert from "node:assert/strict";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { StoredIdentity } from "../durable-objects/identity-do.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
  generateTestIdentity,
  generateTestToken,
} from "./test-helpers.js";

type SuspendReason = "manual" | "budget_exceeded" | "parent_suspended";

type SuspendRequest = {
  reason?: SuspendReason;
};

type ActiveToken = {
  id: string;
  identityId: string;
};

type D1Call = {
  query: string;
  params: unknown[];
};

type KvPutCall = {
  key: string;
  value: string;
};

type DurableObjectCall = {
  identityId: string;
  method: string;
  path: string;
  body: unknown;
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

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function assertIsoTimestamp(value: string | undefined, fieldName: string): void {
  assert.equal(typeof value, "string", `${fieldName} should be set`);
  assert.equal(Number.isNaN(Date.parse(value as string)), false, `${fieldName} should be an ISO timestamp`);
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);
  const sponsorId = overrides.sponsorId ?? "user_owner_1";

  return {
    ...base,
    sponsorId,
    sponsorChain: overrides.sponsorChain ?? [sponsorId, "agent_root_1", base.id],
    workspaceId: overrides.workspaceId ?? "ws_test",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
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
    sponsorId: identity.sponsorId,
    sponsor_id: identity.sponsorId,
    sponsorChain: JSON.stringify(identity.sponsorChain),
    sponsor_chain: JSON.stringify(identity.sponsorChain),
    workspaceId: identity.workspaceId,
    workspace_id: identity.workspaceId,
    ...(identity.suspendedAt !== undefined
      ? { suspendedAt: identity.suspendedAt, suspended_at: identity.suspendedAt }
      : {}),
    ...(identity.suspendReason !== undefined
      ? { suspendReason: identity.suspendReason, suspend_reason: identity.suspendReason }
      : {}),
  };
}

function createRecordingD1({
  childIdentities = [],
  activeTokens = [],
}: {
  childIdentities?: StoredIdentity[];
  activeTokens?: ActiveToken[];
} = {}): { db: D1Database; calls: D1Call[] } {
  const calls: D1Call[] = [];
  const meta = {
    changed_db: false,
    changes: 0,
    duration: 0,
    rows_read: 0,
    rows_written: 0,
  };

  const resolveRows = (query: string): unknown[] => {
    const normalized = normalizeSql(query);

    if (/\bfrom\s+identities\b/.test(normalized)) {
      return childIdentities.map((identity) => toIdentityRow(identity));
    }

    if (/token/.test(normalized)) {
      return activeTokens.map((token) => ({
        id: token.id,
        jti: token.id,
        tokenId: token.id,
        token_id: token.id,
        identityId: token.identityId,
        identity_id: token.identityId,
        status: "active",
      }));
    }

    return [];
  };

  const createPreparedStatement = (query: string) => ({
    bind: (...params: unknown[]) => ({
      first: async <T>() => {
        calls.push({ query: normalizeSql(query), params });
        return (resolveRows(query)[0] as T | null) ?? null;
      },
      run: async () => {
        calls.push({ query: normalizeSql(query), params });
        return { success: true, meta };
      },
      raw: async <T>() => {
        calls.push({ query: normalizeSql(query), params });
        return resolveRows(query) as T[];
      },
      all: async <T>() => {
        calls.push({ query: normalizeSql(query), params });
        return { results: resolveRows(query) as T[], success: true, meta };
      },
    }),
    first: async <T>() => {
      calls.push({ query: normalizeSql(query), params: [] });
      return (resolveRows(query)[0] as T | null) ?? null;
    },
    run: async () => {
      calls.push({ query: normalizeSql(query), params: [] });
      return { success: true, meta };
    },
    raw: async <T>() => {
      calls.push({ query: normalizeSql(query), params: [] });
      return resolveRows(query) as T[];
    },
    all: async <T>() => {
      calls.push({ query: normalizeSql(query), params: [] });
      return { results: resolveRows(query) as T[], success: true, meta };
    },
  });

  return {
    calls,
    db: {
      prepare: (query: string) => createPreparedStatement(query),
      batch: async <T>(statements: D1PreparedStatement[]) =>
        Promise.all(statements.map((statement) => statement.run())) as Awaited<T>,
      exec: async (query: string) => {
        calls.push({ query: normalizeSql(query), params: [] });
        return { count: 0, duration: 0 };
      },
      dump: async () => new ArrayBuffer(0),
    } as D1Database,
  };
}

function createRecordingKV(): { kv: KVNamespace; puts: KvPutCall[] } {
  const puts: KvPutCall[] = [];
  const store = new Map<string, string>();

  return {
    puts,
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        puts.push({ key, value });
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
      getWithMetadata: async (key: string) => ({
        value: store.get(key) ?? null,
        metadata: null,
        cacheStatus: null,
      }),
    } as KVNamespace,
  };
}

function createIdentityNamespace(seedIdentities: StoredIdentity[]): {
  namespace: DurableObjectNamespace;
  identities: Map<string, StoredIdentity>;
  calls: DurableObjectCall[];
} {
  const identities = new Map(seedIdentities.map((identity) => [identity.id, clone(identity)]));
  const calls: DurableObjectCall[] = [];

  const applySuspension = (current: StoredIdentity, reason: SuspendReason): StoredIdentity => {
    if (current.status === "suspended") {
      throw new Error("identity_already_suspended");
    }

    if (current.status === "retired") {
      throw new Error("retired_identity_cannot_be_suspended");
    }

    const timestamp = new Date().toISOString();
    const suspended: StoredIdentity = {
      ...current,
      status: "suspended",
      suspendedAt: timestamp,
      suspendReason: reason,
      updatedAt: timestamp,
    };

    identities.set(current.id, suspended);
    return suspended;
  };

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

          if (pathname === "/internal/suspend" && request.method === "POST") {
            if (!current) {
              return jsonResponse({ error: "identity_not_found" }, 404);
            }

            const reason = body && typeof body === "object" && typeof (body as SuspendRequest).reason === "string"
              ? (body as SuspendRequest).reason
              : undefined;
            if (!reason) {
              return jsonResponse({ error: "reason is required" }, 400);
            }

            try {
              return jsonResponse(applySuspension(current, reason), 200);
            } catch (error) {
              const message = error instanceof Error ? error.message : "unable_to_suspend_identity";
              return jsonResponse({ error: message }, 409);
            }
          }

          if (pathname === "/internal/update" && request.method === "PATCH") {
            if (!current) {
              return jsonResponse({ error: "identity_not_found" }, 404);
            }

            const update = body && typeof body === "object" && !Array.isArray(body)
              ? (body as Partial<StoredIdentity> & SuspendRequest)
              : null;
            if (!update) {
              return jsonResponse({ error: "Invalid JSON body" }, 400);
            }

            const requestedReason =
              typeof update.reason === "string"
                ? update.reason
                : typeof update.suspendReason === "string"
                  ? (update.suspendReason as SuspendReason)
                  : undefined;
            if (update.status === "suspended" || requestedReason) {
              try {
                return jsonResponse(applySuspension(current, requestedReason ?? "manual"), 200);
              } catch (error) {
                const message = error instanceof Error ? error.message : "unable_to_suspend_identity";
                return jsonResponse({ error: message }, 409);
              }
            }

            const updated: StoredIdentity = {
              ...current,
              ...update,
              updatedAt: new Date().toISOString(),
            };
            identities.set(current.id, updated);
            return jsonResponse(updated, 200);
          }

          return jsonResponse({ error: `unexpected_do_request:${request.method}:${pathname}` }, 500);
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
}

function findAuditCall(calls: D1Call[], reason: SuspendReason): boolean {
  return calls.some(({ query, params }) => {
    const serialized = `${query} ${JSON.stringify(params)}`;
    return /audit/.test(serialized) && serialized.includes(reason);
  });
}

function assertRevocationWrites(puts: KvPutCall[], activeTokens: ActiveToken[]): void {
  assert.ok(puts.length > 0, "expected suspend flow to call REVOCATION_KV.put()");

  for (const token of activeTokens) {
    assert.equal(
      puts.some(({ key, value }) => `${key} ${value}`.includes(token.id)),
      true,
      `expected revocation writes to include token ${token.id}`,
    );
  }
}

async function postSuspendIdentity(
  identityId: string,
  body: unknown,
  {
    claims,
    identities = [],
    childIdentities = [],
    activeTokens = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
    childIdentities?: StoredIdentity[];
    activeTokens?: ActiveToken[];
  } = {},
): Promise<{
  response: Response;
  identityState: Map<string, StoredIdentity>;
  doCalls: DurableObjectCall[];
  d1Calls: D1Call[];
  revocationPuts: KvPutCall[];
}> {
  const identityNamespace = createIdentityNamespace([...identities, ...childIdentities]);
  const recordingD1 = createRecordingD1({ childIdentities, activeTokens });
  const recordingKV = createRecordingKV();
  const app = createTestApp({
    IDENTITY_DO: identityNamespace.namespace,
    DB: recordingD1.db,
    REVOCATION_KV: recordingKV.kv,
  });
  const request = createTestRequest(
    "POST",
    `/v1/identities/${identityId}/suspend`,
    body,
    {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    },
  );

  return {
    response: await app.request(request, undefined, app.bindings),
    identityState: identityNamespace.identities,
    doCalls: identityNamespace.calls,
    d1Calls: recordingD1.calls,
    revocationPuts: recordingKV.puts,
  };
}

test("POST /v1/identities/:id/suspend with reason returns 200 and sets suspended fields", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_manual_200",
    orgId: "org_suspend_manual",
    status: "active",
    suspendedAt: undefined,
    suspendReason: undefined,
  });

  const { response, identityState } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.status, "suspended");
  assert.equal(body.suspendReason, "manual");
  assertIsoTimestamp(body.suspendedAt, "suspendedAt");
  assertIsoTimestamp(body.updatedAt, "updatedAt");

  const persisted = identityState.get(identity.id);
  assert.ok(persisted, "expected suspended identity to remain in durable object state");
  assert.equal(persisted?.status, "suspended");
  assert.equal(persisted?.suspendReason, "manual");
});

test("POST /v1/identities/:id/suspend returns 400 when reason is missing", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_missing_reason",
    orgId: "org_suspend_validation",
  });

  const { response } = await postSuspendIdentity(identity.id, {}, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.match(body.error, /reason/i);
});

test("POST /v1/identities/:id/suspend returns 404 for a non-existent identity", async () => {
  const { response } = await postSuspendIdentity("agent_suspend_missing_404", { reason: "manual" });

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/suspend returns 409 when the identity is already suspended", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_already_suspended",
    orgId: "org_suspend_conflict",
    status: "suspended",
    suspendedAt: "2026-03-10T09:00:00.000Z",
    suspendReason: "manual",
  });

  const { response } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /already|suspend/i);
});

test("POST /v1/identities/:id/suspend returns 409 when the identity is retired", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_retired",
    orgId: "org_suspend_retired",
    status: "retired",
  });

  const { response } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /retired|cannot/i);
});

test("POST /v1/identities/:id/suspend revokes all active tokens for the identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_suspend_revoke_tokens",
    orgId: "org_suspend_revoke",
  });
  const activeTokens: ActiveToken[] = [
    { id: "jti_access_1", identityId: identity.id },
    { id: "jti_access_2", identityId: identity.id },
    { id: "jti_refresh_3", identityId: identity.id },
  ];

  const { response, revocationPuts } = await postSuspendIdentity(identity.id, { reason: "manual" }, {
    claims: { org: identity.orgId },
    identities: [identity],
    activeTokens,
  });

  await assertJsonResponse<StoredIdentity>(response, 200);
  assertRevocationWrites(revocationPuts, activeTokens);
});

test("POST /v1/identities/:id/suspend cascades suspension to sub-agents spawned by the identity", async () => {
  const parent = createStoredIdentity({
    id: "agent_suspend_parent",
    orgId: "org_suspend_cascade",
    sponsorChain: ["user_owner_1", "agent_root_1", "agent_suspend_parent"],
  });
  const childA = createStoredIdentity({
    id: "agent_suspend_child_a",
    orgId: parent.orgId,
    sponsorId: parent.id,
    sponsorChain: ["user_owner_1", "agent_root_1", parent.id, "agent_suspend_child_a"],
  });
  const childB = createStoredIdentity({
    id: "agent_suspend_child_b",
    orgId: parent.orgId,
    sponsorId: parent.id,
    sponsorChain: ["user_owner_1", "agent_root_1", parent.id, "agent_suspend_child_b"],
  });

  const { response, identityState, doCalls } = await postSuspendIdentity(parent.id, { reason: "manual" }, {
    claims: { org: parent.orgId },
    identities: [parent],
    childIdentities: [childA, childB],
  });

  await assertJsonResponse<StoredIdentity>(response, 200);

  const parentAfter = identityState.get(parent.id);
  const childAAfter = identityState.get(childA.id);
  const childBAfter = identityState.get(childB.id);

  assert.equal(parentAfter?.status, "suspended");
  assert.equal(parentAfter?.suspendReason, "manual");
  assert.equal(childAAfter?.status, "suspended");
  assert.equal(childAAfter?.suspendReason, "parent_suspended");
  assert.equal(childBAfter?.status, "suspended");
  assert.equal(childBAfter?.suspendReason, "parent_suspended");
  assert.equal(
    doCalls.filter(({ path }) => path === "/internal/suspend" || path === "/internal/update").length >= 3,
    true,
    "expected suspend flow to touch the parent and each spawned child identity",
  );
});

test("POST /v1/identities/:id/suspend writes audit events with manual, budget_exceeded, and parent_suspended reasons", async () => {
  const parent = createStoredIdentity({
    id: "agent_audit_parent",
    orgId: "org_suspend_audit",
  });
  const child = createStoredIdentity({
    id: "agent_audit_child",
    orgId: parent.orgId,
    sponsorId: parent.id,
    sponsorChain: ["user_owner_1", "agent_root_1", parent.id, "agent_audit_child"],
  });
  const budgetExceededIdentity = createStoredIdentity({
    id: "agent_audit_budget",
    orgId: parent.orgId,
  });

  const manualFlow = await postSuspendIdentity(parent.id, { reason: "manual" }, {
    claims: { org: parent.orgId },
    identities: [parent],
    childIdentities: [child],
  });
  const budgetFlow = await postSuspendIdentity(budgetExceededIdentity.id, { reason: "budget_exceeded" }, {
    claims: { org: budgetExceededIdentity.orgId },
    identities: [budgetExceededIdentity],
  });

  await assertJsonResponse<StoredIdentity>(manualFlow.response, 200);
  await assertJsonResponse<StoredIdentity>(budgetFlow.response, 200);

  assert.equal(findAuditCall(manualFlow.d1Calls, "manual"), true, "expected manual suspend audit event");
  assert.equal(
    findAuditCall(manualFlow.d1Calls, "parent_suspended"),
    true,
    "expected cascaded child suspend audit event",
  );
  assert.equal(
    findAuditCall(budgetFlow.d1Calls, "budget_exceeded"),
    true,
    "expected budget-triggered suspend audit event",
  );
});
