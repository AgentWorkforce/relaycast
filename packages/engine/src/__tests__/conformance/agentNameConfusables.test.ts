import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspace,
  FakeSocket,
  makeNodeStack,
  type TestStack,
} from './harness.js';
import { handleNodeControlMessage, recoverAgentViaNode, registerAgentViaNode } from '../../engine/node.js';
import { agents } from '../../db/tables.js';
import { AGENT_NAME_MAX_LENGTH, RELEASED_NAME_MARKER } from '../../engine/agent.js';
import { WEBHOOK_AGENT_NAME } from '../../engine/messageMetadata.js';

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

  async function registerNodeOnSocket(workspaceId: string, node: { id: string; name: string }, maxAgents: number) {
    const sock = new FakeSocket();
    await handleNodeControlMessage({
      db: stack.runtime.deps.db,
      registry: stack.runtime.realtime,
      workspaceId,
      nodeId: node.id,
      socket: sock,
      raw: JSON.stringify({
        v: 1,
        id: `reg-${node.id}`,
        type: 'node.register',
        name: node.name,
        node_id: node.id,
        capabilities: [],
        max_agents: maxAgents,
        tags: [],
        version: 'v1',
        resume_cursor: null,
      }),
    });
    expect(sock.ofType('reply').find((frame) => frame.id === `reg-${node.id}`)).toMatchObject({
      ok: true,
    });
    return sock;
  }

  it('rejects all reported confusable variants beside an existing agent on POST /v1/agents', async () => {
    const ws = await createWorkspace(stack.app, 'confusable-poc');
    const created = await postAgent(ws.workspaceKey, 'alpha1');
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { ok: true; data: { id: string; name: string } };
    expect(createdBody.data.name).toBe('alpha1');

    // Case variants -> 409 agent_already_exists
    for (const variant of ['ALPHA1', 'Alpha1']) {
      const res = await postAgent(ws.workspaceKey, variant);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: { code: 'agent_already_exists' },
      });
    }

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

    const aliceRes = await postAgent(ws1.workspaceKey, 'Alice');
    expect(aliceRes.status).toBe(201);
    const alice = ((await aliceRes.json()) as { ok: true; data: { id: string; name: string } }).data;
    expect(alice.name).toBe('Alice');

    // Same workspace rejects lower/upper case variants.
    const dup = await postAgent(ws1.workspaceKey, 'alice');
    expect(dup.status).toBe(409);

    // Different workspace can register independently with different casing.
    const otherRes = await postAgent(ws2.workspaceKey, 'alice');
    expect(otherRes.status).toBe(201);
    const otherAlice = ((await otherRes.json()) as { ok: true; data: { id: string; name: string } }).data;
    expect(otherAlice.name).toBe('alice');

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

    const reregRes = await postAgent(ws1.workspaceKey, 'alice');
    expect(reregRes.status).toBe(201);
    const reregistered = ((await reregRes.json()) as { ok: true; data: { id: string; name: string } }).data;
    expect(reregistered.name).toBe('alice');
    expect(reregistered.id).not.toBe(alice.id);
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

    await registerNodeOnSocket(ws.workspaceId, node, 2);

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

  it('preserves node recovery for pre-existing legacy agent names with spaces or non-ASCII characters', async () => {
    const ws = await createWorkspace(stack.app, 'legacy-node-recover');
    const enrollRes = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ws.workspaceKey}`,
      },
      body: JSON.stringify({ name: 'legacy-broker', max_agents: 4 }),
    });
    expect(enrollRes.status).toBe(201);
    const { data: node } = (await enrollRes.json()) as { data: { id: string; name: string } };

    await registerNodeOnSocket(ws.workspaceId, node, 4);

    // Seed pre-0089 legacy hosted agents that would be rejected by new registration.
    for (const [id, legacyName, tokenHash] of [
      ['legacy_space', 'build worker', 'tok_legacy_space'],
      ['legacy_unicode', 'caf\u00e9', 'tok_legacy_unicode'],
    ] as const) {
      await stack.runtime.deps.db.insert(agents).values({
        id,
        workspaceId: ws.workspaceId,
        name: legacyName,
        canonicalName: legacyName.toLowerCase(),
        handle: `@${legacyName}`,
        type: 'agent',
        tokenHash,
        status: 'offline',
        locationType: 'via_node',
        locationNodeId: node.id,
        originNodeId: node.id,
        providerName: 'default',
      });

      const recovered = await recoverAgentViaNode(stack.runtime.deps.db, ws.workspaceId, node.id, 'default', {
        type: 'agent.recover',
        id: `recover-${id}`,
        name: legacyName,
        expected_agent_id: id,
      });
      expect(recovered.agent_id).toBe(id);
      expect(recovered.name).toBe(legacyName);
      expect(recovered.token).toBeTruthy();
    }

    // Reserved names are still rejected on recovery.
    await expect(
      recoverAgentViaNode(stack.runtime.deps.db, ws.workspaceId, node.id, 'default', {
        type: 'agent.recover',
        id: 'recover-reserved',
        name: WEBHOOK_AGENT_NAME.toUpperCase(),
        expected_agent_id: 'any_id',
      }),
    ).rejects.toMatchObject({ code: 'invalid_agent_name', status: 400 });
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
});
