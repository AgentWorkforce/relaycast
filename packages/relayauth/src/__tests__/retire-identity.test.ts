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

type RetireRequest = {
  reason?: string;
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

function createRecordingD1({
  activeTokens = [],
}: {
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

  const applyRetirement = (current: StoredIdentity): StoredIdentity => {
    if (current.status === "retired") {
      throw new Error("identity_already_retired");
    }

    const timestamp = new Date().toISOString();
    const retired: StoredIdentity = {
      ...current,
      status: "retired",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: timestamp,
    };

    identities.set(current.id, retired);
    return retired;
  };

  const applyReactivation = (current: StoredIdentity): StoredIdentity => {
    if (current.status === "active") {
      throw new Error("identity_already_active");
    }

    if (current.status === "retired") {
      throw new Error("retired_identity_cannot_be_reactivated");
    }

    const timestamp = new Date().toISOString();
    const reactivated: StoredIdentity = {
      ...current,
      status: "active",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: timestamp,
    };

    identities.set(current.id, reactivated);
    return reactivated;
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

          if (pathname === "/internal/retire" && request.method === "POST") {
            if (!current) {
              return jsonResponse({ error: "identity_not_found" }, 404);
            }

            try {
              return jsonResponse(applyRetirement(current), 200);
            } catch (error) {
              const message = error instanceof Error ? error.message : "unable_to_retire_identity";
              return jsonResponse({ error: message }, 409);
            }
          }

          if (pathname === "/internal/reactivate" && request.method === "POST") {
            if (!current) {
              return jsonResponse({ error: "identity_not_found" }, 404);
            }

            try {
              return jsonResponse(applyReactivation(current), 200);
            } catch (error) {
              const message = error instanceof Error ? error.message : "unable_to_reactivate_identity";
              return jsonResponse({ error: message }, 409);
            }
          }

          return jsonResponse({ error: `unexpected_do_request:${request.method}:${pathname}` }, 500);
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
}

function assertRevocationWrites(puts: KvPutCall[], activeTokens: ActiveToken[]): void {
  assert.ok(puts.length > 0, "expected retire flow to call REVOCATION_KV.put()");

  for (const token of activeTokens) {
    assert.equal(
      puts.some(({ key, value }) => `${key} ${value}`.includes(token.id)),
      true,
      `expected revocation writes to include token ${token.id}`,
    );
  }
}

function createRetireHarness({
  claims,
  identities = [],
  activeTokens = [],
}: {
  claims?: Partial<RelayAuthTokenClaims>;
  identities?: StoredIdentity[];
  activeTokens?: ActiveToken[];
} = {}): {
  app: ReturnType<typeof createTestApp>;
  identityState: Map<string, StoredIdentity>;
  doCalls: DurableObjectCall[];
  d1Calls: D1Call[];
  revocationPuts: KvPutCall[];
  authHeaders: HeadersInit;
} {
  const identityNamespace = createIdentityNamespace(identities);
  const recordingD1 = createRecordingD1({ activeTokens });
  const recordingKV = createRecordingKV();
  const app = createTestApp({
    IDENTITY_DO: identityNamespace.namespace,
    DB: recordingD1.db,
    REVOCATION_KV: recordingKV.kv,
  });

  return {
    app,
    identityState: identityNamespace.identities,
    doCalls: identityNamespace.calls,
    d1Calls: recordingD1.calls,
    revocationPuts: recordingKV.puts,
    authHeaders: {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    },
  };
}

async function requestLifecycleRoute(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  body: unknown,
  headers: HeadersInit,
): Promise<Response> {
  const request = createTestRequest(method, path, body, headers);
  return app.request(request, undefined, app.bindings);
}

async function postRetireIdentity(
  identityId: string,
  body: unknown,
  {
    claims,
    identities = [],
    activeTokens = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
    activeTokens?: ActiveToken[];
  } = {},
): Promise<{
  response: Response;
  identityState: Map<string, StoredIdentity>;
  doCalls: DurableObjectCall[];
  d1Calls: D1Call[];
  revocationPuts: KvPutCall[];
}> {
  const harness = createRetireHarness({ claims, identities, activeTokens });
  const response = await requestLifecycleRoute(
    harness.app,
    "POST",
    `/v1/identities/${identityId}/retire`,
    body,
    harness.authHeaders,
  );

  return {
    response,
    identityState: harness.identityState,
    doCalls: harness.doCalls,
    d1Calls: harness.d1Calls,
    revocationPuts: harness.revocationPuts,
  };
}

test("POST /v1/identities/:id/retire returns 200 with the updated identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_200",
    orgId: "org_retire_200",
    status: "active",
    updatedAt: "2026-03-24T09:00:00.000Z",
  });

  const { response, doCalls } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.name, identity.name);
  assert.equal(body.type, identity.type);
  assert.equal(body.orgId, identity.orgId);
  assert.equal(doCalls.some(({ method, path }) => method === "POST" && path === "/internal/retire"), true);
});

