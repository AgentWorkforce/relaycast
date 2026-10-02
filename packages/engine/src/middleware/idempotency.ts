import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { KeyValueStore } from '../ports/kv.js';
import { sha256Hex } from '../lib/crypto.js';
import { jsonOk } from '../lib/httpResponse.js';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_LOCK_TTL_SECONDS = 30;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

interface StoredIdempotencyRecord<T> {
  status: number;
  data: T;
  fingerprint?: string;
}

export interface IdempotentResult<T> {
  status: number;
  data: T;
  replayed: boolean;
}

type DeliveryInternals = {
  _notifications_durable?: boolean;
  _delivery?: unknown;
  _deliveries?: unknown;
  _delivery_rejections?: unknown;
};

interface RunIdempotentOptions<T> {
  workspaceId: string;
  actorId: string;
  scope: string;
  key?: string;
  status?: number;
  fingerprint?: string;
  /** Prior fingerprint formats accepted only when replaying an existing record. */
  compatibleFingerprints?: string[];
  ttlSeconds?: number;
  kv?: KeyValueStore;
  requireKv?: boolean;
  /** Fail closed on an unreadable prior record, without failing a committed write on KV completion loss. */
  requireKvRead?: boolean;
  requireFingerprint?: boolean;
  operation: () => Promise<T>;
  /**
   * Fresh-result hook that must complete before the idempotency success record
   * is stored. Use it for durable post-mutation writes that must not be skipped
   * by a later idempotent replay.
   */
  afterOperation?: (data: T) => Promise<void>;
}

function fingerprintMatches(
  stored: string | undefined,
  current: string | undefined,
  compatible: string[],
): boolean {
  return !stored || !current || stored === current || compatible.includes(stored);
}

function idempotencyUnavailableError(cause?: unknown): Error {
  const err = new Error('Idempotency storage is unavailable');
  Object.assign(err, { code: 'idempotency_unavailable', status: 503, cause });
  return err;
}

export async function buildIdempotencyStorageKey(workspaceId: string, actorId: string, scope: string, key: string): Promise<string> {
  const [digest, scopeDigest] = await Promise.all([
    sha256Hex(key),
    sha256Hex(scope),
  ]);
  return `idem:v1:${workspaceId}:${actorId}:${scopeDigest.slice(0, 16)}:${digest}`;
}

export function parseIdempotencyKey(headerValue: string | undefined): { key?: string; error?: string } {
  if (headerValue === undefined) {
    return {};
  }

  const key = headerValue.trim();
  if (!key) {
    return { error: 'Idempotency-Key cannot be empty' };
  }

  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      error: `Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`,
    };
  }

  // Restrict to visible ASCII (no whitespace/control chars)
  if (/[^\x21-\x7E]/.test(key)) {
    return {
      error: 'Idempotency-Key must contain only visible ASCII characters',
    };
  }

  return { key };
}

export function applyIdempotencyReplayHeader<T>(c: Context, result: IdempotentResult<T>) {
  if (result.replayed) {
    c.header('Idempotency-Replayed', 'true');
  }
}

export function stripDeliveryInternals<T extends object>(data: T) {
  const {
    _notifications_durable: _dropNotifications,
    _delivery: _dropDelivery,
    _deliveries: _dropDeliveries,
    _delivery_rejections: _dropRejections,
    ...publicData
  } = data as T & DeliveryInternals;
  return publicData;
}

export function jsonIdempotentOk<T extends object>(c: Context, result: IdempotentResult<T>) {
  applyIdempotencyReplayHeader(c, result);
  return jsonOk(c, stripDeliveryInternals(result.data), result.status as ContentfulStatusCode);
}

