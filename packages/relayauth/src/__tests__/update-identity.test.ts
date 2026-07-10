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
  mockDO,
} from "./test-helpers.js";

type UpdateIdentityBody = Partial<StoredIdentity>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function cloneIdentity(identity: StoredIdentity): StoredIdentity {
  return JSON.parse(JSON.stringify(identity)) as StoredIdentity;
}

function createStoredIdentity(overrides: Partial<StoredIdentity> = {}): StoredIdentity {
  const base = generateTestIdentity(overrides);

  return {
    ...base,
    sponsorId: overrides.sponsorId ?? "user_sponsor_1",
    sponsorChain: overrides.sponsorChain ?? ["user_sponsor_1", "agent_parent_1"],
    workspaceId: overrides.workspaceId ?? "ws_test",
    ...(overrides.budget !== undefined ? { budget: overrides.budget } : {}),
    ...(overrides.budgetUsage !== undefined ? { budgetUsage: overrides.budgetUsage } : {}),
  };
}

function createUpdateIdentityDoStub(initialIdentity: StoredIdentity | null): DurableObjectNamespace {
  let current = initialIdentity ? cloneIdentity(initialIdentity) : null;

  return mockDO(async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === "/internal/get" && request.method === "GET") {
      return current
        ? jsonResponse(current, 200)
        : jsonResponse({ error: "identity_not_found" }, 404);
    }

    if (pathname === "/internal/update" && (request.method === "PATCH" || request.method === "POST")) {
      if (!current) {
        return jsonResponse({ error: "identity_not_found" }, 404);
      }

      const update = await request.json<UpdateIdentityBody>().catch(() => null);
      if (!update || typeof update !== "object" || Array.isArray(update) || Object.keys(update).length === 0) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const timestamp = new Date().toISOString();
      current = {
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

      return jsonResponse(current, 200);
    }

    return jsonResponse(
      {
        error: `unexpected_do_request:${request.method}:${pathname}`,
      },
      500,
    );
  });
}

async function patchIdentity(
  identityId: string,
  body: unknown,
  {
    claims,
    identity,
  }: {
    claims?: Partial<RelayAuthTokenClaims>;
    identity?: StoredIdentity | null;
  } = {},
): Promise<Response> {
  const app = createTestApp({
    IDENTITY_DO: createUpdateIdentityDoStub(identity === undefined ? createStoredIdentity({ id: identityId }) : identity),
  });
  const request = createTestRequest(
    "PATCH",
    `/v1/identities/${identityId}`,
    body,
    {
      Authorization: `Bearer ${generateTestToken(claims)}`,
    },
  );

  return app.request(request, undefined, app.bindings);
}

test("PATCH /v1/identities/:id with name update returns 200 with updated identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_name_200",
    name: "Before Rename",
    orgId: "org_patch_name",
    metadata: { team: "platform" },
    scopes: ["scope:read"],
    roles: ["operator"],
    createdAt: "2026-03-01T10:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
  });

  const response = await patchIdentity(identity.id, { name: "After Rename" }, {
    claims: { org: identity.orgId },
    identity,
  });

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.orgId, identity.orgId);
  assert.equal(body.name, "After Rename");
  assert.equal(body.status, identity.status);
  assert.deepEqual(body.metadata, identity.metadata);
  assert.deepEqual(body.scopes, identity.scopes);
  assert.deepEqual(body.roles, identity.roles);
  assert.equal(body.createdAt, identity.createdAt);
  assert.notEqual(body.updatedAt, identity.updatedAt);
});

test("PATCH /v1/identities/:id updates metadata by merging instead of replacing", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_metadata",
    metadata: {
      team: "platform",
      region: "eu-west-1",
    },
  });

  const response = await patchIdentity(
    identity.id,
    {
      metadata: {
        region: "us-east-1",
        owner: "ops",
      },
    },
    {
      claims: { org: identity.orgId },
      identity,
    },
  );

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.deepEqual(body.metadata, {
    team: "platform",
    region: "us-east-1",
    owner: "ops",
  });
});

