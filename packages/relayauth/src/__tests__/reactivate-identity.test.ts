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

type DurableObjectCall = {
  identityId: string;
  method: string;
  path: string;
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

function createIdentityNamespace(seedIdentities: StoredIdentity[]): {
  namespace: DurableObjectNamespace;
  identities: Map<string, StoredIdentity>;
  calls: DurableObjectCall[];
} {
  const identities = new Map(seedIdentities.map((identity) => [identity.id, clone(identity)]));
  const calls: DurableObjectCall[] = [];

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

          calls.push({
            identityId,
            method: request.method,
            path: pathname,
          });

          if (pathname === "/internal/get" && request.method === "GET") {
            return current
              ? jsonResponse(current, 200)
              : jsonResponse({ error: "identity_not_found" }, 404);
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

async function postReactivateIdentity(
  identityId: string,
  {
    claims,
    identities = [],
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identities?: StoredIdentity[];
  } = {},
): Promise<{
  response: Response;
  identityState: Map<string, StoredIdentity>;
  doCalls: DurableObjectCall[];
}> {
  const identityNamespace = createIdentityNamespace(identities);
  const app = createTestApp({
    IDENTITY_DO: identityNamespace.namespace,
  });
  const request = createTestRequest(
    "POST",
    `/v1/identities/${identityId}/reactivate`,
    undefined,
    {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    },
  );

  return {
    response: await app.request(request, undefined, app.bindings),
    identityState: identityNamespace.identities,
    doCalls: identityNamespace.calls,
  };
}

test("POST /v1/identities/:id/reactivate returns 200 with the updated identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_200",
    orgId: "org_reactivate_200",
    status: "suspended",
    suspendedAt: "2026-03-24T09:00:00.000Z",
    suspendReason: "manual_review",
    updatedAt: "2026-03-24T09:00:00.000Z",
  });

  const { response, doCalls } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.name, identity.name);
  assert.equal(body.type, identity.type);
  assert.equal(body.orgId, identity.orgId);
  assert.equal(doCalls.some(({ method, path }) => method === "POST" && path === "/internal/reactivate"), true);
});

test('POST /v1/identities/:id/reactivate sets status back to "active"', async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_status",
    orgId: "org_reactivate_status",
    status: "suspended",
    suspendedAt: "2026-03-24T09:10:00.000Z",
    suspendReason: "budget_exceeded",
  });

  const { response, identityState } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.status, "active");
  assert.equal(identityState.get(identity.id)?.status, "active");
});

test("POST /v1/identities/:id/reactivate clears suspendReason and suspendedAt", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_clears_suspend_fields",
    orgId: "org_reactivate_clears_suspend_fields",
    status: "suspended",
    suspendedAt: "2026-03-24T09:20:00.000Z",
    suspendReason: "manual_review",
  });

  const { response, identityState } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.suspendedAt, undefined);
  assert.equal(body.suspendReason, undefined);
  assert.equal(identityState.get(identity.id)?.suspendedAt, undefined);
  assert.equal(identityState.get(identity.id)?.suspendReason, undefined);
});

test("POST /v1/identities/:id/reactivate returns 404 for a non-existent identity", async () => {
  const { response } = await postReactivateIdentity("agent_reactivate_missing");

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("POST /v1/identities/:id/reactivate returns 409 if the identity is already active", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_already_active",
    orgId: "org_reactivate_already_active",
    status: "active",
  });

  const { response } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /already|active/i);
});

test("POST /v1/identities/:id/reactivate returns 409 if the identity is retired", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_retired",
    orgId: "org_reactivate_retired",
    status: "retired",
  });

  const { response } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<{ error: string }>(response, 409);

  assert.match(body.error, /retired|cannot/i);
});

test("POST /v1/identities/:id/reactivate updates the updatedAt timestamp", async () => {
  const identity = createStoredIdentity({
    id: "agent_reactivate_updates_timestamp",
    orgId: "org_reactivate_updates_timestamp",
    status: "suspended",
    suspendedAt: "2026-03-24T09:30:00.000Z",
    suspendReason: "manual_review",
    updatedAt: "2026-03-24T09:30:00.000Z",
  });

  const { response, identityState } = await postReactivateIdentity(identity.id, {
    claims: { org: identity.orgId },
    identities: [identity],
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assertIsoTimestamp(body.updatedAt, "updatedAt");
  assert.notEqual(body.updatedAt, identity.updatedAt);
  assert.equal(Date.parse(body.updatedAt) >= Date.parse(identity.updatedAt), true);
  assert.equal(identityState.get(identity.id)?.updatedAt, body.updatedAt);
});
