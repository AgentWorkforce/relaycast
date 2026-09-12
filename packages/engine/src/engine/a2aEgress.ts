import { and, eq, or, sql, lte, inArray, asc } from 'drizzle-orm';
import { a2aAgents, a2aEgress, messages, agents } from '../db/schema.js';
import { runAtomicWrites, type EngineDb } from '../ports/database.js';
import { randomUuid } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { sendToExternalAgent } from './a2a.js';

/** Same finite retry horizon as HTTP idempotency; payloads never dispatch after it. */
export const A2A_EGRESS_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const batchLimit = (limit: number) => Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
const expired = (intent: typeof a2aEgress.$inferSelect) => intent.createdAt.getTime() + A2A_EGRESS_RETRY_WINDOW_MS <= Date.now();
const notRetained = () => codedError('Accepted A2A message is no longer retained', 'a2a_message_not_retained', 410);
const targetGone = () => codedError('Accepted A2A target no longer registered at its original endpoint', 'a2a_target_gone', 410);
const windowExpired = () => codedError('Accepted A2A retry window expired', 'a2a_egress_expired', 410);

async function validateSource(db: EngineDb, intent: typeof a2aEgress.$inferSelect) {
  if (expired(intent)) throw windowExpired();
  const [source] = await db.select({ id: messages.id }).from(messages).where(and(
    eq(messages.id, intent.messageId), eq(messages.workspaceId, intent.workspaceId),
  ));
  if (!source) throw notRetained();
}

/** Durable admission and a lease exclude concurrent senders. A crash after remote
 * acceptance can replay the same message_id; receivers must deduplicate it.
 */
export async function dispatchA2aEgress(db: EngineDb, id: string): Promise<void> {
  const [existing] = await db.select().from(a2aEgress).where(eq(a2aEgress.id, id));
  if (!existing) throw windowExpired();
  if (existing.status === 'failed') throw codedError(existing.lastError ?? 'A2A upstream rejected the accepted message', existing.errorCode ?? 'a2a_upstream_rejected', existing.errorStatus ?? 502);
  if (existing.status === 'sent') {
    await validateSource(db, existing);
    return;
  }
  const token = randomUuid();
  const [intent] = await db.update(a2aEgress).set({
    status: 'sending', claimToken: token, leaseUntil: new Date(Date.now() + 120_000),
    attempts: sql`${a2aEgress.attempts} + 1`,
  }).where(and(eq(a2aEgress.id, id), or(
    and(eq(a2aEgress.status, 'pending'), or(
      sql`${a2aEgress.leaseUntil} IS NULL`, lte(a2aEgress.leaseUntil, new Date()),
      lte(a2aEgress.createdAt, new Date(Date.now() - A2A_EGRESS_RETRY_WINDOW_MS)),
      sql`NOT EXISTS (SELECT 1 FROM messages WHERE id = ${a2aEgress.messageId} AND workspace_id = ${a2aEgress.workspaceId})`,
      sql`NOT EXISTS (SELECT 1 FROM a2a_agents t JOIN agents a ON a.id = t.relay_agent_id AND a.workspace_id = t.workspace_id
        WHERE t.id = ${a2aEgress.targetId} AND t.workspace_id = ${a2aEgress.workspaceId} AND t.external_url = ${a2aEgress.externalUrl})`,
    )),
    and(eq(a2aEgress.status, 'sending'), lte(a2aEgress.leaseUntil, new Date())),
  ))).returning();
  if (!intent) throw codedError('Accepted A2A message is being sent; retry the same key', 'a2a_egress_in_progress', 409);
  try {
    if (!intent.payload) throw notRetained();
    await sendToExternalAgent(intent.externalUrl, intent.payload, undefined, async () => {
      // Read one coherent tuple immediately before EACH fetch, including transport
      // retries. Credentials exist only in memory; never pair a rotated URL with
      // the captured endpoint. A live lease also excludes concurrent cleanup.
      const [current] = await db.select({ intent: a2aEgress, source: messages.id, target: a2aAgents, recipient: agents.id })
        .from(a2aEgress)
        .leftJoin(messages, and(eq(messages.id, a2aEgress.messageId), eq(messages.workspaceId, a2aEgress.workspaceId)))
        .leftJoin(a2aAgents, and(eq(a2aAgents.id, a2aEgress.targetId), eq(a2aAgents.workspaceId, a2aEgress.workspaceId)))
        .leftJoin(agents, and(eq(agents.id, a2aAgents.relayAgentId), eq(agents.workspaceId, a2aEgress.workspaceId)))
        .where(and(eq(a2aEgress.id, id), eq(a2aEgress.claimToken, token), eq(a2aEgress.status, 'sending')));
      if (!current || expired(current.intent)) throw windowExpired();
      if (!current.source) throw notRetained();
      if (!current.target || !current.recipient || current.target.externalUrl !== intent.externalUrl) throw targetGone();
      return { scheme: current.target.authScheme, credential: current.target.authCredential };
    });
  } catch (error) {
    const failure = error as Error & { retryable?: boolean; status?: number; code?: string };
    const retryable = failure.retryable === true || (failure.retryable !== false && !(failure.status && failure.status >= 400 && failure.status < 500));
    // Upstream error bodies may contain secrets; persist/report only engine text.
    const message = failure.code === 'a2a_message_not_retained' ? notRetained().message
      : failure.code === 'a2a_target_gone' ? targetGone().message
      : failure.code === 'a2a_egress_expired' ? windowExpired().message
      : 'A2A transport failed for the accepted message';
    await db.update(a2aEgress).set({
      status: retryable ? 'pending' : 'failed', claimToken: null,
      leaseUntil: retryable ? new Date(Date.now() + 30_000) : null,
      ...(retryable ? {} : { payload: null }),
      lastError: message, errorStatus: failure.status ?? 500, errorCode: failure.code ?? 'internal_error',
    }).where(and(eq(a2aEgress.id, id), eq(a2aEgress.claimToken, token)));
    throw codedError(message, failure.code ?? 'internal_error', failure.status ?? 500);
  }
  await runAtomicWrites(db, tx => [
    tx.update(a2aAgents).set({ messagesSent: sql`${a2aAgents.messagesSent} + 1` })
      .where(and(eq(a2aAgents.id, intent.targetId), sql`EXISTS (SELECT 1 FROM a2a_egress WHERE id = ${id} AND claim_token = ${token} AND status = 'sending')`)),
    tx.update(a2aEgress).set({ status: 'sent', payload: null, claimToken: null, leaseUntil: null, lastError: null, errorStatus: null, errorCode: null })
      .where(and(eq(a2aEgress.id, id), eq(a2aEgress.claimToken, token))),
  ], { requireAtomic: true });
}

