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

  const resolveRows = (query: string, params: unknown[]): unknown[] => {
    const normalized = normalizeSql(query);

    if (/from tokens/.test(normalized)) {
      const [identityId] = params;
      return activeTokens
        .filter((token) => token.identityId === identityId)
        .map((token) => ({
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
        return (resolveRows(query, params)[0] as T | null) ?? null;
      },
      run: async () => {
        calls.push({ query: normalizeSql(query), params });
        return { success: true, meta };
      },
      raw: async <T>() => {
        calls.push({ query: normalizeSql(query), params });
        return resolveRows(query, params) as T[];
      },
      all: async <T>() => {
        calls.push({ query: normalizeSql(query), params });
        return { results: resolveRows(query, params) as T[], success: true, meta };
      },
    }),
    first: async <T>() => {
      calls.push({ query: normalizeSql(query), params: [] });
      return (resolveRows(query, [])[0] as T | null) ?? null;
    },
    run: async () => {
      calls.push({ query: normalizeSql(query), params: [] });
      return { success: true, meta };
    },
    raw: async <T>() => {
      calls.push({ query: normalizeSql(query), params: [] });
      return resolveRows(query, []) as T[];
    },
    all: async <T>() => {
      calls.push({ query: normalizeSql(query), params: [] });
      return { results: resolveRows(query, []) as T[], success: true, meta };
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
    } as unknown as DurableObjectNamespace,
  };
}

function assertRevocationWrites(puts: KvPutCall[], activeTokens: ActiveToken[]): void {
  assert.equal(puts.length, activeTokens.length, "expected one revocation write per active token");

  for (const token of activeTokens) {
    assert.equal(
      puts.some(({ key, value }) => key === `revoked:${token.id}` && value.includes(token.id)),
      true,
      `expected revocation writes to include token ${token.id}`,
    );
  }
}

function createDeleteHarness({
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
      "X-Confirm-Delete": "true",
    },
  };
}

async function requestIdentityRoute(
  app: ReturnType<typeof createTestApp>,
  method: string,
  path: string,
  headers: HeadersInit,
): Promise<Response> {
  const request = createTestRequest(method, path, undefined, headers);
  return app.request(request, undefined, app.bindings);
}

async function deleteIdentity(
  identityId: string,
  {
    claims,
    identities = [],
    activeTokens = [],
    headers,
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
    activeTokens?: ActiveToken[];
    headers?: HeadersInit;
  } = {},
): Promise<{
  response: Response;
  identityState: Map<string, StoredIdentity>;
  doCalls: DurableObjectCall[];
  d1Calls: D1Call[];
  revocationPuts: KvPutCall[];
  app: ReturnType<typeof createTestApp>;
  authHeaders: HeadersInit;
}> {
  const harness = createDeleteHarness({ claims, identities, activeTokens });
  const response = await requestIdentityRoute(
    harness.app,
    "DELETE",
    `/v1/identities/${identityId}?confirm=true`,
    headers ?? harness.authHeaders,
  );

  return {
    response,
    identityState: harness.identityState,
    doCalls: harness.doCalls,
    d1Calls: harness.d1Calls,
    revocationPuts: harness.revocationPuts,
    app: harness.app,
    authHeaders: harness.authHeaders,
  };
}

test("DELETE /v1/identities/:id with confirm=true returns 204", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_204",
    orgId: "org_delete_204",
    status: "active",
  });

  const { response } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("DELETE /v1/identities/:id requires X-Confirm-Delete: true header", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_requires_header",
    orgId: "org_delete_requires_header",
  });

  const { response } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
    headers: {
      Authorization: `Bearer ${generateTestToken({ org: identity.orgId })}`,
    },
  });

  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.match(body.error, /confirm|x-confirm-delete/i);
});

test("DELETE /v1/identities/:id returns 404 for a non-existent identity", async () => {
  const { response } = await deleteIdentity("agent_delete_missing");

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("DELETE /v1/identities/:id hard deletes the identity from storage", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_hard_delete",
    orgId: "org_delete_hard_delete",
    status: "suspended",
    suspendedAt: "2026-03-20T10:00:00.000Z",
    suspendReason: "manual_review",
  });

  const { response, identityState, doCalls } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  assert.equal(response.status, 204);
  assert.equal(identityState.has(identity.id), false);
  assert.equal(
    doCalls.some(({ method, path, identityId }) =>
      method === "DELETE" && path === "/internal/delete" && identityId === identity.id),
    true,
    "expected delete flow to call the durable object delete endpoint",
  );
});

test("GET /v1/identities/:id returns 404 after DELETE /v1/identities/:id", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_then_get",
    orgId: "org_delete_then_get",
    status: "active",
  });
  const harness = createDeleteHarness({
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const deleteResponse = await requestIdentityRoute(
    harness.app,
    "DELETE",
    `/v1/identities/${identity.id}?confirm=true`,
    harness.authHeaders,
  );
  assert.equal(deleteResponse.status, 204);

  const getResponse = await requestIdentityRoute(
    harness.app,
    "GET",
    `/v1/identities/${identity.id}`,
    {
      Authorization: `Bearer ${generateTestToken({ org: identity.orgId })}`,
    },
  );
  const body = await assertJsonResponse<{ error: string }>(getResponse, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("DELETE /v1/identities/:id revokes all active tokens for the identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_delete_revoke_tokens",
    orgId: "org_delete_revoke",
    status: "retired",
  });
  const activeTokens: ActiveToken[] = [
    { id: "jti_delete_access_1", identityId: identity.id },
    { id: "jti_delete_access_2", identityId: identity.id },
    { id: "jti_delete_refresh_3", identityId: identity.id },
  ];

  const { response, d1Calls, revocationPuts } = await deleteIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
    activeTokens,
  });

  assert.equal(response.status, 204);
  assert.equal(d1Calls.some(({ query }) => /from tokens/.test(query)), true);
  assertRevocationWrites(revocationPuts, activeTokens);
});

test("DELETE /v1/identities/:id can delete identities in active, suspended, and retired states", async () => {
  const statuses = ["active", "suspended", "retired"] as const;

  for (const status of statuses) {
    const identity = createStoredIdentity({
      id: `agent_delete_status_${status}`,
      orgId: "org_delete_all_statuses",
      status,
      ...(status === "suspended"
        ? {
            suspendedAt: "2026-03-22T08:30:00.000Z",
            suspendReason: "manual_review",
          }
        : {}),
    });

    const { response, identityState } = await deleteIdentity(identity.id, {
      claims: { org: identity.orgId },
      identities: [identity],
    });

    assert.equal(response.status, 204, `expected ${status} identity delete to return 204`);
    assert.equal(identityState.has(identity.id), false, `expected ${status} identity to be removed from storage`);
  }
});
