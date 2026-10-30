import { describe, expect, it } from 'vitest';
import { callWorkspaceActor } from '../../../gateway.js';
import { verifyFileToken } from '../../../lib/fileTokens.js';
import { sha256Hex } from '../../../lib/crypto.js';
import { ActorReplayRequired, nextMaintenanceAt } from '../index.js';
import { SignedUrlFileStorage } from '../files.js';
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

  it('verifies live-family credentials as well as the self-routing ones it mints', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const { alice } = await workspaceWithAgents(actor);
    const unknown = await call(actor, 'GET', '/v1/agents', undefined, `rk_live_${'0'.repeat(32)}`);
    expect(unknown.status).toBe(401);
    expect(unknown.json.error?.message).toBe('Invalid API key');

    const legacy = `at_live_${'cd'.repeat(16)}`;
    actor.sql.raw.prepare('UPDATE agents SET token_hash = ? WHERE token_hash = ?')
      .run(await sha256Hex(legacy), await sha256Hex(alice));
    expect((await call(actor, 'GET', '/v1/inbox', undefined, legacy)).status).toBe(200);
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

  it('issues self-routing credentials without being configured to', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, { config: {} });
    const { key } = await workspaceWithAgents(actor);
    expect(key).toMatch(/^relaycast_ws_/);
  });

  it('arms the alarm from outstanding work and lets an idle workspace go dormant', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    await call(actor, 'POST', '/v1/workspaces', { name: 'idle' });
    expect(nextMaintenanceAt(actor.sql)).toBeNull();

    const now = Date.now();
    // A registered agent is live until its liveness TTL; maintenance must run then.
    actor.sql.exec("INSERT INTO agents (id, workspace_id, name, token_hash, status, last_seen) VALUES ('a1', ?, 'a', 't', 'active', ?)",
      WORKSPACE_ID, Math.floor(now / 1000));
    const due = nextMaintenanceAt(actor.sql)!;
    expect(due).toBeGreaterThan(now + 4 * 60_000);
    expect(due).toBeLessThanOrEqual(now + 5 * 60_000 + 1_000);

    // An unfinished delivery keeps it armed until its expiry, independent of activity.
    actor.sql.exec("UPDATE agents SET status = 'offline' WHERE id = 'a1'");
    expect(nextMaintenanceAt(actor.sql)).toBeNull();
    actor.sql.exec('INSERT INTO file_cleanup_queue (storage_key, delete_after, process_after) VALUES (?, ?, ?)',
      `${WORKSPACE_ID}/f/x`, Math.floor(now / 1000), Math.floor(now / 1000) + 3600);
    expect(nextMaintenanceAt(actor.sql)).toBe((Math.floor(now / 1000) + 3600) * 1000);
  });

  it('arms the alarm at A2A egress leases and task deadlines, not for a queue waiting on its node', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    await call(actor, 'POST', '/v1/workspaces', { name: 'deadlines' });
    actor.sql.raw.pragma('foreign_keys = OFF');
    const nowSeconds = Math.floor(Date.now() / 1000);

    // A pending invocation already dispatched once, with no retry time, waits for
    // its node to reconnect; the sweep does nothing with it.
    actor.sql.exec(
      "INSERT INTO action_invocations (id, workspace_id, action_name, status, dispatch_attempts, created_at) VALUES ('inv1', ?, 'build', 'pending', 1, ?)",
      WORKSPACE_ID, nowSeconds,
    );
    expect(nextMaintenanceAt(actor.sql)).toBeNull();

    // A task queued the same way still expires at its deadline.
    const deadline = new Date((nowSeconds + 600) * 1000).toISOString();
    actor.sql.exec(
      "INSERT INTO action_invocations (id, workspace_id, action_name, status, dispatch_attempts, created_at, task_state) VALUES ('task1', ?, 'build', 'pending', 1, ?, ?)",
      WORKSPACE_ID, nowSeconds, JSON.stringify({ deadline }),
    );
    expect(nextMaintenanceAt(actor.sql)).toBe((nowSeconds + 600) * 1000);
    actor.sql.exec("DELETE FROM action_invocations WHERE id = 'task1'");

    actor.sql.exec(
      "INSERT INTO a2a_egress (id, workspace_id, message_id, target_id, external_url, fingerprint, status, lease_until) VALUES ('e1', ?, 'm1', 't1', 'https://agent.example.com', 'f', 'sending', ?)",
      WORKSPACE_ID, nowSeconds + 120,
    );
    expect(nextMaintenanceAt(actor.sql)).toBe((nowSeconds + 120) * 1000);
  });

  it('bounds a blob delete when the gateway never answers', async () => {
    const never: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
    const storage = new SignedUrlFileStorage('https://armadillo.test', 'file-secret', never, 50);
    await expect(storage.deleteObjects({ storageKeys: ['w/f/a.txt'] })).rejects.toThrow();
  });

  it('alerts on a maintenance pass that rolls back and counts consecutive failures across the rollback', async () => {
    const alerts: Record<string, unknown>[] = [];
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, {
      telemetry: { capture() {}, captureException: (_error, context) => { if (context?.alert) alerts.push(context); } },
    });
    await call(actor, 'POST', '/v1/workspaces', { name: 'doomed-maintenance' });
    // The expiry reaper's write group deletes the workspace's events, then its
    // workspace delete aborts: a group that fails after writing.
    actor.sql.raw.exec(`
      UPDATE workspaces SET expires_at = unixepoch() - 60;
      INSERT INTO workspace_events (workspace_id, seq, type, payload) VALUES ('${WORKSPACE_ID}', 999, 'probe', '{}');
      CREATE TRIGGER refuse_workspace_delete BEFORE DELETE ON workspaces BEGIN SELECT RAISE(ABORT, 'refused'); END;
    `);

    actor.alarm.at = Math.floor(Date.now() / 1000) * 1000;
    await expect(actor.maintain()).rejects.toBeInstanceOf(ActorReplayRequired);
    expect(alerts).toEqual([expect.objectContaining({
      alert: 'maintenance_rolled_back',
      workspace_id: WORKSPACE_ID,
      step: 'workspace_expiry',
      write_group: expect.any(Number),
      error_code: 'SQLITE_CONSTRAINT_TRIGGER',
      consecutive_failures: 1,
    })]);
    // The retry alarm carries the count and survives the rollback.
    expect(actor.alarm.at! % 1000).toBe(1);
    expect(rows(actor, "SELECT COUNT(*) AS n FROM workspace_events WHERE seq = 999")).toEqual([{ n: 1 }]);

    await expect(actor.maintain()).rejects.toBeInstanceOf(ActorReplayRequired);
    expect(alerts.at(-1)).toMatchObject({ consecutive_failures: 2 });
    expect(actor.alarm.at! % 1000).toBe(2);

    // Once the pass commits, scheduled alarms are whole seconds again.
    actor.sql.raw.exec('DROP TRIGGER refuse_workspace_delete');
    await actor.maintain();
    expect(actor.alarm.at === null || actor.alarm.at % 1000 === 0).toBe(true);
  });

  it('keeps a pending backoff alarm and its failure count when requests arrive', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    await workspaceWithAgents(actor);
    const backoff = (Math.floor(Date.now() / 1000) + 600) * 1000 + 3;
    actor.alarm.at = backoff;
    await call(actor, 'GET', '/v1/agents', undefined, (await call<{ api_key: string }>(actor, 'GET', '/v1/workspace')).json?.data?.api_key);
    expect(actor.alarm.at).toBe(backoff);
  });

  it('bounds the time a maintenance pass spends on blob deletes when the gateway hangs', async () => {
    const hang: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, { outboundFetch: hang, blobDeleteBudgetMs: 200 });
    await call(actor, 'POST', '/v1/workspaces', { name: 'hung-gateway' });
    for (let i = 0; i < 30; i += 1) {
      actor.sql.exec('INSERT INTO file_cleanup_queue (storage_key, delete_after, process_after) VALUES (?, 0, 0)', `${WORKSPACE_ID}/f${i}/f${i}`);
    }
    const started = Date.now();
    await actor.maintain();
    expect(Date.now() - started).toBeLessThan(2_000);
    // Nothing was lost: the queue keeps every row for the next pass.
    expect(rows(actor, 'SELECT COUNT(*) AS n FROM file_cleanup_queue')).toEqual([{ n: 30 }]);
  });

  it('drains blob cleanup across passes when only part of a batch fits the budget', async () => {
    const deletedCount = new Map<string, number>();
    const slow: typeof fetch = (input, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const token = new URL(new Request(input).url).searchParams.get('token')!;
        const key = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).key as string;
        deletedCount.set(key, (deletedCount.get(key) ?? 0) + 1);
        resolve(new Response(null, { status: 204 }));
      }, 60);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); });
    });
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, { outboundFetch: slow, blobDeleteBudgetMs: 200 });
    await call(actor, 'POST', '/v1/workspaces', { name: 'slow-gateway' });
    for (let i = 0; i < 10; i += 1) {
      actor.sql.exec('INSERT INTO file_cleanup_queue (storage_key, delete_after, process_after) VALUES (?, 0, 0)', `${WORKSPACE_ID}/f${i}/f${i}`);
    }
    const queued = () => (rows(actor, 'SELECT COUNT(*) AS n FROM file_cleanup_queue')[0] as { n: number }).n;
    const sizes = [queued()];
    for (let pass = 0; pass < 10 && queued() > 0; pass += 1) {
      actor.sql.exec('UPDATE file_cleanup_queue SET process_after = 0');
      await actor.maintain();
      sizes.push(queued());
    }
    expect(sizes.at(-1)).toBe(0);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    expect(sizes.length).toBeGreaterThan(2);
    expect([...deletedCount.values()].every((count) => count === 1)).toBe(true);
    expect(deletedCount.size).toBe(10);
  });

  it('arms the alarm when an idempotency record expires', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    await call(actor, 'POST', '/v1/workspaces', { name: 'kv-expiry' });
    actor.sql.exec('DELETE FROM _actor_kv');
    expect(nextMaintenanceAt(actor.sql)).toBeNull();
    const expiresAt = Date.now() + 3_600_000;
    actor.sql.exec("INSERT INTO _actor_kv (key, value, expires_at) VALUES ('idem', 'v', ?)", expiresAt);
    expect(nextMaintenanceAt(actor.sql)).toBe(Math.floor(expiresAt / 1000) * 1000);
  });

  it('queues ephemeral events during a request and sends them from maintenance', async () => {
    const sent: string[] = [];
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, {
      outboundFetch: async (input) => {
        sent.push(new Request(input).url);
        return new Response('ok');
      },
    });
    await workspaceWithAgents(actor);
    const ephemeral = actor.runtime.deps.config!.ephemeralEventFetch!;
    await actor.sql.atomic(async () => {
      const response = await ephemeral('https://hooks.example.com/push', { method: 'POST', body: '{"type":"typing"}' });
      expect(response.status).toBe(202);
    });
    expect(sent).toEqual([]);
    expect(nextMaintenanceAt(actor.sql)).not.toBeNull();
    await actor.maintain();
    expect(sent).toEqual(['https://hooks.example.com/push']);
    expect(actor.sql.exec('SELECT COUNT(*) AS n FROM _actor_outbound')).toEqual([{ n: 0 }]);
  });

  it('sends outbound HTTP from maintenance only to public HTTPS destinations', async () => {
    const sent: string[] = [];
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, {
      outboundFetch: async (input) => {
        sent.push(new Request(input).url);
        return new Response('ok');
      },
    });
    await workspaceWithAgents(actor);
    const outbound = actor.runtime.deps.config!.outboundWebhookFetch!;
    await expect(outbound('https://hooks.example.com/a')).rejects.toThrow(/deferred to actor maintenance/);
    const ephemeral = actor.runtime.deps.config!.ephemeralEventFetch!;
    await actor.sql.atomic(async () => {
      await ephemeral('http://169.254.169.254/latest', { method: 'POST' });
      await ephemeral('https://10.0.0.1/hook', { method: 'POST' });
    });
    await actor.maintain();
    expect(sent).toEqual([]);
  });

  it('signs upload size and type, and deletes blobs through the gateway from maintenance', async () => {
    const requests: { method: string; url: string }[] = [];
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, {
      outboundFetch: async (input, init) => {
        requests.push({ method: init?.method ?? 'GET', url: new Request(input).url });
        return new Response(null, { status: 204 });
      },
    });
    const { files } = actor.runtime.deps;
    const { uploadUrl } = await files.createUploadUrl({ storageKey: `${WORKSPACE_ID}/f1/a.txt`, contentType: 'text/plain', sizeBytes: 5 });
    const token = new URL(uploadUrl).searchParams.get('token');
    expect(await verifyFileToken('file-secret', token)).toMatchObject({ op: 'put', size: 5, type: 'text/plain' });

    await expect(files.deleteObjects!({ storageKeys: [`${WORKSPACE_ID}/f1/a.txt`] })).rejects.toThrow(/deferred/);
    expect(requests).toEqual([]);
    actor.sql.exec('INSERT INTO file_cleanup_queue (storage_key, delete_after, process_after) VALUES (?, 0, 0)', `${WORKSPACE_ID}/f1/a.txt`);
    await actor.maintain();
    expect(requests.map((request) => request.method)).toEqual(['DELETE']);
    const deleteToken = new URL(requests[0].url).searchParams.get('token');
    expect(await verifyFileToken('file-secret', deleteToken)).toMatchObject({ op: 'delete', key: `${WORKSPACE_ID}/f1/a.txt` });
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
