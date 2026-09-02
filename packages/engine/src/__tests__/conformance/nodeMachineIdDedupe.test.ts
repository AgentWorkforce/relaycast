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
 * reclaimed, so cleanup never stuck and the roster refilled. Enrollment now
 * falls back to the machine's existing broker.
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

  it('re-enrolling one machine under a fresh name rotates its row instead of adding one', async () => {
    const ws = await createWorkspace(stack.app, 'dedupe');

    const first = await enroll(ws.workspaceKey, { name: 'host-a-boot1', machine_id: 'machine-a' });
    expect(first.status).toBe(201);
    const second = await enroll(ws.workspaceKey, { name: 'host-a-boot2', machine_id: 'machine-a' });
    expect(second.status).toBe(201);

    // Same row, renamed — and a freshly minted token, so the re-enroll still
    // hands the host working credentials.
    expect(second.body.data?.id).toBe(first.body.data?.id);
    expect(second.body.data?.name).toBe('host-a-boot2');
    expect(second.body.data?.token).not.toBe(first.body.data?.token);

    const rows = await roster(ws.workspaceKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('host-a-boot2');
    expect(rows[0]!.machine_id).toBe('machine-a');
  });

  it('persists machine_id supplied at enrollment', async () => {
    const ws = await createWorkspace(stack.app, 'persist');
    const created = await enroll(ws.workspaceKey, { name: 'host-b', machine_id: 'machine-b' });

    const [row] = await stack.runtime.deps.db
      .select()
      .from(nodes)
      .where(eq(nodes.id, created.body.data!.id as string));
    expect(row!.machineId).toBe('machine-b');
  });

  it('keeps distinct machines on distinct rows', async () => {
    const ws = await createWorkspace(stack.app, 'distinct');
    await enroll(ws.workspaceKey, { name: 'host-a', machine_id: 'machine-a' });
    await enroll(ws.workspaceKey, { name: 'host-b', machine_id: 'machine-b' });

    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('does not collapse the many direct delivery hosts one machine runs', async () => {
    const ws = await createWorkspace(stack.app, 'direct');
    const hosts = await Promise.all([
      enroll(ws.workspaceKey, { name: 'agent-1-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 }),
      enroll(ws.workspaceKey, { name: 'agent-2-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 }),
    ]);
    expect(hosts.map((r) => r.status)).toEqual([201, 201]);

    // A direct node is a node-of-one: a machine legitimately hosts many, so
    // machine_id must not key them.
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('leaves a broker alone when a direct node on the same machine enrolls', async () => {
    const ws = await createWorkspace(stack.app, 'mixed');
    await enroll(ws.workspaceKey, { name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    await enroll(ws.workspaceKey, { name: 'direct-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 });

    const rows = await roster(ws.workspaceKey);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.name === 'broker-host')?.role).toBe('broker');
    expect(rows.find((r) => r.name === 'direct-host')?.role).toBe('direct');
  });

  it('does not hijack a machine\'s broker when an http_push node enrolls without a role', async () => {
    const ws = await createWorkspace(stack.app, 'httppush');
    const broker = await enroll(ws.workspaceKey, { name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4 });

    // `role` omitted: for a non-ws kind the documented default is `direct`, so
    // this must create its own node rather than rotate — and re-transport —
    // the live broker sharing the machine.
    const push = await enroll(ws.workspaceKey, {
      name: 'push-host',
      machine_id: 'machine-a',
      kind: 'http_push',
      delivery: { url: 'https://push.example.com/hook' },
    });
    expect(push.body.data?.id).not.toBe(broker.body.data?.id);

    const rows = await roster(ws.workspaceKey);
    expect(rows).toHaveLength(2);
    const stillBroker = rows.find((r) => r.name === 'broker-host');
    expect(stillBroker?.kind).toBe('ws');
    expect(stillBroker?.role).toBe('broker');
  });

  it('does not hijack a machine\'s broker when a poll node enrolls without a role', async () => {
    const ws = await createWorkspace(stack.app, 'poll');
    const broker = await enroll(ws.workspaceKey, { name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
    const poll = await enroll(ws.workspaceKey, { name: 'poll-host', machine_id: 'machine-a', kind: 'poll' });

    expect(poll.body.data?.id).not.toBe(broker.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('keeps concurrent first-enrollments of one machine on a single row', async () => {
    const ws = await createWorkspace(stack.app, 'concurrent');
    // Two boots of the same machine racing to enroll under different names.
    // Both miss node_id and name, so both reach the machine lookup; without
    // serialization both insert and the roster grows anyway.
    const results = await Promise.all([
      enroll(ws.workspaceKey, { name: 'host-a-boot1', machine_id: 'machine-a' }),
      enroll(ws.workspaceKey, { name: 'host-a-boot2', machine_id: 'machine-a' }),
    ]);

    // Both must succeed: one row is only the right answer if neither enroll
    // was rejected, otherwise this passes for the wrong reason.
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });

  it('lets an explicit node_id pin identity and opt out of machine grouping', async () => {
    const ws = await createWorkspace(stack.app, 'pinned');
    const a = await enroll(ws.workspaceKey, { node_id: 'node_a', name: 'broker-a', machine_id: 'machine-a', role: 'broker', max_agents: 4 });
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
    // The dedupe key is only durable if the WS register path cannot erase it.
    // recomputeNodeAggregate writes machineId only when non-null, and this
    // feature now depends on that: a broker that enrolls with a machine_id and
    // then registers without one must keep the value, or its next boot under a
    // fresh name would mint a new row again.
    const ws = await createWorkspace(stack.app, 'register-keeps');
    const enrolled = await enroll(ws.workspaceKey, {
      node_id: 'node_m', name: 'broker-host', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(enrolled.status).toBe(201);

    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, 'node_m', new FakeSocket());
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'reg-no-machine',
      type: 'node.register',
      name: 'broker-host',
      node_id: 'node_m',
      provider: { name: 'default', instance_id: 'i1' },
      capabilities: [],
      max_agents: 4,
      tags: [],
      version: 'v1',
      resume_cursor: null,
    }));

    const [row] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_m'));
    expect(row!.machineId).toBe('machine-a');

    // And the dedupe still works on the next boot. Registering made the node
    // live, and a live incumbent is deliberately never adopted, so first take
    // it offline — the host going away is exactly what precedes a re-enroll.
    await stack.runtime.deps.db.update(nodes).set({ status: 'offline' }).where(eq(nodes.id, 'node_m'));

    const reboot = await enroll(ws.workspaceKey, { name: 'broker-host-reboot', machine_id: 'machine-a' });
    expect(reboot.body.data?.id).toBe('node_m');
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });

  it('does not adopt a LIVE incumbent broker when a second broker presents its machine_id', async () => {
    // The renamed-reboot case dedupes because the old node is gone. This is the
    // opposite case: the incumbent is still live, so the claimant cannot be the
    // same host coming back. Adopting the row here would rename a running
    // broker and rotate its token out from under it -- a silent hijack, the
    // same shape as burning an agent name.
    //
    // A shared machine_id is not automatically hostile: a VM cloned from a
    // snapshot, or containers baked from one image, legitimately carry the same
    // id and run concurrently. So the claimant gets its OWN row rather than a
    // rejection -- the ambiguous match is declined, not the enrollment.
    const ws = await createWorkspace(stack.app, 'live-incumbent');

    const incumbent = await enroll(ws.workspaceKey, {
      node_id: 'node_live', name: 'broker-a', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(incumbent.status).toBe(201);

    // Bring the incumbent live: register + heartbeat, so status=online and the
    // heartbeat is inside NODE_LIVENESS_TTL_MS.
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

    // A different broker claims the live incumbent's machine_id.
    const claimant = await enroll(ws.workspaceKey, {
      name: 'broker-b', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(claimant.status).toBe(201);
    expect(claimant.body.data?.id).not.toBe('node_live');

    // The incumbent must be untouched in all three identity fields.
    const [after] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_live'));
    expect(after!.id).toBe(before!.id);
    expect(after!.name).toBe('broker-a');
    expect(after!.tokenHash).toBe(before!.tokenHash);

    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('still dedupes onto a stale incumbent once it is no longer live', async () => {
    // The guard is liveness, not identity: the same claim against an incumbent
    // that has gone offline is the reboot case and must still collapse.
    const ws = await createWorkspace(stack.app, 'stale-incumbent');
    const first = await enroll(ws.workspaceKey, {
      name: 'broker-a', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    // Never registered, so never live.
    const second = await enroll(ws.workspaceKey, {
      name: 'broker-a-reboot', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(second.body.data?.id).toBe(first.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });

  it('finds the offline row even when many live brokers share the machine_id', async () => {
    // The candidate scan is bounded. If the bound were applied before the
    // liveness filter, enough live rows would push the one reusable row out of
    // range and enrollment would insert yet another - the exact growth this
    // feature exists to stop, reappearing only on busy machines.
    const ws = await createWorkspace(stack.app, 'crowded-machine');
    const now = Date.now();

    // 25 live brokers on one machine, all older than the offline row.
    for (let i = 0; i < 25; i++) {
      await stack.runtime.deps.db.insert(nodes).values({
        id: `node_live_${i}`,
        workspaceId: ws.workspaceId,
        name: `live-${i}`,
        tokenHash: `hash-live-${i}`,
        machineId: 'machine-a',
        role: 'broker',
        kind: 'ws',
        status: 'online',
        lastHeartbeatAt: new Date(now),
        createdAt: new Date(now - 10_000 + i),
      });
    }
    // One offline row, newest of the set, so an ordered scan reaches it last.
    await stack.runtime.deps.db.insert(nodes).values({
      id: 'node_reusable',
      workspaceId: ws.workspaceId,
      name: 'gone-host',
      tokenHash: 'hash-reusable',
      machineId: 'machine-a',
      role: 'broker',
      kind: 'ws',
      status: 'offline',
      lastHeartbeatAt: new Date(now - 600_000),
      createdAt: new Date(now),
    });

    const reboot = await enroll(ws.workspaceKey, {
      name: 'gone-host-reboot', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(reboot.status).toBe(201);
    // Must reuse the offline row, not mint a 27th.
    expect(reboot.body.data?.id).toBe('node_reusable');
    expect(await roster(ws.workspaceKey)).toHaveLength(26);
  });

  it('does not adopt an online broker whose heartbeat is in the future', async () => {
    // lastHeartbeatAt is always stamped server-side, so a future value means
    // the server clock rolled back (or the DB was restored). isNodeLive reports
    // such a node as NOT live because it requires age >= 0 -- while the node may
    // still be heartbeating perfectly well. Deferring to isNodeLive here would
    // hand a running broker's row and token to whoever enrolls next, in exactly
    // the window where isNodeLive cannot detect the hijack.
    const ws = await createWorkspace(stack.app, 'future-heartbeat');
    const future = new Date(Date.now() + 10 * 60_000);
    await stack.runtime.deps.db.insert(nodes).values({
      id: 'node_future',
      workspaceId: ws.workspaceId,
      name: 'skewed-host',
      tokenHash: 'hash-future',
      machineId: 'machine-a',
      role: 'broker',
      kind: 'ws',
      status: 'online',
      lastHeartbeatAt: future,
      createdAt: new Date(Date.now() - 60_000),
    });

    const [before] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_future'));
    // The premise: isNodeLive alone would call this reusable...
    expect(isNodeLive(before!)).toBe(false);
    // ...and the reusability rule deliberately does not.
    expect(isReusableForMachineMatch(before!)).toBe(false);

    const claimant = await enroll(ws.workspaceKey, {
      name: 'claimant-host', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(claimant.status).toBe(201);
    expect(claimant.body.data?.id).not.toBe('node_future');

    const [after] = await stack.runtime.deps.db.select().from(nodes).where(eq(nodes.id, 'node_future'));
    expect(after!.name).toBe('skewed-host');
    expect(after!.tokenHash).toBe('hash-future');
    expect(await roster(ws.workspaceKey)).toHaveLength(2);

    // The leak is bounded: the row just created carries a null heartbeat, so
    // the NEXT enrollment reuses it rather than adding a third.
    const second = await enroll(ws.workspaceKey, {
      name: 'claimant-host-reboot', machine_id: 'machine-a', role: 'broker', max_agents: 4,
    });
    expect(second.body.data?.id).toBe(claimant.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(2);
  });

  it('adopts the machine_id of a row that enrolled before it reported one', async () => {
    const ws = await createWorkspace(stack.app, 'backfill');
    // Pre-existing roster row from before this path existed: no machine_id.
    const first = await enroll(ws.workspaceKey, { name: 'legacy-host' });
    // The same host, now reporting its machine, still matches by name and
    // records the id — so its *next* boot under a new name dedupes.
    const second = await enroll(ws.workspaceKey, { name: 'legacy-host', machine_id: 'machine-a' });
    expect(second.body.data?.id).toBe(first.body.data?.id);

    const third = await enroll(ws.workspaceKey, { name: 'legacy-host-reboot', machine_id: 'machine-a' });
    expect(third.body.data?.id).toBe(first.body.data?.id);
    expect(await roster(ws.workspaceKey)).toHaveLength(1);
  });
});
