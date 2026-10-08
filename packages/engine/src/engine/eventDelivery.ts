import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { eventSubscriptions, pendingEvents, webhookDeliveries } from '../db/schema.js';
import { hmacSha256Hex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import { signStandardWebhook } from '../lib/standardWebhook.js';
import { getActiveSubscriptions } from './eventSubscription.js';

type Db = ReturnType<typeof getDb>;
type Fetch = typeof globalThis.fetch;

const DELIVERY_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 7;
const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Delays after failed attempts 1-6; attempt 7 moves to dead-letter. */
export const WEBHOOK_RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
] as const;

export function signPayload(payload: string, secret: string): Promise<string> {
  return hmacSha256Hex(payload, secret);
}

interface DeliveryTarget {
  id: string;
  url: string;
  secret: string | null;
  signatureScheme: 'legacy' | 'standard-webhooks';
  headers: Record<string, string> | null;
  filter: { channel?: string; mentions?: string } | null;
}

interface AttemptDeliveryResult {
  ok: boolean;
  retryable: boolean;
  status: number | null;
  error: string | null;
}

export interface DeliverEventOptions {
  /** Durable `pending_events.id`; required for per-subscriber retry persistence. */
  eventId?: string;
  /** Stable event creation timestamp. Retries only refresh the signing timestamp. */
  eventTimestamp?: Date | string;
  /** Platform-specific fetch. Node supplies a DNS-pinning implementation in production. */
  fetch?: Fetch;
  /** Deterministic clock seam for tests. */
  now?: Date;
}

export interface EventDeliverySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  retryableFailures: number;
  deadLettered: number;
  nextRetryAt: string | null;
}

function emptySummary(): EventDeliverySummary {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    retryableFailures: 0,
    deadLettered: 0,
    nextRetryAt: null,
  };
}

function publicDeliveryHeaders(headers: Record<string, string> | null): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      return lower !== 'content-type'
        && !lower.startsWith('x-relay-')
        && !lower.startsWith('webhook-');
    }),
  );
}

function matchesFilter(
  filter: { channel?: string; mentions?: string } | null,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;

  if (filter.channel) {
    const channelName = (payload.channel_name as string) || (payload.channel as string) || '';
    if (!channelName || channelName !== filter.channel) return false;
  }

  if (filter.mentions) {
    const text = (payload.text as string) || '';
    const mentionPattern = new RegExp(`@${filter.mentions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`);
    if (!mentionPattern.test(text)) return false;
  }

  return true;
}

async function stableDeliveryId(eventId: string, subscriptionId: string): Promise<string> {
  const digest = await sha256Hex(`${eventId}\0${subscriptionId}`);
  return `whd_${digest.slice(0, 32)}`;
}

async function buildDeliveryHeaders(
  target: DeliveryTarget,
  eventType: string,
  deliveryId: string,
  body: string,
  now: Date,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    ...publicDeliveryHeaders(target.headers),
    'Content-Type': 'application/json',
    'X-Relay-Event': eventType,
    'X-Relay-Timestamp': now.toISOString(),
    'webhook-id': deliveryId,
  };

  if (!target.secret) return headers;

  if (target.signatureScheme === 'standard-webhooks') {
    const timestampSeconds = String(Math.floor(now.getTime() / 1000));
    headers['webhook-timestamp'] = timestampSeconds;
    headers['webhook-signature'] = await signStandardWebhook(
      target.secret,
      deliveryId,
      timestampSeconds,
      body,
    );
  } else {
    headers['X-Relay-Signature'] = `sha256=${await signPayload(body, target.secret)}`;
  }
  return headers;
}

async function attemptDelivery(
  fetchImpl: Fetch,
  target: DeliveryTarget,
  eventType: string,
  deliveryId: string,
  body: string,
  now: Date,
): Promise<AttemptDeliveryResult> {
  if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BYTES) {
    return { ok: false, retryable: false, status: 413, error: 'payload exceeds 256 KiB' };
  }
  if (!isSafeExternalUrl(target.url, { strict: true, requireHttps: true })) {
    return { ok: false, retryable: false, status: null, error: 'unsafe webhook URL' };
  }

  let headers: Record<string, string>;
  try {
    headers = await buildDeliveryHeaders(target, eventType, deliveryId, body, now);
    new Headers(headers);
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { ok: true, retryable: false, status: response.status, error: null };
    if (response.status === 410 || response.status === 413) {
      return { ok: false, retryable: false, status: response.status, error: `HTTP ${response.status}` };
    }
    if (
      response.status >= 400
      && response.status < 500
      && response.status !== 408
      && response.status !== 429
    ) {
      return { ok: false, retryable: false, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: false, retryable: true, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function activeTargets(
  db: Db,
  workspaceId: string,
  eventType: string,
): Promise<DeliveryTarget[]> {
  const rows = await getActiveSubscriptions(db, workspaceId, eventType);
  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    secret: row.secret,
    signatureScheme: row.signatureScheme,
    headers: (row.headers as Record<string, string> | null) ?? null,
    filter: row.filter as { channel?: string; mentions?: string } | null,
  }));
}

