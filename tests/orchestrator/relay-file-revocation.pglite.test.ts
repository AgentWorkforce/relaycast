// Persistent relayfile access revocation (relay_file_access_revocations,
// migration 0089). Before this store existed, RelayFileAccessManager kept
// revocations in an in-memory Set — a process/Lambda restart silently
// un-revoked tokens and replicas never saw each other's revocations. These
// tests run the real migration SQL against PGlite (no query mocking) and
// prove the three properties that closed the gap:
//
//  1. A revocation survives a "restart" (a brand-new manager instance backed
//     by the same store still sees the token as revoked).
//  2. A revocation issued by replica A is visible to replica B within the
//     read-through cache TTL.
//  3. Rows self-expire: a revocation past the token's natural JWT expiry is
//     ignored on read and removed by prune().
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import {
  type ProvisionedRelayFileAccess,
  RelayFileAccessManager,
  hashRelayFileToken,
} from "../../packages/core/src/relay-file-access.js";
import { DrizzleRelayFileRevocationStore } from "../../packages/core/src/db/relay-file-revocations.js";
import * as schema from "../../packages/core/src/db/schema.js";

const MIGRATION_PATH = path.join(
  process.cwd(),
  "packages/web/drizzle/0089_relay_file_access_revocations.sql",
);

type StoreDb = ConstructorParameters<typeof DrizzleRelayFileRevocationStore>[0];
type ProvisionMapHolder = {
  provisions: Map<string, ProvisionedRelayFileAccess & { createdAt: string }>;
};

async function createStoreBackend() {
  const client = new PGlite();
  const migrationSql = (await readFile(MIGRATION_PATH, "utf8"))
    .replace(/^-->\s*statement-breakpoint\s*$/gmu, "")
    .trim();
  await client.exec(migrationSql);
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    makeStore: () => new DrizzleRelayFileRevocationStore(db as unknown as StoreDb),
    cleanup: () => client.close(),
  };
}

function makeManager(
  store: DrizzleRelayFileRevocationStore,
  options: { cacheTtlMs?: number; tokenTtlSeconds?: number } = {},
): RelayFileAccessManager {
  return new RelayFileAccessManager({
    relayfileUrl: "https://relayfile.example",
    relayAuthUrl: "https://relayauth.example",
    relayAuthApiKey: "test-api-key",
    revocationStore: store,
    revocationCacheTtlMs: options.cacheTtlMs ?? 0,
    tokenTtlSeconds: options.tokenTtlSeconds ?? 7_200,
  });
}

function provisionAccess(
  manager: RelayFileAccessManager,
  token: string,
  options: { workspace?: string; agentName?: string; createdAt?: Date } = {},
): ProvisionedRelayFileAccess {
  const workspace = options.workspace ?? "rw_testrev";
  const agentName = options.agentName ?? "worker-agent";
  const access: ProvisionedRelayFileAccess = {
    relayfileUrl: "https://relayfile.example",
    token,
    workspace,
    wsUrl: `wss://relayfile.example/v1/workspaces/${workspace}/fs/ws?token=${token}`,
    agentName,
    scopes: ["fs:read"],
    dotfileRules: [],
  };
  (manager as unknown as ProvisionMapHolder).provisions.set(token, {
    ...access,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
  });
  return access;
}

