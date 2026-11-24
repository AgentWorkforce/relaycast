import { and, desc, eq, exists, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { eventSubscriptions, pendingEvents, webhookDeliveries } from '../db/tables.js';
import { hmacSha256Hex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import { signStandardWebhook } from '../lib/standardWebhook.js';
import { runAtomicWrites } from '../ports/database.js';
import {
  getActiveSubscriptions,
  subscribesToEventType,
  type SubscriptionFilter,
  type SubscriptionMatcher,
} from './eventSubscription.js';
import { isInboundWebhookMessage } from './messageMetadata.js';

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
  filter: SubscriptionFilter | null;
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
  /**
   * Platform-specific SSRF-safe fetch. Required whenever a matching target is
   * delivered; omission fails closed instead of falling back to global fetch.
   */
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
        && !lower.startsWith('webhook-')
        && lower !== 'x-forward-to'
        && lower !== 'x-proxy-auth';
    }),
  );
}

function requireSafeFetch(fetchImpl: Fetch | undefined): Fetch {
  if (fetchImpl) return fetchImpl;
  throw codedError(
    'Outbound webhook delivery requires a platform SSRF-safe fetch implementation',
    'event_delivery_fetch_required',
    503,
  );
}

/** One `data.recipients` entry on a webhook payload: a delivery record of the event. */
export interface WebhookRecipient {
  agent_id: string;
  agent_name: string;
  delivery_id?: string;
  seq?: number;
}

/** Most `data.recipients` entries a single webhook body carries. */
export const MAX_WEBHOOK_RECIPIENTS = 500;
/**
 * Most entries stored on the outbox row: the first {@link MAX_WEBHOOK_RECIPIENTS}
 * plus later ones some `filter.recipients` matches, so that filter is evaluated
 * against more than the delivered cap. Bounds the `pending_events` row size:
 * 2,000 entries with snowflake ids, `del_` ids and 7-digit seqs measure about
 * 275 KB of JSON with 32-character agent names (about 340 KB with 64), on top
 * of the event body. Settled rows are pruned 24 h after completion
 * (`cleanupOldEvents`).
 */
export const MAX_STORED_WEBHOOK_RECIPIENTS = 2_000;

function recipientMatches(names: readonly string[], recipient: unknown): boolean {
  if (!recipient || typeof recipient !== 'object') return false;
  const { agent_id: agentId, agent_name: agentName } = recipient as Partial<WebhookRecipient>;
  return names.some((name) => name === agentName || name === agentId);
}

export function matchesFilter(
  filter: SubscriptionFilter | null,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;

  if (filter.channel) {
    const channelName = (payload.channel_name as string) || (payload.channel as string) || '';
    if (!channelName || channelName !== filter.channel) return false;
  }

  if (filter.mentions) {
    // A webhook-posted message mentions no one: its text is written by
    // whoever holds the webhook URL, who must not be able to address agents
    // outside the channel the webhook posts into.
    if (isInboundWebhookMessage(payload.metadata)) return false;
    const text = (payload.text as string) || '';
    const mentionPattern = new RegExp(`@${filter.mentions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`);
    if (!mentionPattern.test(text)) return false;
  }

  if (filter.recipients) {
    // An event without a recipient list (any non-message event) never matches.
    const names = filter.recipients;
    if (!Array.isArray(payload.recipients)) return false;
    if (!payload.recipients.some((recipient) => recipientMatches(names, recipient))) return false;
  }

  return true;
}

/**
 * Whether a subscription would deliver this event. Shared by the send-path
 * pre-filter and the queue consumer so both agree, `'*'` included.
 */
export function subscriptionWantsEvent(
  subscription: SubscriptionMatcher,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  return subscribesToEventType(subscription.events, eventType)
    && matchesFilter(subscription.filter, payload);
}