test("PATCH /v1/identities/:id updates scopes by replacing the entire array", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_scopes",
    scopes: ["scope:read", "scope:write", "scope:admin"],
  });

  const response = await patchIdentity(
    identity.id,
    {
      scopes: ["scope:limited"],
    },
    {
      claims: { org: identity.orgId },
      identity,
    },
  );

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.deepEqual(body.scopes, ["scope:limited"]);
  assert.deepEqual(body.roles, identity.roles);
});

test("PATCH /v1/identities/:id updates the name and sets updatedAt to the current time", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_updated_at",
    name: "Before Timestamp Update",
    updatedAt: "2026-03-01T10:00:00.000Z",
  });
  const startedAt = Date.now();

  const response = await patchIdentity(identity.id, { name: "After Timestamp Update" }, {
    claims: { org: identity.orgId },
    identity,
  });

  const finishedAt = Date.now();
  const body = await assertJsonResponse<StoredIdentity>(response, 200);
  const updatedAtMs = Date.parse(body.updatedAt);

  assert.equal(body.name, "After Timestamp Update");
  assert.equal(Number.isNaN(updatedAtMs), false);
  assert.ok(updatedAtMs >= startedAt, `expected updatedAt >= ${new Date(startedAt).toISOString()}`);
  assert.ok(updatedAtMs <= finishedAt, `expected updatedAt <= ${new Date(finishedAt).toISOString()}`);
});

test("PATCH /v1/identities/:id returns 404 for a non-existent identity", async () => {
  const response = await patchIdentity(
    "agent_missing_patch",
    { name: "Nope" },
    {
      identity: null,
    },
  );

  const body = await assertJsonResponse<{ error: string }>(response, 404);

  assert.deepEqual(body, { error: "identity_not_found" });
});

test("PATCH /v1/identities/:id returns 400 for an empty body", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_empty_body",
  });

  const response = await patchIdentity(identity.id, {}, {
    claims: { org: identity.orgId },
    identity,
  });

  const body = await assertJsonResponse<{ error: string }>(response, 400);

  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
});

test("PATCH /v1/identities/:id ignores immutable fields id, orgId, and createdAt", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_immutable",
    orgId: "org_locked",
    createdAt: "2026-03-01T00:00:00.000Z",
    name: "Before Immutable Attempt",
  });

  const response = await patchIdentity(
    identity.id,
    {
      id: "agent_patch_mutated",
      orgId: "org_mutated",
      createdAt: "2030-01-01T00:00:00.000Z",
      name: "After Immutable Attempt",
    },
    {
      claims: { org: identity.orgId },
      identity,
    },
  );

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.id, identity.id);
  assert.equal(body.orgId, identity.orgId);
  assert.equal(body.createdAt, identity.createdAt);
  assert.equal(body.name, "After Immutable Attempt");
});

test("PATCH /v1/identities/:id can update metadata on a suspended identity", async () => {
  const identity = createStoredIdentity({
    id: "agent_patch_suspended",
    status: "suspended",
    metadata: {
      queue: "manual-review",
    },
    suspendedAt: "2026-03-10T09:00:00.000Z",
    suspendReason: "manual_review",
  });

  const response = await patchIdentity(
    identity.id,
    {
      metadata: {
        ticket: "INC-1234",
      },
    },
    {
      claims: { org: identity.orgId },
      identity,
    },
  );

  const body = await assertJsonResponse<StoredIdentity>(response, 200);

  assert.equal(body.status, "suspended");
  assert.equal(body.suspendedAt, identity.suspendedAt);
  assert.equal(body.suspendReason, identity.suspendReason);
  assert.deepEqual(body.metadata, {
    queue: "manual-review",
    ticket: "INC-1234",
  });
});
