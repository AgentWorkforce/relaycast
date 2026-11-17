import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  attachDirectNodeSocket,
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import {
  INVOCATION_SWEEP_BUDGET_MS,
  NEVER_DISPATCHED_SWEEP_GRACE_MS,
  NEVER_DISPATCHED_SWEEP_SUB_BATCH,
  sweepTimedOutInvocations,
  type SweepTimedOutInvocationsReport,
} from '../../engine/action.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';
import { actionInvocations, nodes } from '../../db/tables.js';
import * as sqlx from '../../db/sqlx.js';

// The gateway's invocation_sweep cron took ~16 s on D1 every run: the
// never-dispatched phase slept 5 s in process, and every phase walked every
// matching row. A run is now bounded by rows per phase and a wall-clock
// budget, and the never-dispatched grace is spread over two runs.

const HOUR = 60 * 60 * 1000;

async function insertPending(
  stack: TestStack,
  workspaceId: string,
  opts: {
    id: string;
    createdAt: Date;
    dispatchAttempts?: number;
    retryAfterAt?: Date | null;
    spawnReservedAt?: Date | null;
    handlerNodeId?: string | null;
    dispatchedNodeId?: string | null;
    actionId?: string | null;
    actionName?: string;
  },
): Promise<void> {
  await stack.runtime.handle.db.insert(actionInvocations).values({
    id: opts.id,
    workspaceId,
    actionId: opts.actionId ?? null,
    actionName: opts.actionName ?? 'spawn',
    callerId: null,
    callerName: null,
    input: { capability: 'claude' },
    status: 'pending',
    dispatchAttempts: opts.dispatchAttempts ?? 0,
    retryAfterAt: opts.retryAfterAt ?? null,
    spawnReservedAt: opts.spawnReservedAt ?? null,
    handlerNodeId: opts.handlerNodeId ?? null,
    dispatchedNodeId: opts.dispatchedNodeId ?? null,
    createdAt: opts.createdAt,
  });
}

async function sweepCursorId(stack: TestStack, name: string): Promise<string | null> {
  const [row] = await sqlx.all<{ cursor: string }>(
    stack.runtime.handle.db,
    sql`SELECT cursor FROM maintenance_cursors WHERE id = ${`invocation-sweep-v1:${name}`}`,
  );
  return row ? (JSON.parse(row.cursor) as { id: string }).id : null;
}

async function statuses(stack: TestStack, ids: string[]) {
  const out: Record<string, { status: string; error: string | null }> = {};
  for (const id of ids) {
    const [row] = await stack.runtime.handle.db
      .select({ status: actionInvocations.status, error: actionInvocations.error })
      .from(actionInvocations)
      .where(eq(actionInvocations.id, id));
    out[id] = row;
  }
  return out;
}

async function sweep(
  stack: TestStack,
  opts: Parameters<typeof sweepTimedOutInvocations>[2] & object = {},
  registry: NodeConnectionRegistry = stack.runtime.realtime,
) {
  let report: SweepTimedOutInvocationsReport | undefined;
  const started = performance.now();
  const rescheduled = await sweepTimedOutInvocations(stack.runtime.handle.db, registry, {
    pendingInvocationMaxAgeMs: HOUR,
    ...opts,
    onReport: (r) => { report = r; },
  });
  return { rescheduled, report: report!, elapsedMs: performance.now() - started };
}

