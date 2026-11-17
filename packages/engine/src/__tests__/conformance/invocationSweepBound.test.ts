import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';
import {
  NEVER_DISPATCHED_SWEEP_GRACE_MS,
  sweepTimedOutInvocations,
  type SweepTimedOutInvocationsReport,
} from '../../engine/action.js';
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
  },
): Promise<void> {
  await stack.runtime.handle.db.insert(actionInvocations).values({
    id: opts.id,
    workspaceId,
    actionId: null,
    actionName: 'spawn',
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

async function sweep(stack: TestStack, opts: Parameters<typeof sweepTimedOutInvocations>[2] & object = {}) {
  let report: SweepTimedOutInvocationsReport | undefined;
  const started = performance.now();
  const rescheduled = await sweepTimedOutInvocations(stack.runtime.handle.db, stack.runtime.realtime, {
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
});