export async function runIdempotent<T>(
  options: RunIdempotentOptions<T>,
): Promise<IdempotentResult<T>> {
  const {
    workspaceId,
    actorId,
    scope,
    key,
    fingerprint,
    compatibleFingerprints = [],
    operation,
    afterOperation,
    status = 201,
    ttlSeconds = IDEMPOTENCY_TTL_SECONDS,
    kv,
    requireKv = false,
    requireKvRead = false,
    requireFingerprint = false,
  } = options;

  if (!key) {
    if (requireKv) {
      const err = new Error('Idempotency key is required');
      Object.assign(err, { code: 'idempotency_key_required', status: 400 });
      throw err;
    }
    const data = await operation();
    if (afterOperation) await afterOperation(data);
    return { status, data, replayed: false };
  }

  /** Replay a stored record, rejecting a key reused with a different payload. */
  const replayOf = (raw: string): IdempotentResult<T> => {
    const parsed = JSON.parse(raw) as StoredIdempotencyRecord<T>;
    if ((requireFingerprint && !parsed.fingerprint) || !fingerprintMatches(parsed.fingerprint, fingerprint, compatibleFingerprints)) {
      const err = new Error('Idempotency-Key was reused with a different request payload');
      Object.assign(err, { code: 'idempotency_key_reused', status: 409 });
      throw err;
    }
    return { status: parsed.status || status, data: parsed.data, replayed: true };
  };

  let kvStore: KeyValueStore | null = kv ?? null;
  let kvKey: string | null = null;
  let lockKey: string | null = null;
  let lockAcquired = false;
  // Settles the lock write that overlaps `operation`. The failure paths must
  // await it before deleting the lock, or the delete can race ahead of the put
  // and leave the key held until its TTL expires.
  let lockWrite: Promise<void> | null = null;

  if (!kvStore && (requireKv || requireKvRead)) {
    throw idempotencyUnavailableError();
  }

  // Storage the caller declared mandatory must fail closed before the operation
  // commits, so those paths keep the lock write on the critical path.
  const failClosed = requireKv || requireKvRead;

  if (kvStore) {
    kvKey = await buildIdempotencyStorageKey(workspaceId, actorId, scope, key);
    lockKey = `${kvKey}:lock`;

    try {
      // The record and the lock are independent keys, so read them in one round
      // trip instead of two. KV has no atomic NX-style set, so the lock stays
      // best-effort: in rare races duplicate operations may still run.
      const [existingRaw, existingLock] = await Promise.all([
        kvStore.get(kvKey),
        kvStore.get(lockKey),
      ]);

      if (existingRaw) {
        return replayOf(existingRaw);
      }

      if (existingLock) {
        // Another request may be processing, or may have committed between the
        // paired reads above and now. One extra read — on the contended path
        // only — keeps that case a replay instead of a spurious conflict.
        const concurrentRaw = await kvStore.get(kvKey);
        if (concurrentRaw) {
          return replayOf(concurrentRaw);
        }

        const err = new Error('Another request with this Idempotency-Key is still processing');
        Object.assign(err, { code: 'idempotency_in_progress', status: 409 });
        throw err;
      }

      // Acquire the lock. Nothing reads it before the next request with this
      // key, and the success record below supersedes it, so on the fast path it
      // overlaps `operation` instead of adding a serialized round trip.
      const lockPut = kvStore.put(lockKey, '1', { expirationTtl: IDEMPOTENCY_LOCK_TTL_SECONDS });
      if (failClosed) {
        await lockPut;
        lockWrite = Promise.resolve();
      } else {
        // A lost lock write means the lock is not held: skip the record, exactly
        // as a synchronous lock-write failure did.
        lockWrite = lockPut.catch(() => { lockAcquired = false; });
      }
      lockAcquired = true;
    } catch (err) {
      if (err instanceof Error && ['idempotency_key_reused', 'idempotency_in_progress'].includes((err as Error & { code?: string }).code ?? '')) {
        throw err;
      }
      if (failClosed) {
        throw idempotencyUnavailableError(err);
      }
      // KV unavailable or decode failure: proceed without idempotency.
      kvStore = null;
      kvKey = null;
      lockKey = null;
      lockAcquired = false;
      lockWrite = null;
    }
  }

  try {
    const data = await operation();
    if (afterOperation) await afterOperation(data);
    if (lockWrite) await lockWrite;

    if (kvStore && kvKey && lockAcquired) {
      const record: StoredIdempotencyRecord<T> = {
        status,
        data,
        fingerprint,
      };
      try {
        await kvStore.put(kvKey, JSON.stringify(record), { expirationTtl: ttlSeconds });
        // The stored record answers every later request for this key, so the
        // lock needs no explicit delete — it simply expires.
      } catch (err) {
        // The record is missing, so the lock must go now: otherwise a retry
        // inside the lock TTL sees neither and is rejected as in-progress.
        if (lockKey) {
          try { await kvStore.delete(lockKey); } catch { /* bounded by the lock TTL */ }
          lockAcquired = false;
        }
        if (requireKv) {
          throw idempotencyUnavailableError(err);
        }
        // KV failure during record storage — proceed without idempotency record.
      }
    }

    return { status, data, replayed: false };
  } catch (err) {
    if (lockWrite) await lockWrite.catch(() => {});
    if (kvStore && lockKey && lockAcquired) {
      try { await kvStore.delete(lockKey); } catch { /* ignore */ }
    }
    throw err;
  }
}