test('POST /v1/identities/:id/retire sets status to "retired" permanently', async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_status",
    orgId: "org_retire_status",
    status: "active",
    updatedAt: "2026-03-24T09:10:00.000Z",
  });

  const { response, identityState } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.status, "retired");
  assertIsoTimestamp(body.updatedAt, "updatedAt");
  assert.notEqual(body.updatedAt, identity.updatedAt);
  assert.equal(identityState.get(identity.id)?.status, "retired");
});

test("POST /v1/identities/:id/retire accepts an optional reason in the body", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_reason",
    orgId: "org_retire_reason",
    status: "active",
  });

  const body = { reason: "manual_cleanup" } satisfies RetireRequest;
  const result = await postRetireIdentity(identity.id, body, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const responseBody = await assertJsonResponse<StoredIdentity>(result.response, 200);

  assert.equal(responseBody.status, "retired");
  assert.equal(result.doCalls.some(({ method, path }) => method === "POST" && path === "/internal/retire"), true);
});

test("POST /v1/identities/:id/retire returns 404 for a non-existent identity", async () => {
  const { response } = await postRetireIdentity("agent_retire_missing", undefined);

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/retire returns 409 if the identity is already retired", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_already_retired",
    orgId: "org_retire_already_retired",
    status: "retired",
  });

  const { response } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /already|retired/i);
});

test("POST /v1/identities/:id/retire can retire an active identity directly", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_active",
    orgId: "org_retire_active",
    status: "active",
  });

  const { response, identityState } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.status, "retired");
  assert.equal(identityState.get(identity.id)?.status, "retired");
});

test("POST /v1/identities/:id/retire can retire a suspended identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_suspended",
    orgId: "org_retire_suspended",
    status: "suspended",
    suspendedAt: "2026-03-24T09:20:00.000Z",
    suspendReason: "manual_review",
  });

  const { response, identityState } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.status, "retired");
  assert.equal(body.suspendedAt, undefined);
  assert.equal(body.suspendReason, undefined);
  assert.equal(identityState.get(identity.id)?.status, "retired");
  assert.equal(identityState.get(identity.id)?.suspendedAt, undefined);
  assert.equal(identityState.get(identity.id)?.suspendReason, undefined);
});

test("POST /v1/identities/:id/retire revokes all active tokens for the identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_revoke_tokens",
    orgId: "org_retire_revoke",
    status: "active",
  });
  const activeTokens: ActiveToken[] = [
    { id: "jti_access_1", identityId: identity.id },
    { id: "jti_access_2", identityId: identity.id },
    { id: "jti_refresh_3", identityId: identity.id },
  ];

  const { response, d1Calls, revocationPuts } = await postRetireIdentity(identity.id, undefined, {
    claims: { org: identity.orgId },
    identities: [identity],
    activeTokens,
  });

  await assertJsonResponse<StoredIdentity>(response, 200);
  assert.equal(d1Calls.some(({ query }) => /from tokens/.test(query)), true);
  assertRevocationWrites(revocationPuts, activeTokens);
});

test("a retired identity cannot be reactivated after POST /v1/identities/:id/retire", async () => {
  const identity = createStoredIdentity({
    id: "agent_retire_then_reactivate",
    orgId: "org_retire_then_reactivate",
    status: "active",
  });
  const harness = createRetireHarness({
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const retireResponse = await requestLifecycleRoute(
    harness.app,
    "POST",
    `/v1/identities/${identity.id}/retire`,
    undefined,
    harness.authHeaders,
  );
  await assertJsonResponse<StoredIdentity>(retireResponse, 200);

  const reactivateResponse = await requestLifecycleRoute(
    harness.app,
    "POST",
    `/v1/identities/${identity.id}/reactivate`,
    undefined,
    harness.authHeaders,
  );
  const reactivateBody = await assertJsonResponse<{ error: string }>(reactivateResponse, 409);

  assert.match(reactivateBody.error, /retired|reactivate|cannot/i);
});
