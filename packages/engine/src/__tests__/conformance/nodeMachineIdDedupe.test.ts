import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, type TestStack } from './harness.js';
import { nodes } from '../../db/schema.js';

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
    await enroll(ws.workspaceKey, { name: 'agent-1-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 });
    await enroll(ws.workspaceKey, { name: 'agent-2-host', machine_id: 'machine-a', kind: 'ws', role: 'direct', max_agents: 1 });

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
    await Promise.all([
      enroll(ws.workspaceKey, { name: 'host-a-boot1', machine_id: 'machine-a' }),
      enroll(ws.workspaceKey, { name: 'host-a-boot2', machine_id: 'machine-a' }),
    ]);

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