/**
 * The consumer-side filter. Like {@link matchesFilter}, except that once the
 * stored list was cut at {@link MAX_STORED_WEBHOOK_RECIPIENTS}, a
 * `filter.recipients` with no match in it may have matched a cut entry: the
 * subscription is delivered if its other checks pass, and
 * {@link payloadForTarget} gives it `recipients: []` with
 * `recipients_truncated: true`. The send-path pre-check stays strict, on the
 * full list.
 */
function deliveryMatchesFilter(filter: SubscriptionFilter | null, payload: Record<string, unknown>): boolean {
  if (matchesFilter(filter, payload)) return true;
  const stored = payload.recipients;
  const cut = Array.isArray(stored) && stored.length >= MAX_STORED_WEBHOOK_RECIPIENTS
    && payload.recipients_truncated === true;
  return cut && !!filter?.recipients && matchesFilter({ ...filter, recipients: undefined }, payload);
}

/**
 * Bound `recipients` for the outbox row: the first {@link MAX_WEBHOOK_RECIPIENTS},
 * then later entries matched by the `filter.recipients` of a subscription that
 * wants this event (type, channel and mentions included; `matchers === null`:
 * unknown, keep everything) up to {@link MAX_STORED_WEBHOOK_RECIPIENTS}.
 * `recipients_truncated` is set when the full list is longer than the cap.
 * Filtered subscriptions whose matches were all cut by that bound are still
 * delivered, with an empty truncated list (see {@link deliveryMatchesFilter}).
 */
export function withStoredRecipients(
  payload: Record<string, unknown>,
  recipients: WebhookRecipient[],
  matchers: SubscriptionMatcher[] | null,
  eventType: string,
): Record<string, unknown> {
  if (recipients.length <= MAX_WEBHOOK_RECIPIENTS) return { ...payload, recipients };
  // Only subscriptions that would deliver this event (judged on the full list)
  // may claim the slots past the first 500.
  const full = { ...payload, recipients };
  const filters = matchers
    ?.filter((m) => m.filter?.recipients && subscriptionWantsEvent(m, eventType, full))
    .map((m) => m.filter!.recipients!);
  const stored = recipients.slice(0, MAX_WEBHOOK_RECIPIENTS);
  for (const recipient of recipients.slice(MAX_WEBHOOK_RECIPIENTS)) {
    if (stored.length >= MAX_STORED_WEBHOOK_RECIPIENTS) break;
    if (!filters || filters.some((names) => recipientMatches(names, recipient))) stored.push(recipient);
  }
  return { ...payload, recipients: stored, recipients_truncated: true };
}

/**
 * The `data` one target receives: `recipients` narrowed to the target's
 * `filter.recipients` matches (after matching ran on the full stored list),
 * then capped at {@link MAX_WEBHOOK_RECIPIENTS}.
 */
function payloadForTarget(target: DeliveryTarget, payload: Record<string, unknown>): Record<string, unknown> {
  const stored = payload.recipients;
  if (!Array.isArray(stored)) return payload;
  const { recipients_truncated: storedTruncated, ...rest } = payload;
  const names = target.filter?.recipients;
  const matching = names ? stored.filter((recipient) => recipientMatches(names, recipient)) : stored;
  const truncated = matching.length > MAX_WEBHOOK_RECIPIENTS || (storedTruncated === true && (
    // Unfiltered: the stored list is already short of the full one. Filtered:
    // only when the stored bound may have dropped later matches.
    !names || stored.length >= MAX_STORED_WEBHOOK_RECIPIENTS
  ));
  return {
    ...rest,
    recipients: matching.slice(0, MAX_WEBHOOK_RECIPIENTS),
    ...(truncated ? { recipients_truncated: true } : {}),
  };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Serialize `envelope(data)` with `data.recipients` cut to the longest prefix
 * that keeps the body within {@link MAX_WEBHOOK_BYTES} (UTF-8, as
 * `attemptDelivery` measures it), marking a cut list `recipients_truncated`.
 * Linear: the body is the base (empty list, flag set) plus each entry's JSON
 * and a separating comma. A body whose base alone is too large is returned
 * whole and fails as before.
 */
function fitRecipientsBody(
  data: Record<string, unknown>,
  envelope: (data: Record<string, unknown>) => unknown,
): string {
  const whole = JSON.stringify(envelope(data));
  const entries = data.recipients;
  if (!Array.isArray(entries) || entries.length === 0 || utf8Bytes(whole) <= MAX_WEBHOOK_BYTES) return whole;
  let budget = MAX_WEBHOOK_BYTES - utf8Bytes(JSON.stringify(envelope({ ...data, recipients: [], recipients_truncated: true })));
  if (budget < 0) return whole;
  let count = 0;
  for (const entry of entries) {
    const size = utf8Bytes(JSON.stringify(entry)) + (count > 0 ? 1 : 0);
    if (size > budget) break;
    budget -= size;
    count += 1;
  }
  return JSON.stringify(envelope({ ...data, recipients: entries.slice(0, count), recipients_truncated: true }));
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
    // The status is known once the headers arrive. Release the body without
    // waiting for it: a subscriber that keeps its response open must not hold
    // the delivery (and the queue behind it).
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      // A locked or already-closed body: nothing to release.
    }
    if (response.ok) return { ok: true, retryable: false, status: response.status, error: null };
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, retryable: false, status: response.status, error: `HTTP ${response.status}` };
    }
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
    filter: row.filter as SubscriptionFilter | null,
  }));
}