async function initializePersistentDeliveries(
  db: Db,
  eventId: string,
  targets: DeliveryTarget[],
): Promise<boolean> {
  const [parent] = await db
    .select({ initialized: pendingEvents.webhookInitialized })
    .from(pendingEvents)
    .where(eq(pendingEvents.id, eventId));
  if (!parent) return false;
  if (parent.initialized) return true;

  if (targets.length > 0) {
    const values = await Promise.all(targets.map(async (target) => ({
      id: await stableDeliveryId(eventId, target.id),
      eventId,
      subscriptionId: target.id,
    })));
    await db.insert(webhookDeliveries).values(values).onConflictDoNothing();
  }
  await db
    .update(pendingEvents)
    .set({ webhookInitialized: true })
    .where(eq(pendingEvents.id, eventId));
  return true;
}

async function claimDelivery(db: Db, id: string, now: Date) {
  const [claimed] = await db
    .update(webhookDeliveries)
    .set({
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      nextAttemptAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
      lastError: null,
    })
    .where(and(
      eq(webhookDeliveries.id, id),
      eq(webhookDeliveries.status, 'pending'),
      lte(webhookDeliveries.nextAttemptAt, now),
    ))
    .returning();
  return claimed ?? null;
}

async function settleDelivery(
  db: Db,
  delivery: typeof webhookDeliveries.$inferSelect,
  result: AttemptDeliveryResult,
  now: Date,
): Promise<void> {
  if (result.ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'succeeded',
        lastStatus: result.status,
        lastError: null,
        completedAt: now,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'pending')));
    return;
  }

  if (!result.retryable) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'failed',
        lastStatus: result.status,
        lastError: result.error,
        completedAt: now,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'pending')));
    return;
  }

  if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'dead_letter',
        lastStatus: result.status,
        lastError: result.error,
        completedAt: now,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'pending')));
    return;
  }

  const retryDelay = WEBHOOK_RETRY_DELAYS_MS[delivery.attempts - 1];
  await db
    .update(webhookDeliveries)
    .set({
      nextAttemptAt: new Date(now.getTime() + retryDelay),
      lastStatus: result.status,
      lastError: result.error,
    })
    .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.status, 'pending')));
}

async function deliverWithoutPersistence(
  db: Db,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  eventBody: string,
  now: Date,
  fetchImpl: Fetch,
): Promise<EventDeliverySummary> {
  const targets = (await activeTargets(db, workspaceId, eventType))
    .filter((target) => matchesFilter(target.filter, payload));
  if (targets.length === 0) return emptySummary();

  const results = await Promise.all(targets.map(async (target) => {
    const id = `whd_${globalThis.crypto.randomUUID()}`;
    return attemptDelivery(fetchImpl, target, eventType, id, eventBody, now);
  }));
  const retryableFailures = results.filter((result) => !result.ok && result.retryable).length;
  if (retryableFailures > 0) {
    throw codedError(
      `Retryable webhook delivery failures: ${retryableFailures} of ${results.length}`,
      'event_delivery_retryable_failure',
      503,
    );
  }
  const succeeded = results.filter((result) => result.ok).length;
  return {
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    retryableFailures: 0,
    deadLettered: 0,
    nextRetryAt: null,
  };
}

