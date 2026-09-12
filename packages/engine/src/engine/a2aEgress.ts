import { and, eq, or, sql, lte } from 'drizzle-orm';
import { a2aAgents, a2aEgress } from '../db/schema.js';
import { runAtomicWrites, type EngineDb } from '../ports/database.js';
import { randomUuid } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { sendToExternalAgent } from './a2a.js';

/** Transport is allowed only after durable admission. A lease excludes concurrent retries.
 * Remote acceptance followed by a crash can replay the SAME A2A message_id; peers
 * must deduplicate it. This is at-least-once egress, not distributed exactly-once.
 */
export async function dispatchA2aEgress(db: EngineDb, id: string): Promise<void> {
  const [existing] = await db.select().from(a2aEgress).where(eq(a2aEgress.id, id));
  if (!existing) throw new Error('A2A egress intent not found');
  if (existing.status === 'sent') return;
  if (existing.status === 'failed') throw codedError(existing.lastError ?? 'A2A upstream rejected the accepted message', existing.errorCode ?? 'a2a_upstream_rejected', existing.errorStatus ?? 502);
  const token = randomUuid();
  const [intent] = await db.update(a2aEgress).set({
    status: 'sending', claimToken: token, leaseUntil: new Date(Date.now() + 120_000),
    attempts: sql`${a2aEgress.attempts} + 1`,
  }).where(and(eq(a2aEgress.id, id), or(
    and(eq(a2aEgress.status, 'pending'), or(sql`${a2aEgress.leaseUntil} IS NULL`, lte(a2aEgress.leaseUntil, new Date()))),
    and(eq(a2aEgress.status, 'sending'), lte(a2aEgress.leaseUntil, new Date())),
  ))).returning();
  if (!intent) throw codedError('Accepted A2A message is being sent; retry the same key', 'a2a_egress_in_progress', 409);
  try {
    const [target] = await db.select().from(a2aAgents).where(and(
      eq(a2aAgents.id, intent.targetId), eq(a2aAgents.workspaceId, intent.workspaceId),
    ));
    if (!target) throw codedError('A2A target no longer registered', 'a2a_agent_not_found', 404);
    await sendToExternalAgent(intent.externalUrl, intent.payload, {
      scheme: target.authScheme, credential: target.authCredential,
    });
  } catch (error) {
    const failure = error as Error & { retryable?: boolean; status?: number; code?: string };
    // Network/timeouts are uncertain and must retain the original payload/id.
    const retryable = failure.retryable === true || (failure.retryable !== false && !(failure.status && failure.status >= 400 && failure.status < 500));
    await db.update(a2aEgress).set({
      status: retryable ? 'pending' : 'failed', claimToken: null,
      leaseUntil: retryable ? new Date(Date.now() + 30_000) : null,
      lastError: failure.message, errorStatus: failure.status ?? 502, errorCode: failure.code ?? null,
    }).where(and(eq(a2aEgress.id, id), eq(a2aEgress.claimToken, token)));
    throw error;
  }
  // Counter and terminal state commit together. If this fails, leave the lease
  // recoverable and reuse the same remote identity on the next attempt.
  await runAtomicWrites(db, tx => [
    tx.update(a2aAgents).set({ messagesSent: sql`${a2aAgents.messagesSent} + 1` })
      .where(and(eq(a2aAgents.id, intent.targetId), sql`EXISTS (SELECT 1 FROM a2a_egress WHERE id = ${id} AND claim_token = ${token} AND status = 'sending')`)),
    tx.update(a2aEgress).set({ status: 'sent', claimToken: null, leaseUntil: null, lastError: null, errorStatus: null, errorCode: null })
      .where(and(eq(a2aEgress.id, id), eq(a2aEgress.claimToken, token))),
  ], { requireAtomic: true });
}

/** Hosts schedule this recovery helper; no KV record is needed to recover an accepted intent. */
export async function sweepPendingA2aEgress(db: EngineDb, limit = 20): Promise<{ attempted: number; failed: number }> {
  const due = await db.select({ id: a2aEgress.id }).from(a2aEgress).where(and(
    or(eq(a2aEgress.status, 'pending'), eq(a2aEgress.status, 'sending')),
    or(sql`${a2aEgress.leaseUntil} IS NULL`, lte(a2aEgress.leaseUntil, new Date())),
  )).limit(Math.max(1, Math.min(100, Math.floor(limit))));
  let failed = 0;
  for (const intent of due) {
    try { await dispatchA2aEgress(db, intent.id); } catch { failed++; }
  }
  return { attempted: due.length, failed };
}
