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
  /** Alternate fingerprints understood by this version; older engines ignore them. */
  fingerprints?: string[];
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
  _idempotency_replayed?: boolean;
  _idempotency_ttl_seconds?: number;
};

interface RunIdempotentOptions<T> {
  workspaceId: string;
  actorId: string;
  scope: string;
  key?: string;
  status?: number;
  fingerprint?: string;
  /** Primary fingerprint persisted for rollback compatibility. */
  storageFingerprint?: string;
  /** Prior fingerprint formats accepted only when replaying an existing record. */
  compatibleFingerprints?: string[];
  ttlSeconds?: number;
  /** Override result retention (for example, an authoritative claim's remaining lifetime). */
  ttlSecondsForResult?: (data: T) => number | undefined;
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
  storedCompatible: string[],
  current: string | undefined,
  compatible: string[],
): boolean {
  if (!stored || !current) return true;
  const accepted = new Set([current, ...compatible]);
  return [stored, ...storedCompatible].some((candidate) => accepted.has(candidate));
}

function stripReplayStorageInternals<T>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const {
    _idempotency_replayed: _dropReplay,
    _idempotency_ttl_seconds: _dropTtl,
    ...storedData
  } = data as T & Pick<DeliveryInternals, '_idempotency_replayed' | '_idempotency_ttl_seconds'>;
  return storedData as T;
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
    _idempotency_replayed: _dropIdempotencyReplay,
    _idempotency_ttl_seconds: _dropIdempotencyTtl,
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
    storageFingerprint,
    compatibleFingerprints = [],
    operation,
    afterOperation,
    status = 201,
    ttlSeconds = IDEMPOTENCY_TTL_SECONDS,
    ttlSecondsForResult,
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
    if (
      (requireFingerprint && !parsed.fingerprint)
      || !fingerprintMatches(parsed.fingerprint, parsed.fingerprints ?? [], fingerprint, compatibleFingerprints)
    ) {
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
      // `allSettled` keeps the reads independent in failure too: a stored record
      // answers the request on its own, so a failed lock read must not void a
      // replay the record read already proved. Otherwise either read failing is
      // a read failure, exactly as the serialized record-then-lock reads were.
      const [recordRead, lockRead] = await Promise.allSettled([
        kvStore.get(kvKey),
        kvStore.get(lockKey),
      ]);

      if (recordRead.status === 'fulfilled' && recordRead.value) {
        return replayOf(recordRead.value);
      }
      if (recordRead.status === 'rejected') throw recordRead.reason;
      if (lockRead.status === 'rejected') throw lockRead.reason;
      const existingLock = lockRead.value;

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

      // Acquire the best-effort lock before mutating. KV has no compare-and-set,
      // so two callers can both have observed empty keys above. Re-reading the
      // record after this write preserves the old fence: if the other caller
      // completed while this lock write was pending, replay its result instead
      // of running the operation a second time. Do not delete the lock on this
      // replay path because it may still belong to the other caller.
      await kvStore.put(lockKey, '1', { expirationTtl: IDEMPOTENCY_LOCK_TTL_SECONDS });
      lockAcquired = true;

      let recheckRaw: string | null;
      try {
        recheckRaw = await kvStore.get(kvKey);
      } catch (err) {
        // This caller wrote the lock but could not establish whether a result
        // landed while that write was pending. Release the lock before the
        // outer policy either fails closed or degrades to an unprotected
        // operation; otherwise every immediate retry sees a stale 409.
        try { await kvStore.delete(lockKey); } catch { /* bounded by the lock TTL */ }
        lockAcquired = false;
        throw err;
      }
      if (recheckRaw) {
        return replayOf(recheckRaw);
      }
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
    }
  }

  try {
    const data = await operation();
    if (afterOperation) await afterOperation(data);

    if (kvStore && kvKey && lockAcquired) {
      const resultTtlSeconds = ttlSecondsForResult?.(data) ?? ttlSeconds;
      const record: StoredIdempotencyRecord<T> = {
        status,
        // Current-request replay metadata controls the header and cache TTL;
        // it is not part of the public receipt and must not leak after rollback.
        data: stripReplayStorageInternals(data),
        fingerprint: storageFingerprint ?? fingerprint,
        ...(
          fingerprint && storageFingerprint && fingerprint !== storageFingerprint
            ? { fingerprints: [fingerprint] }
            : {}
        ),
      };
      try {
        if (resultTtlSeconds > 0) {
          await kvStore.put(kvKey, JSON.stringify(record), { expirationTtl: resultTtlSeconds });
          // The stored record answers every later request for this key, so the
          // lock needs no explicit delete — it simply expires.
        } else if (lockKey) {
          // The authoritative claim expired while the operation was replaying.
          // Do not extend it through KV, and release this request's short lock.
          await kvStore.delete(lockKey);
          lockAcquired = false;
        }
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
    if (kvStore && lockKey && lockAcquired) {
      try { await kvStore.delete(lockKey); } catch { /* ignore */ }
    }
    throw err;
  }
}