export async function deliverEvent(
  db: Db,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  options: DeliverEventOptions = {},
): Promise<EventDeliverySummary> {
  const now = options.now ?? new Date();
  let timestampSource = options.eventTimestamp;
  if (!timestampSource && options.eventId) {
    const [parent] = await db
      .select({ createdAt: pendingEvents.createdAt })
      .from(pendingEvents)
      .where(eq(pendingEvents.id, options.eventId));
    timestampSource = parent?.createdAt;
  }
  const eventTimestamp = new Date(timestampSource ?? now).toISOString();
  const body = JSON.stringify({
    type: eventType,
    workspace_id: workspaceId,
    timestamp: eventTimestamp,
    data: payload,
  });
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!options.eventId) {
    return deliverWithoutPersistence(db, workspaceId, eventType, payload, body, now, fetchImpl);
  }

  const targets = (await activeTargets(db, workspaceId, eventType))
    .filter((target) => matchesFilter(target.filter, payload));
  if (!await initializePersistentDeliveries(db, options.eventId, targets)) {
    return deliverWithoutPersistence(db, workspaceId, eventType, payload, body, now, fetchImpl);
  }

  const targetById = new Map(targets.map((target) => [target.id, target]));
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventId, options.eventId));
  if (rows.length === 0) return emptySummary();

  await Promise.all(rows.map(async (row) => {
    if (row.status !== 'pending' || row.nextAttemptAt.getTime() > now.getTime()) return;
    const target = targetById.get(row.subscriptionId);
    if (!target) return;
    const claimed = await claimDelivery(db, row.id, now);
    if (!claimed) return;
    const result = await attemptDelivery(fetchImpl, target, eventType, claimed.id, body, now);
    await settleDelivery(db, claimed, result, now);
  }));

  const settled = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventId, options.eventId));
  const pending = settled.filter((row) => row.status === 'pending');
  const deadLettered = settled.filter((row) => row.status === 'dead_letter').length;
  const failed = settled.filter((row) => row.status === 'failed' || row.status === 'dead_letter').length;
  const succeeded = settled.filter((row) => row.status === 'succeeded').length;

  if (pending.length > 0) {
    const nextRetryAt = pending.reduce(
      (earliest, row) => row.nextAttemptAt < earliest ? row.nextAttemptAt : earliest,
      pending[0].nextAttemptAt,
    );
    const retryAfterMs = Math.max(0, nextRetryAt.getTime() - now.getTime());
    const error = codedError(
      `Retryable webhook delivery failures: ${pending.length} of ${settled.length}`,
      'event_delivery_retryable_failure',
      503,
    );
    error.diagnostics = { retry_after_ms: retryAfterMs };
    throw error;
  }

  return {
    attempted: settled.length,
    succeeded,
    failed,
    retryableFailures: 0,
    deadLettered,
    nextRetryAt: null,
  };
}

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'dead_letter';

export async function listWebhookDeliveries(
  db: Db,
  workspaceId: string,
  subscriptionId: string,
  options: { status?: WebhookDeliveryStatus; limit?: number } = {},
) {
  const conditions = [
    eq(eventSubscriptions.workspaceId, workspaceId),
    eq(webhookDeliveries.subscriptionId, subscriptionId),
  ];
  if (options.status) conditions.push(eq(webhookDeliveries.status, options.status));
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      eventId: webhookDeliveries.eventId,
      eventType: pendingEvents.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      lastError: webhookDeliveries.lastError,
      lastStatus: webhookDeliveries.lastStatus,
      createdAt: webhookDeliveries.createdAt,
      completedAt: webhookDeliveries.completedAt,
    })
    .from(webhookDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, webhookDeliveries.subscriptionId))
    .innerJoin(pendingEvents, eq(pendingEvents.id, webhookDeliveries.eventId))
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 100));

  return rows.map((row) => ({
    id: row.id,
    event_id: row.eventId,
    event_type: row.eventType,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.status === 'pending' ? row.nextAttemptAt.toISOString() : null,
    last_error: row.lastError,
    last_status: row.lastStatus,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  }));
}

export type ReplayWebhookDeliveryResult =
  | { kind: 'not_found' }
  | { kind: 'not_replayable'; status: WebhookDeliveryStatus }
  | {
    kind: 'replayed';
    event: { outboxId: string; workspaceId: string; type: string; data: Record<string, unknown> };
  };

export async function replayWebhookDelivery(
  db: Db,
  workspaceId: string,
  subscriptionId: string,
  deliveryId: string,
): Promise<ReplayWebhookDeliveryResult> {
  const [row] = await db
    .select({
      id: webhookDeliveries.id,
      status: webhookDeliveries.status,
      eventId: pendingEvents.id,
      eventType: pendingEvents.eventType,
      payload: pendingEvents.payload,
    })
    .from(webhookDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, webhookDeliveries.subscriptionId))
    .innerJoin(pendingEvents, eq(pendingEvents.id, webhookDeliveries.eventId))
    .where(and(
      eq(eventSubscriptions.workspaceId, workspaceId),
      eq(webhookDeliveries.subscriptionId, subscriptionId),
      eq(webhookDeliveries.id, deliveryId),
    ));
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'failed' && row.status !== 'dead_letter') {
    return { kind: 'not_replayable', status: row.status };
  }

  const now = new Date();
  const [replayed] = await db
    .update(webhookDeliveries)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      lastStatus: null,
      completedAt: null,
    })
    .where(and(
      eq(webhookDeliveries.id, row.id),
      inArray(webhookDeliveries.status, ['failed', 'dead_letter']),
    ))
    .returning({ id: webhookDeliveries.id });
  if (!replayed) {
    const [current] = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, row.id));
    return current
      ? { kind: 'not_replayable', status: current.status }
      : { kind: 'not_found' };
  }
  await db
    .update(pendingEvents)
    .set({
      status: 'pending',
      attempts: 0,
      maxAttempts: 32,
      processAfter: now,
      lastError: null,
      completedAt: null,
    })
    .where(eq(pendingEvents.id, row.eventId));

  return {
    kind: 'replayed',
    event: {
      outboxId: row.eventId,
      workspaceId,
      type: row.eventType,
      data: row.payload as Record<string, unknown>,
    },
  };
}