describe('invocation sweep is bounded', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => {
    vi.useRealTimers();
    stack.close();
  });

  it('finishes well under a second with nothing to sweep', async () => {
    const { report, elapsedMs, rescheduled } = await sweep(stack);
    expect(rescheduled).toBe(0);
    expect(report.budgetExhausted).toBe(false);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('stops when the budget is spent and the next run continues', async () => {
    const ws = await createWorkspace(stack.app, 'sweep-budget');
    const ids = ['inv_b1', 'inv_b2', 'inv_b3'];
    for (const [i, id] of ids.entries()) {
      await insertPending(stack, ws.workspaceId, { id, createdAt: new Date(Date.now() - 2 * HOUR - i * 1_000) });
    }

    const spent = await sweep(stack, { budgetMs: 0, neverDispatchedSweepGraceMs: 0 });
    expect(spent.report.budgetExhausted).toBe(true);
    expect(spent.report.neverDispatchedFailed).toBe(0);
    expect(Object.values(await statuses(stack, ids)).map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);

    const next = await sweep(stack, { neverDispatchedSweepGraceMs: 0 });
    expect(next.report.budgetExhausted).toBe(false);
    expect(next.report.neverDispatchedFailed).toBe(3);
    for (const row of Object.values(await statuses(stack, ids))) {
      expect(row).toEqual({ status: 'failed', error: 'never_dispatched_expired' });
    }
  });

  it('caps each phase at maxRowsPerPass rows and drains oldest first', async () => {
    const ws = await createWorkspace(stack.app, 'sweep-max-rows');
    const ids = ['inv_m1', 'inv_m2', 'inv_m3', 'inv_m4', 'inv_m5'];
    // inv_m1 is the oldest.
    for (const [i, id] of ids.entries()) {
      await insertPending(stack, ws.workspaceId, { id, createdAt: new Date(Date.now() - 10 * HOUR + i * 60_000) });
    }

    const failedPerRun: number[] = [];
    for (let run = 0; run < 3; run++) {
      const { report } = await sweep(stack, { maxRowsPerPass: 2, neverDispatchedSweepGraceMs: 0 });
      failedPerRun.push(report.neverDispatchedFailed);
      if (run === 0) {
        const after = await statuses(stack, ids);
        expect(ids.filter((id) => after[id].status === 'failed')).toEqual(['inv_m1', 'inv_m2']);
      }
    }
    expect(failedPerRun).toEqual([2, 2, 1]);
  });

  it('rotates the due-pending lane across runs instead of re-reading the oldest page', async () => {
    const ws = await createWorkspace(stack.app, 'sweep-rotate');
    // Attempted rows, so the never-dispatched phase leaves them to the reschedule lane.
    const ids = ['inv_r1', 'inv_r2', 'inv_r3'];
    for (const [i, id] of ids.entries()) {
      await insertPending(stack, ws.workspaceId, {
        id,
        createdAt: new Date(Date.now() - 5 * 60_000 + i * 1_000),
        dispatchAttempts: 1,
        retryAfterAt: new Date(Date.now() - 1_000),
      });
    }
    const cursor = async () => {
      const [row] = await sqlx.all<{ cursor: string }>(
        stack.runtime.handle.db,
        sql`SELECT cursor FROM maintenance_cursors WHERE id = 'invocation-sweep-v1:pending'`,
      );
      return row ? (JSON.parse(row.cursor) as { id: string }).id : null;
    };

    await sweep(stack, { maxRowsPerPass: 1 });
    expect(await cursor()).toBe('inv_r1');
    await sweep(stack, { maxRowsPerPass: 1 });
    expect(await cursor()).toBe('inv_r2');
    await sweep(stack, { maxRowsPerPass: 1 });
    expect(await cursor()).toBe('inv_r3');
    // Past the end: wrap so the next run starts from the oldest again.
    await sweep(stack, { maxRowsPerPass: 1 });
    expect(await cursor()).toBeNull();
  });

  it('does not sleep: the default grace notes candidates on one run and fails them on a later run', async () => {
    expect(NEVER_DISPATCHED_SWEEP_GRACE_MS).toBeGreaterThan(0);
    const ws = await createWorkspace(stack.app, 'sweep-two-pass');
    await insertPending(stack, ws.workspaceId, { id: 'inv_tp_stale', createdAt: new Date(Date.now() - 2 * HOUR) });
    // Its unclaimed send records the attempt after the first run saw it.
    await insertPending(stack, ws.workspaceId, { id: 'inv_tp_sent', createdAt: new Date(Date.now() - 2 * HOUR) });

    const first = await sweep(stack);
    expect(first.elapsedMs).toBeLessThan(1_000);
    expect(first.report.neverDispatchedDeferred).toBe(true);
    expect(first.report.neverDispatchedFailed).toBe(0);

    await stack.runtime.handle.db
      .update(actionInvocations)
      .set({ dispatchAttempts: 1 })
      .where(eq(actionInvocations.id, 'inv_tp_sent'));

    // A run inside the grace still does nothing.
    const early = await sweep(stack);
    expect(early.report.neverDispatchedFailed).toBe(0);
    expect((await statuses(stack, ['inv_tp_stale'])).inv_tp_stale.status).toBe('pending');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + NEVER_DISPATCHED_SWEEP_GRACE_MS + 1_000);
    const later = await sweep(stack);
    expect(later.report.neverDispatchedFailed).toBe(1);
    expect(await statuses(stack, ['inv_tp_stale', 'inv_tp_sent'])).toEqual({
      inv_tp_stale: { status: 'failed', error: 'never_dispatched_expired' },
      inv_tp_sent: { status: 'pending', error: null },
    });
  });

  it('fails expired rows that hold a capacity hold without a placement token and returns the slot', async () => {
    const ws = await createWorkspace(stack.app, 'sweep-held');
    const db = stack.runtime.handle.db;
    for (const id of ['nd_held_a', 'nd_held_b']) {
      await db.insert(nodes).values({
        id, workspaceId: ws.workspaceId, name: id, tokenHash: `${id}-hash`,
        status: 'offline', role: 'broker', maxAgents: 2, reservedAgents: 1,
      });
    }
    // Restored unsent claim: hold on the dispatched node, attempts back to 0.
    await insertPending(stack, ws.workspaceId, {
      id: 'inv_held_dispatched',
      createdAt: new Date(Date.now() - 2 * HOUR),
      spawnReservedAt: new Date(Date.now() - 2 * HOUR),
      dispatchedNodeId: 'nd_held_a',
      handlerNodeId: 'nd_held_a',
    });
    // Hold with only a placement snapshot node and no token.
    await insertPending(stack, ws.workspaceId, {
      id: 'inv_held_snapshot',
      createdAt: new Date(Date.now() - 2 * HOUR),
      spawnReservedAt: new Date(Date.now() - 2 * HOUR),
      handlerNodeId: 'nd_held_b',
    });

    const { report } = await sweep(stack, { neverDispatchedSweepGraceMs: 0 });
    expect(report.neverDispatchedFailed).toBe(2);
    expect(report.neverDispatchedHeldReleased).toBe(2);
    const rows = await db
      .select({
        id: actionInvocations.id,
        status: actionInvocations.status,
        error: actionInvocations.error,
        spawnReservedAt: actionInvocations.spawnReservedAt,
      })
      .from(actionInvocations)
      .where(eq(actionInvocations.workspaceId, ws.workspaceId));
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'failed', error: 'never_dispatched_expired', spawnReservedAt: null });
    }
    const held = await db.select({ id: nodes.id, reservedAgents: nodes.reservedAgents }).from(nodes)
      .where(eq(nodes.workspaceId, ws.workspaceId));
    expect(held.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'nd_held_a', reservedAgents: 0 },
      { id: 'nd_held_b', reservedAgents: 0 },
    ]);
  });

  it('a phase that spends its share on live handlers does not starve expiry or retries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    const ws = await createWorkspace(stack.app, 'sweep-fair');
    const db = stack.runtime.handle.db;
    const handler = await registerAgent(stack.app, ws.workspaceKey, 'orchestrator');
    const register = await stack.app.request('/v1/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handler.token}` },
      body: JSON.stringify({ name: 'crm.lookup', description: 'Look up', handler_agent: 'orchestrator' }),
    });
    expect(register.status).toBe(201);
    const actionId = (await register.json() as { data: { id: string } }).data.id;
    await attachDirectNodeSocket(stack, ws.workspaceId, handler);

    // Open invocations on a live handler: attempted and not due, so only the
    // unreachable-handler phase looks at them, and every check leaves them open.
    const live = Array.from({ length: 12 }, (_, i) => `inv_live_${String(i).padStart(2, '0')}`);
    for (const [i, id] of live.entries()) {
      await insertPending(stack, ws.workspaceId, {
        id, actionId, actionName: 'crm.lookup', dispatchAttempts: 1,
        createdAt: new Date(Date.now() - HOUR + i * 1_000),
      });
    }
    await insertPending(stack, ws.workspaceId, { id: 'inv_fair_expired', createdAt: new Date(Date.now() - 2 * HOUR) });
    await insertPending(stack, ws.workspaceId, {
      id: 'inv_fair_due', dispatchAttempts: 1,
      createdAt: new Date(Date.now() - 60_000), retryAfterAt: new Date(Date.now() - 1_000),
    });

    // Each reachability check costs 40% of a quarter share, so the first phase
    // runs out after three checks every run.
    const checkMs = INVOCATION_SWEEP_BUDGET_MS / 10;
    let checks = 0;
    const realtime = stack.runtime.realtime;
    const slow = new Proxy(realtime, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'isProviderConnected') {
          return (...args: Parameters<NodeConnectionRegistry['isProviderConnected']>) => {
            checks++;
            vi.setSystemTime(Date.now() + checkMs);
            return realtime.isProviderConnected(...args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const opts = { neverDispatchedSweepGraceMs: 0, timeoutMs: 24 * HOUR };

    const first = await sweep(stack, opts, slow);
    expect(first.report.budgetExhausted).toBe(true);
    expect(first.report.unreachableFailed).toBe(0);
    // Later phases still got their turn in the same run.
    expect(first.report.neverDispatchedFailed).toBe(1);
    expect((await statuses(stack, ['inv_fair_expired'])).inv_fair_expired)
      .toEqual({ status: 'failed', error: 'never_dispatched_expired' });
    const [due] = await db.select({ retryAfterAt: actionInvocations.retryAfterAt })
      .from(actionInvocations).where(eq(actionInvocations.id, 'inv_fair_due'));
    // The due-pending lane checked it: no longer due at the old retry time.
    expect(due.retryAfterAt === null || due.retryAfterAt.getTime() > Date.now() - 1_000).toBe(true);
    expect(await sweepCursorId(stack, 'pending')).toBeNull();
    // The unreachable phase recorded scan progress past the rows it left open.
    expect(checks).toBe(3);
    expect(await sweepCursorId(stack, 'unreachable')).toBe(live[2]);

    vi.setSystemTime(Date.now() + 60_000);
    await sweep(stack, opts, slow);
    expect(await sweepCursorId(stack, 'unreachable')).toBe(live[5]);
    vi.setSystemTime(Date.now() + 60_000);
    await sweep(stack, opts, slow);
    expect(await sweepCursorId(stack, 'unreachable')).toBe(live[8]);
    // The short final page (three rows) is checked to its end, so it wraps.
    vi.setSystemTime(Date.now() + 60_000);
    await sweep(stack, opts, slow);
    expect(await sweepCursorId(stack, 'unreachable')).toBeNull();
    vi.setSystemTime(Date.now() + 60_000);
    await sweep(stack, opts, slow);
    expect(await sweepCursorId(stack, 'unreachable')).toBe(live[2]);
    const open = await statuses(stack, live);
    expect(Object.values(open).every((row) => row.status === 'pending')).toBe(true);
  });

  it('stops never-dispatched work between sub-batches and emits effects for every row it failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    const ws = await createWorkspace(stack.app, 'sweep-sub-batch');
    const ids = Array.from({ length: 12 }, (_, i) => `inv_sb_${String(i).padStart(2, '0')}`);
    for (const [i, id] of ids.entries()) {
      await insertPending(stack, ws.workspaceId, { id, createdAt: new Date(Date.now() - 2 * HOUR + i * 1_000) });
    }
    // A slow effect: each failed row's webhook send takes a tenth of the budget,
    // so one sub-batch of effects outlasts the never-dispatched phase's share.
    const effectMs = INVOCATION_SWEEP_BUDGET_MS / 10;
    let notified: string[] = [];
    const completionDeps = {
      ...stack.runtime.deps,
      webhookQueue: {
        async send(message: { data: Record<string, unknown> }) {
          notified.push(String(message.data.invocation_id));
          vi.setSystemTime(Date.now() + effectMs);
        },
      },
    };
    const failedIds = async () => {
      const after = await statuses(stack, ids);
      return ids.filter((id) => after[id].status === 'failed');
    };

    const seen: string[] = [];
    const expected = [
      ids.slice(0, NEVER_DISPATCHED_SWEEP_SUB_BATCH),
      ids.slice(NEVER_DISPATCHED_SWEEP_SUB_BATCH, 2 * NEVER_DISPATCHED_SWEEP_SUB_BATCH),
      ids.slice(2 * NEVER_DISPATCHED_SWEEP_SUB_BATCH),
    ];
    for (const [run, batch] of expected.entries()) {
      notified = [];
      const { report } = await sweep(stack, { neverDispatchedSweepGraceMs: 0, completionDeps });
      expect(report.neverDispatchedFailed).toBe(batch.length);
      expect(report.budgetExhausted).toBe(run < 2);
      // Every row failed this run was notified, in this run; nothing else was.
      expect([...notified].sort()).toEqual(batch);
      seen.push(...batch);
      expect(await failedIds()).toEqual(seen);
      vi.setSystemTime(Date.now() + 60_000);
    }
  });
});
