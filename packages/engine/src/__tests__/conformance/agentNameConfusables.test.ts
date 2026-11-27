import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';
import { handleNodeControlMessage, registerAgentViaNode } from '../../engine/node.js';
import { AGENT_NAME_MAX_LENGTH, RELEASED_NAME_MARKER } from '../../engine/agent.js';
import { WEBHOOK_AGENT_NAME } from '../../engine/messageMetadata.js';

const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));

describe('agent name validation and confusable resistance', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(async () => {
    await stack.close();
  });

  async function postAgent(workspaceKey: string, name: string) {
    return stack.app.request('/v1/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${workspaceKey}`,
      },
      body: JSON.stringify({ name }),
    });
  }

  it('rejects all reported confusable variants beside an existing agent on POST /v1/agents', async () => {
    const ws = await createWorkspace(stack.app, 'confusable-poc');
    const original = await registerAgent(stack.app, ws.workspaceKey, 'alpha1');
    expect(original.name).toBe('alpha1');

    // Case variant -> 409 agent_already_exists
    const caseVariant = await postAgent(ws.workspaceKey, 'ALPHA1');
    expect(caseVariant.status).toBe(409);
    await expect(caseVariant.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent_already_exists' },
    });

    const mixedCase = await postAgent(ws.workspaceKey, 'Alpha1');
    expect(mixedCase.status).toBe(409);
    await expect(mixedCase.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'agent_already_exists' },
    });

    // Homoglyphs, invisible/bidi characters, trailing/leading/internal whitespace,
    // control characters, oversized names, and case-variant reserved names -> 400 invalid_agent_name
    const invalidNames = [
      'alph\u04301', // Cyrillic 'а' (U+0430)
      '\u03b1lpha1', // Greek 'α'
      'alpha1\u200b', // Zero-width space (U+200B)
      'alpha1\ufeff', // Zero-width no-break space
      'alpha\u202e1', // Right-to-left override
      'alpha1 ', // Trailing space
      ' alpha1', // Leading space
      'alpha 1', // Internal space
      'alpha1\t', // Trailing tab
      'alpha1\n', // Trailing newline
      'alpha1\u00a0', // Non-breaking space
      'alpha1\u0000', // NUL byte
      'a'.repeat(AGENT_NAME_MAX_LENGTH + 1),
      WEBHOOK_AGENT_NAME.toUpperCase(),
      `victim${RELEASED_NAME_MARKER.toUpperCase()}123`,
    ];

    for (const badName of invalidNames) {
      const res = await postAgent(ws.workspaceKey, badName);
      expect(res.status, `expected 400 for ${JSON.stringify(badName)}`).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_agent_name' },
      });
    }
  });

  it('preserves display casing, allows re-registration under new casing after delete, and isolates across workspaces', async () => {
    const ws1 = await createWorkspace(stack.app, 'casing-ws-1');
    const ws2 = await createWorkspace(stack.app, 'casing-ws-2');

    const alice = await registerAgent(stack.app, ws1.workspaceKey, 'Alice');
    expect(alice.name).toBe('Alice');

    // Same workspace rejects lower/upper case variants.
    const dup = await postAgent(ws1.workspaceKey, 'alice');
    expect(dup.status).toBe(409);

    // Different workspace can register independently with different casing.
    const otherWsAlice = await registerAgent(stack.app, ws2.workspaceKey, 'alice');
    expect(otherWsAlice.name).toBe('alice');

    // Exact-match lookup keeps working with display casing.
    const getExact = await stack.app.request('/v1/agents/Alice', {
      headers: { authorization: `Bearer ${ws1.workspaceKey}` },
    });
    expect(getExact.status).toBe(200);
    const getWrongCase = await stack.app.request('/v1/agents/alice', {
      headers: { authorization: `Bearer ${ws1.workspaceKey}` },
    });
    expect(getWrongCase.status).toBe(404);

    // Deleting Alice tombstones her row and frees canonical_name so `alice` can register.
    const del = await stack.app.request('/v1/agents/Alice', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ws1.workspaceKey}` },
    });
    expect(del.status).toBe(204);

    const reregistered = await registerAgent(stack.app, ws1.workspaceKey, 'alice');
    expect(reregistered.name).toBe('alice');
    expect(reregistered.agentId).not.toBe(alice.agentId);
  });

  it('enforces the same validation and case-insensitive uniqueness on node agent.register without leaking capacity', async () => {
    const ws = await createWorkspace(stack.app, 'node-confusables');
    const enrollRes = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'broker-1', max_agents: 2 }),
    });
    expect(enrollRes.status).toBe(201);
    const { data: node } = (await enrollRes.json()) as { data: { id: string; name: string } };

    const sock = new FakeSocket();
    await handleNodeControlMessage({
      db: stack.runtime.deps.db,
      workspaceId: ws.workspaceId,
      nodeId: node.id,
      socket: sock,
      message: {
        type: 'node.register',
        id: 'reg-node',
        name: node.name,
        capabilities: [],
        max_agents: 2,
      },
    });

    const first = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, node.id, 'default', {
      type: 'agent.register',
      id: 'reg-1',
      name: 'Alpha1',
    });
    expect(first.name).toBe('Alpha1');

    // Case variant conflicts with agent_already_exists.
    await expect(
      registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, node.id, 'default', {
        type: 'agent.register',
        id: 'reg-case',
        name: 'alpha1',
      }),
    ).rejects.toMatchObject({ code: 'agent_already_exists', status: 409 });

    // Homoglyph and trailing whitespace are rejected with invalid_agent_name.
    for (const bad of ['alph\u04301', 'Alpha1\u200b', 'Alpha1 ', 'Alpha1\t']) {
      await expect(
        registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, node.id, 'default', {
          type: 'agent.register',
          id: 'reg-bad',
          name: bad,
        }),
      ).rejects.toMatchObject({ code: 'invalid_agent_name', status: 400 });
    }

    // Node capacity was not leaked by the rejected attempts (still 1 slot free).
    const second = await registerAgentViaNode(stack.runtime.deps.db, ws.workspaceId, node.id, 'default', {
      type: 'agent.register',
      id: 'reg-2',
      name: 'Beta1',
    });
    expect(second.name).toBe('Beta1');
  });

  it('rejects confusable names in POST /v1/agents/spawn', async () => {
    const ws = await createWorkspace(stack.app, 'spawn-confusables');
    const enrollRes = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'spawn-node', max_agents: 4 }),
    });
    expect(enrollRes.status).toBe(201);

    for (const bad of ['alph\u04301', 'worker\u200b', 'worker ', 'worker\t']) {
      const res = await stack.app.request('/v1/agents/spawn', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ws.workspaceKey}`,
        },
        body: JSON.stringify({ name: bad, cli: 'claude', task: 'check' }),
      });
      expect(res.status, `expected 400 for spawn ${JSON.stringify(bad)}`).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_agent_name' },
      });
    }
  });

  it('migrates pre-0089 legacy case-duplicate agents safely without data loss and still blocks new variants', async () => {
    const handle = getSqliteDb(':memory:');
    try {
      const sqlFiles = readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql') && file < '0089_agent_canonical_name.sql')
        .sort();
      handle.sqlite.exec(`CREATE TABLE IF NOT EXISTS _engine_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
      for (const file of sqlFiles) {
        if (file === '0048_bounded_maintenance.sql' || file === '0049_redrive_review_hardening.sql') continue;
        handle.sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
        handle.sqlite.prepare('INSERT INTO _engine_migrations (name) VALUES (?)').run(file);
      }

      // Seed a legacy workspace that already had two case-colliding active agents
      // plus one released tombstone before migration 0089.
      handle.sqlite.exec(`
        INSERT INTO workspaces(id, name, api_key_hash) VALUES ('ws_legacy', 'legacy', 'hash_legacy');
        INSERT INTO agents(id, workspace_id, name, handle, token_hash, status, created_at) VALUES
          ('a_first', 'ws_legacy', 'alpha1', '@alpha1', 'tok_1', 'active', 100),
          ('a_second', 'ws_legacy', 'ALPHA1', '@ALPHA1', 'tok_2', 'active', 200),
          ('a_gone', 'ws_legacy', 'beta1#released-a_gone', '@beta1#released-a_gone', 'tok_3', 'released', 50);
      `);

      // Migration 0089 succeeds despite the pre-existing case duplicates.
      expect(runMigrations(handle).applied).toEqual(['0089_agent_canonical_name.sql']);

      const rows = handle.sqlite
        .prepare('SELECT id, name, canonical_name, status FROM agents ORDER BY id')
        .all() as Array<{ id: string; name: string; canonical_name: string | null; status: string }>;
      expect(rows).toEqual([
        { id: 'a_first', name: 'alpha1', canonical_name: 'alpha1', status: 'active' },
        { id: 'a_gone', name: 'beta1#released-a_gone', canonical_name: null, status: 'released' },
        { id: 'a_second', name: 'ALPHA1', canonical_name: null, status: 'active' },
      ]);

      // Even if the first legacy row is released, the surviving legacy row with
      // canonical_name = NULL still prevents registering a new case variant.
      handle.sqlite
        .prepare("UPDATE agents SET name = 'alpha1#released-a_first', canonical_name = NULL, status = 'released' WHERE id = 'a_first'")
        .run();

      const { registerAgent: engineRegisterAgent } = await import('../../engine/agent.js');
      await expect(
        engineRegisterAgent(handle.db, 'ws_legacy', { name: 'Alpha1' }),
      ).rejects.toMatchObject({ code: 'agent_already_exists', status: 409 });

      // Once both legacy rows are released, `Alpha1` can register cleanly.
      handle.sqlite
        .prepare("UPDATE agents SET name = 'ALPHA1#released-a_second', canonical_name = NULL, status = 'released' WHERE id = 'a_second'")
        .run();
      const fresh = await engineRegisterAgent(handle.db, 'ws_legacy', { name: 'Alpha1' });
      expect(fresh.name).toBe('Alpha1');
    } finally {
      handle.sqlite.close();
    }
  });
});