/** Indexed, bounded deletion after the retry horizon. Active transport leases
 * are retained until settlement/lease expiry; cleanup never revokes their claim.
 * After deletion a key is fresh, as with the existing HTTP idempotency contract.
 */
export async function cleanupA2aEgress(db: EngineDb, limit = 20): Promise<number> {
  const eligible = and(
    lte(a2aEgress.createdAt, new Date(Date.now() - A2A_EGRESS_RETRY_WINDOW_MS)),
    or(sql`${a2aEgress.leaseUntil} IS NULL`, lte(a2aEgress.leaseUntil, new Date()), sql`${a2aEgress.status} != 'sending'`),
  );
  const candidates = db.select({ id: a2aEgress.id }).from(a2aEgress).where(eligible)
    .orderBy(asc(a2aEgress.createdAt), asc(a2aEgress.id)).limit(batchLimit(limit));
  const deleted = await db.delete(a2aEgress).where(inArray(a2aEgress.id, candidates)).returning({ id: a2aEgress.id });
  return deleted.length;
}

/** Existing Node/HOST maintenance entrypoint includes bounded retention cleanup. */
export async function sweepPendingA2aEgress(db: EngineDb, limit = 20): Promise<{ attempted: number; failed: number }> {
  const due = await db.select({ id: a2aEgress.id }).from(a2aEgress).where(and(
    or(eq(a2aEgress.status, 'pending'), eq(a2aEgress.status, 'sending')),
    or(sql`${a2aEgress.leaseUntil} IS NULL`, lte(a2aEgress.leaseUntil, new Date())),
  )).limit(batchLimit(limit));
  let failed = 0;
  for (const intent of due) {
    try { await dispatchA2aEgress(db, intent.id); } catch { failed++; }
  }
  await cleanupA2aEgress(db, limit);
  return { attempted: due.length, failed };
}
