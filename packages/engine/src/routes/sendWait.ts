import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import * as deliveryEngine from '../engine/delivery.js';
import { sentDeliveryReceipt } from '../engine/deliveryWire.js';
import { MAX_SEND_WAIT_MS } from '../ports/deliveryWaiters.js';
import { jsonError } from '../lib/httpResponse.js';

/**
 * `wait_ms` on a send: how long the response may park for the created
 * delivery rows to be confirmed by the receiving software (`accepted_at`) or
 * to settle (consumed, replied, failed). `0` (the default) answers at once.
 * A blank query value is rejected rather than coerced to 0.
 */
export const sendWaitMsSchema = z.number().int().min(0).max(MAX_SEND_WAIT_MS);

type LiveDeliveryState = NonNullable<ReturnType<Awaited<ReturnType<typeof deliveryEngine.readDeliveryStates>>['get']>>;

/** The row's current state overlaid on the receipt the send created. */
function liveFields(live: LiveDeliveryState) {
  return {
    status: live.status,
    acceptedAt: live.acceptedAt,
    repliedAt: live.repliedAt,
    replyMessageId: live.replyMessageId,
    error: live.error,
    expiresAt: live.expiresAt,
  };
}

const sendWaitQuerySchema = z.object({
  wait_ms: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? Number.NaN : value),
    z.coerce.number().int().min(0).max(MAX_SEND_WAIT_MS),
  ).optional(),
});

/** The effective `wait_ms` for a send: the body's, else the query's, else 0. */
export function resolveSendWaitMs(
  c: Context<AppEnv>,
  bodyWaitMs: number | undefined,
): { ok: true; waitMs: number } | { ok: false; response: Response } {
  const query = sendWaitQuerySchema.safeParse({ wait_ms: c.req.query('wait_ms') });
  if (!query.success) {
    return { ok: false, response: jsonError(c, 'invalid_request', `wait_ms must be an integer between 0 and ${MAX_SEND_WAIT_MS}`, 400) };
  }
  return { ok: true, waitMs: bodyWaitMs ?? query.data.wait_ms ?? 0 };
}

/**
 * Park up to `waitMs` for every row in `records` to be accepted or settled
 * (consumed, replied, failed) — a host-side socket write is not enough —
 * then return the rows' current sender-facing receipts. Nothing is held while
 * parked: each wake re-reads the rows and parks again on the ones still
 * short. Hosts without a `DeliveryWaiters` provider answer at once with the
 * receipts as created. `records` is the (already capped) list the response
 * names, so a wide channel fanout never parks on more rows than it reports.
 */
export async function awaitSentDeliveries(
  c: Context<AppEnv>,
  workspaceId: string,
  records: readonly Parameters<typeof sentDeliveryReceipt>[0][],
  waitMs: number,
): Promise<ReturnType<typeof sentDeliveryReceipt>[]> {
  const waiters = c.get('engine').deliveryWaiters;
  const asCreated = records.map(sentDeliveryReceipt);
  if (waitMs <= 0 || records.length === 0 || !waiters?.waitForDeliveryState) return asCreated;

  const ids = records.map((record) => record.id);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const since = Date.now();
    const states = await deliveryEngine.readDeliveryStates(c.get('engine').db, workspaceId, ids);
    const pending = ids.filter((id) => {
      const row = states.get(id);
      return row !== undefined && !deliveryEngine.deliveryStateSettled(row);
    });
    const remaining = deadline - Date.now();
    if (pending.length === 0 || remaining <= 0) {
      return records.map((record) => {
        const live = states.get(record.id);
        return live ? sentDeliveryReceipt({ ...record, ...liveFields(live) }) : sentDeliveryReceipt(record);
      });
    }
    const outcome = await waiters.waitForDeliveryState({
      workspaceId,
      deliveryIds: pending,
      since,
      timeoutMs: remaining,
      signal: c.req.raw.signal,
    });
    if (outcome === 'timeout') {
      // One last read: a transition can land between the timer and here.
      const final = await deliveryEngine.readDeliveryStates(c.get('engine').db, workspaceId, ids);
      return records.map((record) => {
        const live = final.get(record.id);
        return live ? sentDeliveryReceipt({ ...record, ...liveFields(live) }) : sentDeliveryReceipt(record);
      });
    }
  }
}