/**
 * Snapshot matching subscribers once (the caller has read the parent row and
 * found it not yet initialized), making new rows due at the delivery pass's
 * clock. Returns the stable delivery id of each target, in target order.
 */
async function initializePersistentDeliveries(
  db: Db,
  eventId: string,
  targets: DeliveryTarget[],
  now: Date,
): Promise<string[]> {
  const ids = await Promise.all(targets.map((target) => stableDeliveryId(eventId, target.id)));
  const markInitialized = (handle: Db) => handle
    .update(pendingEvents)
    .set({ webhookInitialized: true })
    .where(eq(pendingEvents.id, eventId));
  if (targets.length === 0) {
    await markInitialized(db);
    return ids;
  }
  // One atomic unit (a single D1 batch round trip; one transaction on Node
  // and PostgreSQL), so no pass can see the flag set without the rows, nor
  // the rows without the flag. The parent is written first, as in
  // replayWebhookDelivery, so both writers lock the two tables in one order.
  await runAtomicWrites(db, (tx) => [
    markInitialized(tx),
    tx.insert(webhookDeliveries).values(targets.map((target, index) => ({
      id: ids[index],
      eventId,
      subscriptionId: target.id,
      // Use this pass's clock so an insert crossing a second boundary is
      // still due when compared with the time captured by deliverEvent.
      nextAttemptAt: now,
    }))).onConflictDoNothing(),
  ]);
  return ids;
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
      lt(webhookDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
    ))
    .returning();
  return claimed ?? null;
}

/**
 * A worker can crash after issuing the final HTTP request but before recording
 * its outcome. Once that final lease expires, dead-letter it instead of
 * claiming an eighth attempt.
 */
async function deadLetterExpiredFinalAttempts(db: Db, eventId: string, now: Date): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'dead_letter',
      lastError: 'attempts exhausted after delivery lease expired',
      completedAt: now,
    })
    .where(and(
      eq(webhookDeliveries.eventId, eventId),
      eq(webhookDeliveries.status, 'pending'),
      lte(webhookDeliveries.nextAttemptAt, now),
      gte(webhookDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
    ));
}

async function failUnavailableDelivery(db: Db, id: string, now: Date): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: 'failed',
      lastError: 'subscription inactive or no longer matches this event',
      completedAt: now,
    })
    .where(and(
      eq(webhookDeliveries.id, id),
      eq(webhookDeliveries.status, 'pending'),
      lte(webhookDeliveries.nextAttemptAt, now),
    ));
}

