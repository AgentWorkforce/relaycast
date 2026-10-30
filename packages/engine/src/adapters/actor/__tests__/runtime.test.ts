import { describe, expect, it } from 'vitest';
import { callWorkspaceActor } from '../../../gateway.js';
import { FakeWorkspaceActor, jsonRequest } from './fakeActor.js';

const WORKSPACE_ID = '241764880589606912';

interface Envelope<T> { ok: boolean; data: T; error?: { code: string; message: string } }

async function call<T>(actor: FakeWorkspaceActor, method: string, path: string, body?: unknown, token?: string) {
  const response = await callWorkspaceActor(
    (request, replay) => actor.handle(request, replay),
    jsonRequest(method, path, body, token),
  );
  return { status: response.status, json: (response.body ? JSON.parse(response.body) : null) as Envelope<T> };
}

async function workspaceWithAgents(actor: FakeWorkspaceActor) {
  const created = await call<{ workspace_id: string; api_key: string }>(actor, 'POST', '/v1/workspaces', { name: 'armadillo' });
  expect(created.status).toBe(201);
  const key = created.json.data.api_key;
  const alice = await call<{ token: string }>(actor, 'POST', '/v1/agents', { name: 'alice' }, key);
  const bob = await call<{ token: string }>(actor, 'POST', '/v1/agents', { name: 'bob' }, key);
  return { created, key, alice: alice.json.data.token, bob: bob.json.data.token };
}

function rows(actor: FakeWorkspaceActor, sql: string, ...bindings: string[]) {
  return actor.sql.raw.prepare(sql).all(...bindings) as Record<string, unknown>[];
}

describe('workspace actor runtime', () => {
  it('serves the engine for its own workspace with self-routing credentials', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { created, key, alice, bob } = await workspaceWithAgents(actor);

    expect(created.json.data.workspace_id).toBe(WORKSPACE_ID);
    expect(key).toMatch(new RegExp(`^relaycast_ws_${WORKSPACE_ID}_[0-9a-f]{64}$`));
    expect(alice).toMatch(new RegExp(`^relaycast_ag_${WORKSPACE_ID}_[0-9a-f]{64}$`));

    expect((await call(actor, 'POST', '/v1/channels', { name: 'general-2' }, alice)).status).toBe(201);
    expect((await call(actor, 'POST', '/v1/channels/general-2/join', {}, bob)).status).toBe(200);
    expect((await call(actor, 'POST', '/v1/channels/general-2/messages', { text: 'hello from a durable actor' }, alice)).status).toBe(201);

    const read = await call<{ text: string; agent_name: string }[]>(actor, 'GET', '/v1/channels/general-2/messages?limit=5', undefined, bob);
    expect(read.status).toBe(200);
    expect(read.json.data.map((message) => [message.agent_name, message.text])).toEqual([['alice', 'hello from a durable actor']]);

    expect((await call(actor, 'POST', '/v1/dm', { to: 'bob', text: 'direct hello' }, alice)).status).toBe(201);
    const inbox = await call<{ unread_dms: { from: string; unread_count: number }[] }>(actor, 'GET', '/v1/inbox', undefined, bob);
    expect(inbox.status).toBe(200);
    expect(inbox.json.data.unread_dms).toEqual([expect.objectContaining({ from: 'alice', unread_count: 1 })]);

    const search = await call<{ text: string }[]>(actor, 'GET', '/v1/search?q=durable', undefined, bob);
    expect(search.status).toBe(200);
    expect(search.json.data.map((hit) => hit.text)).toContain('hello from a durable actor');

    // Every call committed in one pass.
    expect(actor.calls.every((entry) => entry.replay === 0)).toBe(true);
  });

  it('rejects credentials from the other family', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    await workspaceWithAgents(actor);
    const legacy = await call(actor, 'GET', '/v1/agents', undefined, `rk_live_${'0'.repeat(32)}`);
    expect(legacy.status).toBe(401);
    expect(legacy.json.error?.message).toBe('Invalid token format');
  });

  it('refuses a second workspace in the same actor', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    await workspaceWithAgents(actor);
    const again = await call(actor, 'POST', '/v1/workspaces', { name: 'second' });
    expect(again.status).toBe(409);
    expect(again.json.error?.code).toBe('workspace_exists');
  });

  it('rolls back a write group that failed after writing and still answers with the engine response', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key } = await workspaceWithAgents(actor);
    const verifier = 'a'.repeat(64);
    const owner = await call(actor, 'POST', '/v1/agents', { name: 'owner', recovery_proof_hash: verifier }, key);
    expect(owner.status).toBe(201);

    // The registration group inserts the direct node and the agent, then the
    // recovery-credential insert hits the verifier's unique index.
    actor.calls.length = 0;
    const thief = await call(actor, 'POST', '/v1/agents', { name: 'thief', recovery_proof_hash: verifier }, key);
    expect(thief.status).toBe(409);
    expect(thief.json.error?.code).toBe('agent_recovery_proof_conflict');
    expect(actor.calls.map((entry) => entry.replay)).toEqual([0, 1]);

    // Nothing from the failed group survived: no agent, no implicit direct node.
    expect(rows(actor, 'SELECT id FROM agents WHERE name = ?', 'thief')).toEqual([]);
    expect(rows(actor, "SELECT id FROM nodes WHERE name LIKE '%thief%'")).toEqual([]);
  });

  it('continues past a rolled-back group to the path the engine chose', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { key } = await workspaceWithAgents(actor);
    const verifier = 'c'.repeat(64);
    const register = () => call(actor, 'POST', '/v1/agents', { name: 'recycled', recovery_proof_hash: verifier }, key);
    expect((await register()).status).toBe(201);
    expect((await call(actor, 'DELETE', '/v1/agents/recycled', undefined, key)).status).toBe(204);

    // The group conflicts on the released holder's verifier after writing;
    // the engine reclaims the verifier and registers again in the same request.
    actor.calls.length = 0;
    const again = await register();
    expect(again.status).toBe(201);
    expect(actor.calls.map((entry) => entry.replay)).toEqual([0, 1]);
    expect(rows(actor, 'SELECT COUNT(*) AS n FROM agent_recovery_credentials WHERE verifier_hash = ?', verifier)).toEqual([{ n: 1 }]);
    expect(rows(actor, "SELECT COUNT(*) AS n FROM agents WHERE name = 'recycled'")).toEqual([{ n: 1 }]);
  });

  it('keeps idempotency records in the actor database', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice } = await workspaceWithAgents(actor);
    const send = () => callWorkspaceActor(
      (request, replay) => actor.handle(request, replay),
      {
        ...jsonRequest('POST', '/v1/channels/general/messages', { text: 'once' }, alice),
        headers: [
          ['content-type', 'application/json'],
          ['authorization', `Bearer ${alice}`],
          ['idempotency-key', 'send-once-1'],
        ],
      },
    );
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(JSON.parse(second.body).data.id).toBe(JSON.parse(first.body).data.id);
    expect(rows(actor, "SELECT COUNT(*) AS n FROM messages WHERE body = 'once'")).toEqual([{ n: 1 }]);
    expect(rows(actor, 'SELECT COUNT(*) AS n FROM _actor_kv')[0].n).toBeGreaterThan(0);
  });

  it('defers outbound HTTP to maintenance and arms the alarm', async () => {
    const fetched: string[] = [];
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, {
      outboundFetch: async (input) => {
        fetched.push(String(input));
        return new Response('ok');
      },
    });
    await workspaceWithAgents(actor);
    expect(actor.alarm.at).not.toBeNull();
    await actor.maintain();
    expect(fetched).toEqual([]);
  });
});