describe("relay file access revocation persistence", () => {
  let backend: Awaited<ReturnType<typeof createStoreBackend>>;

  beforeEach(async () => {
    backend = await createStoreBackend();
  });

  afterEach(async () => {
    await backend.cleanup();
  });

  it("revocation survives a simulated restart (new instance, same store)", async () => {
    const managerBeforeRestart = makeManager(backend.makeStore());
    const access = provisionAccess(managerBeforeRestart, "access-token-1");

    assert.equal(await managerBeforeRestart.isRevoked(access.token), false);
    assert.equal(await managerBeforeRestart.revokeAgent(access.token), true);
    assert.equal(await managerBeforeRestart.isRevoked(access.token), true);

    // "Restart": a brand-new manager with empty in-memory state, same store.
    const managerAfterRestart = makeManager(backend.makeStore());
    assert.equal(await managerAfterRestart.isRevoked(access.token), true);
    // An unrelated token is still fine.
    assert.equal(await managerAfterRestart.isRevoked("some-other-token"), false);
  });

  it("revocation on replica A is honored by replica B", async () => {
    const replicaA = makeManager(backend.makeStore());
    const replicaB = makeManager(backend.makeStore());
    const access = provisionAccess(replicaA, "access-token-1");

    assert.equal(await replicaB.isRevoked(access.token), false);
    await replicaA.revokeAgent(access.token);
    // cacheTtlMs is 0 in these managers, so B re-consults the store.
    assert.equal(await replicaB.isRevoked(access.token), true);
  });

  it("replica B serves a stale cached answer only within the cache TTL", async () => {
    const originalDateNow = Date.now;
    let fakeNow = originalDateNow();
    Date.now = () => fakeNow;
    const replicaA = makeManager(backend.makeStore());
    const replicaB = makeManager(backend.makeStore(), { cacheTtlMs: 50 });
    try {
      const access = provisionAccess(replicaA, "access-token-1");

      // Prime B's read-through cache with "not revoked".
      assert.equal(await replicaB.isRevoked(access.token), false);
      await replicaA.revokeAgent(access.token);
      // Within the TTL the stale cached value may be served (documented bound).
      fakeNow += 49;
      assert.equal(await replicaB.isRevoked(access.token), false);
      // Past the TTL the store is re-consulted and the revocation is honored.
      fakeNow += 2;
      assert.equal(await replicaB.isRevoked(access.token), true);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("stores a token hash, never the raw bearer token", async () => {
    const manager = makeManager(backend.makeStore());
    const access = provisionAccess(manager, "access-token-1");
    await manager.revokeAgent(access.token);

    const rows = await backend.client.query<{ token_hash: string; workspace: string; agent_name: string }>(
      "SELECT token_hash, workspace, agent_name FROM relay_file_access_revocations",
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]!.token_hash, hashRelayFileToken(access.token));
    assert.notEqual(rows.rows[0]!.token_hash, access.token);
    assert.equal(rows.rows[0]!.workspace, access.workspace);
    assert.equal(rows.rows[0]!.agent_name, "worker-agent");
  });

  it("expired revocations are ignored on read and removed by prune", async () => {
    const store = backend.makeStore();
    const tokenHash = hashRelayFileToken("expired-token");
    await store.revoke({
      tokenHash,
      scope: "relayfile-access",
      workspace: null,
      agentName: null,
      revokedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    // TTL filter on read: the row exists but the token's JWT already expired,
    // so the revocation is moot.
    assert.equal(await store.isRevoked(tokenHash), false);

    const stillValidHash = hashRelayFileToken("still-valid-token");
    await store.revoke({
      tokenHash: stillValidHash,
      scope: "relayfile-access",
      workspace: null,
      agentName: null,
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const pruned = await store.prune();
    assert.equal(pruned, 1);
    assert.equal(await store.isRevoked(stillValidHash), true);

    const rows = await backend.client.query("SELECT token_hash FROM relay_file_access_revocations");
    assert.equal(rows.rows.length, 1);
  });

  it("revoking the same token twice is idempotent", async () => {
    const manager = makeManager(backend.makeStore());
    const access = provisionAccess(manager, "access-token-1");

    assert.equal(await manager.revokeAgent(access.token), true);
    // Second revoke: provision already gone, store upsert is a no-op.
    assert.equal(await manager.revokeAgent(access.token), false);
    assert.equal(await manager.isRevoked(access.token), true);

    const rows = await backend.client.query("SELECT token_hash FROM relay_file_access_revocations");
    assert.equal(rows.rows.length, 1);
  });

  it("revocation persists with no provision record (token minted elsewhere)", async () => {
    // WorkspaceRegistry mints tokens independently of this manager —
    // revocation must still persist for tokens the manager never provisioned.
    const manager = makeManager(backend.makeStore());
    await manager.revokeAgent("foreign-token");

    const fresh = makeManager(backend.makeStore());
    assert.equal(await fresh.isRevoked("foreign-token"), true);
  });
});
