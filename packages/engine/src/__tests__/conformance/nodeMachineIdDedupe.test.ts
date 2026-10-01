import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, FakeSocket, type TestStack } from './harness.js';
import { nodes } from '../../db/schema.js';
import { isNodeLive, isReusableForMachineMatch } from '../../engine/placement.js';

/**
 * Enrollment dedupes on machine_id.
 *
 * A fleet host that persists no node_id enrolls under a fresh name on every
 * boot. Keyed on name alone, each boot minted a new roster row that nothing
 * reclaimed, so cleanup never stuck and the roster refilled.
 *
 * Reuse requires the row to have heartbeated once and then gone stale — proof
 * that a host held it and left. A row that never connected is never reused,
 * because that case is indistinguishable from two clones cold-booting from one
 * image, where adopting the row silently revokes the other host's token.
 */
describe('node enrollment — machine_id dedupe', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function enroll(workspaceKey: string, body: Record<string, unknown>) {
    const res = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> } };
  }

  async function roster(workspaceKey: string) {
    const res = await stack.app.request('/v1/nodes', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    return ((await res.json()) as { data: Record<string, unknown>[] }).data;
  }

  /** The host heartbeated, then went away: proof of life well past the TTL. */
  async function markConnectedThenGone(nodeId: string) {
    const long_ago = new Date(Date.now() - 600_000);
    await stack.runtime.deps.db
      .update(nodes)
      .set({ status: 'offline', lastHeartbeatAt: long_ago, provenLiveAt: long_ago })
      .where(eq(nodes.id, nodeId));
  }

  /** Registered but never heartbeated: the plumbing wrote lastHeartbeatAt only. */
  async function markRegisteredNeverHeartbeated(nodeId: string) {
    await stack.runtime.deps.db
      .update(nodes)
      .set({ status: 'offline', lastHeartbeatAt: new Date(Date.now() - 600_000), provenLiveAt: null })
      .where(eq(nodes.id, nodeId));
  }

  it('re-enrolling one machine under a fresh name rotates its row instead of adding one', async () => {
    const ws = await createWorkspace(stack.app, 'dedupe');

    const first = await enroll(ws.workspaceKey, { name: 'host-a-boot1', machine_id: 'machine-a' });
    expect(first.status).toBe(201);
    await markConnectedThenGone(first.body.data?.id as string);

    const second = await enroll(ws.workspaceKey, { name: 'host-a-boot2', machine_id: 'machine-a' });
    expect(second.status).toBe(201);

    expect(second.body.data?.id).toBe(first.body.data?.id);
    expect(second.body.data?.name).toBe('host-a-boot2');
    expect(second.body.data?.token).not.toBe(first.body.data?.token);

    const rows = await roster(ws.workspaceKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.machine_id).toBe('machine-a');
  });

  it('never reuses a row that has not connected, so cold-boot clones stay separate', async () => {
    // Two hosts from one baked image enrolling moments apart. This request
    // sequence is byte-identical to one host enrolling twice, so enrollment
    // cannot tell them apart — it must not adopt, or the first host's token is
    // silently revoked.
    const ws = await createWorkspace(stack.app, 'clones');
    const a = await enroll(ws.workspaceKey, { name: 'clone-a', machine_id: 'baked-1', role: 'broker', max_agents: 4 });
    const b = await enroll(ws.workspaceKey, { name: 'clone-b', machine_id: 'baked-1', role: 'broker', max_agents: 4 });

    expect(b.body.data?.id).not.toBe(a.body.data?.id);
    const [rowA] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, a.body.data?.id as string));
    expect(rowA!.name).toBe('clone-a');
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('does not reuse a row that only ever registered, never heartbeated', async () => {
    // registerNode / upsertProvider / recomputeNodeAggregate all write
    // lastHeartbeatAt, and markNodeOffline writes it again on disconnect. None
    // of those prove the node was alive, so none may unlock reuse.
    const ws = await createWorkspace(stack.app, 'registered-only');
    const first = await enroll(ws.workspaceKey, { name: 'host-a', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await markRegisteredNeverHeartbeated(first.body.data?.id as string);

    const second = await enroll(ws.workspaceKey, { name: 'host-a-boot2', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    expect(second.body.data?.id).not.toBe(first.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('does not let a just-reused row be reused again before its new holder proves life', async () => {
    // Reuse rotates tokenHash. If the stale proof survived that rotation, a
    // third enrollment could take the row straight back and revoke the token
    // the second enrollment was just handed.
    const ws = await createWorkspace(stack.app, 'double-reuse');
    const first = await enroll(ws.workspaceKey, { name: 'host-boot1', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await markConnectedThenGone(first.body.data?.id as string);

    const second = await enroll(ws.workspaceKey, { name: 'host-boot2', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    expect(second.body.data?.id).toBe(first.body.data?.id);

    const [afterReuse] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, second.body.data?.id as string));
    expect(afterReuse!.provenLiveAt).toBeNull();

    const third = await enroll(ws.workspaceKey, { name: 'host-boot3', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    expect(third.body.data?.id).not.toBe(second.body.data?.id);

    // The second host's row and credential survive.
    const [rowTwo] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, second.body.data?.id as string));
    expect(rowTwo!.name).toBe('host-boot2');
    const { sha256Hex } = await import('../../lib/crypto.js');
    expect(rowTwo!.tokenHash).toBe(await sha256Hex(second.body.data?.token as string));
  });

  it('a real heartbeat frame is what unlocks reuse', async () => {
    // End-to-end: enroll, register, heartbeat, then age the proof out.
    const ws = await createWorkspace(stack.app, 'heartbeat-unlocks');
    await enroll(ws.workspaceKey, {
      node_id: 'node_hb', name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_hb', new FakeSocket());
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg', type: 'node.register', name: 'broker-host', node_id: 'node_hb',
      provider: { name: 'default', instance_id: 'i1' }, capabilities: [], max_agents: 4,
      tags: [], version: 'v1', resume_cursor: null,
    }));
    // Registration alone must not set proof of life.
    const [afterRegister] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_hb'));
    expect(afterRegister!.lastHeartbeatAt).not.toBeNull();
    expect(afterRegister!.provenLiveAt).toBeNull();

    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', provider: { name: 'default', instance_id: 'i1' },
      active_agents: 0, handlers_live: true,
    }));
    const [afterHeartbeat] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_hb'));
    expect(afterHeartbeat!.provenLiveAt).not.toBeNull();

    // Age the proof out; now the row is reusable.
    await markConnectedThenGone('node_hb');
    const reboot = await enroll(ws.workspaceKey, { name: 'broker-host-reboot', machine_id: 'machine-a' });
    expect(reboot.body.data?.id).toBe('node_hb');
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });

  it('persists machine_id supplied at enrollment', async () => {
    const ws = await createWorkspace(stack.app, 'persist');
    const created = await enroll(ws.workspaceKey, { name: 'host-b', machine_id: 'machine-b' });
    const [row] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, created.body.data!.id as string));
    expect(row!.machineId).toBe('machine-b');
  });

  it('keeps distinct machines on distinct rows', async () => {
    const ws = await createWorkspace(stack.app, 'distinct');
    const a = await enroll(ws.workspaceKey, { name: 'host-a', machine_id: 'machine-a' });
    await markConnectedThenGone(a.body.data?.id as string);
    await enroll(ws.workspaceKey, { name: 'host-b', machine_id: 'machine-b' });
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('does not collapse the many direct delivery hosts one machine runs', async () => {
    const ws = await createWorkspace(stack.app, 'direct');
    const one = await enroll(ws.workspaceKey, { name: 'agent-1-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 });
    await markConnectedThenGone(one.body.data?.id as string);
    const two = await enroll(ws.workspaceKey, { name: 'agent-2-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 });
    expect(two.status).toBe(201);
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('leaves a broker alone when a direct node on the same machine enrolls', async () => {
    const ws = await createWorkspace(stack.app, 'mixed');
    const broker = await enroll(ws.workspaceKey, { name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await markConnectedThenGone(broker.body.data?.id as string);
    await enroll(ws.workspaceKey, { name: 'direct-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 });

    const rows = await roster(ws.workspaceKey);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'broker-host')?.role).toBe('broker');
    expect(rows.find((r) => r.name === 'direct-host')?.role).toBe('direct');
  });

  it('does not hijack a machine\'s broker when an http_push node enrolls without a role', async () => {
    const ws = await createWorkspace(stack.app, 'httppush');
    const broker = await enroll(ws.workspaceKey, { name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await markConnectedThenGone(broker.body.data?.id as string);

    const push = await enroll(ws.workspaceKey, {
      name: 'push-host', machine_id: 'machine-a', kind: 'http_push',
      delivery: { url: 'https://push.example.com/hook' },
    });
    expect(push.body.data?.id).not.toBe(broker.body.data?.id);

    const rows = await roster(ws.workspaceKey);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'broker-host')?.kind).toBe('ws');
    expect(rows.find((r) => r.name === 'broker-host')?.role).toBe('broker');
  });

  it('does not hijack a machine\'s broker when a poll node enrolls without a role', async () => {
    const ws = await createWorkspace(stack.app, 'poll');
    const broker = await enroll(ws.workspaceKey, { name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await markConnectedThenGone(broker.body.data?.id as string);
    const poll = await enroll(ws.workspaceKey, { name: 'poll-host', machine_id: 'machine-a', kind: 'poll' });

    expect(poll.body.data?.id).not.toBe(broker.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('does not adopt a LIVE incumbent broker when a second broker presents its machine_id', async () => {
    const ws = await createWorkspace(stack.app, 'live-incumbent');
    const incumbent = await enroll(ws.workspaceKey, {
      node_id: 'node_live', name: 'broker-a', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(incumbent.status).toBe(201);

    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_live', new FakeSocket());
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg-live', type: 'node.register', name: 'broker-a', node_id: 'node_live',
      provider: { name: 'default', instance_id: 'i1' }, capabilities: [], max_agents: 4,
      tags: [], version: 'v1', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.heartbeat', provider: { name: 'default', instance_id: 'i1' },
      active_agents: 0, handlers_live: true,
    }));

    const [before] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_live'));
    expect(isNodeLive(before!)).toBe(true);
    expect(isReusableForMachineMatch(before!)).toBe(false);

    const claimant = await enroll(ws.workspaceKey, {
      name: 'broker-b', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(claimant.status).toBe(201);
    expect(claimant.body.data?.id).not.toBe('node_live');

    const [after] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_live'));
    expect(after!.id).toBe(before!.id);
    expect(after!.name).toBe('broker-a');
    expect(after!.tokenHash).toBe(before!.tokenHash);
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('does not adopt an online broker whose heartbeat is in the future', async () => {
    // lastHeartbeatAt is stamped server-side, so a future value means the server
    // clock moved backwards while the node may still be heartbeating normally.
    const ws = await createWorkspace(stack.app, 'future-heartbeat');
    await stack.runtime.deps.db.insert(nodes).values({
      id: 'node_future', workspaceId: ws.workspaceId, name: 'skewed-host',
      tokenHash: 'hash-future', machineId: 'machine-a', role: 'broker', kind: 'ws',
      status: 'online', lastHeartbeatAt: new Date(Date.now() + 600_000),
      provenLiveAt: new Date(Date.now() + 600_000), createdAt: new Date(Date.now() - 60_000),
    });

    const [before] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_future'));
    expect(isReusableForMachineMatch(before!)).toBe(false);

    const claimant = await enroll(ws.workspaceKey, {
      name: 'claimant-host', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(claimant.body.data?.id).not.toBe('node_future');

    const [after] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_future'));
    expect(after!.name).toBe('skewed-host');
    expect(after!.tokenHash).toBe('hash-future');
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('finds the reusable row even when many live brokers share the machine_id', async () => {
    const ws = await createWorkspace(stack.app, 'crowded-machine');
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      await stack.runtime.deps.db.insert(nodes).values({
        id: `node_live_${i}`, workspaceId: ws.workspaceId, name: `live-${i}`,
        tokenHash: `hash-live-${i}`, machineId: 'machine-a', role: 'broker', kind: 'ws',
        // Registered just now (so live) but last PROVED life long ago. Without
        // the liveness predicate in SQL these pass the proof filter, fill the
        // scan window, and hide the reusable row behind them.
        status: 'online', lastHeartbeatAt: new Date(now),
        provenLiveAt: new Date(now - 600_000), createdAt: new Date(now - 10_000 + i),
      });
    }
    await stack.runtime.deps.db.insert(nodes).values({
      id: 'node_reusable', workspaceId: ws.workspaceId, name: 'gone-host',
      tokenHash: 'hash-reusable', machineId: 'machine-a', role: 'broker', kind: 'ws',
      status: 'offline', lastHeartbeatAt: new Date(now - 600_000),
      provenLiveAt: new Date(now - 600_000), createdAt: new Date(now),
    });

    const reboot = await enroll(ws.workspaceKey, {
      name: 'gone-host-reboot', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(reboot.body.data?.id).toBe('node_reusable');
    expect(await roster(ws.workspaceKey)).toHaveLength(26);
  });

  it('does not reuse a row with a stale proof but a future heartbeat', async () => {
    // Server clock rollback. isNodeLive returns false for the negative age, so
    // the stale proof alone would read as reusable while the broker is running.
    const ws = await createWorkspace(stack.app, 'future-hb-stale-proof');
    await stack.runtime.deps.db.insert(nodes).values({
      id: 'node_skew', workspaceId: ws.workspaceId, name: 'skewed-host',
      tokenHash: 'hash-skew', machineId: 'machine-a', role: 'broker', kind: 'ws',
      // `offline` deliberately: with `online` the SQL not-live clause already
      // excludes this row, so the separate future-heartbeat clause would never
      // be exercised and could be deleted without failing this test.
      status: 'offline', lastHeartbeatAt: new Date(Date.now() + 600_000),
      provenLiveAt: new Date(Date.now() - 600_000), createdAt: new Date(Date.now() - 60_000),
    });

    const [before] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_skew'));
    expect(isNodeLive(before!)).toBe(false);
    expect(isReusableForMachineMatch(before!)).toBe(false);

    const claimant = await enroll(ws.workspaceKey, {
      name: 'claimant', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(claimant.body.data?.id).not.toBe('node_skew');

    const [after] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_skew'));
    expect(after!.name).toBe('skewed-host');
    expect(after!.tokenHash).toBe('hash-skew');
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('finds the reusable row behind many future-dated rows', async () => {
    // Pins the SQL future-heartbeat clause specifically. A single future-dated
    // row is caught by the JS check whether or not SQL excludes it, so only
    // crowding shows the difference: without the SQL clause these fill the scan
    // window and the reusable row behind them is never seen.
    const ws = await createWorkspace(stack.app, 'crowded-future');
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      await stack.runtime.deps.db.insert(nodes).values({
        id: `node_skew_${i}`, workspaceId: ws.workspaceId, name: `skew-${i}`,
        tokenHash: `hash-skew-${i}`, machineId: 'machine-a', role: 'broker', kind: 'ws',
        status: 'offline', lastHeartbeatAt: new Date(now + 600_000),
        provenLiveAt: new Date(now - 600_000), createdAt: new Date(now - 10_000 + i),
      });
    }
    await stack.runtime.deps.db.insert(nodes).values({
      id: 'node_reusable_2', workspaceId: ws.workspaceId, name: 'gone-host',
      tokenHash: 'hash-reusable-2', machineId: 'machine-a', role: 'broker', kind: 'ws',
      status: 'offline', lastHeartbeatAt: new Date(now - 600_000),
      provenLiveAt: new Date(now - 600_000), createdAt: new Date(now),
    });

    const reboot = await enroll(ws.workspaceKey, {
      name: 'gone-host-reboot', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(reboot.body.data?.id).toBe('node_reusable_2');
    expect(await roster(ws.workspaceKey)).toHaveLength(26);
  });

  it('lets an explicit node_id pin identity and opt out of machine grouping', async () => {
    const ws = await createWorkspace(stack.app, 'pinned');
    const a = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'broker-a', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await markConnectedThenGone('node_a');
    const b = await enroll(ws.workspaceKey, { node_id: 'node_b', name: 'broker-b', machine_id: 'machine-a', role: 'broker', max_agents: 4 });

    expect(a.body.data?.id).toBe('node_a');
    expect(b.body.data?.id).toBe('node_b');
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('still keys on name when the caller sends no machine_id', async () => {
    const ws = await createWorkspace(stack.app, 'noname');
    const first = await enroll(ws.workspaceKey, { name: 'host-a' });
    const second = await enroll(ws.workspaceKey, { name: 'host-a' });
    expect(second.body.data?.id).toBe(first.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });

  it('keeps the enrollment-set machine_id when a register frame omits one', async () => {
    const ws = await createWorkspace(stack.app, 'register-keeps');
    const enrolled = await enroll(ws.workspaceKey, {
      node_id: 'node_m', name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(enrolled.status).toBe(201);

    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_m', new FakeSocket());
    await handle.handleMessage(JSON.stringify({
      v: 1, id: 'reg-no-machine', type: 'node.register', name: 'broker-host', node_id: 'node_m',
      provider: { name: 'default', instance_id: 'i1' }, capabilities: [], max_agents: 4,
      tags: [], version: 'v1', resume_cursor: null,
    }));

    const [row] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_m'));
    expect(row!.machineId).toBe('machine-a');

    // Registering made it live and gave it a heartbeat. Age it out, which is
    // the host having connected and then gone, and the next boot dedupes.
    await markConnectedThenGone('node_m');
    const reboot = await enroll(ws.workspaceKey, { name: 'broker-host-reboot', machine_id: 'machine-a' });
    expect(reboot.body.data?.id).toBe('node_m');
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });
});