async function settleDelivery(
  db: Db,
  delivery: typeof webhookDeliveries.$inferSelect,
  result: AttemptDeliveryResult,
  now: Date,
): Promise<void> {
  // A D1 settlement can resume after another consumer reclaimed the lease.
  const ownsClaim = and(
    eq(webhookDeliveries.id, delivery.id),
    eq(webhookDeliveries.status, 'pending'),
    eq(webhookDeliveries.attempts, delivery.attempts),
    eq(webhookDeliveries.nextAttemptAt, delivery.nextAttemptAt),
  );
  if (result.ok) {
    await db
      .update(webhookDeliveries)
      .set({
        status: 'succeeded',
        lastStatus: result.status,
        lastError: null,
        completedAt: now,
      })
      .where(ownsClaim);
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
      .where(ownsClaim);
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
      .where(ownsClaim);
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
    .where(ownsClaim);
}

async function deliverWithoutPersistence(
  db: Db,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  bodyFor: (target: DeliveryTarget) => string,
  now: Date,
  fetchImpl: Fetch | undefined,
): Promise<EventDeliverySummary> {
  const targets = (await activeTargets(db, workspaceId, eventType))
    .filter((target) => deliveryMatchesFilter(target.filter, payload));
  if (targets.length === 0) return emptySummary();

  const safeFetch = requireSafeFetch(fetchImpl);

  const results = await Promise.all(targets.map(async (target) => {
    const id = `whd_${globalThis.crypto.randomUUID()}`;
    return attemptDelivery(safeFetch, target, eventType, id, bodyFor(target), now);
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

/**
 * Delivers one event to the workspace's active subscriptions for its type,
 * filtered with {@link deliveryMatchesFilter}; message events get a per-target
 * `data.recipients` ({@link payloadForTarget}) cut to the body size cap.
 */
export async function deliverEvent(
  db: Db,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
  options: DeliverEventOptions = {},
): Promise<EventDeliverySummary> {
  const now = options.now ?? new Date();
  const { eventId } = options;
  // The outbox row is read once, alongside the subscriptions: its creation
  // time stamps the body (unless the caller supplied one) and its
  // `webhookInitialized` flag picks the first-pass path below.
  let parent: { createdAt: Date; initialized: boolean } | undefined;
  let subscribed: DeliveryTarget[] = [];
  if (eventId) {
    [[parent], subscribed] = await Promise.all([
      db
        .select({ createdAt: pendingEvents.createdAt, initialized: pendingEvents.webhookInitialized })
        .from(pendingEvents)
        .where(eq(pendingEvents.id, eventId)),
      activeTargets(db, workspaceId, eventType),
    ]);
  }
  let timestampSource = options.eventTimestamp;
  if (!timestampSource && eventId) timestampSource = parent?.createdAt;
  const eventTimestamp = new Date(timestampSource ?? now).toISOString();
  const sharedBody = JSON.stringify({
    type: eventType,
    workspace_id: workspaceId,
    timestamp: eventTimestamp,
    data: payload,
  });
  // `recipients` differs per target, so those bodies (and signatures) do too,
  // and each list is cut to fit the body size cap.
  const bodyFor = (target: DeliveryTarget) => Array.isArray(payload.recipients)
    ? fitRecipientsBody(payloadForTarget(target, payload), (data) => ({
      type: eventType,
      workspace_id: workspaceId,
      timestamp: eventTimestamp,
      data,
    }))
    : sharedBody;
  const fetchImpl = options.fetch;

  if (!eventId) {
    return deliverWithoutPersistence(db, workspaceId, eventType, payload, bodyFor, now, fetchImpl);
  }
  if (!parent) {
    // `eventId` identifies an outbox row. If that row was already pruned, an
    // at-least-once queue replay is stale; delivering without persistence here
    // would create new delivery ids and fan the event out a second time.
    return emptySummary();
  }

  const targets = subscribed.filter((target) => deliveryMatchesFilter(target.filter, payload));
  const deliver = async (target: DeliveryTarget, deliveryId: string, safeFetch: Fetch) => {
    const claimed = await claimDelivery(db, deliveryId, now);
    if (!claimed) return;
    const result = await attemptDelivery(safeFetch, target, eventType, claimed.id, bodyFor(target), now);
    await settleDelivery(db, claimed, result, now);
  };

  const targetById = new Map(targets.map((target) => [target.id, target]));
  const selectRows = () => db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventId, eventId));
  const deliveryIds = parent.initialized
    ? null
    : await initializePersistentDeliveries(db, eventId, targets, now);
  const fastPath = deliveryIds !== null && targets.length > 0 && fetchImpl !== undefined;
  if (fastPath) {
    // First pass with matching targets: claim each target's stable row
    // directly instead of re-reading the rows just written. The claim's
    // guards (pending, due, attempts below the cap) leave alone any row a
    // crashed earlier pass or a concurrent consumer already took. The few
    // rows this skips the full path's pre-delivery cleanup for (a stale row
    // of a subscription that no longer matches, an expired final attempt)
    // are still pending and due afterwards, and are settled below, in this
    // pass. Without a fetch the full path keeps today's order of failing
    // stale rows before refusing to deliver.
    await Promise.all(targets.map((target, index) => deliver(target, deliveryIds[index], fetchImpl)));
  } else {
    await deadLetterExpiredFinalAttempts(db, eventId, now);
    const rows = await selectRows();
    if (rows.length === 0) return emptySummary();

    const dueRows = rows.filter(
      (row) => row.status === 'pending' && row.nextAttemptAt.getTime() <= now.getTime(),
    );
    await Promise.all(dueRows
      .filter((row) => !targetById.has(row.subscriptionId))
      .map((row) => failUnavailableDelivery(db, row.id, now)));
    const safeFetch = dueRows.some((row) => targetById.has(row.subscriptionId))
      ? requireSafeFetch(fetchImpl)
      : undefined;

    await Promise.all(rows.map(async (row) => {
      if (row.status !== 'pending' || row.nextAttemptAt.getTime() > now.getTime()) return;
      const target = targetById.get(row.subscriptionId);
      if (!target) return;
      await deliver(target, row.id, safeFetch!);
    }));
  }

  let settled = await selectRows();
  if (fastPath) {
    // Every row this pass claimed is settled or leased into the future now,
    // so a row still pending and due is one the claims skipped: a stale row
    // of a subscription that no longer matches, or an expired final attempt.
    // Settle those as the full path would have before delivering (in its
    // order: dead-letter first), then re-read. Common case: nothing is due
    // and no statement is added.
    const due = settled.filter(
      (row) => row.status === 'pending' && row.nextAttemptAt.getTime() <= now.getTime(),
    );
    if (due.length > 0) {
      await deadLetterExpiredFinalAttempts(db, eventId, now);
      await Promise.all(due
        .filter((row) => !targetById.has(row.subscriptionId))
        .map((row) => failUnavailableDelivery(db, row.id, now)));
      settled = await selectRows();
    }
  }
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
  // Reset the parent and child in one adapter-portable atomic unit. The parent
  // predicate observes the child while it is still terminal, so a stale
  // concurrent replay cannot resurrect the parent after another replay wins.
  // Atomicity also prevents a queue poll from claiming the parent between the
  // two statements and settling it before the child becomes pending.
  const [, replayedRows] = await runAtomicWrites(db, tx => [
    tx
      .update(pendingEvents)
      .set({
        status: 'pending',
        attempts: 0,
        maxAttempts: 32,
        processAfter: now,
        lastError: null,
        completedAt: null,
      })
      .where(and(
        eq(pendingEvents.id, row.eventId),
        exists(
          tx
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(and(
              eq(webhookDeliveries.id, row.id),
              inArray(webhookDeliveries.status, ['failed', 'dead_letter']),
            )),
        ),
      )),
    tx
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
      .returning({ id: webhookDeliveries.id }),
  ], { requireAtomic: true });
  const [replayed] = replayedRows as Array<{ id: string }>;
  if (!replayed) {
    const [current] = await db
      .select({ status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, row.id));
    return current
      ? { kind: 'not_replayable', status: current.status }
      : { kind: 'not_found' };
  }
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
